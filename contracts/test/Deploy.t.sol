// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/script/Deploy.s.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

import {TestERC20} from "./helpers/TestERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {DeployDemoExtraVaults} from "../script/DeployDemoExtraVaults.s.sol";

/// @dev Mimics the per-vault `tickMathLibrary()` accessor the deploy assertion
///      reads, but returns a caller-chosen address — used to prove the deploy
///      assertion fails on a wrong/zero linked library (finding L3-D1).
contract BadTickMathVault {
    address private immutable _lib;

    constructor(address lib_) {
        _lib = lib_;
    }

    function tickMathLibrary() external view returns (address) {
        return _lib;
    }

    /// @dev BasketVault(addr).totalAssets() is also probed by the assertion;
    ///      return 0 so a passing codehash would still be exercised in range.
    function totalAssets() external pure returns (uint256) {
        return 0;
    }
}

/// @dev Test-only subclass exposing the internal TickMath link-integrity
///      assertion of `DeployDemoExtraVaults` so a deliberately wrong/zero
///      linked address can be shown to fail the deploy assertion (finding L3-D1).
contract DeployDemoExtraVaultsHarness is DeployDemoExtraVaults {
    function assertTickMathLinkIntegrity(
        address protocolVault,
        address rwaVault,
        address agentVault
    ) external view {
        _assertTickMathLinkIntegrity(protocolVault, rwaVault, agentVault);
    }
}

