# Smart-contract security review — 2026-10-12

## Scope and disposition

**Status:** Final draft for PR review, including adversarial re-checks and owner-confirmed imminent retirement of RouterGovernance voting. This document reports vulnerabilities and review limits; it does not certify the contracts as free of vulnerabilities.

**Baseline:** `2c81c742f97fc2faa033befc38a01a2c2af66cc3` from `origin/dev`, the repository's default branch. The production Solidity sources are unchanged from `7c742860fad65b09442bf64fdf2b0098ba0b135f`, where the initial review began. Review branch: `review/contracts-security-20261012`. Source line references below refer to this baseline; Solidity paths are relative to `contracts/` unless stated otherwise.

The inventory covers 28 production Solidity implementations: seven adapters, four gateway contracts, eight libraries, four vault implementations/base contracts, and five top-level contracts. Review areas included authorization, share accounting, withdrawals, adapter eligibility, swap/oracle boundaries, committee attribution, router weights, emergency actions and keeper actions. Deployment scripts, committee-feed consumers and prior audit records were inspected for context. Third-party protocols and deployment tooling were not independently audited.

No Base (8453) production manifest was available under `deployments/`; the repository contains Twin placeholders and a rehearsal example. Live bytecode, role holders, balances and configuration were not verified. References to the Safe, the 48-hour timelock and an unheld keeper role describe intended deployment wiring. The tests use local fixtures and mocks, including direct role impersonation; they do not reproduce the complete production Safe/timelock path.

Severity reflects both impact and prerequisites. Findings 1 and 2 require an administrative action before an ordinary holder or depositor can benefit. Finding 5 concerns the authority of an emergency key. Voting retirement is the accepted resolution of finding 4; it needs no separate quorum fix. Findings 3 and 6 have explicit deployment/use assumptions below.

**Post-baseline remediation:** core issue 1788 (merged as PR 1814, `d5c6a2e1`) changed `RobotMoneyVault` after this baseline. Deposits now close while any active adapter is ineligible, keeper `rebalance()` skips ineligible adapters, and it reverts while deposits are paused or the vault is shut down. This closes the window-deposit and keeper-recovery paths of finding 1 and the mechanism of finding 6. The affected review tests now assert the remediated behavior. Findings 1 and 6 below describe the baseline.

Core issue 1790 (PR 1818) changed `RobotMoneyGateway.committeeVoteSubmit` after this baseline: it now reverts `CommitteeAgentNotCaller` when `p.agent != msg.sender`, so a gateway agent can no longer file a signal under another member's address. The finding 3 reproductions were flipped to assert the refusal. The indexer's latest-per-member aggregation changed under the same issue. Finding 3 below describes the baseline.

Core issue 1789 changed `RobotMoneyVault.addAdapter` after this baseline: it reverts `AdapterAlreadyActive` when any active entry already holds the address. A re-add after `removeAdapter` or `forceRemoveAdapter` stays legal and appends a new entry. The finding 2 reproductions were flipped to assert the refusal and par payouts. Finding 2 below describes the baseline.

Core issue 1791 changed `RobotMoneyGateway` agent authorization after this baseline: a caller without `ADMIN_ROLE` binds an agent other than itself only with the agent's EIP-712 consent, so the reveal reverts `InvalidAgentConsent` without it. An address an `ADMIN_ROLE` caller bound without consent can free itself with `releaseAgent`. The finding 7 reproductions were flipped to assert the refusal. Finding 7 below describes the baseline.

Core issue 1820 changed `RobotMoneyVault` exclusion recovery after this baseline: excluding an active adapter opens a record in the vault's `ExclusionLedger` with a snapshot of every holder's shares. USDC recovered from that adapter (`emergencyWithdrawAdapter`, `emergencyWithdraw`, `adminRebalance`, or restored eligibility, which realises the residual first) goes to the record, never to idle NAV, and is claimable pro rata by the holders at the snapshot, exiters included. A redeem that would pay 0 USDC during the exclusion reverts `ZeroPayoutDuringExclusion`. The finding 1 exit and orphan reproductions were flipped to assert the claim. Finding 1 below describes the baseline.

