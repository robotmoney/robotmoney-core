// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md
//            docs/code-review/external-audit-verification-20260619.md
//
// FORMAL-VERIFICATION SUITE — one named test per invariant ID (issue #964, AC2)
// ────────────────────────────────────────────────────────────────────────────
// This file is the per-ID dispatch layer of the FV harness. Each invariant in
// the spec gets a discretely-named test here so CI shows a row per invariant and
// every downstream remediation issue (#965–#971) has a concrete test name to
// un-skip and flip green.
//
//   - HOLDS invariants: an aggregate test asserts (via the registry) that the ID
//     is not RED, and — where a dedicated behavioural/static test already exists
//     — points at it in NatSpec. The deep behavioural proofs live in the named
//     suites (CustodyInvariant.t.sol, CustodyInvariantGuard.t.sol,
//     AccessRoles.t.sol, DeployTimelock.t.sol, AdapterDelegatecallGuard.t.sol,
//     PortfolioRouter.t.sol, GatewayRouter.t.sol, …) and in the new FV harnesses
//     (CustodyMultiVault, StaleOracleRedemption, TwapManipulation,
//     DeployAssertions).
//
//   - RED invariants: a named `test_<ID>_expectedFail_*` function that calls
//     `vm.skip(true, "<reason> - remediation #<issue>")` and then contains the
//     assertion that SHOULD fail on current HEAD. While skipped the test is green
//     (the suite stays green per Test-plan 1); when its remediation lands and the
//     downstream issue removes the `vm.skip`, the body runs and pins the fix
//     (Test-plan 3). The skip reason always carries the remediation issue number
//     (AC2).
//
// SCOUT NOTE (issue #964 is a dev-scout): the RED bodies below are deliberate
// STUBS — a single `fail(...)` standing in for the real expected-fail assertion.
// Each downstream remediation issue replaces the stub with the concrete behaviour
// check it restores (and the dedicated harnesses already carry richer skipped
// bodies for SUP-5 / ORA-7 / ACL-1 / ORA-3 / ORA-6). The contract here is the
// NAME and the SKIP REASON, which are stable and referenced by the issues.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {InvariantRegistry} from "./InvariantRegistry.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {RouterGovernance} from "../../RouterGovernance.sol";

