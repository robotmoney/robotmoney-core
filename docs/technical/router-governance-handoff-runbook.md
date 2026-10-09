# Router-weight governance handoff — from a consensus receipt to applied weights

Canonical: `docs/product/20260623-product-proposal-investment-committee-v0.md` §3.4, §6.2
Canonical: `docs/technical/governance-decisions.md`
Canonical: `docs/technical/security-model.md` §4
Implements: issue #1248 tasks 5.5, 5.8, 5.9 and acceptance criteria 5, 6; core 1696 (`apply-receipt`)

---

## 0. Purpose and the separation that makes it a control, not a label

The committee **recommends**; a **different** body **applies**. The Safe
multisig, through the `TimelockController`, is the only body that changes any
Robot Money contract configuration, router weights included. `WEIGHT_SETTER_ROLE`
is the only authority over router weights (INV-4, `docs/prd.md` §12). It
submits the Investment Committee's consensus receipt, and that submission is the
rebalance:

```
COMMITTEE (records a receipt: id, payload digest, payload URI)
   │  recordReceipt through the gateway, COMMITTEE_AGENT_ROLE only
   ▼
SAFE schedules ONE timelock batch                                  ← govern row `apply-receipt`
   │  releaseReceipt(receiptId) + the router weight change
   ▼
timelock delay (172800 s on 8453)
   ▼
SAFE executes the batch → receipt released, router weights applied
   ▼
verifier reads isReleased(receiptId) and the router weights back
```

There is no voting by token holders or anyone else: no voter set, no voting
power, no quorum, no voting period, no execution delay, no propose, vote or
execute. `RouterGovernance.propose`, `vote` and `execute` exist in the deployed
test bytecode, are unused, have no voters, and are deleted before the final
deployment, when a weight-setter `applyReceipt` call replaces them. Nothing
submits a weight change unattended: every rebalance is a Safe-signed timelock
operation. This runbook is the operator's playbook for that path, end to end.

---

## 1. The weight setter and its replacement

`PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE`, which is its own
role admin (core 1522). `RouterGovernance` holds it, together with router
`ADMIN_ROLE`, and the `TimelockController` holds `ADMIN_ROLE` on
`RouterGovernance`. On today's bytecode the weight call inside the
`apply-receipt` batch is `RouterGovernance.setDefaultWeights(vaults, bps)`,
which the timelock reaches through that `ADMIN_ROLE`. The final deployment
replaces it with a weight-setter `applyReceipt` call, and the role ends with the
timelock.

**No committee agent holds weight-setting or timelock authority.** The
`COMMITTEE_AGENT_ROLE` holder set is disjoint from the Safe signers, the
timelock and every `WEIGHT_SETTER_ROLE` holder
(`GovernanceSeparationInvariant.t.sol`). Granting a committee agent any of
those is a security-model change requiring a new ADR against INV-4; it is not
an ordinary ops action and must never be performed by this runbook's steps.

**Replacing RouterGovernance is a rotation, not a redeploy (core 1571).**
`RouterGovernance` has no upgrade path, so a buggy instance cannot be fixed in
place. Replace it through the router's bounded
rotation of `WEIGHT_SETTER_ROLE` (ADR-0002). Granting a
new `RouterGovernance` `ADMIN_ROLE` does not move `setWeights` authority,
because `setWeights` is gated on `WEIGHT_SETTER_ROLE`, which no role admin can
grant. Only the rotation moves it.

1. Deploy the new `RouterGovernance` against the existing router
   (`RouterGovernance.router` is an immutable). Its deployer hands its
   `ADMIN_ROLE` to the timelock. The constructor's cadence arguments are
   unused configuration on today's bytecode, and the new instance starts
   empty.
2. The Safe calls `router.proposeWeightSetterRotation(newGovernance)` directly.
   It needs the Safe's 2-of-3 signatures. The target must be a contract. Only
   one proposal can be pending. The `WeightSetterRotationProposed` log and
   `pendingWeightSetterRotation()` make it observable, and the stage 12
   verifier fails while it is pending.
3. The Safe schedules ONE timelock batch (`scheduleBatch`) with three router
   calls, in this order: `executeWeightSetterRotation(newGovernance)`,
   `grantRole(ADMIN_ROLE, newGovernance)`, `revokeRole(ADMIN_ROLE, oldGovernance)`.
   Never schedule them separately. The execute call does not touch `ADMIN_ROLE`,
   so the old `RouterGovernance` would keep it (caps, quarantine, default
   weights) between operations. The batch runs once the timelock delay has
   passed (172800 s on 8453), counted from the proposal in step 2 and from the
   schedule. Anyone may then run the ready batch. To abort before execution, the
   Safe calls `router.cancelWeightSetterRotation()` and cancels the scheduled
   batch. The timelock cannot cancel.
4. Check after the batch: `getRoleMemberCount(WEIGHT_SETTER_ROLE) == 1`, the new
   instance holds `WEIGHT_SETTER_ROLE` and router `ADMIN_ROLE`, and the old
   instance holds neither. Check the router caps, `quarantineAddress` and
   default weights are unchanged (`routerCap`, `vaultCap[*]`,
   `quarantineAddress`, `getDefaultWeights`).