/// @dev Exercises the deploy script in-process and asserts the post-deploy
///      invariants the operator and downstream tooling rely on (issue #10).
///      The script deploys RobotMoneyVault + AaveV3Adapter + CompoundV3Adapter
///      + MorphoAdapter (issue #363) instead of MockVault.
///      MockVault is retained only for its own unit
///      tests.  The script always binds the gateway to an externally-supplied
///      USDC token; this test deploys a `TestERC20` helper and passes its
///      address in.  The smoke-test devnet does the same with the canonical
///      Base USDC proxy seeded into genesis alloc (issue #255).
///
///      Note: adapter constructors only check for address(0) — they do NOT
///      require the protocol contracts to have bytecode. The in-process test
///      therefore succeeds even though AAVE_V3_POOL et al. are not deployed
///      in the forge unit-test environment. Actual protocol interaction is
///      tested by the fork regression suite (VaultForkRegressions.t.sol) and
///      the fork-e2e-rust harness.
contract DeployTest is Test {
    Deploy internal script;
    TestERC20 internal usdc;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");

    function setUp() public {
        script = new Deploy();
        usdc = new TestERC20();
    }

    function _run() internal returns (Deploy.Deployed memory) {
        return script.runInProcessWith(admin, pauser, agent, shareReceiver, address(usdc));
    }

    // --- Happy path -----------------------------------------------------

    function test_deploy_wiresUsdcVaultAndAdminPauserRoles() public {
        Deploy.Deployed memory d = _run();

        // Gateway pins the right token + vault.
        assertEq(d.gateway.usdc(), d.usdc, "usdc mismatch");
        assertEq(d.gateway.vault(), address(d.vault), "vault mismatch");
        // RobotMoneyVault exposes asset() (ERC-4626) not assetToken()
        assertEq(d.vault.asset(), d.usdc, "vault.asset mismatch");
        assertEq(d.usdc, address(usdc), "usdc passthrough");

        // All three adapters are wired to the correct USDC and VAULT addresses.
        assertEq(address(d.aaveAdapter.USDC()), d.usdc, "aaveAdapter.USDC mismatch");
        assertEq(d.aaveAdapter.VAULT(), address(d.vault), "aaveAdapter.VAULT mismatch");
        assertEq(address(d.compoundAdapter.USDC()), d.usdc, "compoundAdapter.USDC mismatch");
        assertEq(d.compoundAdapter.VAULT(), address(d.vault), "compoundAdapter.VAULT mismatch");
        assertEq(address(d.morphoAdapter.USDC()), d.usdc, "morphoAdapter.USDC mismatch");
        assertEq(d.morphoAdapter.VAULT(), address(d.vault), "morphoAdapter.VAULT mismatch");

        // Vault has all three real adapters registered.
        assertEq(d.vault.activeAdapterCount(), 3, "vault should have 3 active adapters");

        // Admin + Pauser hold their roles.
        assertTrue(d.gateway.hasRole(d.gateway.ADMIN_ROLE(), admin), "admin role");
        assertTrue(d.gateway.hasRole(d.gateway.DEFAULT_ADMIN_ROLE(), admin), "default admin");
        assertTrue(d.gateway.hasRole(d.gateway.PAUSER_ROLE(), pauser), "pauser role");

        // Agent holds AGENT and nothing else.
        assertTrue(d.gateway.hasRole(d.gateway.AGENT_ROLE(), agent), "agent role");
        assertFalse(d.gateway.hasRole(d.gateway.ADMIN_ROLE(), agent), "agent !admin");
        assertFalse(d.gateway.hasRole(d.gateway.PAUSER_ROLE(), agent), "agent !pauser");

        // Runtime hash pinned correctly.
        assertEq(d.gatewayRuntimeHash, keccak256(address(d.gateway).code));
    }

    /// @notice The production deploy path wires exactly three DISTINCT real
    ///         adapter addresses — no single-address aliasing. This is the
    ///         regression guard for the removed test-only no-yield deploy hatch
    ///         (issue #912), which used to alias all three typed adapter fields
    ///         to one no-yield adapter instance. `runInProcessWith` shares the
    ///         same `_doDeploy` adapter-construction code path as the broadcast
    ///         `run()` entrypoint, so this exercises the `run()`-equivalent
    ///         wiring.
    function test_deploy_wiresThreeDistinctRealAdapterAddresses() public {
        Deploy.Deployed memory d = _run();

        address aave = address(d.aaveAdapter);
        address compound = address(d.compoundAdapter);
        address morpho = address(d.morphoAdapter);

        // No zero addresses.
        assertTrue(aave != address(0), "aaveAdapter is zero");
        assertTrue(compound != address(0), "compoundAdapter is zero");
        assertTrue(morpho != address(0), "morphoAdapter is zero");

        // All three are pairwise distinct — no single-address aliasing.
        assertTrue(aave != compound, "aave aliases compound");
        assertTrue(aave != morpho, "aave aliases morpho");
        assertTrue(compound != morpho, "compound aliases morpho");

        // Each is a real, distinct adapter type wired to the vault: the three
        // real adapters expose the Base-mainnet protocol immutables that a
        // single aliased no-yield adapter could not.
        assertEq(address(d.aaveAdapter.POOL()), script.AAVE_V3_POOL(), "aave POOL mismatch");
        assertEq(
            address(d.compoundAdapter.COMET()),
            script.COMPOUND_V3_COMET(),
            "compound COMET mismatch"
        );
        assertEq(
            address(d.morphoAdapter.MORPHO_VAULT()),
            script.MORPHO_GAUNTLET_USDC_PRIME(),
            "morpho vault mismatch"
        );

        // Exactly three active adapters registered (no fourth, no single-arm).
        assertEq(d.vault.activeAdapterCount(), 3, "vault should have 3 active adapters");
    }

    function test_deploy_authorizesAgentWithSanePolicy() public {
        Deploy.Deployed memory d = _run();
        (
            bool active,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address recv,,
            uint256 maxWithdrawPerPayment,
            uint256 maxWithdrawPerWindow
        ) = d.gateway.agents(agent);
        assertTrue(active);
        assertGt(validUntil, block.timestamp);
        assertEq(maxPerPayment, script.DEFAULT_MAX_PER_PAYMENT());
        assertEq(maxPerWindow, script.DEFAULT_MAX_PER_WINDOW());
        assertEq(recv, shareReceiver);
        assertEq(maxWithdrawPerPayment, script.DEFAULT_MAX_WITHDRAW_PER_PAYMENT());
        assertEq(maxWithdrawPerWindow, script.DEFAULT_MAX_WITHDRAW_PER_WINDOW());
    }

    function test_deploy_doesNotMintToAgent() public {
        // The script no longer mints test USDC to the agent — funding is
        // the caller's responsibility (smoke-test harness or unit-test
        // helpers). The agent's USDC balance must be untouched by the
        // deploy.
        uint256 before = usdc.balanceOf(agent);
        _run();
        assertEq(usdc.balanceOf(agent), before, "deploy must not mint to agent");
    }

    // --- USDC_ADDRESS preconditions -------------------------------------

    function test_deploy_revertsWhenUsdcAddressZero() public {
        vm.expectRevert(bytes("USDC_ADDRESS=0"));
        script.runInProcessWith(admin, pauser, agent, shareReceiver, address(0));
    }

    function test_deploy_revertsWhenUsdcAddressHasNoCode() public {
        address eoa = makeAddr("not-a-token");
        vm.expectRevert(bytes("USDC_ADDRESS has no code"));
        script.runInProcessWith(admin, pauser, agent, shareReceiver, eoa);
    }

    // --- Role-separation invariant (issue #10's headline test) ----------

    function test_deploy_grantingAgentRoleToAdminReverts() public {
        Deploy.Deployed memory d = _run();

        // Build a policy and try to authorize ADMIN as an AGENT — this
        // must revert because admin already holds ADMIN_ROLE.
        address[] memory noDestinations = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 1 days),
            maxPerPayment: 1e6,
            maxPerWindow: 1e6,
            shareReceiver: shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noDestinations
        });

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        d.gateway.authorizeAgent(admin, p);
    }

    function test_deploy_grantingAgentRoleToPauserReverts() public {
        Deploy.Deployed memory d = _run();

        address[] memory noDestinations2 = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 1 days),
            maxPerPayment: 1e6,
            maxPerWindow: 1e6,
            shareReceiver: shareReceiver,
            allowedDestinations: noDestinations2,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noDestinations2
        });

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        d.gateway.authorizeAgent(pauser, p);
    }

    // --- Pre-deploy distinctness check ----------------------------------

    function test_deploy_revertsWhenAdminEqualsPauser() public {
        vm.expectRevert(bytes("ADMIN==PAUSER"));
        script.runInProcessWith(admin, admin, agent, shareReceiver, address(usdc));
    }

    function test_deploy_revertsWhenAdminEqualsAgent() public {
        vm.expectRevert(bytes("ADMIN==AGENT"));
        script.runInProcessWith(admin, pauser, admin, shareReceiver, address(usdc));
    }

    function test_deploy_revertsWhenPauserEqualsAgent() public {
        vm.expectRevert(bytes("PAUSER==AGENT"));
        script.runInProcessWith(admin, pauser, pauser, shareReceiver, address(usdc));
    }

    // --- Seed deposit constant (issue #656) --------------------------------

    /// @notice SEED_DEPOSIT_AMOUNT constant equals 1,000 USDC (1_000_000_000 wei).
    ///         This is a pure unit check — no protocol interaction required.
    ///         The fork-level post-conditions are in DeploySeedDeposit.t.sol.
    function test_deploy_seedDepositAmount_isOneThousandUsdc() public view {
        assertEq(
            script.SEED_DEPOSIT_AMOUNT(),
            1_000_000_000,
            "SEED_DEPOSIT_AMOUNT must be 1_000_000_000 (1,000 USDC in 6-decimal wei)"
        );
    }

    // --- Env-driven path also works (single test to keep coverage) ------

    function test_deploy_envDriven_runInProcessSucceeds() public {
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(pauser));
        vm.setEnv("AGENT_ADDRESS", vm.toString(agent));
        vm.setEnv("SHARE_RECEIVER_ADDRESS", vm.toString(shareReceiver));
        vm.setEnv("USDC_ADDRESS", vm.toString(address(usdc)));
        Deploy.Deployed memory d = script.runInProcess();
        assertEq(d.admin, admin);
        assertEq(d.pauser, pauser);
        assertEq(d.agent, agent);
        assertEq(d.usdc, address(usdc));
    }

    // --- L3-D1: TickMath link integrity ------------------------------------

    /// @notice Audited runtime codehash of the canonical `TickMath` library,
    ///         pinned identically to both deploy scripts. If this drifts, the
    ///         library or compiler settings changed and the deploy-time
    ///         assertion in `Deploy.s.sol` / `DeployDemoExtraVaults.s.sol` must
    ///         be re-pinned.
    bytes32 internal constant TICKMATH_AUDITED_CODEHASH =
        0x1201c85bdae3b953cb38d7ae72ab099c55bc602a8c68b46cd649e8e38fdb875e;

    /// @dev Deploy a representative basket-family vault (uses the TickMath link)
    ///      with no real swap router; totalAssets() with an empty basket returns
    ///      the vault's USDC balance and never touches TickMath, so it is a
    ///      non-reverting in-range probe.
    function _deployBasketVault() internal returns (BasketVault) {
        return BasketVault(
            address(
                new AgentTokenVault(
                    IERC20(address(usdc)),
                    ISwapRouter(makeAddr("swapRouter")),
                    10_000_000 * 1e6, // tvlCap
                    1_000_000 * 1e6, // perDepositCap
                    0, // exitFeeBps
                    admin, // feeRecipient
                    admin, // admin
                    makeAddr("emergency") // emergencyResponder
                )
            )
        );
    }

    /// @notice The linked TickMath library has non-empty code and a runtime
    ///         codehash equal to the audited artifact, and the basket vault's
    ///         totalAssets() is non-reverting and in range. This is the positive
    ///         arm of the deploy-time assertion.
    function test_tickMathLink_codehashMatchesAudited_andTotalAssetsInRange() public {
        BasketVault vault = _deployBasketVault();

        address lib = vault.tickMathLibrary();
        assertTrue(lib != address(0), "linked TickMath must be non-zero");
        assertGt(lib.code.length, 0, "linked TickMath must have code");
        assertEq(lib.codehash, TICKMATH_AUDITED_CODEHASH, "TickMath codehash must match audited");

        uint256 nav = vault.totalAssets();
        assertEq(nav, 0, "empty basket totalAssets is the USDC balance (0)");
        assertLe(nav, 10_000_000 * 1e6 * 1000, "totalAssets must be in range");
    }

    /// @notice The Deploy.s.sol deploy path asserts TickMath canonicality: a
    ///         successful in-process deploy implies the linked library's codehash
    ///         equals the audited constant (the assertion runs inside _doDeploy).
    function test_tickMathLink_deployAssertsCanonicalLibrary() public {
        // _run() invokes the full deploy, which calls _assertTickMathCanonical()
        // internally; reaching this assert means the canonicality check passed.
        Deploy.Deployed memory d = _run();
        assertTrue(address(d.vault) != address(0), "deploy completed past TickMath assertion");
    }

    /// @notice A deliberately wrong (and a zero) linked-library address fails the
    ///         same codehash check the deploy assertion enforces. Proves the
    ///         assertion is not vacuous — a mislinked library does not pass.
    function test_tickMathLink_wrongOrZeroAddressFailsCodehashCheck() public {
        // The canonical library, for reference.
        address canonical = _deployBasketVault().tickMathLibrary();
        assertEq(canonical.codehash, TICKMATH_AUDITED_CODEHASH, "control: canonical matches");

        // Zero address: no code, codehash is zero → mismatch.
        BadTickMathVault zeroVault = new BadTickMathVault(address(0));
        address zeroLib = zeroVault.tickMathLibrary();
        assertEq(zeroLib.code.length, 0, "zero address has no code");
        assertTrue(
            zeroLib.codehash != TICKMATH_AUDITED_CODEHASH,
            "zero address must not pass codehash check"
        );

        // Wrong address (a contract whose code is not TickMath) → mismatch.
        BadTickMathVault wrongVault = new BadTickMathVault(address(this));
        address wrongLib = wrongVault.tickMathLibrary();
        assertGt(wrongLib.code.length, 0, "wrong address has code (this test contract)");
        assertTrue(
            wrongLib.codehash != TICKMATH_AUDITED_CODEHASH,
            "wrong (non-TickMath) code must not pass codehash check"
        );
    }

    /// @notice The actual DeployDemoExtraVaults TickMath link-integrity assertion
    ///         reverts when a vault links a zero (no-code) or wrong (non-TickMath)
    ///         library — proving the deploy assertion fails closed on mislink.
    function test_tickMathLink_deployAssertionRevertsOnMislink() public {
        DeployDemoExtraVaultsHarness harness = new DeployDemoExtraVaultsHarness();

        // Zero linked library → reverts on the zero-address check.
        address zeroVault = address(new BadTickMathVault(address(0)));
        vm.expectRevert(bytes("TickMath: zero linked library"));
        harness.assertTickMathLinkIntegrity(zeroVault, zeroVault, zeroVault);

        // Wrong (non-TickMath) linked library with code → reverts on codehash.
        address wrongVault = address(new BadTickMathVault(address(this)));
        vm.expectRevert(bytes("TickMath: codehash mismatch"));
        harness.assertTickMathLinkIntegrity(wrongVault, wrongVault, wrongVault);
    }
}