Core issue 1698 (QA plan v1 task C1, `92c8c84e`) deleted the RouterGovernance propose, vote and execute path after this baseline, so the quorum in finding 4 no longer exists (`RouterGovernance.t.sol::test_noVotingSurface`). The same change makes `setWeights` and `_setDefaultWeights` revert `DuplicateVault`, which remediates finding 8. Finding 5 is still open under issue 1705; core 1820 narrows it, because a force removal of an adapter that was excluded first leaves the loss with the snapshot holders only. Findings 4, 5 and 8 below describe the baseline.

The audit ledger records the disposition of every finding as rows SR-1012-1 to SR-1012-9 in `docs/audits.md`, and re-dispositions AZ-BSK-3, AZ-GW-3, AZ-GOV-1, HR-L-9 and HR-L-11 against source (issue 1792, QA plan v1 task W2). `scripts/check-audit-ledger.sh` fails when a numbered finding heading below has no ledger row. This remediates finding 9.

## Review conclusions

| # | Finding | Severity / disposition | Required conditions | Evidence |
|---|---|---|---|---|
| 1 | Deposits remain open while funded adapter value is excluded from NAV | Medium | ADMIN excludes value before deposits pause; value subsequently returns to NAV | Reproduced at baseline; window-deposit and keeper paths remediated by 1788; exit and recovery attribution remediated by 1820 |
| 2 | Duplicate strategy adapter registration overpays early redeemers | Medium | ADMIN registers an already-active adapter again | Reproduced value extraction at baseline; remediated by 1789 |
| 3 | A gateway agent can attribute a committee signal to another member | Low under advisory-only use | An allowlisted committee member exists; attacker self-registers at the gateway | On-chain spoofing reproduced at baseline; gateway identity guard remediated by 1790; aggregation inspected in source |
| 4 | One voter meets quorum under example deployment values | Imminent retirement; no separate fix | Voting retained and used with quorum 2 and voter power 1000 | Reproduced on reviewed bytecode; removal accepted; voting removed by 1698 |
| 5 | Emergency force removal reprices exits before recoverable value is settled | Medium; authority decision tracked | EMERGENCY removes a funded adapter | Reproduced; open under 1705; narrowed by 1820 |
| 6 | Keeper rebalance can reverse an emergency withdrawal | Info if keeper role is unheld; Medium if granted | A keeper can call after the rebalance interval | Reproduced at baseline; remediated by 1788 |
| 7 | Permissionless authorization can squat another agent's policy ownership | Low | Target address is unowned and passes role-separation checks | Ownership denial reproduced at baseline; committee-blocking claim disproved; remediated by 1791 |
| 8 | Router weight vectors permit duplicate vault addresses | Low | Authorized weight setter or ADMIN submits duplicates | Source inspection; previously reported HR-L-9; remediated by 1698 |
| 9 | Audit dispositions and documentation disagree with current source | Info | — | Source/history inspection; ledger reconciled under 1792 |

The V4 recorder has a reproduced sampling concern whose economic impact remains unassessed; see “Open review item: V4 sampling.”

## Findings

### 1. Medium — deposits remain open while funded adapter value is excluded from NAV

**Code:** `RobotMoneyVault.sol:467-481, 495-506, 722-724, 957-960, 1000-1035, 1150-1153, 1361-1375, 1468-1474`.

`setAdapterAllowed(adapter, false)` removes a funded adapter from `totalAssets()` immediately. `_activeAdapterCount()` still includes the entry, and deposits remain open. New shares mint against reduced NAV and gain a claim on subsequent recoveries. Revoking an adapter code hash can produce the same exclusion.

**Reproduction:** Alice deposits 2,000 USDC across two adapters. ADMIN excludes one adapter holding 1,000 USDC. Bob deposits 1,000 USDC against the reduced NAV. After ADMIN restores eligibility, Bob redeems for 1,499.999999 USDC. Originally reproduced at baseline. After 1788, `SecurityReviewPoc.test_revokedAdapterWindowDepositBlocked` asserts the window deposit reverts and Alice keeps her full claim.

Recovery can occur through restored eligibility, `emergencyWithdrawAdapter`, or `rebalance()`. The emergency path pauses deposits when called, but previously minted shares already participate in the recovery. The keeper path iterates active adapters without checking eligibility before withdrawal and routes recovered funds into eligible adapters. Both paths were reproduced at baseline. After 1788, `test_f1_emergencyWithdrawAdapterOnRevokedAdapterRecoversToExistingHolders` and `test_f1_keeperRebalanceSkipsRevokedAdapter` assert that recovery reaches existing holders and the keeper leaves the quarantined adapter alone.

