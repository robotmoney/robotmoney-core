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

    /// @notice SUP-5 — redeem never reverts on stale feed when underlying is idle
    ///         USDC. Deep harness: StaleOracleRedemption.t.sol::test_SUP5_*.
    function test_SUP5_expectedFail_idleUsdcRedeemSurvivesStaleFeed() public {
        _skipRed(
            "SUP-5", "RwaVault redeem reverts on stale feed even after unwind to idle USDC (NC-1)"
        );
        fail();
    }

    /// @notice ADP-2 — only an eligible (allowlisted + codehash-pinned) adapter
    ///         contributes to NAV / receives funds (BasketVault.addAsset vets it).
    function test_ADP2_expectedFail_onlyEligibleAdapterPricesNav() public {
        _skipRed(
            "ADP-2",
            "BasketVault.addAsset accepts unvetted adapter; revoked-but-active adapter still priced (NC-2/F-14)"
        );
        fail();
    }

    /// @notice ACL-3 — ADMIN_ROLE on a fund-holding contract never reaches zero.
    function test_ACL3_expectedFail_vaultsAndGatewayHaveAdminFloor() public {
        _skipRed(
            "ACL-3",
            "vaults + gateway use plain AccessControl; last-admin revoke bricks governance (F-06)"
        );
        fail();
    }

    /// @notice ACL-5 — an emergency action can only de-risk; the stale-override
    ///         setter sits at a higher tier than the unwind it enables.
    function test_ACL5_expectedFail_emergencyOverrideIsHigherTier() public {
        _skipRed(
            "ACL-5", "one EMERGENCY_ROLE key sets stale-override and runs emergencyUnwind (F-08)"
        );
        fail();
    }

    /// @notice ORA-3 — the TWAP pricing pool equals the execution pool;
    ///         addAsset reverts on mismatch. Deep harness:
    ///         DeployAssertions.t.sol::test_ORA3_*.
    function test_ORA3_expectedFail_twapPoolEqualsExecutionPool() public {
        _skipRed(
            "ORA-3",
            "BasketVault.addAsset stores pool and swapFee independently, never asserts equality (F-09)"
        );
        fail();
    }

    /// @notice ORA-7 — the slippage floor is an independent backstop, not the same
    ///         TWAP that prices the trade. Deep harness:
    ///         TwapManipulation.t.sol::test_ORA7_*.
    function test_ORA7_expectedFail_slippageFloorIsIndependentBackstop() public {
        _skipRed(
            "ORA-7",
            "BasketVault._slippageFloor derives from the NAV TWAP; co-manipulable (F-09/F-11/F-16)"
        );
        fail();
    }

    /// @notice LIFE-3 — vault shutdown/pause disables deposits only, never blocks
    ///         withdrawals (basket family).
    function test_LIFE3_expectedFail_pauseNeverFreezesWithdrawals() public {
        _skipRed(
            "LIFE-3",
            "BasketVault._withdraw is whenNotPaused; EMERGENCY pause freezes withdrawals (F-06/NC-3)"
        );
        fail();
    }

    /// @notice LIFE-4 — depositor funds are never permanently frozen; a blocking
    ///         state is always reversible by a still-available authority.
    function test_LIFE4_expectedFail_withdrawalBlockIsAlwaysReversible() public {
        _skipRed(
            "LIFE-4",
            "basket pause + no admin floor + no restoreVault can freeze withdrawals forever (F-06/F-07/NC-3)"
        );
        fail();
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
