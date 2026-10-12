# Smart-contract security review — 2026-10-12

Baseline: `2c81c742f97fc2faa033befc38a01a2c2af66cc3` (`origin/dev`, the repository's default branch; `origin/main` does not exist). The Solidity production sources are unchanged from `7c742860fad65b09442bf64fdf2b0098ba0b135f`, where the focused review was performed. Review worktree: `review/contracts-security-20261012`.

Status: finalized after rechecking the initial findings and their prerequisites.

The scope inventory contains 28 production Solidity implementations under `contracts/`: vaults, router, registry, gateway, governance, adapters, libraries, and feature flags. Manual tracing concentrated on authorization, deposit/share accounting, withdrawals, adapter eligibility, swap/oracle boundaries, and committee attribution. Interfaces, tests, architecture documents, and earlier audit reports supplied context.

This report evaluates the checked-out source. It does not establish that a live deployment uses identical bytecode or configuration. Deployment scripts and third-party protocols were not independently audited, the full test suite was not run, and no completeness claim or absence-of-vulnerabilities conclusion is made. The focused reproductions use the repository's mocks and demonstrate the specific behaviors described below.

## Review conclusions

| Finding | Severity | Required conditions | Evidence |
|---|---|---|---|
| Recoverable assets captured by deposits during adapter exclusion | High, conditional | Governance excludes a funded adapter while deposits remain open, then restores or recovers its assets | Reproduced value transfer through eligibility restoration |
| Duplicate strategy adapter registration | Low, operational | Admin submits the same active adapter address twice | Reproduced inflated NAV and failed full redemption |
| Committee vote attribution spoofing | Medium | At least one committee member is allowlisted; attacker self-registers a gateway agent | Reproduced without any admin action by the attacker |

The second finding was downgraded from Medium because the trigger is a trusted admin configuration error. The third finding's authorization description was corrected: gateway `AGENT_ROLE` is also obtainable through permissionless commit/reveal. Neither committee votes nor consensus receipts automatically apply router weights or move vault funds.

## Findings

### 1. High — adapter quarantine leaves a recoverable-asset minting window

**Code:** `RobotMoneyVault.sol:467-481, 495-505, 528-541, 957-960, 1361-1375, 1468-1474`.

`setAdapterAllowed(adapter, false)` removes a funded adapter from `totalAssets()` immediately, but `_activeAdapterCount()` still includes it and deposits remain open. A new user therefore mints shares against the reduced NAV. If the adapter is later re-allowed or its assets are recovered into idle USDC, the new shares claim part of the pre-existing holders' recovered value. Revoking a code hash has the same effect.

The attacker does not need an admin key, but cannot initiate the exclusion or restoration. The vulnerable window depends on governance actions and available deposit capacity. Atomic pause-and-recovery avoids this particular minting window. The High rating reflects the potential loss of existing holder backing once the window exists; it is not a claim of unconditional exploitation during normal operation.

**Reproduction:** Alice deposits 2,000 USDC into two 1,000-USDC adapters. Admin revokes one adapter. Bob deposits 1,000 USDC at the reduced 1,000-USDC NAV. Admin restores eligibility. Bob redeems for 1,499.999999 USDC, taking about 500 USDC from Alice's original backing. `SecurityReviewPoc.test_revokedAdapterReactivationTransfersValue` passes.

**Recommendation:** Close deposits atomically when funded adapter value is excluded from NAV, and keep them closed until recovered value has been allocated to the holders who bore the exclusion or the loss is finalized. This requires more than checking for an eligible adapter because a partially excluded position also dilutes existing holders.

**History:** The same mechanism appears in `20260623-code-review-testmachine-azimuth.md` under “Deposits during adapter exclusion.” `docs/audits.md` marks the related AZ-BSK-3 row fixed; this reproduction shows the RobotMoneyVault path remains reachable at this baseline. Reconcile that disposition.

### 2. Low — an admin can accidentally register one strategy adapter twice

**Code:** `RobotMoneyVault.sol:467-473, 938-947, 845-921`.

`addAdapter` checks eligibility and count, but never checks whether the address is already active. `totalAssets()` then adds the same adapter balance once per entry, overstating NAV. The withdrawal loop also treats both entries as independent, so a full redemption asks one adapter to deliver the same funds twice and reverts with `InsufficientAdapterLiquidity`. This requires an admin configuration error; the resulting vault accounting failure is silent until users interact.

**Reproduction:** Deposit 1,000 USDC, register the same adapter again, and `totalAssets()` becomes 2,000 USDC. Redeeming all shares reverts. `SecurityReviewPoc.test_duplicateAdapterDoubleCountsNavAndBlocksFullRedemption` passes.

**Recommendation:** Reject an adapter address already present as an active entry. Provide an explicit reactivation path for inactive entries if needed.

**History:** Previously reported as SR-M15 (`20260612-code-review-internal-claude.md`) and L-002 (`20260728-code-review-internal-kimi.md`); still reproducible.

### 3. Medium — one gateway agent can attribute a committee vote to another

**Code:** `gateway/RobotMoneyGateway.sol:1529-1536`, `gateway/InvestmentCommitteePolicy.sol:213-231`.

Committee membership is admin-controlled. Gateway agent membership is also available permissionlessly: an attacker can call `commitAuthorization`, wait one block, and call `revealAuthorization` with a policy naming itself as `shareReceiver` (`RobotMoneyGateway.sol:632-700`). This grants `AGENT_ROLE` without multisig approval.

That agent can then call `committeeVoteSubmit`. The gateway forwards caller-controlled `p.agent`; the policy checks whether `p.agent` has `COMMITTEE_AGENT_ROLE`, not whether that address submitted the vote. An attacker can therefore publish arbitrary vote fields attributed on-chain to an existing allowlisted committee member. This violates the identity model in `docs/architecture.md:601`, which relies on an agent submitting its own vote.

The IC policy is signalling-only. The demonstrated impact is false vote provenance, with potential influence on consumers of those votes. There is no demonstrated ability to change router allocations, release consensus receipts, or move vault funds through this bug. Those actions retain their separate authorization gates.

**Reproduction:** A fresh address obtains gateway agent status through commit/reveal, then submits a vote with `p.agent` set to an existing allowlisted member. The stored vote names that member even though the caller has no committee role. `SecurityReviewCommitteePoc.test_permissionlessAgentCanImpersonateCommitteeMember` passes. No admin transaction is used to onboard the attacker.

**Recommendation:** In `committeeVoteSubmit`, require `p.agent == msg.sender` or overwrite the forwarded agent field with `msg.sender`. Keep the policy's role check on that authenticated identity.

This finding does **not** concern `ConsensusRecommendationReceipt.recordReceipt`: its gateway entry point passes the actual `msg.sender` as submitter, and the receipt checks that submitter's committee role. Receipt release is separately `ADMIN_ROLE` gated.

## Verification

- `forge test --match-path 'contracts/test/SecurityReview*Poc.t.sol' --match-test 'test_duplicateAdapterDoubleCountsNavAndBlocksFullRedemption|test_revokedAdapterReactivationTransfersValue|test_permissionlessAgentCanImpersonateCommitteeMember' -vv` — 3 passed, 0 failed, across 2 test contracts.
- Existing `RobotMoneyVaultTest.test_ADP2_revokedAdapterExcludedFromNavAndPulls` — passed, confirming the NAV exclusion that enables finding 1.

## Remaining review work

The V4 recorder's public sampling and extrapolation deserve further adversarial testing, including transient price changes reversed after a record and gaps between honest records. No additional finding or profitable oracle attack is claimed here. Live deployment bytecode, role assignments, pool liquidity, keeper cadence, and configuration must be checked separately before assigning deployment-specific exposure to these source findings.

No production code was changed. The report and two `SecurityReview*Poc.t.sol` files remain uncommitted review artifacts in the isolated worktree.
