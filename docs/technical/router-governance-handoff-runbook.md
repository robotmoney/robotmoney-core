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
SUBMITTER (records a receipt: id, payload digest, payload URI)
   │  recordReceipt on the receipt contract, RECEIPT_SUBMITTER_ROLE only
   ▼
SAFE schedules ONE timelock call                                   ← govern row `apply-receipt`
   │  RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)
   ▼
timelock delay (172800 s on 8453; 900 to 172799 s in a rehearsal, release runbook 4.10)
   ▼
SAFE executes the call → receipt released, router weights applied
   ▼
verifier reads isReleased(receiptId) and the router weights back
```

There is no voting by token holders or anyone else: no voter set, no voting
power, no quorum, no voting period, no execution delay, no propose, vote or
execute. `RouterGovernance` has no propose, vote or execute function (issue
1698). The mainnet test deployment ran the earlier bytecode with voter addresses
nobody holds. Nothing
submits a weight change unattended: every rebalance is a Safe-signed timelock
operation. This runbook is the operator's playbook for that path, end to end.

**System boundary (owner decision 2026-10-19).** Everything on this path
belongs to the vaults system: the receipt contract, `RouterGovernance`, the router, the Safe and the timelock. The rmpc gateway
system (`RobotMoneyGateway` and `rmpc`) is a separate client of the vaults
system. The weight path works with no gateway deployed.

**Deployed release (v0.5.0).** The deployed contracts still route committee
writes through the gateway. A committee agent records through
`RobotMoneyGateway.consensusRecordReceipt`
(`consensus-receipt-submitter-runbook.md` §1). Both committee contracts bind
one gateway address. Steps below marked "deployed release" apply to it. The
system split review records where the code differs (`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-system-split.md`).

---

## 1. The weight setter and its replacement

`PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE`, which is its own
role admin (core 1522). `RouterGovernance` holds it, together with router
`ADMIN_ROLE`. The `TimelockController` holds `ADMIN_ROLE` and
`RouterGovernance`'s own `WEIGHT_SETTER_ROLE` on `RouterGovernance`. The
`apply-receipt` call is `RouterGovernance.applyReceipt(receiptId,
payloadDigest, vaults, bps)`, which the timelock reaches through that
`WEIGHT_SETTER_ROLE`. It releases the receipt and calls
`PortfolioRouter.setWeights` in one call. It sets the router's active vector.
The default vector stays the fallback.

**No receipt submitter holds weight-setting or timelock authority.** The
`RECEIPT_SUBMITTER_ROLE` holder set is disjoint from the timelock and every
`WEIGHT_SETTER_ROLE` holder (`GovernanceSeparationInvariant.t.sol`). Granting
a submitter any of those is a security-model change requiring a new ADR against INV-4; it is not
an ordinary ops action and must never be performed by this runbook's steps.

**Replacing RouterGovernance is a rotation, not a redeploy (core 1571).**
`RouterGovernance` has no upgrade path, so a buggy instance cannot be fixed in
place. Replace it through the router's bounded
rotation of `WEIGHT_SETTER_ROLE` (ADR-0002). Granting a
new `RouterGovernance` `ADMIN_ROLE` does not move `setWeights` authority,
because `setWeights` is gated on `WEIGHT_SETTER_ROLE`, which no role admin can
grant. Only the rotation moves it.

1. Deploy the new `RouterGovernance` against the existing router and receipt
   register (`RouterGovernance.router` and `receipts` are immutables). Its
   deployer hands its `ADMIN_ROLE` and its own `WEIGHT_SETTER_ROLE` (the
   `applyReceipt` gate) to the timelock and drops both copies. The timelock
   must be the only holder of that `WEIGHT_SETTER_ROLE`. The new instance
   starts empty.
2. The Safe calls `router.proposeWeightSetterRotation(newGovernance)` directly.
   It needs the Safe's 2-of-3 signatures. The target must be a contract. Only
   one proposal can be pending. The `WeightSetterRotationProposed` log and
   `pendingWeightSetterRotation()` make it observable, and the stage 12
   verifier fails while it is pending.
3. The Safe schedules ONE timelock batch (`scheduleBatch`) with three router
   calls, in this order: `executeWeightSetterRotation(newGovernance)`,
   `grantRole(ADMIN_ROLE, newGovernance)`, `revokeRole(ADMIN_ROLE, oldGovernance)`.
   Add two calls on the `ConsensusRecommendationReceipt` register to the same
   batch: `grantRole(ADMIN_ROLE, newGovernance)` and
   `revokeRole(ADMIN_ROLE, oldGovernance)`. `applyReceipt` releases the receipt,
   so the new instance needs that role.
   Never schedule them separately. The execute call does not touch `ADMIN_ROLE`,
   so the old `RouterGovernance` would keep it (caps, quarantine, default
   weights) between operations. The batch runs once the timelock delay has
   passed (172800 s on 8453; 900 to 172799 s in a rehearsal, release runbook 4.10), counted from the proposal in step 2 and from the
   schedule. Anyone may then run the ready batch. To abort before execution, the
   Safe calls `router.cancelWeightSetterRotation()` and cancels the scheduled
   batch. The timelock cannot cancel.
4. Check after the batch: `getRoleMemberCount(WEIGHT_SETTER_ROLE) == 1`, the new
   instance holds `WEIGHT_SETTER_ROLE` and router `ADMIN_ROLE`, and the old
   instance holds neither. The new instance holds the receipt register's
   `ADMIN_ROLE` and the old one does not. The timelock is the one holder of the
   new instance's own `WEIGHT_SETTER_ROLE`. The verifier asserts both
   (`receipt: ADMIN_ROLE held by governance (applyReceipt releases)` and
   `governance: WEIGHT_SETTER_ROLE (applyReceipt) held by timelock`). Check the router caps, `quarantineAddress` and
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

**Replacing the router itself.** The rotation does not cover this. A new
router needs a redeploy of the vaults-system pieces that bind it (steps 1, 2
and 5). The gateway deposits only into vaults, so it does not need the new
router. On the deployed release the gateway still holds the router as an
immutable, so steps 3 and 4 apply to the deployed release only (§0):

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
   immutable. The new instance starts empty. Run the governance stage (7 on
   v0.5.0) and the timelock stage (11) again for the new pair.
3. The gateway has no router binding in the target: the `routerContract`
   slot is retired (owner decision 2026-10-20). A router change needs no
   gateway redeploy. The gateway keeps serving deposits into its allowed
   vaults. Agent authorizations stay where they are.
4. The receipt contract is untouched by a router change. It binds nothing
   to the gateway or the router.

   > **Deployed release (v0.5.0) only.** On release v0.5.0
   > `RobotMoneyGateway.routerContract` is an immutable, so a router change
   > there means a new gateway in its own run, with depositors authorizing
   > agents on it again, plus a new `InvestmentCommitteePolicy` and
   > `ConsensusRecommendationReceipt` (`DeployInvestmentCommitteePolicy`)
   > wired with `setICPolicy` and `setConsensusReceipt`. None of that applies
   > to the target.
5. The Safe schedules and executes `VaultRegistry.setRouter(newRouter)` through
   the admin timelock. The deployer cannot do it: it no longer holds the
   registry `ADMIN_ROLE`. The registry does not need a redeploy because
   `setRouter` is repeatable. `setRouter(address(0))` is refused while the old
   router still carries default weights, so never unlink first. Re-link
   straight to the new router, whose default weights step 1 already set.
6. Retire the old router. `setRouter` does not stop it. The gateway is not
   retired with the router: it has no router binding (step 3). Where a
   gateway does need to stop, the pause is `RobotMoneyGateway.pauseDeposits()`,
   which reverts `deposit` with `DepositsArePaused`.
   The holder of `DEPOSIT_PAUSER_ROLE` (the pauser key set at deploy, which the
   timelock handover does not touch) calls it directly. It needs no timelock
   call. Only `unpauseDeposits()` needs the timelock-held `ADMIN_ROLE`. Do not
   use the vault's `pauseDeposits()`. The vault is shared, so that would stop
   the new gateway as well. The old router has no switch of its own.
   `PortfolioRouter.deposit` and `depositFor` are public with no gateway gate,
   so pausing the old gateway does not stop direct deposits to the old router.
   No router-level call stops the old router. The only stop is the shared vault
   `pauseDeposits`, which also halts the new gateway, so do not use it. Treat
   the old router as still depositable and tell users to stop using it. Each
   agent's owner may also call `revokeAgent`. Depositors redeem on the vault
   directly: the gateway has no withdrawal path, and a vault
   `pauseDeposits` never freezes a withdrawal. Old receipts stay on the
   receipt contract and do not move.
7. Re-point every off-chain reader at the new addresses:
   - dapp: `VITE_ROUTER_ADDRESS`, `VITE_GATEWAY_ADDRESS`, `VITE_GOVERNANCE_ADDRESS`
     (`clients/dapp/.env.example`) and the pinned `VITE_GATEWAY_EXPECTED_CODE_HASH`.
   - Rust payment client: `router_address`, `gateway_address`, `governance_address`
     and the pinned `gateway_runtime_hash` (`clients/rust-payment-client/config.example.toml`).
   - explorer indexer: `INDEXER_PORTFOLIO_ROUTER`, `INDEXER_ROUTER_GOVERNANCE`,
     `INDEXER_GATEWAY`, `INDEXER_CONSENSUS_RECEIPT` (`services/explorer-indexer/src/main.rs`).
   - publish-contracts manifests: the `router`, `gateway` and governance
     entries of the new deployment manifest (sheet keys `ROUTER_ADDRESS`,
     `GATEWAY_ADDRESS`, `GOVERNANCE_ADDRESS` and
     `CONSENSUS_RECEIPT_ADDRESS` are read from manifests, never typed).

Old receipts stay readable on the old receipt contract but do not move to the
new one. Allocation state on the old router does not carry over either.


---

## 2. The handoff path, step by step

### Step 1 — the submitter records a receipt

The receipt submitter records the committee's consensus on the receipt
contract (`ConsensusRecommendationReceipt.recordReceipt`, gated by
`RECEIPT_SUBMITTER_ROLE`; `consensus-receipt-submitter-runbook.md`). On the
deployed release the call goes through the gateway (§0). The receipt
stores the id, the payload digest and the payload URI. The digest is
`keccak256("robotmoney:consensus-receipt:v1\n" || compact JSON || "\n")`,
never a plain `keccak256` of the file (`publish-contracts/src/receipt-digest.ts`). It
moves no funds and calls no `setWeights`. Most receipts are recorded and never
applied: the Safe applies a receipt by scheduling the call in Step 2 and
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
- its stored digest equals `keccak256("robotmoney:consensus-receipt:v1\n" || payload bytes)` (the payload file as the canonical route serves it, with its trailing newline; `publish-contracts/src/receipt-digest.ts`),
- the receipt is not yet released,
- the payload's weight vector sums to 10 000 bps,
- the vault set and order equal the registry's router-eligible list.

It then schedules ONE timelock call through the real Safe (`schedule`):
`RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)`. The
Safe's signers sign one transaction. The CLI exits `GOVERN_PENDING` (exit 15)
with the ready time and the exact resume command. On 8453 the row runs only
when named with `--row apply-receipt` and a receipt id, as a post-launch action
with its own 172800 s delay (900 to 172799 s in a rehearsal, release runbook 4.10); it is never part of stage 13 (the four vault
unpauses). The Twin rehearsal runs the same row after the unpause rows and
warps the delay. A Twin run proves the row executes on the real contracts; it
is not evidence that mainnet governance works.

### Step 3 — the delay passes

The timelock enforces its real delay (172800 s on 8453; 900 to 172799 s in a rehearsal, release runbook 4.10). To abort, the Safe
cancels the scheduled operation on the timelock before the delay passes.
Nothing else can stop or speed up the operation.

### Step 4 — the Safe executes the call

The same command resumes: the Safe executes the call, the receipt flips to
released and the router's active weight vector becomes the receipt's allocation
in the same transaction. `applyReceipt` re-checks that the receipt is recorded,
unreleased and that the payload digest matches. Partial state is impossible:
release and weights are one call, so a reverting weight call releases nothing.

### Step 5 — read back and record

The tool reads `isReleased(receiptId)` and the router's weights back and fails
if either differs from the payload. Record the application in the evidence file
under `receipt_applications` (`publish-contracts/evidence.example.json`,
core 1696), and rerun the stage 12 verifier, which labels the applied receipt and weights.

---

## 3. Compromise and incident response

| Compromised role | Blast radius | Response |
|---|---|---|
| **Submitter Safe** (recorded a receipt) | Can anchor a wrong digest, polluting the public record; cannot release, cannot set weights. | New session id + public correction (`consensus-receipt-submitter-runbook.md`). Target: `revokeRole(RECEIPT_SUBMITTER_ROLE, safe)` via the timelock. Deployed release (v0.5.0): no `RECEIPT_SUBMITTER_ROLE` exists there; revoke with `InvestmentCommitteePolicy.revokeAgent` plus `RobotMoneyGateway.revokeAgent` (the timelock owns the agent, so both are timelock calls). Never schedule `apply-receipt` for a receipt under correction. |
| **One Safe signer's key** | Can sign, alone, nothing: the Safe threshold needs more than one signer. | Rotate the signer on the Safe; cancel any operation that signer helped schedule and is still pending. |
| **Payload file on the operator host** | Cannot pass the digest check unless it is the recorded payload; cannot change what the receipt says. | Rebuild from clean state; re-fetch the payload from the receipt's URI and re-run the row. |
| **`ADMIN_ROLE` and `WEIGHT_SETTER_ROLE` on `RouterGovernance`** (held by the timelock) | Reaches `applyReceipt` and `setDefaultWeights` only after a Safe-signed schedule and the delay. | The Safe cancels the pending operation; verify the submitter and weight-setter sets are still disjoint (`GovernanceSeparationInvariant.t.sol`). |

---

## 4. Post-deployment verification

Every deploy that touches the weight setter, the receipt contract or the timelock
must re-run:

```bash
forge test --match-contract GovernanceSeparationInvariant   # submitter ⊥ weight setter
forge test --match-test testSignallingOnlyBoundary          # INV-4 static boundary
```

These fail loudly if the submitter and the weight-setting bodies ever overlap or
if the receipt contract gains a `setWeights` path of its own. After an
`apply-receipt` round, the stage 12 verifier's read-back of `isReleased` and the
router weights is the acceptance evidence.