Existing holders who redeem during exclusion surrender their shares at reduced NAV and have no automatic entitlement to later recovery. If supply reaches zero, ordinary deposits after restoration do not capture the orphaned value because of ERC4626 virtual shares. At baseline this was demonstrated by `test_f1_holderExitDuringWindowStrandsSurplusBehindVirtualShares`. At baseline this did **not** prove the assets were unconditionally locked forever: another ADMIN-controlled exclusion, deposit and restoration sequence recovered the value. After 1788 that sequence is blocked at the deposit leg (`test_assessment_orphanRedistributionSequenceBlocked`). After 1820 the exiter keeps the claim and nothing is orphaned: restoration realises the excluded balance into the exclusion record of the snapshot holders (`test_f1_holderExitDuringWindowKeepsRecoveryClaim`, `RobotMoneyVaultTest.test_exclusionRecoveryPaidProRataToSnapshot`).

The deployment scripts configure an open timelock executor (`script/DeployTimelock.s.sol:83-85`). An observer may execute an independently scheduled, ready revocation and then deposit in the same transaction, if the operation permits that sequence. Executing a restore also requires that restore to have been separately authorized and become ready. An open executor neither creates operations nor permits interleaving calls within an atomic timelock batch. These timing implications were inspected in source, not reproduced through a real Safe/timelock fixture.

**Severity:** Medium because the demonstrated window requires ADMIN action, and an emergency pause before revocation prevents new deposits during exclusion (`test_f1_pauseBeforeRevokeClosesWindow`). That mitigation does not resolve underpaid exits or entitlement to later recoveries. Available deposit capacity affects the attack size; it is not a one-for-one bound on value captured from excluded assets.

**Recommendation:** Make `maxDeposit`/`maxMint` return zero and make `deposit`/`mint` revert while an active adapter is ineligible. Prevent ordinary keeper rebalancing from interacting with quarantined adapters; retain an explicit, authorized recovery path. Pause before exclusion and keep deposits closed until recovery accounting or the loss disposition is settled. Separately define how holders exiting during exclusion retain any intended recovery entitlement. Update the onboarding-only description of `setAdapterAllowed` at L950-956 and in `docs/technical/smart-contracts.md:165, 174-177`.

**History:** AZ-BSK-3 (`20260623-code-review-testmachine-azimuth.md:588-680`) describes this mechanism, but `docs/audits.md:416` marks it fixed for RobotMoneyVault. The cited fixes `d147bda9` and `639faa1c` changed BasketVault/RwaVault accounting; the RobotMoneyVault reproduction still passes. Reconcile the ledger against this source path.

### 2. Medium — duplicate strategy adapter registration overpays early redeemers

**Code:** `RobotMoneyVault.sol:467-473, 845-921, 938-947, 977-980, 1044-1062, 1181-1192`.

`addAdapter` checks eligibility and count but does not reject an already-active address. `totalAssets()` counts that adapter's balance once per entry. An ordinary user cannot add the duplicate; this requires an administrative configuration error.

**Reproduction:** With two equal holders and one adapter holding 2,000 USDC counted twice, the first holder redeems for 1,999.999999 USDC, consuming nearly all backing. A partial redemption can also extract the inflated value, while a later depositor receives approximately half the expected shares. Full redemption of all outstanding shares can revert; that does not prevent earlier value extraction. Originally reproduced at baseline. After 1789, `test_f2_eachHolderRedeemsOwnBackingAfterDuplicateRefused`, `test_f2_partialRedeemPaysParAfterDuplicateRefused` and `test_f2_depositAfterDuplicateRefusedMintsAtPar` assert that the duplicate add reverts `AdapterAlreadyActive` and every holder is paid or minted at par.

When a duplicate-add operation has been scheduled and is ready on an open-executor timelock, a holder can time execution and redemption together. The authorization prerequisite remains the erroneous ADMIN operation.

Both duplicate entries reject ordinary removal while the shared adapter balance is nonzero. The local fixture reproduces recovery by draining through `adminRebalance([0,0])`, removing the duplicate, then reallocating. Emergency force removal of the duplicate also corrects NAV but pauses deposits and emits a misleading loss amount. Production recovery should pause new deposits and keep the accounting repair atomic where possible; its operational sequence must be exercised through the actual governance path. After 1789 no duplicate can be created: `test_f2_noDuplicateEntryToRemoveAfterRefusal` and `test_f2_noDuplicateToForceRemoveAfterRefusal` pin that there is no second entry to repair, and `test_f2_reAddAfterRemoveAdapterCountsBalanceOnce` pins the legal drain, remove and re-add path.

