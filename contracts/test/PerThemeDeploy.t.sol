// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md §7,
//            docs/technical/unified-vault-spec.md §8 — theme deployment table.
//
// Tests for contracts/script/DeployVaultThemes.s.sol (issue #1129): the
// per-theme deploy scripts instantiate each of the four themes
// (rmUSDC/rmPROTO/rmAGENT/rmRWA) as ONE unified `Vault` deployment composed with
// a theme-specific, VARIABLE-LENGTH adapter set. The suite asserts, per theme:
//   * the resulting Vault's adapter SET (addresses + count),
//   * the per-adapter WEIGHTS (`capBps`) and the VARIABLE weight-array length
//     (rmUSDC 3 / rmPROTO 3 / rmAGENT 3 / rmRWA 1 — not the old fixed-length 4),
//   * the vault-attested `isExact` per adapter and the `allExact()` composition
//     class (true only for the all-lending rmUSDC),
//   * rmAGENT wiring a per-theme `TimelockController` as the adapter admin,
//   * rmRWA ENFORCING the active-adapter-count cap of 1 (a second `addAdapter`
//     reverts `MaxAdaptersReached`).
//
// Runs in the default `forge test` CI job (no fork, no external resource) with a
// non-zero executed test count — the deploy scripts are exercised end-to-end
// against mock `IPositionAdapter`s, so the diff is genuinely executed, not just
// compiled.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Vault} from "../Vault.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {DeployVaultThemes} from "../script/DeployVaultThemes.s.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Minimal `IPositionAdapter` fixture bound to a vault, used only to exercise
///      the deploy-time REGISTRATION path (allowlist + codehash + addAdapter). It
///      never receives deposits in these tests, so `deploy`/`withdraw`/`totalAssets`
///      are trivial. `isExact()` is a self-report (constructor-set) that the vault
///      does NOT read at registration — the attested bool comes from the deploy
///      script's `AdapterSpec` (spec §5.1, C2). UNIQUE name to avoid forge-doc
///      re-link collisions with the other suites' fixtures.
contract ThemeRegAdapter is IPositionAdapter {
    address public immutable USDC;
    address public immutable VAULT;
    bool internal immutable _exact;

    constructor(address usdc_, address vault_, bool exact_) {
        USDC = usdc_;
        VAULT = vault_;
        _exact = exact_;
    }

    function deploy(uint256 usdcIn, uint256) external view returns (uint256) {
        require(msg.sender == VAULT, "onlyVault");
        return usdcIn;
    }

    function withdraw(uint256, uint256) external view returns (uint256) {
        require(msg.sender == VAULT, "onlyVault");
        return 0;
    }

    function totalAssets() external pure returns (uint256) {
        return 0;
    }

    function isExact() external view returns (bool) {
        return _exact;
    }

    function harvestRewards() external {}

    function sweepForeignToken(address) external {}
}

