# ADR — Router-weight governance: the Safe applies consensus receipts through the weight setter

> Scope: decision record for router-weight governance. It fixes who may change
> Portfolio Router weights, through which call path, and what the Investment
> Committee's consensus receipt has to do with it. No bytecode, explorer
> changes, or rmpc commands are produced by this record.
>
> Closes the open question listed under `docs/architecture.md` §10
> ("Router-weight governance implementation").

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

The Investment Committee is a set of agents holding `COMMITTEE_AGENT_ROLE` on
`InvestmentCommitteePolicy`. The gateway records their consensus as a
`ConsensusRecommendationReceipt`: a receipt id, a payload digest and a payload
URI, written on chain by `recordReceipt`. A receipt is a recommendation. It
moves no funds and sets no weights by itself.

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
changes any Robot Money contract configuration, router weights included.**

Every privileged change (roles, caps, fees, eligibility, default weights,
receipt release, router weights) is a Safe-signed timelock operation: the Safe
reaches its signer threshold, schedules the operation, the timelock delay
passes (172800 s on 8453), and the Safe executes it. No EOA, keeper, relay or
agent changes configuration. `docs/technical/security-model.md` §4 is the
authority on the channel; this record only states that router weights are not
an exception to it.

### 3.2 A receipt is applied, not voted on

**The Investment Committee records a consensus receipt. The weight setter
applies it through the timelock. That application is the rebalance.**

The committee's output is a receipt (`recordReceipt`, submitter gated by
`COMMITTEE_AGENT_ROLE`). Nothing happens to the router at record time. When the
Safe decides to act on a receipt, it schedules **one** timelock operation that
releases the receipt and applies its weight vector:

- publish-contracts govern row `apply-receipt` (core 1696) takes the receipt id
  and the payload file;
- before anything is sent it checks that the receipt is recorded, that its
  stored digest equals `keccak256` of the payload bytes, that the receipt is not
  yet released, that the payload's bps sum to 10 000, and that the vault set and
  order equal the registry's router-eligible list;
- the Safe schedules one `scheduleBatch` whose calls are
  `ConsensusRecommendationReceipt.releaseReceipt(receiptId)` and the router
  weight change for that vector (on today's bytecode
  `RouterGovernance.setDefaultWeights(vaults, bps)`, the `ADMIN_ROLE` call the
  timelock holds);
- after the delay the Safe executes the batch, and the tool reads
  `isReleased(receiptId)` and the router's weights back, failing on any
  difference.

Release and weights are one operation, so a released receipt whose weights were
not applied, or applied weights whose receipt is unreleased, cannot exist.
Admin discretion (D5 in the product proposal) is the Safe's choice of which
receipt to apply and when. Most receipts are recorded and never applied: the
Safe applies a receipt by scheduling the batch, and declines one by doing
nothing.

### 3.3 No voting

**There is no voting by token holders or anyone else: no voter set, no voting
power, no quorum, no voting period, no execution delay, no propose, vote or
execute.**

Weights are an outcome of the committee's consensus and the Safe's decision to
apply it, not of a tally. `RouterGovernance.propose`, `vote` and `execute`
exist in the deployed test bytecode, are unused, have no voters, and are
deleted before the final deployment, when a weight-setter `applyReceipt` call
replaces them. The mainnet test deploys
today's bytecode with an empty voter set. rmpc has no vote command.

The IC agent's `committee vote-submit` is a signed tilt the agent sends to the
committee session. It is not a vote on anything: it changes no contract state
and carries no authority over weights.

The only delay in the path is the timelock's own delay. The only threshold is
the Safe's signer threshold.

### 3.4 The committee and the weight setter are disjoint

**No committee agent holds `WEIGHT_SETTER_ROLE`, router `ADMIN_ROLE` or any
timelock role, and no Safe signer or timelock address holds
`COMMITTEE_AGENT_ROLE`.**

The committee recommends; the Safe applies. The two sets of addresses must not
overlap, so a compromised committee key can at most record a wrong receipt, and
a receipt can at most be applied by a Safe-signed timelock operation after its
delay. `GovernanceSeparationInvariant.t.sol` asserts the disjointness. Granting
a committee agent any weight-setting or timelock authority is a security-model
change that needs a new ADR against INV-4; it is not an ordinary admin action.

### 3.5 Receipt lifecycle

A receipt has two on-chain states.