5. The target must not be able to grant `WEIGHT_SETTER_ROLE` to other accounts.
   Execution revokes every holder in a loop of about 19k gas per holder, so a
   target that floods the role with holders (1501 holders cost about 28.97M gas)
   could make the rotation unexecutable. The current `RouterGovernance` has no
   such path. Audit any other target for it before proposing. The router refuses
   itself, the Safe and the timelock as targets.
6. Update the governance entry of the governance manifest to the new address,
   then rerun the stage 12 verifier. Re-point the off-chain readers listed in
   redeploy step 7 that name the governance address (`VITE_GOVERNANCE_ADDRESS`,
   `governance_address`, `INDEXER_ROUTER_GOVERNANCE`).

The old instance cannot set weights after step 4. Nothing on it carries over.

**Replacing the gateway or the router themselves.** The rotation does not cover
these. The gateway holds the router as an immutable, so a new router needs a
redeploy that cascades:

1. Deploy a new `PortfolioRouter`. Do not rerun `DeployPortfolioRouter.s.sol`
   against the existing deployment. It calls `registry.setRouterEligible` and
   `registry.setRouter` as the deployer, who no longer holds the registry
   `ADMIN_ROLE`, so it would revert. Deploy the router contract on its own.
   The constructor grants the deployer `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE` on
   the new router, and the constructor defaults apply until you set otherwise.
   Order matters. While the deployer still holds `ADMIN_ROLE` on the new router,
   which is before the new router's `ADMIN_ROLE` moves to the timelock, the
   deployer sets `routerCap`, every `vaultCap[*]`, `quarantineAddress` and the
   default weights (`setRouterCap`, `setVaultCap`, `setQuarantineAddress`,
   `setDefaultWeights`). After that handover the same calls are Safe-scheduled
   timelock calls. Eligibility is already on the registry, so no
   `setRouterEligible` is needed. The default weights need one entry per
   router-eligible vault, so their length equals `registry.routerEligibleCount()`.
   The deployer's `WEIGHT_SETTER_ROLE` on the new router must be dropped too.
   Step 2 covers it.
2. Deploy a new `RouterGovernance` against it. `RouterGovernance.router` is an
   immutable. The new instance starts empty. Run the stage 6 and 11 handoff
   again for the new pair.
3. Deploy a new gateway. `RobotMoneyGateway.routerContract` is an immutable.
   Depositors must authorize agents on the new gateway again. Hand the new
   gateway to the timelock as well (gateway `ADMIN_ROLE` handover), not only
   the router pair.
4. Deploy a new `InvestmentCommitteePolicy` and `ConsensusRecommendationReceipt`
   (`DeployInvestmentCommitteePolicy`). Both hold the gateway as an immutable,
   and the receipt also takes the IC policy as an immutable, so they bind the
   gateway address (`DeployGateway.s.sol`). Wire them on the new gateway with
   `setICPolicy` and `setConsensusReceipt`.
5. The Safe schedules and executes `VaultRegistry.setRouter(newRouter)` through
   the admin timelock. The deployer cannot do it: it no longer holds the
   registry `ADMIN_ROLE`. The registry does not need a redeploy because
   `setRouter` is repeatable. `setRouter(address(0))` is refused while the old
   router still carries default weights, so never unlink first. Re-link
   straight to the new router, whose default weights step 1 already set.
6. Retire the old router and gateway. `setRouter` does not stop them. The old
   gateway stays depositable, and its router still serves any deposit routed
   through it. The pause is `RobotMoneyGateway.pauseDeposits()` on the old
   gateway, which reverts both `deposit` entry points with `DepositsArePaused`.
   The holder of `DEPOSIT_PAUSER_ROLE` (the pauser key set at deploy, which the
   timelock handover does not touch) calls it directly. It needs no timelock
   call. Only `unpauseDeposits()` needs the timelock-held `ADMIN_ROLE`. Do not
   use the vault's `pauseDeposits()`. The vault is shared, so that would stop
   the new gateway as well. The old router has no switch of its own.
   `PortfolioRouter.deposit` and `depositFor` are public with no gateway gate,
   so pausing the old gateway does not stop direct deposits to the old router.
   No router-level call stops the old router. The only stop is the shared vault
   `pauseDeposits`, which also halts the new gateway, so do not use it. Treat
   the old router as still depositable, tell users to stop using it, and pause
   the old gateway. Each agent's owner may also call
   `revokeAgent` on the old gateway. Users withdraw through the old gateway,
   because `pauseDeposits` never freezes a withdrawal. Old receipts and old
   agent authorizations stay on the old contracts and do not move.