contract PerThemeDeployTest is Test {
    DeployVaultThemes internal deployer;
    TestERC20 internal usdc;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");

    uint256 internal constant TVL_CAP = 10_000_000 * 1e6;
    uint256 internal constant PER_DEPOSIT_CAP = 1_000_000 * 1e6;
    uint256 internal constant NAV_GROWTH_BPS = 500;

    function setUp() public {
        deployer = new DeployVaultThemes();
        usdc = new TestERC20();
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _deployVault(DeployVaultThemes.Theme t) internal returns (Vault v) {
        DeployVaultThemes.VaultConfig memory cfg = DeployVaultThemes.VaultConfig({
            usdc: IERC20(address(usdc)),
            tvlCap: TVL_CAP,
            perDepositCap: PER_DEPOSIT_CAP,
            exitFeeBps: 0,
            maxNavGrowthRateBps: NAV_GROWTH_BPS,
            feeRecipient: feeRecipient,
            admin: admin,
            emergency: emergency
        });
        v = deployer.deployThemeVault(t, cfg);
    }

    /// @dev Build a variable-length adapter set for `v`: one mock adapter per
    ///      `(capBps, isExact)` pair, each bound to the vault.
    function _specs(Vault v, uint16[] memory caps, bool[] memory exacts)
        internal
        returns (DeployVaultThemes.AdapterSpec[] memory specs)
    {
        specs = new DeployVaultThemes.AdapterSpec[](caps.length);
        for (uint256 i = 0; i < caps.length; i++) {
            ThemeRegAdapter a = new ThemeRegAdapter(address(usdc), address(v), exacts[i]);
            specs[i] = DeployVaultThemes.AdapterSpec({
                adapter: address(a), capBps: caps[i], isExact: exacts[i]
            });
        }
    }

    /// @dev Assert the vault's registered adapter set matches `specs` exactly:
    ///      count, per-adapter address, weight (`capBps`), attested `isExact`,
    ///      and active flag.
    function _assertAdapterSet(Vault v, DeployVaultThemes.AdapterSpec[] memory specs)
        internal
        view
    {
        assertEq(v.adapterCount(), specs.length, "registry entry count");
        assertEq(v.activeAdapterCount(), specs.length, "active adapter count");
        for (uint256 i = 0; i < specs.length; i++) {
            (address addr, uint16 capBps, bool active, bool isExact,,) = v.getAdapterInfo(i);
            assertEq(addr, specs[i].adapter, "adapter address");
            assertEq(capBps, specs[i].capBps, "adapter weight (capBps)");
            assertTrue(active, "adapter active");
            assertEq(isExact, specs[i].isExact, "attested isExact");
        }
    }

    // ─── rmUSDC — all-lending, exact composition ────────────────────────────

    function test_rmUsdc_deploysExactLendingSet() public {
        DeployVaultThemes.Theme t = DeployVaultThemes.Theme.RM_USDC;
        Vault v = _deployVault(t);

        // 3 lending adapters (Morpho / Aave / Compound), all attested EXACT.
        uint16[] memory caps = new uint16[](3);
        caps[0] = 4000;
        caps[1] = 3000;
        caps[2] = 3000;
        bool[] memory exacts = new bool[](3);
        exacts[0] = true;
        exacts[1] = true;
        exacts[2] = true;

        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);
        deployer.wireTheme(v, t, admin, specs);

        assertEq(v.name(), "Robot Money USDC");
        assertEq(v.symbol(), "rmUSDC");
        assertEq(v.maxSlippageBps(), 0, "rmUSDC maxSlippage 0");
        assertEq(v.maxActiveAdapters(), 20, "rmUSDC keeps default cap");
        _assertAdapterSet(v, specs);
        assertTrue(v.allExact(), "rmUSDC is all-exact (withdraw live)");
    }

    // ─── rmPROTO — 3 Uniswap-V3 asset adapters, inexact ─────────────────────

    function test_rmProto_deploysInexactV3Set() public {
        DeployVaultThemes.Theme t = DeployVaultThemes.Theme.RM_PROTO;
        Vault v = _deployVault(t);

        // wETH / cbBTC / wSOL — all attested INEXACT (slippage-priced).
        uint16[] memory caps = new uint16[](3);
        caps[0] = 5000; // wETH
        caps[1] = 3000; // cbBTC
        caps[2] = 2000; // wSOL
        bool[] memory exacts = new bool[](3);
        // all false

        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);
        deployer.wireTheme(v, t, admin, specs);

        assertEq(v.symbol(), "rmPROTO");
        assertEq(v.maxSlippageBps(), 100, "rmPROTO maxSlippage 100");
        assertEq(v.maxActiveAdapters(), 10, "rmPROTO cap 10");
        _assertAdapterSet(v, specs);
        assertFalse(v.allExact(), "rmPROTO is inexact (redeem-only)");
    }

    // ─── rmAGENT — 3 mixed-venue adapters + per-theme TimelockController ─────

    function test_rmAgent_deploysMixedSetWithTimelockAdmin() public {
        DeployVaultThemes.Theme t = DeployVaultThemes.Theme.RM_AGENT;
        Vault v = _deployVault(t);

        // BNKR (V3) / JUNO (V4) / RM (Aerodrome) — mixed venues, all INEXACT.
        uint16[] memory caps = new uint16[](3);
        caps[0] = 4000;
        caps[1] = 3000;
        caps[2] = 3000;
        bool[] memory exacts = new bool[](3);

        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);
        // Bootstrap operator (admin) wires the set while still holding ADMIN_ROLE.
        deployer.wireTheme(v, t, admin, specs);

        assertEq(v.symbol(), "rmAGENT");
        assertEq(v.maxSlippageBps(), 300, "rmAGENT maxSlippage 300");
        assertEq(v.maxActiveAdapters(), 15, "rmAGENT cap 15");
        _assertAdapterSet(v, specs);
        assertFalse(v.allExact(), "rmAGENT is inexact");

        // Wire a per-theme TimelockController as the adapter admin (ADR-0004
        // add/remove delays) and hand ADMIN_ROLE to it.
        uint256 minDelay = 48 hours;
        address proposer = makeAddr("agentGovernance");
        address executor = makeAddr("agentExecutor");
        TimelockController timelock = deployer.deployAgentTimelock(minDelay, proposer, executor);
        deployer.finalizeAdmin(v, admin, address(timelock));

        bytes32 adminRole = v.ADMIN_ROLE();
        assertTrue(v.hasRole(adminRole, address(timelock)), "timelock holds ADMIN_ROLE");
        assertFalse(v.hasRole(adminRole, admin), "bootstrap operator renounced ADMIN_ROLE");
        assertEq(v.adminCount(), 1, "single ADMIN after handoff");
        assertEq(timelock.getMinDelay(), minDelay, "timelock encodes ADR-0004 delay");
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), proposer), "governance is proposer");
    }

    // ─── rmRWA — single Chronicle adapter, active-adapter cap = 1 ────────────

    function test_rmRwa_deploysSingleAdapterAndEnforcesCapOfOne() public {
        DeployVaultThemes.Theme t = DeployVaultThemes.Theme.RM_RWA;
        Vault v = _deployVault(t);

        // A single deSPXA Chronicle adapter, INEXACT, full weight.
        uint16[] memory caps = new uint16[](1);
        caps[0] = 10_000;
        bool[] memory exacts = new bool[](1);

        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);
        deployer.wireTheme(v, t, admin, specs);

        assertEq(v.symbol(), "rmRWA");
        assertEq(v.maxSlippageBps(), 50, "rmRWA maxSlippage 50");
        assertEq(v.maxActiveAdapters(), 1, "rmRWA active-adapter cap 1");
        _assertAdapterSet(v, specs);
        assertFalse(v.allExact(), "rmRWA is inexact");

        // ENFORCEMENT: a second (fully eligible) active adapter reverts on the cap.
        ThemeRegAdapter second = new ThemeRegAdapter(address(usdc), address(v), false);
        vm.startPrank(admin);
        v.setAdapterAllowed(address(second), true);
        v.setAdapterCodeHashAllowed(address(second).codehash, true); // same codehash, idempotent
        vm.expectRevert(Vault.MaxAdaptersReached.selector);
        v.addAdapter(address(second), 10_000, false);
        vm.stopPrank();
    }

    // ─── expectedAdapters count invariant (issue #1179) ─────────────────────

    /// @dev After a correctly-counted wiring, the vault's active adapter count
    ///      equals the theme's `expectedAdapters` — the field is now read and
    ///      enforced, not a write-only doc aid.
    function _assertWireCountMatchesExpected(DeployVaultThemes.Theme t) internal {
        Vault v = _deployVault(t);
        uint256 expected = deployer.themeParams(t).expectedAdapters;

        uint16[] memory caps = new uint16[](expected);
        bool[] memory exacts = new bool[](expected);
        for (uint256 i = 0; i < expected; i++) {
            caps[i] = uint16(10_000 / expected);
        }
        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);
        deployer.wireTheme(v, t, admin, specs);

        assertEq(v.activeAdapterCount(), expected, "active count == expectedAdapters");
    }

    function test_rmUsdc_wireCountMatchesExpected() public {
        _assertWireCountMatchesExpected(DeployVaultThemes.Theme.RM_USDC);
    }

    function test_rmProto_wireCountMatchesExpected() public {
        _assertWireCountMatchesExpected(DeployVaultThemes.Theme.RM_PROTO);
    }

    function test_rmAgent_wireCountMatchesExpected() public {
        _assertWireCountMatchesExpected(DeployVaultThemes.Theme.RM_AGENT);
    }

    function test_rmRwa_wireCountMatchesExpected() public {
        _assertWireCountMatchesExpected(DeployVaultThemes.Theme.RM_RWA);
    }

    /// @dev A wiring whose adapter count differs from `expectedAdapters` reverts
    ///      `AdapterCountMismatch` — the documented spec §8 MUST-invariant is now
    ///      an in-code guarantee for every theme, not just rmRWA's incidental cap.
    function _assertWireWrongCountReverts(DeployVaultThemes.Theme t, uint256 wrong) internal {
        Vault v = _deployVault(t);
        uint256 expected = deployer.themeParams(t).expectedAdapters;

        uint16[] memory caps = new uint16[](wrong);
        bool[] memory exacts = new bool[](wrong);
        for (uint256 i = 0; i < wrong; i++) {
            caps[i] = 1000;
        }
        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployVaultThemes.AdapterCountMismatch.selector, t, expected, wrong
            )
        );
        deployer.wireTheme(v, t, admin, specs);
    }

    function test_rmUsdc_wireWrongCountReverts() public {
        // expectedAdapters == 3; wire one too few.
        _assertWireWrongCountReverts(DeployVaultThemes.Theme.RM_USDC, 2);
    }

    function test_rmProto_wireWrongCountReverts() public {
        // expectedAdapters == 3; wire one too many.
        _assertWireWrongCountReverts(DeployVaultThemes.Theme.RM_PROTO, 4);
    }

    function test_rmAgent_wireWrongCountReverts() public {
        // expectedAdapters == 3; wire one too few.
        _assertWireWrongCountReverts(DeployVaultThemes.Theme.RM_AGENT, 2);
    }

    function test_rmRwa_wireWrongCountReverts() public {
        // expectedAdapters == 1; wire one too many — the count check reverts
        // BEFORE the active-adapter cap is even touched.
        _assertWireWrongCountReverts(DeployVaultThemes.Theme.RM_RWA, 2);
    }

    // ─── Variable-length weight arrays across the four themes (not fixed-4) ──

    function test_weightArrayLengthVariesPerTheme() public {
        // rmUSDC / rmPROTO / rmAGENT each wire 3 adapters; rmRWA wires 1 — the
        // per-theme weight array is variable-length, replacing the fixed-length-4
        // assumption (ADR-0010 §8, Phase 6.5).
        assertEq(_wireLenFor(DeployVaultThemes.Theme.RM_USDC, 3, true), 3, "rmUSDC len 3");
        assertEq(_wireLenFor(DeployVaultThemes.Theme.RM_PROTO, 3, false), 3, "rmPROTO len 3");
        assertEq(_wireLenFor(DeployVaultThemes.Theme.RM_AGENT, 3, false), 3, "rmAGENT len 3");
        assertEq(_wireLenFor(DeployVaultThemes.Theme.RM_RWA, 1, false), 1, "rmRWA len 1");

        // Explicitly assert the set is NOT the old fixed length of 4.
        assertTrue(_wireLenFor(DeployVaultThemes.Theme.RM_RWA, 1, false) != 4, "rmRWA != fixed-4");
    }

    /// @dev Deploy `t`, wire `n` equal-weight adapters, return the resulting active
    ///      count (== the wired weight-array length).
    function _wireLenFor(DeployVaultThemes.Theme t, uint256 n, bool exact)
        internal
        returns (uint256)
    {
        Vault v = _deployVault(t);
        uint16[] memory caps = new uint16[](n);
        bool[] memory exacts = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            caps[i] = 1000;
            exacts[i] = exact;
        }
        DeployVaultThemes.AdapterSpec[] memory specs = _specs(v, caps, exacts);
        deployer.wireTheme(v, t, admin, specs);
        return v.activeAdapterCount();
    }
}