**Recommendation:** Reject registration of an address already present as an active adapter. Preserve deliberate reactivation behavior for inactive entries.

**History:** Previously reported as SR-M15 and L-002. The NC-8 duplicate-reuse fix referenced by `docs/technical/smart-contract-invariants.md:168` applies to `BasketVault.addAsset`, not `RobotMoneyVault.addAdapter`.

### 3. Low — a gateway agent can attribute a committee signal to another member

**Code:** `gateway/RobotMoneyGateway.sol:632-700, 751-753, 1529-1536`; `gateway/InvestmentCommitteePolicy.sol:213-243, 271-280`.

Permissionless gateway registration is intended. It grants a depositor-tier `AGENT_ROLE`, not committee authority. However, `committeeVoteSubmit` forwards caller-controlled `p.agent`; the policy checks that supplied address's committee role without binding it to the caller.

**Reproduction:** A self-registered gateway agent submits under an existing committee member's address. The record names that member, and a later spoof becomes that member's `latestVoteByAgent`. Originally reproduced at baseline. After 1790, `test_selfRevealedAgentCannotImpersonateCommitteeMember` and `test_spoofedVoteCannotSupersedeMembersLatestVote` assert that the gateway reverts `CommitteeAgentNotCaller`, the vote log stays empty, and the member's own latest vote is unchanged. `test_selfRevealedAgentCannotVoteUnderOwnAddress` asserts the IC contract refuses the same agent under its own address (`AgentNotAllowlisted`), so the permissionless gateway tier has no route into the vote log.

The indexer copies the event's agent address and verifies a rationale body against its supplied hash (`services/explorer-indexer/src/indexer.rs:2179, 2203-2220, 2612-2646`). Its aggregation averages all verified votes without latest-per-agent deduplication or a committee-membership join (`services/explorer-indexer/src/db.rs:1979-1983`; `clients/explorer-api/src/routes.rs:1720-1727`). This permits repeated attacker-authored records to bias the public aggregate if their rationale bodies verify. At baseline the flood test proved repeated on-chain submissions only; after 1790, `test_spoofedVoteFloodRevertsUnderMemberName` asserts every repeated submission reverts and leaves the vote log empty. HTTP verification, database ingestion and dashboard rendering were not tested end to end. Repeated legitimate member submissions can also bias this aggregate after caller authentication is fixed.

**Severity and boundary:** Low under the owner's advisory-only committee-signal model and imminent governance-voting retirement. Receipt anchoring passes the real `msg.sender` and checks committee membership; receipt release is ADMIN-gated. `test_selfRegisteredAgentCannotAnchorReceipt` confirms that the spoofing path cannot anchor a receipt. This finding does not demonstrate unauthorized router-weight changes. Reassess severity if a consumer uses the affected feed as an authoritative allocation or receipt input.

**Recommendation:** If the signal endpoint remains, require `p.agent == msg.sender` or populate the identity from the authenticated caller. The current client already uses the signer address. Aggregate the latest signal per member **and vault**, with an explicit membership and freshness policy, and test the complete ingestion path. Governance-voting retirement alone does not repair a retained public signal endpoint or its historical data.

### 4. Imminent retirement — one voter meets quorum under example deployment values

**Code:** `RouterGovernance.sol:52-54, 69, 639`; `script/DeployRouterGovernance.s.sol:95-98`; `publish-contracts/src/sheet.ts:288`; `deployments/twin-918453/stage-sheet.env:16, 48`; `deployments/base-8453-rehearsal/stage-sheet.example.env:26, 58`.

`MIN_QUORUM_THRESHOLD = 2` is compared against voting power, not a count of voters. The example sheets use quorum 2 and power 1000 per voter. One voter therefore satisfies quorum on a Safe-authored proposal. `test_singleVoterCarriesProposalWithSheetValues` reproduces that configuration; it does not establish live production parameters.