7. Re-point every off-chain reader at the new addresses:
   - dapp: `VITE_ROUTER_ADDRESS`, `VITE_GATEWAY_ADDRESS`, `VITE_GOVERNANCE_ADDRESS`
     (`clients/dapp/.env.example`) and the pinned `VITE_GATEWAY_EXPECTED_CODE_HASH`.
   - Rust payment client: `router_address`, `gateway_address`, `governance_address`
     and the pinned `gateway_runtime_hash` (`clients/rust-payment-client/config.example.toml`).
   - explorer indexer: `INDEXER_PORTFOLIO_ROUTER`, `INDEXER_ROUTER_GOVERNANCE`,
     `INDEXER_GATEWAY`, `INDEXER_CONSENSUS_RECEIPT` (`services/explorer-indexer/src/main.rs`).
   - publish-contracts manifests: the `router`, `gateway` and governance
     entries of the new deployment manifest (sheet keys `ROUTER_ADDRESS`,
     `GATEWAY_ADDRESS`, `GOVERNANCE_ADDRESS`, `IC_POLICY_ADDRESS`,
     `CONSENSUS_RECEIPT_ADDRESS` are read from manifests, never typed).

Old receipts stay readable on the old receipt contract but do not move to the
new one. Allocation state on the old router does not carry over either.


---

## 2. The handoff path, step by step

### Step 1 — the committee records a receipt

A committee agent records the consensus through the gateway
(`ConsensusRecommendationReceipt.recordReceipt`, submitter gated by
`COMMITTEE_AGENT_ROLE`; `consensus-receipt-submitter-runbook.md`). The receipt
stores the id, the `keccak256` digest of the payload and the payload URI. It
moves no funds and calls no `setWeights`. Most receipts are recorded and never
applied: the Safe applies a receipt by scheduling the batch in Step 2 and
declines one by doing nothing (D5 admin discretion,
`docs/product/20260623-product-proposal-investment-committee-v0.md` §2.1).

### Step 2 — the Safe schedules `apply-receipt`

```
bun publish-contracts/src/cli.ts govern --row apply-receipt \
  --receipt-id 0x<64hex> --payload FILE \
  <the usual chain, RPC, sheet and signer arguments>
```

Before anything is sent the row checks, and exits `USAGE` on any failure:

- the receipt is recorded on chain,
- its stored digest equals `keccak256` of the payload bytes,
- the receipt is not yet released,
- the payload's weight vector sums to 10 000 bps,
- the vault set and order equal the registry's router-eligible list.

It then schedules ONE timelock batch through the real Safe (`scheduleBatch`):
`releaseReceipt(receiptId)` and the router weight change for that vector. The
Safe's signers sign one transaction. The CLI exits `GOVERN_PENDING` (exit 15)
with the ready time and the exact resume command. On 8453 the row runs only
when named with `--row apply-receipt` and a receipt id, as a post-launch action
with its own 172800 s delay; it is never part of stage 13 (the three basket
unpauses). The Twin rehearsal runs the same row after the unpause rows and
warps the delay. A Twin run proves the row executes on the real contracts; it
is not evidence that mainnet governance works.

### Step 3 — the delay passes

The timelock enforces its real delay (172800 s on 8453). To abort, the Safe
cancels the scheduled operation on the timelock before the delay passes.
Nothing else can stop or speed up the operation.

### Step 4 — the Safe executes the batch

The same command resumes: the Safe executes the batch, the receipt flips to
released and the router's weight vector becomes the receipt's allocation in the
same transaction. Partial state is impossible: release and weights are one
operation, so a reverting weight call releases nothing.

### Step 5 — read back and record

The tool reads `isReleased(receiptId)` and the router's weights back and fails
if either differs from the payload. Record the application in the evidence file
under `receipt_applications` (`publish-contracts/evidence.example.json`,
core 1696), and rerun the stage 12 verifier, which labels the applied receipt and weights.

---

## 3. Compromise and incident response

| Compromised role | Blast radius | Response |
|---|---|---|
| **Submitter EOA** (recorded a receipt) | Can anchor a wrong digest, polluting the public record; cannot release, cannot set weights. | New session id + public correction (`consensus-receipt-submitter-runbook.md`); revoke `AGENT_ROLE`/`COMMITTEE_AGENT_ROLE` via timelock. Never schedule `apply-receipt` for a receipt under correction. |
| **One Safe signer's key** | Can sign, alone, nothing: the Safe threshold needs more than one signer. | Rotate the signer on the Safe; cancel any operation that signer helped schedule and is still pending. |
| **Payload file on the operator host** | Cannot pass the digest check unless it is the recorded payload; cannot change what the receipt says. | Rebuild from clean state; re-fetch the payload from the receipt's URI and re-run the row. |
| **`ADMIN_ROLE` on `RouterGovernance`** (held by the timelock) | Reaches `setDefaultWeights` and `clearVotedWeights` only after a Safe-signed schedule and the delay. | The Safe cancels the pending operation; verify the committee and weight-setter sets are still disjoint (`GovernanceSeparationInvariant.t.sol`). |

---

## 4. Post-deployment verification

Every deploy that touches the weight setter, the receipt contract or the timelock
must re-run:

```bash
forge test --match-contract GovernanceSeparationInvariant   # committee ⊥ weight setter
forge test --match-test testSignallingOnlyBoundary          # INV-4 static boundary
```

These fail loudly if the committee and the weight-setting bodies ever overlap or
if the receipt contract gains a `setWeights` path of its own. After an
`apply-receipt` round, the stage 12 verifier's read-back of `isReleased` and the
router weights is the acceptance evidence.
