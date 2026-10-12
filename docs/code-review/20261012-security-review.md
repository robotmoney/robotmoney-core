# Smart-contract security review — 2026-10-12

Baseline: `2c81c742f97fc2faa033befc38a01a2c2af66cc3` (`origin/dev`, the repository's default branch; `origin/main` does not exist). The Solidity production sources are unchanged from `7c742860fad65b09442bf64fdf2b0098ba0b135f`, where the focused review was performed. Review worktree: `review/contracts-security-20261012`.

Status: re-checked adversarially on 2026-10-12. The first pass reported three findings. The re-check kept all three mechanisms, re-rated two of them, corrected the framing of the third, and added five findings the first pass missed. Every claim below that says "reproduced" has a passing test in `contracts/test/SecurityReview*Poc.t.sol` or `contracts/test/SecurityReviewRecheck*Poc.t.sol` at this baseline.

The scope inventory contains 28 production Solidity implementations under `contracts/` (7 adapters, 4 gateway, 8 library, 4 under `vaults/`, plus `FeatureFlags`, `PortfolioRouter`, `RobotMoneyVault`, `RouterGovernance`, `VaultRegistry`). The first pass traced authorization, deposit/share accounting, withdrawals, adapter eligibility, swap/oracle boundaries, and committee attribution. The re-check added the router, registry, governance, timelock wiring, the gateway's full `AGENT_ROLE` surface, the emergency and keeper paths of the vault, off-chain consumers of committee votes, and the prior-audit ledger.

This report evaluates the checked-out source. No Base (8453) production manifest exists under `deployments/` (only Twin placeholders and a rehearsal example), so live role holders cannot be confirmed from this repository. Deployment scripts were read for role wiring but not independently audited. Third-party protocols were not audited. No completeness claim or absence-of-vulnerabilities conclusion is made.

## Review conclusions

| # | Finding | Severity | Required conditions | Evidence |
|---|---|---|---|---|
| 1 | Deposits stay open while a funded adapter is excluded from NAV | Medium (was High) | ADMIN revokes a funded adapter before deposits are paused; any later recovery leg | Reproduced; mitigation reproduced |
| 2 | Duplicate strategy adapter registration pays the first redeemer twice | Medium (was Low) | ADMIN schedules the same active adapter address twice | Reproduced value extraction |
| 3 | Any gateway agent can attribute a committee vote to an allowlisted member | Medium | One committee member allowlisted; attacker self-registers as a gateway agent | Reproduced, including supersede |
| 4 | One voter carries any router-weight proposal under the shipped sheet | Medium | Stage sheet values `QUORUM_THRESHOLD=2`, `VOTER_POWER=1000` | Reproduced |
| 5 | EMERGENCY `forceRemoveAdapter` reprices every exit | Medium | EMERGENCY hot key acts alone | Reproduced |
| 6 | Keeper `rebalance()` undoes `emergencyWithdraw` | Low (Medium once `KEEPER_ROLE` is granted) | A keeper runs during the timelock delay | Reproduced |
| 7 | Permissionless `revealAuthorization` squats any un-owned agent address | Low | Attacker front-runs a scheduled `authorizeAgent` | Reproduced |
| 8 | Duplicate vault entries in router weight vectors | Low | ADMIN sets a vector with a repeated vault | Source read, HR-L-9 still present |
| 9 | Ledger and doc drift on six prior findings | Info | — | Source read |

## Findings

### 1. Medium — deposits stay open while a funded adapter is excluded from NAV

**Code:** `RobotMoneyVault.sol:467-481, 495-506, 722-724, 957-960, 1000-1035, 1150-1153, 1361-1375, 1468-1474`.

`setAdapterAllowed(adapter, false)` removes a funded adapter from `totalAssets()` immediately, but `_activeAdapterCount()` still includes it and deposits remain open. A new user mints shares against the reduced NAV. Any recovery leg then hands part of the pre-existing holders' value to the new shares. Revoking a code hash has the same effect.

**Reproduction:** Alice deposits 2,000 USDC across two 1,000-USDC adapters. Admin revokes one. Bob deposits 1,000 USDC at the 1,000-USDC NAV. Admin restores eligibility. Bob redeems for 1,499.999999 USDC. `SecurityReviewPoc.test_revokedAdapterReactivationTransfersValue`.

**What the first pass missed:**

- There are three recovery legs, not one. `setAdapterAllowed(true)` (ADMIN), `emergencyWithdrawAdapter` (EMERGENCY, works on an ineligible adapter because it checks only `active` at L1150-1152, and it pauses deposits only after Bob is already in; `test_f1_emergencyWithdrawAdapterOnRevokedAdapterRecoversToWindowDepositor`), and `rebalance()` (ADMIN or KEEPER). `rebalance()` iterates `active` adapters, not `_isAdapterCounted`, and calls `withdraw` on the revoked adapter with no eligibility check (L1015-1030), then routes the proceeds into eligible adapters. A keeper therefore moves "untrusted" adapter funds back into NAV, which contradicts the ADP-2 rationale at L475-478. `test_f1_keeperRebalancePullsRevokedAdapterIntoNav`.
- Existing holders who exit during the window lose permanently. If supply reaches zero while the revoked adapter still holds funds, the surplus is owned by the ERC4626 virtual shares (`_decimalsOffset() == 18`) and can never be claimed by anyone, including the next depositor, because `sweepForeignToken` rejects `asset()`. `test_f1_holderExitDuringWindowStrandsSurplusBehindVirtualShares`.
- The open executor widens the window. `EXECUTOR_ROLE` is `address(0)` (`contracts/script/DeployTimelock.s.sol:83-85`, `docs/operations/contract-release-runbooks.md:252`), so once the Safe schedules `setAdapterAllowed(x, false)` an attacker can execute it and deposit in the same transaction, then execute the restore and redeem atomically. `docs/architecture.md:404-406` still says the open executor is "not yet implemented"; it is implemented.
- The `setAdapterAllowed` docstring (L950-956) says revoking "does NOT affect adapters already registered and active" and "only blocks future deposit allocations". That predates ADP-2 and is wrong: the code excludes the adapter from NAV and from user pulls. `docs/technical/smart-contracts.md:165, 174-177` repeats the stale description, and the docstring's own procedure (revoke, then drain, then remove) is exactly the ordering that opens the window.

**Why Medium, not High:** ADMIN_ROLE is a `TimelockController` with a 48-hour floor on Base (`docs/architecture.md:397-412`, `DeployTimelock.s.sol:60-110`). EMERGENCY_ROLE is an independent hot key that can `pauseDeposits()` before the revoke lands, and `unpauseDeposits` is ADMIN-only, so the safe order pause → revoke → drain → unpause exists today with no code change (`test_f1_pauseBeforeRevokeClosesWindow`). Loss is bounded by the revoked adapter's balance and TVL headroom. No one outside ADMIN can flip eligibility: `_isAdapterEligible` reads two admin-only maps, `codehash` (all production adapters are non-proxy with `immutable` `USDC`/`VAULT`; post-Cancun `selfdestruct` cannot clear code), and two staticcalls that cannot be gas-starved behind the 1.6M entry floors.

**Recommendation:** Close deposits (`maxDeposit() == 0`, revert in `deposit`/`mint`) whenever an active adapter is ineligible. This does not conflict with audit L-4 (`20260609-code-review-internal-claude.md:233`), which was about an unintended revert inside `_allocateTo`. Make `rebalance()` skip ineligible adapters. Fix the `setAdapterAllowed` docstring and `docs/technical/smart-contracts.md`. Add an adapter-quarantine runbook under `docs/operations/` that orders pause before revoke.

**History:** The azimuth report (`20260623-code-review-testmachine-azimuth.md:588-680`, AZ-BSK-3) describes this exact mechanism and cites `RobotMoneyVault.sol`. `docs/audits.md:416` marks it fixed and names RobotMoneyVault. The two fix commits (`d147bda9` for 1098, `639faa1c` for 1664) touched only `contracts/vaults/BasketVault.sol` and `RwaVault.sol` and fixed a different sub-problem (idle USDC in the BasketVault mint denominator). The ledger is wrong; this vault was never fixed.

### 2. Medium — duplicate strategy adapter registration pays the first redeemer twice

**Code:** `RobotMoneyVault.sol:467-473, 524, 594, 845-921, 938-947, 977-980, 1044-1062, 1181-1192`.

`addAdapter` checks eligibility and count but never checks whether the address is already active. `totalAssets()` adds the same adapter balance once per entry.

**What the first pass missed:** the impact is value extraction, not only a stuck vault. With one real adapter holding 1,000 USDC counted twice, a holder who redeems half her shares is paid 999.999999 USDC: pass 1 of `_pullProportional` pulls 500 for entry 0 and the "last counted takes the remainder" rule (L887-888) pulls the other 500 for entry 1, both from the same adapter. `test_f2_partialRedeemPaysDoubledPriceAndEmptiesVault`. With two equal holders, the first full redeemer takes 1,999.999999 of the 2,000 pool and the second holder's exit reverts on dust. `test_f2_firstRedeemerTakesSecondHoldersBacking`. A depositor after the duplicate is minted at the doubled price and receives about half the shares. `test_f2_depositAfterDuplicateMintsAtInflatedPrice`. Because the timelock executor is open, whoever is watching the Safe can execute the scheduled duplicate-add and redeem in one transaction, so the "configuration error" becomes attacker-timed theft.

Recovery is not `removeAdapter`: both entries read the same non-zero balance, so both revert `AdapterNotEmpty`. The clean ADMIN path is `adminRebalance([0,0])` → `removeAdapter(1)` → `adminRebalance([X,0])` (`test_f2_adminOnlyRecoveryRestoresAccounting`). The EMERGENCY path `forceRemoveAdapter(1)` fixes NAV in one call but pauses deposits and emits `AdapterForceRemoved` with `lossAmount` equal to the full, not lost, balance (`test_f2_forceRemoveDuplicateFixesNavButPausesAndMisreportsLoss`). Every path is at least one timelock delay or one hot-key action away.

**Recommendation:** Reject an adapter address already present as an active entry. One line, no behavioural change for legitimate flows.

**History:** SR-M15 (`20260612-code-review-internal-claude.md:178-181`) already says "aware redeemers extract real USDC, leaving the vault insolvent". It is covered only by the grouped row `SR-0612-OPEN` in `docs/audits.md:392` with disposition "accepted-with-rationale, must land before mainnet" (`:465`). L-002 (`20260728-code-review-internal-kimi.md:329`) has no ledger row. `docs/technical/smart-contract-invariants.md:168` claims "the unified `Vault.addAdapter` reuses an inactive entry on re-add — fixed by NC-8 (#970)"; that fix landed only in `BasketVault.addAsset` (`contracts/vaults/BasketVault.sol:1081-1098`), not in `RobotMoneyVault.addAdapter`, which always pushes (L943-946).

### 3. Medium — any gateway agent can attribute a committee vote to an allowlisted member

**Code:** `gateway/RobotMoneyGateway.sol:616-629, 632-700, 751-753, 1529-1536`, `gateway/InvestmentCommitteePolicy.sol:213-243, 271-280`.

The gateway forwards caller-controlled `p.agent` unchecked; the policy checks whether `p.agent` holds `COMMITTEE_AGENT_ROLE`, not whether that address is the submitter, and stores `p.agent`. `SecurityReviewCommitteePoc.test_permissionlessAgentCanImpersonateCommitteeMember`.

**Corrections to the first pass:**

- Self-registration through `commitAuthorization` + `revealAuthorization` is the documented depositor trust model, not a bug (`RobotMoneyGateway.sol:616-629`, `IGateway.sol:366-370`, `docs/architecture.md:944-962`). "Grants `AGENT_ROLE` without multisig approval" was misleading. `AGENT_ROLE` is a self-serve depositor-tier role with no committee authority. Every fund path it gates (`deposit`, `depositTo`, `withdraw`, `withdrawFromRouter`) reads `agents[msg.sender]` and pulls USDC or shares from `msg.sender` or from a `shareReceiver` a non-admin must set to itself (L752). The gateway holds no pooled shares. `test_selfRegisteredAgentCannotPullAnotherHoldersShares`.
- The impact is larger than "false provenance". Votes are append-only with no per-agent key, so the real member's vote never reverts, but the live-state rule is latest-wins (`docs/architecture.md:581-583`, `latestVoteByAgent` at L271-280). An attacker who back-runs the member's vote becomes the member's live position. `test_spoofedVoteSupersedesMembersLatestVote`.
- The off-chain feed is fully attacker-controllable. The indexer stores `decoded.agent` straight from the event (`services/explorer-indexer/src/indexer.rs:2179, 2203-2220`); "verified" means only that the body at `rationale_uri` hashes to `voteJsonHash`, both attacker-supplied (`:2612-2646`). The aggregate is `AVG/COUNT` over `committee_votes WHERE verified` with no per-agent dedupe and no join to `committee_agents` (`services/explorer-indexer/src/db.rs:1979-1983`, `clients/explorer-api/src/routes.rs:1720-1727`), surfaced by the dapp as "aggregated committee tilt" (`clients/dapp/src/lib/committeeApi.ts:59-74`). `docs/architecture.md:618-623` says the timelock proposer "reads the committee's tilts, aggregated off-chain" to propose router weights, so the spoof poisons the signal governance is designed to consume. `test_spoofedVotesFloodUnderMemberName`. Severity stays Medium only because a human proposal step sits between the feed and the router.

Confirmed safe: `consensusRecordReceipt` passes `msg.sender` (L1587) and the receipt checks that submitter's committee role (`ConsensusRecommendationReceipt.sol:133`); `releaseReceipt` is ADMIN-gated. `test_selfRegisteredAgentCannotAnchorReceipt`. No other gateway → policy forward carries a caller-controlled identity.

**Recommendation:** In `committeeVoteSubmit`, revert unless `p.agent == msg.sender`. No ERC-2771, EIP-712, or relayer exists in the gateway, `docs/architecture.md:601-608` rules out relayed votes, and `rmpc` already sets `agent` from the signer (`clients/rust-payment-client/src/commands/committee.rs:212, 286`), so nothing breaks. Separately, have the indexer join votes to the on-chain `committee_agents` set and dedupe to latest-per-agent before aggregating.

### 4. Medium — one voter carries any router-weight proposal under the shipped sheet

**Code:** `RouterGovernance.sol:52-54, 69, 639`, `contracts/script/DeployRouterGovernance.s.sol:95-98`, `publish-contracts/src/sheet.ts:288`, `publish-contracts/src/verify/index.ts:239-244`, `deployments/twin-918453/stage-sheet.env:16, 48`, `deployments/base-8453-rehearsal/stage-sheet.example.env:26, 58`.

`RouterGovernance` claims "a single voter can never carry a weight proposal on their own" via `MIN_QUORUM_THRESHOLD = 2`. Quorum is compared in power units, not voter count. Both stage sheets set `QUORUM_THRESHOLD=2` and `VOTER_POWER=1000` per voter. The deploy script checks only `totalVotingPower >= quorum`, the sheet validator applies the same total-only rule, and the stage 12 verifier checks equality to the sheet. `GovernanceSeparationInvariant.t.sol:191-199` asserts "a minority of two voters must not reach quorum" against fixture constants (`VOTER_POWER=100e18`, `QUORUM=250e18`), never against sheet values. Scenario: the timelock proposes, one compromised or careless voter key votes, the weights move after the execution delay. Proposal content stays Safe-authored, which bounds the impact to choosing among Safe-proposed vectors.

**Reproduction:** `SecurityReviewRecheckGovernancePoc.test_singleVoterCarriesProposalWithSheetValues` with the sheet values.

**Recommendation:** Set `QUORUM_THRESHOLD` in power units above any single voter's power (for the shipped sheet, at least `1001`), and make the deploy script and sheet validator reject `quorum <= max(voterPower)`. Add an invariant test that reads the sheet values.

### 5. Medium — EMERGENCY `forceRemoveAdapter` reprices every exit

**Code:** `RobotMoneyVault.sol:1181-1192, 467-473, 1136, 1158, 789-826, 938-947`.

`forceRemoveAdapter` flips `active = false` without draining. The adapter drops out of `totalAssets()`, no vault function can pull from an inactive entry (`emergencyWithdraw` skips inactive, `emergencyWithdrawAdapter` reverts `AdapterNotFound`), and redeems keep working at the deflated NAV. With every funded adapter removed, `previewRedeem` is 0 while `maxRedeem` still reports the full balance, so `redeem` burns all shares for 0 USDC (`test_O1a_forceRemoveAllFunded_redeemBurnsSharesForZero`). With one of two adapters removed, exits pay 50 cents on the dollar and, after ADMIN re-registers the adapter, the stayers own what the leavers gave up (`test_O1b_forceRemovePartial_exitsUnderpaidStayersOverpaid`). This is the exit-side mirror of finding 1, triggerable by the lower-trust hot key alone, and it is not closed by the deposit pause. It conflicts with `docs/technical/security-model.md:92` ("no role, flag or function can block a redeem") in substance if not in letter, since a redeem that pays zero is a blocked exit.

The function is documented as a loss write-off. The gap is that nothing ties it to an actual loss: a healthy adapter can be written off, and only ADMIN (timelock, 48 hours) can bring it back. Rated Medium as a hot-key trust finding; the same key can already `emergencyWithdraw`, but that path keeps NAV intact.

**Recommendation:** Require `forceRemoveAdapter` to first attempt `emergencyWithdrawAdapter` and succeed, or restrict it to adapters whose `totalAssets()` reverts (the case `test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts` covers). Make `maxRedeem`/`maxWithdraw` consistent with `previewRedeem` when NAV is zero.

### 6. Low — keeper `rebalance()` undoes `emergencyWithdraw`

**Code:** `RobotMoneyVault.sol:1000-1035`, especially the `_routeDeposit(idle)` leg at L1032.

The rebalance throttle bounds only pulls. The routing leg sends the whole idle balance back out, checks neither `depositsPaused` nor `shutdown`, and skips only adapters whose allowlist ADMIN already revoked. After EMERGENCY drains a suspect venue, one keeper call re-deploys 100% of TVL into it during the 48-hour delay before ADMIN can revoke it. `test_O2_keeperRebalanceUndoesEmergencyWithdraw`. This is SR-M10 (`20260612-code-review-internal-claude.md:153`), still open at HEAD, never individually dispositioned in `docs/audits.md`.

`KEEPER_ROLE` is not granted at launch (`docs/technical/smart-contracts.md:143`), so today only the timelock can call `rebalance()`. Rated Low for that reason; it becomes Medium the day a keeper key is granted.

**Recommendation:** Make `rebalance()` revert while `depositsPaused` or `shutdown` is set.

### 7. Low — permissionless `revealAuthorization` squats any un-owned agent address

**Code:** `gateway/RobotMoneyGateway.sol:640-674, 686, 689, 725, 736`, `docs/architecture.md:948-949`.

`revealAuthorization` lets any caller authorize any address that is not already owned, with no `agent == msg.sender` check; the caller becomes `agentOwner[agent]`. The attacker grants a third party `AGENT_ROLE` with `shareReceiver` and `assetRecipient` set to the attacker. ADMIN then cannot onboard that address (`AgentAlreadyOwned`), and `revokeRole(AGENT_ROLE, x)` does not clear `agentOwner`; only the squatter's `revokeAgent` releases it. A timelocked `authorizeAgent` publishes its target address during the delay, so squatting is trivial. The prior audit accepted a squatter DoS only for the router (`docs/audits.md:209`, FS-RTR-5). This gateway variant blocks committee onboarding, since a member needs `AGENT_ROLE` to vote. `test_permissionlessRevealSquatsThirdPartyAgentAddress`.

**Recommendation:** Require `agent == msg.sender` in `revealAuthorization` for non-admin callers, or let ADMIN clear `agentOwner` on `revokeRole`.

### 8. Low — duplicate vault entries in router weight vectors (HR-L-9, still present)

**Code:** `PortfolioRouter.sol:456-469, 537-553`.

`setWeights` and `_setDefaultWeights` check zero, Active, eligible and sum, never uniqueness. A default vector with a duplicate satisfies `length == routerEligibleCount` while silently dropping one eligible vault. Admin-gated. One layer above finding 2, same root cause: no membership check on a registry write.

**Recommendation:** Reject repeated vault addresses in both setters.

### 9. Info — ledger and doc drift

Rows in `docs/audits.md` or canonical docs that state the opposite of the code at this baseline:

- AZ-BSK-3 marked fixed for RobotMoneyVault; not fixed (finding 1).
- `docs/technical/smart-contract-invariants.md:168` says NC-8 fixed duplicate re-add on the unified vault; it fixed only BasketVault (finding 2).
- AZ-GW-3 "accepted, remains mainnet-blocking" (`audits.md:421, 468`); fixed at `RobotMoneyGateway.sol:1363-1386` (empty `allowedSourceVaults` means pinned vault only).
- AZ-GOV-1 "accepted" (`audits.md:422`); fixed at `RouterGovernance.sol:86` (`MAX_HISTORY_BLOCKS = 100_000`).
- HR-L-11 `rescueUsdc` "accepted by design" (`audits.md:341`); the function is deleted (`PortfolioRouter.sol:602-618`).
- `docs/architecture.md:404-406` says open executor is "not yet implemented"; `DeployTimelock.s.sol:83-85` implements it.
- `RobotMoneyVault.sol:950-956` and `docs/technical/smart-contracts.md:165, 174-177` describe the allowlist as onboarding-only (finding 1).

Prior rows this review neither reconfirms nor disputes, for the next pass: SR-H4 (partial), FS-VLT-10, FS-VLT-21, FS-VLT-22, FS-VLT-23, FS-VLT-27, HR-I-1, HR-I-2, HR-I-3, FORCEREMOVE-001, HR-I-7, DC-0606-DEFER GOV-003, AC-008, and the blanket `SR-0612-OPEN` row ("4 High + 19 Medium open"), which no report has reconciled per contract.

## Checked and found sound

- Adapter NAV: Aave (`A_TOKEN.balanceOf`), Compound (`COMET.balanceOf`), Morpho (`convertToAssets`) are index-based with no reversible intra-block move. RobotMoneyVault holds no V4 position; the V4 recorder prices BasketVault only, under the ADR-accepted 600-tick-per-record drag.
- Inflation: `_decimalsOffset() == 18`; a donation to an adapter enters the same `totalAssets()` denominator as a donation to the vault.
- `sweepForeignToken` rejects `asset()` and the share token, and adapter sweeps protect USDC plus their receipt token.
- `_pullProportional`: last-counted remainder is capped at balance, pass 2 is bounded by `remainingNeeded`, the over-delivery clamp leaves surplus idle for all holders.
- Exit fee: 100 bps ceiling, non-zero `feeRecipient` enforced, fee paid only from realised gross.
- Gas floors only revert earlier; the pull path has no try/catch, so an inner out-of-gas reverts the whole call.
- Role admin: `ADMIN_ROLE` is self-administered with a last-admin floor on vault, registry, router, governance; the gateway pins `AGENT_ROLE` admin to `ADMIN_ROLE` and enforces tier disjointness. No lower role can escalate. No proxy, initializer, `delegatecall`, `receive`, `fallback` or `selfdestruct` in production sources. No signature verification in scope, so no replay surface.
- Timelock wiring per scripts: proposer and canceller the Safe, executor open, admin none, 48-hour floor on 8453; the deployer is revoked from every role at stage 12 and the verifier checks it. Between stage 3 and stage 11 the deployer EOA holds ADMIN and EMERGENCY on every vault, which `docs/technical/security-model.md:88` forbids; the vaults deploy paused with a 1 USDC seed, so exposure is bounded.
- Registry authority over a vault is deposit-halt only; `unretire` re-opens deposits only when `depositsPaused` is also false.
- CI runs `forge test` on every PR including drafts with executed-test guards; invariants, fork tests and coverage start at ready-for-review. Slither runs on PRs touching `contracts/**` with `fail_on: high`, so medium and low detectors never fail CI.

## Verification

- `forge test --match-path 'contracts/test/SecurityReview*Poc.t.sol' --match-test 'test_duplicateAdapterDoubleCountsNavAndBlocksFullRedemption|test_revokedAdapterReactivationTransfersValue|test_permissionlessAgentCanImpersonateCommitteeMember' -vv` — 3 passed.
- `forge test --match-path 'contracts/test/SecurityReviewRecheck*.t.sol' --match-test 'test_f1|test_f2|test_O|test_spoofed|test_selfRegistered|test_permissionlessReveal|test_singleVoter' -vv` — 22 passed, 0 failed, across 3 test contracts (`SecurityReviewRecheckVaultPoc`, `SecurityReviewRecheckCommitteePoc`, `SecurityReviewRecheckGovernancePoc`).
- Existing `RobotMoneyVaultTest.test_ADP2_revokedAdapterExcludedFromNavAndPulls` — passed, and it already asserts the permanent loss for a holder who exits during the window (Alice gets 1,000 of her 2,000).

## Remaining review work

The V4 recorder's public sampling and extrapolation still deserve adversarial testing against BasketVault, including transient price changes reversed after a record and gaps between honest records. The indexer's vote aggregation needs a membership join and latest-per-agent dedupe regardless of the on-chain fix. Live deployment bytecode, role assignments, pool liquidity and configuration must be checked against a real Base manifest before assigning deployment-specific exposure.

No production code was changed.