**Disposition:** The owner confirmed imminent voting retirement. Removal under issue 1698 is the accepted resolution; no separate quorum fix is recommended. Verify the final deployment artifact has no voting surface and that weight-setter role wiring matches the replacement design. The mainnet-test plan's inaccessible voter keys are an assumption until verified. Retain this finding as baseline evidence and reassess only if voting is retained or used before removal.

### 5. Medium — emergency force removal reprices exits before recovery is settled

**Code:** `RobotMoneyVault.sol:467-473, 789-826, 938-947, 1136, 1158, 1181-1192`.

`forceRemoveAdapter` deactivates an adapter without withdrawing. Its balance disappears from NAV, and the emergency withdrawal functions cannot pull from the inactive entry. ADMIN can re-register it later. Holders redeeming in the meantime lose their proportional claim on any later recovery.

**Reproduction:** Removing every funded adapter allows shares to be redeemed for zero USDC. Removing one of two equal positions produces approximately half-value exits, while remaining holders benefit when ADMIN restores the position. See `test_O1a_forceRemoveAllFunded_redeemBurnsSharesForZero` and `test_O1b_forceRemovePartial_exitsUnderpaidStayersOverpaid`.

**Severity:** Medium as an emergency-key authority risk. Force removal is an intentional loss-write-off mechanism, but the key can apply it to a healthy, recoverable position without timelock approval. Deposit pausing does not protect exiting holders. A positive `maxRedeem` with zero NAV is not itself an ERC4626 inconsistency: shares can legitimately have zero value.

**Recommendation:** Resolve the emergency-key authority decision tracked by issue 1705 (Q2/C6), including who may finalize a loss and how later recoveries are attributed. Preserve a recovery route for quarantined positions and provide caller-controlled minimum proceeds for protected exits. Withdrawal success must not be a prerequisite for a last-resort write-off; a readable balance does not establish withdrawability. Any solution must preserve the owner's requirement that withdrawals cannot be administratively frozen.

### 6. Info / conditional Medium — keeper rebalance can reverse emergency withdrawal

**Code:** `RobotMoneyVault.sol:1000-1035`.

The rebalance throttle bounds withdrawals from adapters, but `_routeDeposit(idle)` reallocates the entire idle balance. It checks neither `depositsPaused` nor `shutdown`. A keeper can redeploy funds into the same still-eligible venue after an emergency drain, once the interval permits. This was reproduced at baseline with an explicitly granted keeper role. After 1788, `test_O2_keeperRebalanceBlockedAfterEmergencyWithdraw` asserts the keeper call reverts while deposits are paused.

**Severity:** Info under the intended configuration where the keeper role has no holder and only ADMIN can rebalance. Medium if a keeper is granted while this behavior remains. The constructor does not grant the role; that alone does not prove it is unheld on a live deployment. Issue 1705 C5 tracks a verifier assertion. The price-recorder keeper in issue 1779 is unrelated to this vault role.

**Recommendation:** Prevent ordinary keeper allocation during an emergency pause or shutdown, preserving explicit authorized recovery operations. Verify role holders at deployment and before any keeper grant. This is the previously reported SR-M10 mechanism.

### 7. Low — permissionless authorization can squat another agent's policy ownership

**Code:** `gateway/RobotMoneyGateway.sol:640-700, 703-736`; `docs/architecture.md:944-962`.

Any caller can commit and reveal authorization for an unowned agent address that passes role-separation checks, becoming its policy owner without the agent's consent. An attacker can claim a published target before its legitimate owner, including during a timelock delay. Subsequent `authorizeAgent` fails with `AgentAlreadyOwned`. Revoking `AGENT_ROLE` does not release ownership. Originally reproduced at baseline. After 1791, `test_permissionlessRevealCannotSquatThirdPartyAgentAddress` asserts that the same reveal reverts `InvalidAgentConsent`, nothing is bound, and admin onboarding of the address succeeds.

**Boundary:** Squatting itself grants the target `AGENT_ROLE`. It does not inherently block committee registration or voting: at baseline the squatted member still registered and voted while the attacker owned the policy. After 1791, `test_assessment_squatRefusedAndMemberJoinsCommitteeAndVotes` asserts that the squat reverts and the member binds its own address, registers and votes. The defect is unauthorized assignment of policy ownership. No autonomous theft from another holder is established by this finding; fund-moving calls retain their caller/policy constraints.

