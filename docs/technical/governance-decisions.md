# ADR — Router-weight governance: the Safe applies consensus receipts through the weight setter

> Scope: decision record for router-weight governance. It fixes who may change
> Portfolio Router weights, through which call path, and what the Investment
> Committee's consensus receipt has to do with it. No bytecode, explorer
> changes, or rmpc commands are produced by this record.
>
> Closes the open question listed under `docs/architecture.md` §10
> ("Router-weight governance implementation").

The Investment Committee's only on-chain output is the consensus receipt. There is no on-chain committee vote or tilt (owner decision 2026-10-19). A receipt is recorded by a `RECEIPT_SUBMITTER_ROLE` holder under its own address and released only by the Safe applying it through the timelock. The receipt is the only rebalancing signal the Safe may cite. The vector the Safe schedules through `applyReceipt` is the input; the chain cannot parse the payload, so readers compare the applied vector to the payload (owner decision 2026-10-20).

---

## 1. Status

Accepted. Written against `docs/architecture.md` §2.3, §4.2, §10,
`docs/prd.md` §"Allocation Governance" and §12 INV-4, and
`docs/product/20260623-product-proposal-investment-committee-v0.md` §3.4.

---

## 2. Context

`docs/architecture.md` §2.3 fixes the governance boundary: router-weight
governance controls Portfolio Router target weights across active vaults and
nothing else. It cannot govern vault onboarding, vault retirement, per-vault
asset selection, per-vault strategy internals, adapter selection, adapter caps,
fees, or agent permissions.

The Investment Committee is a group of analysts that sign a consensus receipt
off-chain with Ed25519 keys. A submitter holding `RECEIPT_SUBMITTER_ROLE` on
`ConsensusRecommendationReceipt` records it: a receipt id, a payload digest and
a payload URI, written on chain by `recordReceipt`. A receipt is a recommendation. It
moves no funds and sets no weights by itself.

**Two systems (owner decision, 2026-10-19).** Router-weight governance belongs
to the vaults system: the vaults, VaultRegistry, PortfolioRouter,
RouterGovernance and ConsensusRecommendationReceipt, governed by the Safe
through the TimelockController. The rmpc gateway system (RobotMoneyGateway and
`rmpc`) is a separate system and a client of the vaults system. The receipt
submitter records receipts on the receipt contract directly, not through the
gateway. Rebalancing works with no gateway
deployed.

`contracts/PortfolioRouter.sol` is deployed. `setWeights(address[], uint256[])`
and `setDefaultWeights(address[], uint256[])` are the only functions that
change the weight vector. `setWeights` is gated by `WEIGHT_SETTER_ROLE`, which
is its own role admin (core 1522). `setDefaultWeights` is gated by the router's
`ADMIN_ROLE`.

Three questions had to be fixed before any router-weight tooling was written:

1. **Who changes weights.** Which body is allowed to change the router's
   weight vector?
2. **How a receipt becomes weights.** What turns a committee recommendation
   into an applied allocation?
3. **setWeights call path.** Which contract is the sole caller of
   `PortfolioRouter.setWeights`?

---

## 3. Decisions

### 3.1 One body changes configuration

**The Safe multisig, through the `TimelockController`, is the only body that
changes any vaults-system contract configuration, router weights included.**
Who governs the gateway is an open question for the gateway's own release.

Every privileged change (roles, caps, fees, eligibility, default weights,
receipt release, router weights) is a Safe-signed timelock operation: the Safe
reaches its signer threshold, schedules the operation, the timelock delay
passes (172800 s on 8453), and the Safe executes it. No EOA, keeper, relay or
agent changes configuration. `docs/technical/security-model.md` §4 is the
authority on the channel; this record only states that router weights are not
an exception to it.

### 3.2 A receipt is applied, not voted on

**The receipt submitter records the Investment Committee's consensus receipt.
The weight setter applies it through the timelock. That application is the
rebalance.**

The committee's output is a receipt (`recordReceipt`, submitter gated by
`RECEIPT_SUBMITTER_ROLE` on the receipt contract). Nothing happens to the router at record time. When the
Safe decides to act on a receipt, it schedules **one** timelock call that
releases the receipt and applies its weight vector:

- publish-contracts govern row `apply-receipt` (core 1696) takes the receipt id
  and the payload file;
- before anything is sent it checks that the receipt is recorded, that its
  stored digest equals `keccak256` of the payload bytes, that the receipt is not
  yet released, that the payload's bps sum to 10 000, and that the vault set and
  order equal the registry's router-eligible list;
- the Safe schedules one `schedule` whose call is
  `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)`, the
  weight setter's call (`WEIGHT_SETTER_ROLE`, held by the timelock);
- after the delay the Safe executes it. `applyReceipt` checks that the receipt
  is recorded, is not released and that `payloadDigest` equals its stored
  digest (§3.7), then calls `releaseReceipt(receiptId)` and
  `PortfolioRouter.setWeights(vaults, bps)` in the same call. The tool reads
  `isReleased(receiptId)` and the router's active and effective weights back,
  failing on any difference.

Inside `applyReceipt`, release and weights are one call: applied weights whose
receipt is unreleased cannot exist, and `applyReceipt` never releases a
receipt without its weights. A receipt can still be released WITHOUT weights.
The timelock holds `ADMIN_ROLE` on the receipt register directly (the timelock
stage grants it), and the standalone `release-receipt` govern row calls
`releaseReceipt` alone. A receipt released that way can never be applied: a
later `applyReceipt` for it reverts `ReceiptAlreadyReleased` at execute,
after its own delay, and the submitter records a new receipt instead
(`RouterGovernanceApplyReceipt.t.sol::test_applyReceipt_revertsOnReleasedReceipt`).
So "released" does not mean "applied"; a reader checks `ReceiptApplied` (or the
router's weights) for that (security review 2026-10-15, review-security-023).
`applyReceipt` sets the router's active vector. The router's default vector is
untouched and stays the fallback (ADR-0002).
Admin discretion (D5 in the product proposal) is the Safe's choice of which
receipt to apply and when. Most receipts are recorded and never applied: the
Safe applies a receipt by scheduling the call, and declines one by doing
nothing.

### 3.3 No voting

**There is no voting by token holders or anyone else: no voter set, no voting
power, no quorum, no voting period, no execution delay, no propose, vote or
execute.**

Weights are an outcome of the committee's consensus and the Safe's decision to
apply it, not of a tally. `RouterGovernance` has no propose, vote or execute
function, no voter set and no voting event (issue 1698): every one of them was
unused and every one was attack surface on the weight path (security review
2026-10-12, finding 4: one voter met quorum). The final deployment's verifier
asserts that the deployed runtime code dispatches none of the deleted voting
selectors. The mainnet test deployment ran the earlier bytecode with voter
addresses nobody holds keys for. rmpc has no vote command, and no client builds
a call to the deleted functions (CI gate
`.github/scripts/check_no_router_governance_voting.sh`).

The only delay in the path is the timelock's own delay. The only threshold is
the Safe's signer threshold.

### 3.4 The submitter and the weight setter are disjoint

**No receipt submitter holds `WEIGHT_SETTER_ROLE`, router `ADMIN_ROLE` or any
timelock role, and no timelock address holds `RECEIPT_SUBMITTER_ROLE`.**

The committee recommends; the Safe applies. The two sets of addresses must not
overlap, so a compromised submitter key can at most record a wrong receipt, and
a receipt can at most be applied by a Safe-signed timelock operation after its
delay. `GovernanceSeparationInvariant.t.sol` asserts the disjointness. Granting
a submitter any weight-setting or timelock authority is a security-model
change that needs a new ADR against INV-4; it is not an ordinary admin action.

### 3.5 Receipt lifecycle

A receipt has two on-chain states.

| State | Entry condition | Exit conditions |
|---|---|---|
| **Recorded** | `recordReceipt` succeeded from a `RECEIPT_SUBMITTER_ROLE` holder. | The `apply-receipt` call executes: `Released`. A receipt the Safe never schedules stays `Recorded`. |
| **Released** | `applyReceipt` released it, and applied the receipt's weights in the same call. | Terminal. |

Events: `ReceiptRecorded` and `ReceiptReleased` on the receipt contract,
`WeightsSet` on the router and `ReceiptApplied(receiptId, payloadDigest,
vaults, bps)` on `RouterGovernance`. There is no proposal, no vote and no
proposal event in the path, and no client renders proposals.

### 3.6 setWeights call path

**`WEIGHT_SETTER_ROLE` is the only authority over router weights, and the
weight setter acts only on a Safe-scheduled timelock operation.**

`PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE` (core 1522), not
by `ADMIN_ROLE`. The role is its own role admin: `ADMIN_ROLE` cannot grant it,
so the timelock cannot grant itself the role through a scheduled operation.

- `DeployRouterGovernance.s.sol` runs after the receipt register exists. It
  grants `RouterGovernance` router `WEIGHT_SETTER_ROLE`, router `ADMIN_ROLE` and
  the receipt register's `ADMIN_ROLE` (so `applyReceipt` can release), and
  drops the deployer's router `WEIGHT_SETTER_ROLE`.
- `RouterGovernance.applyReceipt` is gated by the contract's own
  `WEIGHT_SETTER_ROLE`, which is its own role admin. The timelock stage
  (`DeployTimelock.s.sol`) hands it to the `TimelockController` and drops the
  deployer's copy, and grants the timelock `ADMIN_ROLE` on `RouterGovernance`,
  which reaches `setDefaultWeights`. Each grant is read
  back by the script and asserted again by the verifier.
- Rotation (core 1616): `RouterGovernance` is replaced without a router
  redeploy through a bounded rotation, not through a role grant. The Safe holds
  `WEIGHT_SETTER_ROTATOR_ROLE` and proposes a contract target on the router
  (`proposeWeightSetterRotation`). The timelock holds
  `WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE` and executes it after the timelock's
  own delay, measured from the proposal (`executeWeightSetterRotation`). The
  Safe can cancel. Execution revokes every holder and grants the target, so one
  holder remains. Neither the timelock nor the Safe can grant either role or
  `WEIGHT_SETTER_ROLE` (all three are self-administered). Design and threat
  table: ADR-0002.

No off-chain relay, multisig signer alone, keeper or agent is in the
weight-update path.

**Emergency path.** `RouterGovernance` has no pause or guardian role, and no
function clears the router's applied vector or resets it to the default
(issue 1988, ADR-0002 amendment 2026-10-29). A bad applied vector is replaced
by a newer receipt through `apply-receipt`. A scheduled `apply-receipt` call
that should not run is cancelled on the timelock by the Safe before its delay
passes.

### 3.7 Payload-digest binding

**The receipt's `payloadDigest` commits to the canonical receipt bytes. The
`applyReceipt` call names the digest its vector was derived from, the contract
refuses a digest that is not the stored one, and the vector-to-payload
derivation is checked off chain before anything is sent and is publicly
re-derivable after.**

- What the digest commits to: `keccak256("robotmoney:consensus-receipt:v1\n"
  || compact JSON || "\n")`, the whole signed receipt (session, stances, judge
  rationale and the `weights` list of bucket and `weight_bps`). It is the one
  scheme every path uses (`publish-contracts/src/receipt-digest.ts`).
- Why the contract does not recompute it: the vector is a parse of JSON
  through the bucket-to-vault table and the registry's eligible order. The EVM
  cannot parse the payload, and carrying the payload in calldata (tens of
  kilobytes through the Safe and the timelock) would still leave the parse off
  chain. A digest over the router vector alone would change what the committee
  signs, which is out of this record's scope.
- What the contract checks: the receipt is recorded, it is not released, and
  the `payloadDigest` argument equals the stored digest
  (`PayloadDigestMismatch` otherwise). The scheduled calldata therefore names
  the anchored payload the Safe signers approved, and a call built against
  another payload, or replayed for a released receipt, reverts.
- What the row checks before anything is sent (`apply-receipt`, §3.2): the
  payload file's digest equals the stored digest, the vector is the payload's
  `weights` mapped to vaults, it sums to 10 000 and it lists exactly the
  registry's router-eligible vaults in registry order.
- What anyone can check after: `ReceiptApplied` records the receipt id, the
  digest and the vector together. Re-deriving the vector from the public
  payload and comparing it to the event is a pure function of public data.
- Uniqueness: a digest binds a vector but does not prove it is well formed.
  `PortfolioRouter.setWeights` and `setDefaultWeights` refuse a vector that
  names a vault twice (`DuplicateVault`, security review 2026-10-12 finding 8),
  so the receipt path keeps that check too.

---

## 4. Authority source

`RouterGovernance.sol` requires no token interface. Authority over weights is
`WEIGHT_SETTER_ROLE` plus the Safe-scheduled timelock operation (§3.6). There
is no token-based governance and no governance token.

---

## 5. Downstream issues and sequencing

| Issue | Unblocked by this ADR? | Must serialize after |
|---|---|---|
| publish-contracts govern row `apply-receipt` (core 1696) | Yes — call path and checks fixed in §3.2 | This ADR |
| Weight-setter `applyReceipt` call and deletion of `propose`/`vote`/`execute` (issue 1698) | Yes — §3.3, §3.6 and §3.7 | core 1696 |
| Twin rehearsal proving the row through the real Safe and timelock | Yes | core 1696 |
| Explorer: receipt tables and the applied-weights read surface | Yes — §3.5 | Receipt contract deployed |
| `rmpc get-governance` | Yes — reads the router weights and the receipt state | Explorer API |

**Strict serial dependency:**

- The `WEIGHT_SETTER_ROLE` grant (§3.6) cannot happen until
  `RouterGovernance.sol` is deployed to the target network. Deploy scripts
  sequence this explicitly.
- The weight-setter contract (issue 1698) lands before the final deployment,
  never on the mainnet test.

---

## 6. Integration risks

### 6.1 Receipt and payload drift

**Risk.** The payload file an operator hands to `apply-receipt` could differ
from the payload the committee recorded.

**Resolution.** The row refuses to send anything unless the receipt's stored
digest equals the receipt digest of the payload bytes, so the weights applied
are the weights the committee recorded, and `applyReceipt` refuses a call that
names another digest (§3.7). Nothing is read from a URI at apply time.

### 6.2 Discretion and whiplash

**Risk.** The Safe could apply receipts at any cadence, or none.

**Resolution.** That is the design: admin discretion (D5) is the Safe's choice
of which receipt to apply and when. A receipt the Safe does not schedule has no
effect. Routing is never stuck: the router routes by its on-chain default
vector until a receipt is applied (ADR-0002).

### 6.3 Weight validation

**Risk.** `PortfolioRouter` requires every vault in the vector to be router
eligible and active, and the bps to sum to exactly 10 000. A vault paused
between record and apply makes the weight call revert.

**Resolution.** The row validates the sum and the vault set against the
registry before scheduling, and the router validates again at execution. A
reverting `applyReceipt` applies nothing and releases nothing: the Safe records a new
receipt round rather than patching the payload.

### 6.4 One operation per receipt

A receipt that is already released is refused by the row. A second
`apply-receipt` round for the same receipt id cannot be scheduled.

### 6.5 Replacing a broken `RouterGovernance`

Replacing the weight-setter contract uses the rotation in §3.6. The runbook is
`docs/technical/router-governance-handoff-runbook.md`.

### 6.6 No outer share token

`RouterGovernance.sol` must not introduce any token minting, wrapping, or LP
mechanics. Its only on-chain side effects are router weight calls and the
receipt release inside `applyReceipt` (`docs/architecture.md` §2.2).

---

## 7. Read surface

The read surface `rmpc get-governance` and the dapp depend on:

```solidity
/// @notice The weight vector currently active on PortfolioRouter (RouterGovernance).
function currentWeights() external view returns (address[] memory vaults, uint256[] memory bps);

/// @notice The router's on-chain default weight vector (ADR-0002).
function getDefaultWeights() external view returns (address[] memory vaults, uint256[] memory bps);

/// @notice Whether a recorded receipt has been released (and so applied).
function isReleased(bytes32 receiptId) external view returns (bool);
```

`RouterGovernance` has no proposal read surface. Implementers must not change
the read surface above without a new ADR.