| State | Entry condition | Exit conditions |
|---|---|---|
| **Recorded** | `recordReceipt` succeeded through the gateway from a `COMMITTEE_AGENT_ROLE` holder. | The `apply-receipt` batch executes: `Released`. A receipt the Safe never schedules stays `Recorded`. |
| **Released** | `releaseReceipt(receiptId)` executed inside the `apply-receipt` batch, which applied the receipt's weights in the same operation. | Terminal. |

Events: `ReceiptRecorded` and `ReceiptReleased` on the receipt contract, and
the router's weight-change event for the applied vector. There is no proposal,
no vote and no proposal event in the path. The explorer's proposal and vote
surfaces render nothing on mainnet because there are no proposals.

### 3.6 setWeights call path

**`WEIGHT_SETTER_ROLE` is the only authority over router weights, and the
weight setter acts only on a Safe-scheduled timelock operation.**

`PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE` (core 1522), not
by `ADMIN_ROLE`. The role is its own role admin: `ADMIN_ROLE` cannot grant it,
so the timelock cannot grant itself the role through a scheduled operation.

- `DeployRouterGovernance.s.sol` grants `RouterGovernance` `WEIGHT_SETTER_ROLE`
  and router `ADMIN_ROLE`, and drops the deployer's copies.
- Stage 11 (`DeployTimelock.s.sol`) grants the `TimelockController`
  `ADMIN_ROLE` on `RouterGovernance`, which reaches `setDefaultWeights`.
  On today's bytecode that is the weight call inside the `apply-receipt` batch.
  The final deployment replaces it with a weight-setter `applyReceipt` call,
  and the role ends with the timelock.
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

**Emergency path.** `RouterGovernance` has no pause or guardian role. The
emergency lever is `clearVotedWeights` (`ADMIN_ROLE`, through the timelock),
which returns routing to the default vector. A scheduled `apply-receipt` batch
that should not run is cancelled on the timelock by the Safe before its delay
passes.

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
| Weight-setter `applyReceipt` call and deletion of `propose`/`vote`/`execute` (contract issue) | Yes — §3.3 and §3.6 | core 1696 |
| Twin rehearsal proving the row through the real Safe and timelock | Yes | core 1696 |
| Explorer: receipt tables and the applied-weights read surface | Yes — §3.5 | Receipt contract deployed |
| `rmpc get-governance` | Yes — reads the router weights and the receipt state | Explorer API |

**Strict serial dependency:**

- The `WEIGHT_SETTER_ROLE` grant (§3.6) cannot happen until
  `RouterGovernance.sol` is deployed to the target network. Deploy scripts
  sequence this explicitly.
- The contract issue lands before the final deployment, never on the mainnet
  test, which deploys today's bytecode.

---

## 6. Integration risks

### 6.1 Receipt and payload drift

**Risk.** The payload file an operator hands to `apply-receipt` could differ
from the payload the committee recorded.

**Resolution.** The row refuses to send anything unless the receipt's stored
digest equals `keccak256` of the payload bytes, so the weights applied are the
weights the committee recorded. Nothing is read from a URI at apply time.

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
reverting batch applies nothing and releases nothing: the Safe records a new
receipt round rather than patching the payload.

### 6.4 One operation per receipt

A receipt that is already released is refused by the row. A second
`apply-receipt` round for the same receipt id cannot be scheduled.

### 6.5 Replacing a broken `RouterGovernance`

Replacing the weight-setter contract uses the rotation in §3.6. The runbook is
`docs/technical/router-governance-handoff-runbook.md`.

### 6.6 No outer share token

`RouterGovernance.sol` must not introduce any token minting, wrapping, or LP
mechanics. Its only on-chain side effects are router weight calls
(`docs/architecture.md` §2.2).

---

## 7. Read surface

The read surface `rmpc get-governance` and the dapp depend on:

```solidity
/// @notice The weight vector currently active on PortfolioRouter.
function currentWeights() external view returns (address[] memory vaults, uint256[] memory bps);

/// @notice The router's on-chain default weight vector (ADR-0002).
function getDefaultWeights() external view returns (address[] memory vaults, uint256[] memory bps);

/// @notice Whether a recorded receipt has been released (and so applied).
function isReleased(bytes32 receiptId) external view returns (bool);
```

`RouterGovernance.activeProposal`, `proposalState` and `cadenceParams` remain
callable on today's bytecode and report no proposals and an empty voter set;
they go away with the contract issue. Implementers must not change the read
surface above without a new ADR.