**Recommendation:** Require consent from the target agent to the intended owner, such as a two-party acceptance flow or a signed authorization bound to owner, gateway, chain, nonce and relevant policy terms. Preserve the documented model in which a depositor owns a distinct agent key's policy. Requiring `agent == msg.sender` would break that use case, and letting ADMIN seize ownership would contradict the existing ownership trust model. Those changes would need an explicit product decision.

### 8. Low — duplicate vault entries in router weight vectors

**Code:** `PortfolioRouter.sol:456-469, 537-553`.

`setWeights` and `_setDefaultWeights` validate eligibility, status and weight sum without enforcing uniqueness. A duplicate default entry can satisfy `length == routerEligibleCount` while omitting another eligible vault. This is an authorized configuration defect: `setWeights` is gated by `WEIGHT_SETTER_ROLE`, and default weights by ADMIN. Unlike finding 2, no duplicated NAV or direct theft is established here.

**Recommendation:** Reject duplicate addresses in both setters. Keep the validation when issue 1698 introduces receipt-based application: digest binding authenticates a submitted vector but does not establish uniqueness. Previously reported as HR-L-9; source-inspected in this review.

### 9. Info — audit dispositions and documentation disagree with source

Reconcile the following against the reviewed baseline:

- AZ-BSK-3 is marked fixed for RobotMoneyVault; finding 1 remains reproducible (`docs/audits.md:416`).
- The NC-8 duplicate-reuse claim in `docs/technical/smart-contract-invariants.md:168` does not apply to RobotMoneyVault (finding 2).
- AZ-GW-3 is listed as accepted/mainnet-blocking, but the empty source-vault list is now restricted to the pinned vault (`gateway/RobotMoneyGateway.sol:1363-1386`).
- AZ-GOV-1 describes a 256-block history limit; `RouterGovernance.sol:86, 600-602` now uses 100,000 blocks. This addresses that specific limit, not every historical-query availability question; voting retirement makes it moot.
- HR-L-11 discusses `rescueUsdc`, which is absent from the reviewed PortfolioRouter.
- `docs/architecture.md:404-406` calls the open timelock executor unimplemented; `script/DeployTimelock.s.sol:83-85` configures it.
- The adapter allowlist documentation still describes onboarding-only effects, contrary to NAV exclusion (finding 1).

This review does not reconcile every prior disposition. Outstanding rows include SR-H4 (partial), FS-VLT-10/21/22/23/27, HR-I-1/2/3/7, FORCEREMOVE-001, DC-0606-DEFER GOV-003, AC-008 and the grouped SR-0612-OPEN row. They require individual verification before being treated as closed or accepted for release.

## Open review item: V4 sampling

**Code:** `adapters/UniswapV4PriceRecorder.sol:151-173, 200-217, 305-345`.

The recorder samples a clamped live tick and extrapolates it until another record. `test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord` moves the mock pool tick, records after a 60-second gap, restores the live tick immediately, then waits 1,800 seconds without another record. The reported window mean remains displaced by 600 ticks while the live pool tick is back at its original value. The staleness check permits exactly 1,800 seconds.

This proves persistent sample distortion in the recorder, not a profitable attack on BasketVault. The test uses a mock pool and a two-slot recorder ring; it does not satisfy or exercise all BasketVault admission guards, perform real swaps, or model fees, liquidity, arbitrage and keeper competition. Existing flash-manipulation coverage records the restored tick two seconds later, so it does not cover this missing-record case.

**Follow-up:** Exercise transient and repeated sampling against BasketVault with production-equivalent pool configuration, ring cardinality, spot/TWAP guards and honest recorder cadence. Measure feasible NAV/slippage effects and transaction profitability before assigning an economic severity. A periodic recorder service reduces the gap but is not proof that adversarial sampling is harmless.

**After this baseline:** core 1793 (QA plan v1 task D5, `83e1899a`) measured the effect and added a USDC sell anchor to `BasketVault.redeem` (`BasketViews.checkSellAnchor`, 4-hour mean, recorder ring of 7,201 slots). Within 30 minutes of a held tick, a USDC redeem loses at most about 4.5 percent; `docs/technical/recorder-manipulation-1793.md` has the numbers and the residual. The ledger row is SR-1012-V4.

## Planned changes and remaining actions

Plan issues were inspected on 2026-10-12. Their intended outcomes inform prioritization; implementation and deployment verification remain separate evidence.

