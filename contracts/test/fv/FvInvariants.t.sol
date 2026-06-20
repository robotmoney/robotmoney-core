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
import {InvariantRegistry} from "./InvariantRegistry.sol";

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

    /// @notice LIFE-5 — a reweight/removal never makes an existing holder's
    ///         position unredeemable through the protocol (router path).
    function test_LIFE5_expectedFail_reweightKeepsPositionRedeemable() public {
        _skipRed("LIFE-5", "redeemFor iterates the live weight vector, not balances (F-03)");
        fail();
    }

    /// @notice RTR-2 — a multi-leg redemption targets the holder's actual
    ///         positions, not the current weight vector.
    function test_RTR2_expectedFail_redeemTargetsActualPositions() public {
        _skipRed("RTR-2", "router redeem iterates weight vector, not holdings (F-03)");
        fail();
    }

    /// @notice RTR-3 — sharesPerLeg[i] is identity-bound to the intended vault,
    ///         never to whichever vault occupies index i after a reweight.
    function test_RTR3_expectedFail_legsAreIdentityBound() public {
        _skipRed("RTR-3", "redeemFor binds legs positionally to _effectiveWeightsMemory (NC-5)");
        fail();
    }

    // ── #968 (F-04, F-05, F-13, NC-4): router deposit integrity ───────────────

    /// @notice LIFE-1 — a retired vault never accepts new deposits on any path,
    ///         with registry status and vault flag always in sync.
    function test_LIFE1_expectedFail_retireSyncsRegistryAndVaultFlag() public {
        _skipRed(
            "LIFE-1",
            "setVaultStatus(_, Retired/Paused) is a back-door that sets only registry status (F-04)"
        );
        fail();
    }

    /// @notice RTR-4 — a weight vector is never executable unless every weighted
    ///         vault is router-eligible AND Active and bps sum to MAX_BPS.
    function test_RTR4_expectedFail_weightsRequireActiveStatus() public {
        _skipRed("RTR-4", "setWeights/propose check eligibility but not VaultStatus==Active (F-05)");
        fail();
    }

    /// @notice RTR-5 — previewDeposit and the executed deposit never disagree on
    ///         which legs are available.
    function test_RTR5_expectedFail_previewMatchesExecute() public {
        _skipRed(
            "RTR-5", "preview marks legs unavailable; _executeLegs reverts the whole tx (F-13/NC-4)"
        );
        fail();
    }

    /// @notice GOV-4 — a governance action that would render router deposits
    ///         non-executable can never be executed.
    function test_GOV4_expectedFail_proposalCannotSelfDosRouter() public {
        _skipRed("GOV-4", "propose/execute don't validate VaultStatus==Active (F-05/RTR-4)");
        fail();
    }

    // ── #969 (F-10, F-11, F-16, NC-6): oracle/pricing integrity ───────────────

    /// @notice SUP-3 — a deposit-then-redeem round trip never returns more than
    ///         was put in: previewRedeem(previewDeposit(x)) <= x.
    function test_SUP3_expectedFail_roundTripNeverProfits() public {
        _skipRed(
            "SUP-3",
            "BasketVault marks mint at TWAP, settles at spot; haircut asymmetry (NC-6/F-16)"
        );
        fail();
    }

    /// @notice GW-5 — every agent redemption carries a real, caller-meaningful
    ///         per-leg slippage floor.
    function test_GW5_expectedFail_agentRedeemCarriesRealFloor() public {
        _skipRed("GW-5", "gateway hardcodes new uint256[](n) zero floor + max deadline (F-11)");
        fail();
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