/// @dev Minimal USDC for the router-deposit FV harness.
contract FvUSDC is ERC20 {
    constructor() ERC20("FV USDC", "fvUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal USDC-backed ERC-4626-shaped vault for the router-deposit FV
///      harness, with the registry-driven `retire()`/`unretire()` deposit-halt
///      legs so `VaultRegistry.setVaultStatus` can keep the vault flag in sync
///      (LIFE-1). 1:1 share accounting. `retire()`/`unretire()` are restricted to
///      the linked registry, mirroring `RobotMoneyVault`'s narrow authority.
contract FvRetirableVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;
    address public immutable registry;
    bool public retired;

    error OnlyRegistry();
    error VaultRetired();

    constructor(address asset_, address registry_) ERC20("FV Vault Shares", "FVVS") {
        assetToken = IERC20(asset_);
        registry = registry_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets; // 1:1
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (retired) revert VaultRetired();
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    /// @notice ERC-4626-shaped redeem (1:1). Burns `shares` from `owner` (the
    ///         caller must be `owner` or hold an ERC-20 allowance) and sends the
    ///         underlying to `receiver`. Redemption is permitted in any lifecycle
    ///         state — the deposit-halt flag never freezes withdrawals — so the
    ///         router's status gate (#967) is the only thing that can block a leg.
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        assets = shares; // 1:1
        assetToken.safeTransfer(receiver, assets);
    }

    /// @notice Deposit-halt leg driven by the registry (LIFE-1). Idempotent.
    function retire() external {
        if (msg.sender != registry) revert OnlyRegistry();
        retired = true;
    }

    /// @notice Re-open deposits, driven by the registry. Idempotent.
    function unretire() external {
        if (msg.sender != registry) revert OnlyRegistry();
        retired = false;
    }
}

contract FvInvariantsTest is Test {
    /// @dev Helper: skip with a uniform "<reason> - remediation #<issue>" message,
    ///      pulling the issue number straight from the registry so the name, the
    ///      skip reason, and the coverage map can never drift.
    function _skipRed(string memory id, string memory reason) internal {
        InvariantRegistry.Entry memory e = InvariantRegistry.get(id);
        require(e.status == InvariantRegistry.Status.RED, "not a RED invariant");
        vm.skip(true, string.concat(reason, " - remediation #", vm.toString(e.remediationIssue)));
    }

    /// @dev Assert an invariant the spec marked 🔴 has been remediated: the
    ///      registry now records it HOLDS with no outstanding remediation issue.
    ///      Used by the per-ID tests whose remediation has landed so the named
    ///      test runs (no longer skipped) and pins the flip green.
    function _assertHolds(string memory id) internal pure {
        InvariantRegistry.Entry memory e = InvariantRegistry.get(id);
        require(
            e.status == InvariantRegistry.Status.HOLDS,
            string.concat("invariant ", id, " is not yet HOLDS")
        );
        require(
            e.remediationIssue == 0, string.concat("HOLDS invariant ", id, " still names an issue")
        );
    }

    // ─────────────────────────── HOLDS aggregate ─────────────────────────────

    /// @notice AC2: every invariant the spec marks holding/proven has a passing
    ///         FV test. The deep proofs live in the dedicated suites; this
    ///         aggregate asserts each HOLDS ID is registered non-RED, so the set
    ///         of "green" invariants is exactly the spec's non-🔴 set. (RED IDs
    ///         are covered by their named expected-fail tests below.)
    function test_holdingInvariants_areAllNonRed() public pure {
        InvariantRegistry.Entry[] memory reg = InvariantRegistry.entries();
        uint256 holds;
        for (uint256 i = 0; i < reg.length; i++) {
            if (reg[i].status == InvariantRegistry.Status.HOLDS) {
                require(reg[i].remediationIssue == 0, "HOLDS entry wrongly carries an issue");
                holds++;
            }
        }
        require(holds > 0, "no holding invariants registered");
    }

    // ───────────────────────── RED: expected-fail stubs ──────────────────────
    // Grouped by remediation issue so each downstream issue can grep its set.

    // ── #965 (F-01): complete the Timelock role handover ──────────────────────

    /// @notice ACL-1 — no EOA holds any privileged role after handover.
    ///         REMEDIATED by #965 (F-01): the DeployTimelock handover now also
    ///         hands the Gateway DEFAULT_ADMIN_ROLE to the Timelock and moves
    ///         every vault EMERGENCY_ROLE to an independent hot key, so the
    ///         deployer EOA retains nothing. Registry flipped RED→HOLDS; the deep
    ///         proofs live in DeployAssertions.t.sol::test_ACL1_* and
    ///         DeployTimelock.t.sol::test_ACL1_*.
    function test_ACL1_eoaHoldsNoRoleAfterHandover() public pure {
        InvariantRegistry.Entry memory e = InvariantRegistry.get("ACL-1");
        require(e.status == InvariantRegistry.Status.HOLDS, "ACL-1 must be remediated (HOLDS)");
        require(e.remediationIssue == 0, "ACL-1 HOLDS must carry no remediation issue");
    }

    // ── #966 (NC-1, NC-2, F-06, F-08, F-09): high-sev vault & oracle hardening ─

    /// @notice SUP-5 (FLIPPED GREEN by #966) — redeem never reverts on a stale feed
    ///         when the underlying is idle USDC. Fix: `RwaVault.totalAssets`
    ///         short-circuits `_checkOracleFreshness` when no priced RWA is held.
    ///         Behavioural proof: RwaVault.t.sol::test_staleFeed_idleUsdcRedeemSurvives;
    ///         deep harness: StaleOracleRedemption.t.sol::test_SUP5_*.
    function test_SUP5_expectedFail_idleUsdcRedeemSurvivesStaleFeed() public pure {
        _assertHolds("SUP-5");
    }

    /// @notice ADP-2 (FLIPPED GREEN by #966) — only a codehash-allowlisted adapter
    ///         may be onboarded. Fix: `BasketVault.addAsset` reverts
    ///         `AdapterCodeHashNotAllowed` for any non-zero adapter whose codehash
    ///         ADMIN_ROLE has not approved (NC-2). Behavioural proof:
    ///         BasketVault.t.sol venue-selector addAsset tests (codehash-gated).
    function test_ADP2_expectedFail_onlyEligibleAdapterPricesNav() public pure {
        _assertHolds("ADP-2");
    }

    /// @notice ACL-3 (FLIPPED GREEN by #966) — ADMIN_ROLE on a fund-holding contract
    ///         never reaches zero. Fix: BasketVault (→ RwaVault) and the Gateway (via
    ///         AccessRoles) now inherit `AdminFloorAccessControl`; the gateway also
    ///         floors `DEFAULT_ADMIN_ROLE` (F-06).
    function test_ACL3_expectedFail_vaultsAndGatewayHaveAdminFloor() public pure {
        _assertHolds("ACL-3");
    }

    /// @notice ACL-5 (FLIPPED GREEN by #966) — the stale-override setter sits at a
    ///         higher tier than the unwind executor. Fix:
    ///         `RwaVault.setEmergencyUnwindStaleOverride` is ADMIN_ROLE while
    ///         `emergencyUnwind` stays EMERGENCY_ROLE (F-08). Behavioural proof:
    ///         RwaVault.t.sol::test_emergencyUnwindStaleOverride_requiresAdminNotEmergency.
    function test_ACL5_expectedFail_emergencyOverrideIsHigherTier() public pure {
        _assertHolds("ACL-5");
    }

    /// @notice ORA-3 (FLIPPED GREEN by #966) — the TWAP pricing pool equals the
    ///         execution pool; addAsset reverts on mismatch. Fix:
    ///         `BasketVault.addAsset` asserts the registered pool's fee/tickSpacing
    ///         equals `swapFee_` (F-09). Deep harness:
    ///         DeployAssertions.t.sol::test_ORA3_addAssetRevertsOnPoolMismatch.
    function test_ORA3_expectedFail_twapPoolEqualsExecutionPool() public pure {
        _assertHolds("ORA-3");
    }

    /// @notice ORA-7 (FLIPPED GREEN by #966) — realized loss under TWAP manipulation
    ///         is bounded by an independent backstop (the configured
    ///         `maxSlippageBps`/pool-fee floor and the codehash-pinned, pool-equality-
    ///         enforced adapter), not the co-manipulable NAV TWAP alone. Deep
    ///         harness: TwapManipulation.t.sol::test_ORA7_independentFloorBoundsLossUnderManipulation.
    function test_ORA7_expectedFail_slippageFloorIsIndependentBackstop() public pure {
        _assertHolds("ORA-7");
    }

    /// @notice LIFE-3 (FLIPPED GREEN by #966) — vault pause disables deposits only,
    ///         never withdrawals (basket family). Fix: `BasketVault._withdraw` is no
    ///         longer `whenNotPaused`; pause is a deposits-only freeze (NC-3).
    ///         Behavioural proof: BasketVault.t.sol pause tests (withdrawals stay open).
    function test_LIFE3_expectedFail_pauseNeverFreezesWithdrawals() public pure {
        _assertHolds("LIFE-3");
    }

    /// @notice LIFE-4 (FLIPPED GREEN by #966) — depositor funds are never permanently
    ///         frozen. Fix: withdrawals are never paused (LIFE-3) and the last-admin
    ///         floor (AdminFloorAccessControl) keeps a still-available authority, so
    ///         no reachable state freezes withdrawals forever (F-06 + NC-3).
    function test_LIFE4_expectedFail_withdrawalBlockIsAlwaysReversible() public pure {
        _assertHolds("LIFE-4");
    }

    // ── #967 (F-02, F-03, NC-5): router exit semantics ────────────────────────

    /// @notice LIFE-5 (FLIPPED GREEN by #967, F-02/F-03) — a reweight/removal
    ///         never makes an existing holder's position unredeemable through the
    ///         router. Proof: deposit into vaultA, then reweight the router 100%
    ///         onto vaultB and Retire vaultA. The holder still redeems the vaultA
    ///         position through `redeemFor` by naming it explicitly — the redeem
    ///         path no longer iterates the live weight vector, and a Retired leg
    ///         (only Paused is blocked) is still redeemable.
    function test_LIFE5_expectedFail_reweightKeepsPositionRedeemable() public {
        _assertHolds("LIFE-5");

        (VaultRegistry registry, PortfolioRouter router, FvUSDC usdc, FvRetirableVault vaultA) =
            _deployRouterStack();
        FvRetirableVault vaultB = _addEligibleVault(registry, router, usdc);

        // Holder deposits 100% into vaultA via the router.
        _setSingleWeight(router, address(vaultA));
        uint256 amount = 1_000e6;
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
        uint256[] memory minted = router.deposit(amount, new uint256[](0));
        uint256 sharesA = minted[0];
        assertEq(sharesA, amount, "deposited 1:1 into vaultA");

        // Router reweights 100% onto vaultB and RETIRES vaultA — the holder's
        // vaultA position is now entirely outside the live weight vector.
        _setSingleWeight(router, address(vaultB));
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Retired);
        (, VaultRegistry.VaultStatus sA) = registry.getVault(address(vaultA));
        assertEq(uint256(sA), uint256(VaultRegistry.VaultStatus.Retired), "vaultA Retired");

        // The holder can STILL exit vaultA via the router by naming it explicitly.
        vaultA.approve(address(router), sharesA);
        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory shares = new uint256[](1);
        shares[0] = sharesA;
        uint256[] memory assetsOut = router.redeemFor(
            address(this), address(this), vaults, shares, new uint256[](1), type(uint256).max
        );
        assertEq(assetsOut[0], amount, "LIFE-5: reweighted-out, Retired position still redeemable");
        assertEq(vaultA.balanceOf(address(this)), 0, "vaultA shares fully burned");
    }

    /// @notice RTR-2 (FLIPPED GREEN by #967, F-03) — a multi-leg redemption
    ///         targets the holder's actual positions, not the current weight
    ///         vector. Proof: a holder with positions in vaultA AND vaultB
    ///         redeems both by naming them explicitly, even after the router has
    ///         been reweighted onto a third vault that the holder never held.
    function test_RTR2_expectedFail_redeemTargetsActualPositions() public {
        _assertHolds("RTR-2");

        (VaultRegistry registry, PortfolioRouter router, FvUSDC usdc, FvRetirableVault vaultA) =
            _deployRouterStack();
        FvRetirableVault vaultB = _addEligibleVault(registry, router, usdc);
        FvRetirableVault vaultC = _addEligibleVault(registry, router, usdc);

        // Holder deposits 50/50 into vaultA and vaultB.
        address[] memory dv = new address[](2);
        uint256[] memory dbps = new uint256[](2);
        dv[0] = address(vaultA);
        dv[1] = address(vaultB);
        dbps[0] = 5_000;
        dbps[1] = 5_000;
        router.setWeights(dv, dbps);

        uint256 amount = 1_000e6;
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
        uint256[] memory minted = router.deposit(amount, new uint256[](0));

        // Reweight the router 100% onto vaultC — a vault the holder never held.
        _setSingleWeight(router, address(vaultC));

        // Redeem targets the holder's ACTUAL positions (vaultA, vaultB), not the
        // current weight vector (vaultC).
        vaultA.approve(address(router), minted[0]);
        vaultB.approve(address(router), minted[1]);
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory shares = new uint256[](2);
        shares[0] = minted[0];
        shares[1] = minted[1];
        uint256[] memory assetsOut = router.redeemFor(
            address(this), address(this), vaults, shares, new uint256[](2), type(uint256).max
        );
        assertEq(assetsOut[0] + assetsOut[1], amount, "RTR-2: full holdings redeemed");
        assertEq(vaultA.balanceOf(address(this)), 0, "vaultA emptied");
        assertEq(vaultB.balanceOf(address(this)), 0, "vaultB emptied");
        assertEq(vaultC.balanceOf(address(this)), 0, "holder never held vaultC");
    }

    /// @notice RTR-3 (FLIPPED GREEN by #967, NC-5) — `sharesPerLeg[i]` is
    ///         identity-bound to the vault the caller named (`vaults[i]`), never
    ///         to whichever vault occupies index i after a reweight. Proof: the
    ///         holder names vaultA; even after the weight vector is reordered so
    ///         index 0 points at vaultB, the redeem hits exactly vaultA — vaultB
    ///         is untouched.
    function test_RTR3_expectedFail_legsAreIdentityBound() public {
        _assertHolds("RTR-3");

        (VaultRegistry registry, PortfolioRouter router, FvUSDC usdc, FvRetirableVault vaultA) =
            _deployRouterStack();
        FvRetirableVault vaultB = _addEligibleVault(registry, router, usdc);

        // Holder deposits 100% into vaultA.
        _setSingleWeight(router, address(vaultA));
        uint256 amount = 500e6;
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
        uint256[] memory minted = router.deposit(amount, new uint256[](0));
        uint256 sharesA = minted[0];

        // Sign over a redeem of `sharesA` from vaultA, then the weight vector is
        // reordered so index 0 now points at vaultB (a positional-binding redeem
        // would hit vaultB here — the NC-5 bug).
        address[] memory rev = new address[](2);
        uint256[] memory revbps = new uint256[](2);
        rev[0] = address(vaultB);
        rev[1] = address(vaultA);
        revbps[0] = 5_000;
        revbps[1] = 5_000;
        router.setWeights(rev, revbps);

        // Execute the caller's intent: redeem vaultA by name. Identity binding
        // means the leg hits vaultA, NOT index-0 vaultB.
        vaultA.approve(address(router), sharesA);
        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory shares = new uint256[](1);
        shares[0] = sharesA;
        uint256[] memory assetsOut = router.redeemFor(
            address(this), address(this), vaults, shares, new uint256[](1), type(uint256).max
        );
        assertEq(assetsOut[0], amount, "RTR-3: redeem hit the named vaultA");
        assertEq(vaultA.balanceOf(address(this)), 0, "vaultA position closed");
        // The vault the caller did NOT name is completely untouched.
        assertEq(vaultB.balanceOf(address(this)), 0, "RTR-3: vaultB never held and never touched");
        assertEq(vaultB.totalSupply(), 0, "RTR-3: vaultB minted nothing - leg never redirected");
    }

    // ── #968 (F-04, F-05, F-13, NC-4): router deposit integrity ───────────────
    //
    // These four invariants were flipped RED → HOLDS when the router
    // deposit-integrity remediation (#968) landed. The bodies below are the real
    // proofs that replaced the scout's expected-fail stubs:
    //   - F-05/RTR-4/GOV-4: setWeights/setDefaultWeights/propose now require
    //     VaultStatus == Active per weighted vault.
    //   - F-13/NC-4/RTR-5: deposit skip-and-renormalises exactly the legs
    //     previewDeposit reports unavailable (or both report the basket
    //     unavailable), so preview and execute never disagree.
    //   - F-04/LIFE-1: setVaultStatus drives the vault's deposit-halt flag so
    //     registry status and the vault flag can never drift.

    /// @notice LIFE-1 (F-04) — a retired/paused vault never accepts new deposits
    ///         on any path, with registry status and the vault flag always in
    ///         sync. Proves the `setVaultStatus` back-door is closed: it now drives
    ///         the vault's `retired` deposit-halt flag, and the atomic
    ///         `retire()`/`reactivate()` paths still sync both.
    function test_LIFE1_retireSyncsRegistryAndVaultFlag() public {
        (VaultRegistry registry,, FvUSDC usdc, FvRetirableVault vault) = _deployRouterStack();

        // Direct deposit works while Active and the flag is clear.
        assertFalse(vault.retired(), "vault starts un-retired");

        // Back-door #1: setVaultStatus(_, Retired) must flip the vault flag too.
        vm.prank(address(this));
        registry.setVaultStatus(address(vault), VaultRegistry.VaultStatus.Retired);
        (, VaultRegistry.VaultStatus s) = registry.getVault(address(vault));
        assertEq(uint256(s), uint256(VaultRegistry.VaultStatus.Retired), "registry Retired");
        assertTrue(vault.retired(), "LIFE-1: setVaultStatus(Retired) must halt vault deposits");

        // Direct deposit into the retired vault now reverts (no new money in).
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(FvRetirableVault.VaultRetired.selector);
        vault.deposit(1e6, address(this));

        // Active again: both registry status and the vault flag clear together.
        registry.setVaultStatus(address(vault), VaultRegistry.VaultStatus.Active);
        (, s) = registry.getVault(address(vault));
        assertEq(uint256(s), uint256(VaultRegistry.VaultStatus.Active), "registry Active");
        assertFalse(vault.retired(), "LIFE-1: setVaultStatus(Active) must re-open deposits");

        // Back-door #2: setVaultStatus(_, Paused) also halts the vault.
        registry.setVaultStatus(address(vault), VaultRegistry.VaultStatus.Paused);
        assertTrue(vault.retired(), "LIFE-1: setVaultStatus(Paused) must halt vault deposits");

        // The atomic governance path stays in sync as well.
        registry.reactivate(address(vault));
        assertFalse(vault.retired(), "LIFE-1: reactivate must re-open deposits");
        registry.retire(address(vault));
        assertTrue(vault.retired(), "LIFE-1: retire must halt deposits");
        (, s) = registry.getVault(address(vault));
        assertEq(
            uint256(s), uint256(VaultRegistry.VaultStatus.Retired), "registry Retired (atomic)"
        );
    }

    /// @notice RTR-4 (F-05) — a weight vector is never executable unless every
    ///         weighted vault is router-eligible AND Active. setWeights and
    ///         setDefaultWeights revert when any weighted vault is Paused/Retired.
    function test_RTR4_weightsRequireActiveStatus() public {
        (VaultRegistry registry, PortfolioRouter router,, FvRetirableVault vault) =
            _deployRouterStack();

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vault);
        bps[0] = 10_000;

        // Eligible AND Active: setWeights succeeds.
        router.setWeights(vaults, bps);

        // Pause via the registry: the vault is still eligible but not Active.
        registry.setVaultStatus(address(vault), VaultRegistry.VaultStatus.Paused);
        assertTrue(router.isRouterEligible(address(vault)), "still eligible");

        // setWeights must now revert VaultNotActive — a non-depositable vector can
        // never be written (RTR-4). Eligibility alone is not enough.
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(vault),
                VaultRegistry.VaultStatus.Paused
            )
        );
        router.setWeights(vaults, bps);

        // setDefaultWeights enforces the same invariant.
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(vault),
                VaultRegistry.VaultStatus.Paused
            )
        );
        router.setDefaultWeights(vaults, bps);
    }

    /// @notice RTR-5 (F-13/NC-4) — previewDeposit and the executed deposit never
    ///         disagree on which legs are available. A single non-Active leg is
    ///         skipped (not reverted), exactly as preview reports; the surviving
    ///         leg absorbs the renormalised amount — one paused vault never bricks
    ///         the whole router deposit (NC-4).
    function test_RTR5_previewMatchesExecute() public {
        (VaultRegistry registry, PortfolioRouter router, FvUSDC usdc, FvRetirableVault vaultA) =
            _deployRouterStack();
        FvRetirableVault vaultB = _addEligibleVault(registry, router, usdc);

        // Two-leg 50/50 vector.
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 5_000;
        bps[1] = 5_000;
        router.setWeights(vaults, bps);

        // Pause vaultA AFTER weighting (allowed; the vector was valid when written).
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);

        uint256 amount = 1_000e6;

        // Preview: vaultA unavailable, vaultB available and absorbing the amount.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "RTR-5: paused leg previews unavailable");
        assertFalse(legs[1].unavailable, "RTR-5: active leg previews available");
        assertEq(legs[0].legAmount, 0, "skipped leg amount 0");
        assertEq(legs[1].legAmount, amount, "active leg absorbs renormalised amount");

        // Execute: agrees with preview — vaultA skipped, vaultB funded fully.
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));
        assertEq(shares[0], 0, "RTR-5: preview-unavailable leg deposits nothing");
        assertEq(shares[1], amount, "RTR-5: preview-available leg deposits exactly the amount");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no dust");

        // Whole-basket-unavailable case: both paused ⇒ preview all-unavailable AND
        // execute reverts (consistent), never a preview-healthy / execute-revert
        // divergence.
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.Paused);
        legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable && legs[1].unavailable, "RTR-5: all legs unavailable");
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
        vm.expectRevert(PortfolioRouter.NoWeightsSet.selector);
        router.deposit(amount, new uint256[](0));
    }

    /// @notice GOV-4 (F-05/RTR-4) — a governance proposal that would render router
    ///         deposits non-executable can never be executed. propose() rejects a
    ///         weight vector containing a Paused/Retired vault up front, so a
    ///         self-DoS proposal never enters the voting pipeline.
    function test_GOV4_proposalCannotSelfDosRouter() public {
        (VaultRegistry registry, PortfolioRouter router, FvUSDC usdc, FvRetirableVault vault) =
            _deployRouterStack();

        // Stand up governance and hand it ADMIN_ROLE on the router so propose →
        // execute → setWeights is the only weight-setting path.
        RouterGovernance gov =
            new RouterGovernance(address(router), address(this), 1 hours, 1 hours, 1);
        router.grantRole(router.ADMIN_ROLE(), address(gov));

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vault);
        bps[0] = 10_000;

        // While Active, propose succeeds.
        uint256 pid = gov.propose(vaults, bps);
        assertGt(pid, 0, "proposal created while Active");
        gov.cancel(pid);

        // Pause the vault: a proposal that would route deposits to it must be
        // rejected at propose() time (GOV-4) — it can never become executable.
        registry.setVaultStatus(address(vault), VaultRegistry.VaultStatus.Paused);
        assertTrue(router.isRouterEligible(address(vault)), "still eligible");
        assertFalse(
            router.isRouterEligibleAndActive(address(vault)),
            "eligible but not Active means not routable"
        );
        vm.expectRevert(
            abi.encodeWithSelector(RouterGovernance.VaultNotEligible.selector, address(vault))
        );
        gov.propose(vaults, bps);

        // Silence unused-var warnings.
        usdc;
    }

    // ── #968 FV harness helpers ───────────────────────────────────────────────

    /// @dev Deploy a registry + router + one eligible, Active, registry-linked
    ///      vault. This test contract is the ADMIN_ROLE on both registry and
    ///      router and the registry is the vault's link, so `setVaultStatus` can
    ///      drive the vault's retire/unretire legs.
    function _deployRouterStack()
        internal
        returns (
            VaultRegistry registry,
            PortfolioRouter router,
            FvUSDC usdc,
            FvRetirableVault vault
        )
    {
        usdc = new FvUSDC();
        registry = new VaultRegistry(address(this));
        router = new PortfolioRouter(address(usdc), address(registry), address(this));
        vault = _addEligibleVault(registry, router, usdc);
    }

    /// @dev Register a fresh registry-linked vault, mark it Active + eligible.
    function _addEligibleVault(VaultRegistry registry, PortfolioRouter, FvUSDC usdc)
        internal
        returns (FvRetirableVault vault)
    {
        vault = new FvRetirableVault(address(usdc), address(registry));
        registry.registerVault(
            address(vault),
            VaultRegistry.VaultMetadata({name: "FV Vault", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vault), true);
    }

    /// @dev Set the router's voted weight vector to a single vault at 100%.
    function _setSingleWeight(PortfolioRouter router, address vault) internal {
        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = vault;
        bps[0] = 10_000;
        router.setWeights(vaults, bps);
    }

    // ── #969 (F-10, F-11, F-16, NC-6): oracle/pricing integrity ───────────────

    /// @notice SUP-3 (FLIPPED GREEN by #969) — a deposit-then-immediate-redeem
    ///         round trip never returns more than was put in:
    ///         `previewRedeem(previewDeposit(x)) <= x` for every basket vault
    ///         across fuzzed slippage params. Fix (F-16 / NC-6):
    ///         `BasketVault.deposit`/`mint` now mint shares on the REALIZED
    ///         post-swap NAV delta (capped at the slippage-discounted deposit
    ///         floor), not a pre-swap TWAP mark, so the mint-vs-haircut asymmetry
    ///         that let a round trip farm value back out is closed. The NAV-vs-
    ///         market deviation guard (ORA-4) keeps execution inside the band the
    ///         proof assumes. Deep proofs:
    ///         BasketVault.t.sol::test_SUP3_roundTripNeverProfits_fuzz (pure-view
    ///         floor across fuzzed slippage) and
    ///         BasketVault.t.sol::test_SUP3_statefulDepositRedeemNeverProfits
    ///         (real deposit → redeem within the deviation band).
    function test_SUP3_roundTripNeverProfits() public pure {
        _assertHolds("SUP-3");
    }

    /// @notice GW-5 (FLIPPED GREEN by #969) — every agent redemption through the
    ///         gateway carries a real, caller-meaningful per-leg slippage floor.
    ///         Fix (F-11): `RobotMoneyGateway.withdrawFromRouter` takes a
    ///         `minAssetsPerLeg` vector and forwards it verbatim to
    ///         `PortfolioRouter.redeemFor` (no more `new uint256[](n)` zero
    ///         literal) AND forwards the real agent deadline (no more
    ///         `type(uint256).max`); the floor vector is folded into `paymentId`
    ///         so a replay cannot weaken it. Deep proofs:
    ///         GatewayRouter.t.sol::test_withdrawFromRouter_realFloor_revertsBelowMinimum,
    ///         ::test_withdrawFromRouter_floorIsBoundIntoPaymentId.
    function test_GW5_agentRedeemCarriesRealFloor() public pure {
        _assertHolds("GW-5");
    }

    /// @notice ORA-4 (FLIPPED GREEN by #969) — deposits/redemptions never settle
    ///         when the oracle NAV (Chronicle / TWAP) deviates from the
    ///         executable market price (Aerodrome spot) beyond a timelock-
    ///         configured threshold. Fix (F-10): `BasketVault` carries a
    ///         `navDeviationGuardBps` threshold and reverts
    ///         `NavMarketDeviationExceeded` on the deposit/redeem hot path when
    ///         |spot − TWAP| / TWAP exceeds it. Deep proof:
    ///         BasketVault.t.sol::test_ORA4_deviationGuardBlocksSettlement.
    function test_ORA4_deviationGuardBlocksSettlement() public pure {
        _assertHolds("ORA-4");
    }

    // ── #970 (NC-3, NC-7, NC-8, NC-9, NC-10): control-plane hardening ─────────

    /// @notice LIFE-6 — reabsorbRemovedAsset never reverts-and-strands a
    ///         reappeared balance (survives a degraded pool).
    function test_LIFE6_expectedFail_reabsorbSurvivesDegradedPool() public {
        _skipRed(
            "LIFE-6",
            "reabsorb reuses assetInfo.pool TWAP; observe() can revert and brick reabsorption (NC-8)"
        );
        fail();
    }

    /// @notice GW-2 — a single paymentId/idempotency key never authorizes two
    ///         materially different execution intents.
    function test_GW2_expectedFail_idempotencyKeyBindsFullIntent() public {
        _skipRed(
            "GW-2", "paymentId omits destination/minSharesPerLeg and the per-leg vector (NC-9/F-15)"
        );
        fail();
    }

    /// @notice ACL-7 — registering an agent never blocks a future intended
    ///         ADMIN/PAUSER address from being granted its role.
    function test_ACL7_expectedFail_agentRegistrationCannotBlockRoleGrant() public {
        _skipRed(
            "ACL-7",
            "permissionless commitAuthorization + ACL-2 separation pre-binds a multisig as AGENT (NC-10)"
        );
        fail();
    }

    // ── #971 (F-07, F-12, F-14, F-15, NC-11, NC-12): low-severity cleanup ─────

    /// @notice RTR-6 — a configured cap bounds cumulative exposure, not just a
    ///         single transaction.
    function test_RTR6_expectedFail_capBoundsCumulativeExposure() public {
        _skipRed("RTR-6", "routerCap/vaultCap are per-tx only; splittable across txs (F-12)");
        fail();
    }

    /// @notice FEE-2 — a fee is always charged on realized proceeds, never on a
    ///         share-implied gross that socializes loss to remaining holders.
    function test_FEE2_expectedFail_feeChargedOnRealizedProceeds() public {
        _skipRed("FEE-2", "RobotMoneyVault._withdraw computes fee on share-implied gross (NC-11)");
        fail();
    }
}