| Issue | Effect on this review |
|---|---|
| 1698 — receipt application and voting removal | Accepted resolution for finding 4. Verify removal and replacement role wiring; retain duplicate-vector validation from finding 8. |
| 1697 — governance documentation | Clarifies advisory committee signals and the authority boundary in finding 3. Does not itself authenticate retained signal submissions. |
| 1705 — four-vault governance plan | Tracks the emergency-authority decision in finding 5 and keeper-role verification in finding 6. |
| 1447 — Safe/timelock integration | Provides the real governance path on which recovery procedures for findings 1 and 2 should be exercised. |
| 1779 — V4 price-recorder keeper | Relevant to sampling cadence; separate from RobotMoneyVault's keeper role. |
| 1788 — vault quarantine fix (PR 1814) | Remediates finding 1's window-deposit and keeper paths and finding 6. |
| 1677 — restored V4 asset-position adapter | Requires separate review if introduced; it is absent from this baseline's RobotMoneyVault strategy set. |

Next actions are to assign remediation owners for finding 1's remaining exit-entitlement question and findings 2 and 7; correct retained committee-signal authentication and aggregation; enforce unique router vectors; settle recovery accounting and emergency authority; and reconcile the audit ledger. Check for existing tracking before creating duplicate issues. The V4 economic analysis and live deployment verification remain open.

## Additional source observations and limits

- Lending adapter NAV reads use Aave receipt balances, Compound balances and Morpho conversion methods. This review does not establish that every upstream valuation is immutable within a transaction or independently audit those protocols.
- RobotMoneyVault uses an ERC4626 virtual-share offset of 18. This mitigates ordinary donation/inflation behavior, but does not prevent the NAV-exclusion mechanism in finding 1.
- RobotMoneyVault's foreign-token sweep excludes the underlying asset and its shares. Adapter sweep protections are separate from adapter eligibility and recovery accounting.
- `_pullProportional` caps the last-entry remainder, bounds its second pass by remaining need, and retains over-delivery as idle balance. Those bounds do not prevent duplicate-entry overvaluation.
- Vault exit fees have a 100 bps ceiling, require a nonzero recipient, and are charged from realized gross proceeds. User pull failures revert atomically; the gas floor does not prove every external valuation call has adequate gas under every configuration.
- Role administration and last-admin protections were inspected. BasketVault deliberately uses DELEGATECALL-linked libraries, including `BasketAssetConfigGuard`; their absence cannot be claimed. Absence of a signature-based relay likewise does not establish absence of every replay or ordering risk.
- Deployment scripts specify Safe proposer/canceller roles, an open executor, a Base timelock floor and deployer handover. Temporary deployer authority and pause/seed sequencing require operational verification; no live exposure bound is inferred from the intended seed amount.

## Verification

All commands run from the review worktree. Tests assert current behavior, including vulnerabilities; passing tests do not mean the defects are fixed. Tests for paths remediated by 1788, 1789, 1790 and 1791 assert the fixed behavior.

- `forge test --match-path 'contracts/test/SecurityReview*Poc.t.sol' --match-test 'test_duplicateAdapterRefused_fullRedemptionPaysPar|test_revokedAdapterWindowDepositBlocked|test_selfRevealedAgentCannotImpersonateCommitteeMember' -vv` — 3 passed.
- `forge test --match-path 'contracts/test/SecurityReviewRecheck*.t.sol' --match-test 'test_f1|test_f2|test_O|test_spoofed|test_selfRegistered|test_selfRevealed|test_permissionlessReveal|test_singleVoter' -vv` — 23 passed.
- `forge test --match-path contracts/test/SecurityReviewRevisionAssessment.t.sol --match-test test_assessment -vv` — 3 passed: the 1791 consent check refuses the squat and the member joins the committee under its own consent; the pre-1788 orphan redistribution sequence is now blocked; transient V4 samples persist without another record.
- `forge test --match-path contracts/test/RobotMoneyVault.t.sol --match-test test_ADP2_revokedAdapterExcludedFromNavAndPulls -vv` — 1 passed; the existing regression asserts the reduced payout during exclusion.

No production contract implementation was changed by this review; the 1788 fix landed separately on `dev`. Deployment-specific exposure, complete off-chain ingestion behavior, V4 economic exploitability and the unreviewed historical audit rows remain outside the verified conclusions.
