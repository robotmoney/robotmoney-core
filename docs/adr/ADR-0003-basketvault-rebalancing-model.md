# ADR-0003: BasketVault rebalancing model — trigger, target weights, cost disclosure

- **Status:** Accepted
- **Affected by:** [ADR-0010 (Proposed)](ADR-0010-unified-vault-architecture.md) — in the unified `Vault`, basket rebalancing is a vault-level adapter reallocation under uniform rebalance throttles; the `BasketVault` `NotImplemented()` `rebalance()` stub and Phase B plan apply to v1 only.
- **Date:** 2026-06-02
- **Deciders:** Product owner
- **Related:**
  - `docs/technical/basket-vault-gap-report.md` §4, Appendix B
  - `docs/development/open-questions.md` §1.B (intra-vault rebalancing, §3.15)
  - `docs/prd.md` §11.2, §11.3
  - `docs/architecture.md` §4.4, §8

## Context

`BasketVault` routes only new deposits equal-weight across active basket assets at
deposit time. No `rebalance()` function exists. When assets are added or removed
via `addAsset`/`removeAsset`, existing depositors' proportional holdings are not
adjusted, causing weight drift that violates the equal-weight mandate over time.

This gap blocks router eligibility for both `ProtocolAssetVault` (rmPROTO) and
`AgentTokenVault` (rmAGENT) — see gap report §4 and Appendix B. Three
sub-questions must be resolved:

1. **Trigger mechanism** — who/what initiates a rebalance, and when?
2. **Target weights** — equal-weight or a governed weight vector?
3. **Cost and slippage disclosure** — who bears rebalancing cost, and how is it
   surfaced before execution?

`docs/development/open-questions.md` §1.B records the working direction as
"new-deposits-only" rebalancing, with the residual open question being which
depositor-facing reporting surface satisfies the PRD's transparent-performance
requirement (target weights vs. aggregate realized weights vs. per-depositor
effective weights).

## Decision

### Trigger: new-deposits-only (no global `rebalance()` for MVP)

The MVP does **not** implement a global `rebalance()` function. Weight correction
occurs only incrementally through new deposits: each deposit allocates its USDC
equal-weight across the current active asset set, correcting aggregate drift at
the margin with every new inflow.

This means:
- There is no admin-initiated `rebalance()` call.
- There is no keeper or off-chain bot triggering global rebalance.
- Existing depositors' realized weights drift relative to the target when assets
  are added or removed; they are not force-sold or bought.

Rationale: a global `rebalance()` requires trusting the executing party (admin or
keeper) to choose a fair execution moment, imposes socialized swap costs on all
shareholders, and introduces a new attack surface (MEV sandwich, front-running).
The new-deposits-only model carries zero swap cost for existing holders; drift is
a reporting concern, not a shareholder-harm concern, in the MVP.

### Target weights: equal-weight

The target is **equal-weight across all active assets** — each active asset
receives `1 / n` of every new deposit, where `n` is the count of active assets
at deposit time.

Governed weight vectors (where individual asset allocations differ from `1/n`)
are deferred. No weight-governance mechanism is introduced in the MVP.

### Cost disclosure: deposit-time weight snapshot + event emission

Because no global rebalance executes, there is no rebalance-execution cost to
disclose to existing holders. Cost disclosure is scoped to deposit time:

1. **`WeightSnapshot` event** — `BasketVault` emits a `WeightSnapshot(address
   indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp)`
   event on every deposit, recording the equal-weight allocation used for that
   deposit. This satisfies the event-stream disclosure requirement.

2. **`previewDepositWeights(uint256 usdcAmount)`** — a new view function returns
   `(address[] assets, uint256[] amountsOut)` showing how a given USDC deposit
   would be allocated across active assets at current prices (using the TWAP
   oracle once implemented, or slot0 until then). This is the pre-execution
   cost-preview mechanism required by `docs/architecture.md` §8.

3. **`realizedWeights(address depositor)`** — a new view function returns the
   depositor's current realized weight vector (each active-asset holding valued
   in USDC divided by total holdings valued in USDC). The dapp and `rmpc`
   display this alongside the target vector so users see per-depositor drift.
   This resolves the residual open question in `docs/development/open-questions.md`
   §1.B: the PRD's transparent-performance requirement is satisfied by exposing
   **both** (a) target weights and (c) per-depositor effective weights.

### `rebalance()` signature: reserved stub only

A no-op `rebalance()` stub is introduced now to:
- reserve the function selector so the contract ABI is stable when a global
  rebalance is implemented in a future phase
- document the intended eventual signature in source

```solidity
/// @notice Reserved for Phase B: global vault rebalance.
/// @dev Not implemented in MVP. Reverts with `NotImplemented()`.
/// Eventual signature (subject to Phase B ADR):
///   rebalance(uint256 maxSlippageBps, uint256 deadline)
///   -> (uint256[] swapAmounts, uint256[] gasEstimates)
/// See docs/adr/ADR-0003-basketvault-rebalancing-model.md
function rebalance(uint256 maxSlippageBps, uint256 deadline) external;
```

The stub reverts with a custom error `NotImplemented()`. It is not callable in
production but satisfies the gap-report requirement that the rebalancing
signature is specified.

## Consequences

**Positive.**

- Zero swap cost to existing shareholders in the MVP. No MEV surface opened.
- Deposit-time weight snapshot provides an auditable, per-depositor record of
  what allocation was applied at every inflow.
- `previewDepositWeights` satisfies `docs/architecture.md` §8 cost-preview
  requirement at deposit time.
- `realizedWeights` satisfies the transparent-performance requirement without
  requiring a global rebalance — the dapp can show each depositor how far their
  basket has drifted from the target.
- Resolves the gap-report §4 blocking item and closes open-questions §3.15
  (intra-vault rebalancing transparency).

**Negative / accepted risks.**

- Aggregate vault composition drifts from equal-weight as assets are added or
  removed and until the new-deposit flow corrects it. The drift is visible
  on-chain but is not actively corrected.
- Late depositors always buy at the target ratio; early depositors may hold
  off-target ratios indefinitely if they never add to their position. This
  asymmetry is accepted in the MVP.
- The no-op `rebalance()` stub adds a function that reverts. Any integration
  that calls it without reading the revert message will fail silently. The
  `NotImplemented()` custom error mitigates this risk.

**Out of scope of this decision.**

- Global `rebalance()` implementation (Phase B; requires a separate ADR
  addressing MEV protection, keeper incentive, and socialized cost distribution).
- TWAP oracle replacement for slot0 in `_quote` (tracked in Appendix A of the
  gap report; a separate ADR is required).
- Slippage-adjusted `previewRedeem` (tracked within the TWAP oracle ADR).
- Shortlist governance for `AgentTokenVault` (ADR to be written separately;
  blocks AgentTokenVault router eligibility independently of this decision).
- Depositor migration on vault retirement (open-questions §1.C).

## Implementation checklist (for Phase A implementation issue)

- [ ] Add `WeightSnapshot` event to `BasketVault` and emit on every deposit.
- [ ] Add `previewDepositWeights(uint256 usdcAmount)` view function.
- [ ] Add `realizedWeights(address depositor)` view function.
- [ ] Add `rebalance(uint256 maxSlippageBps, uint256 deadline)` stub reverting
  with `NotImplemented()`.
- [ ] Add `NotImplemented` custom error to `BasketVault`.
- [ ] Update `docs/development/open-questions.md` §1.B to mark §3.15 resolved
  and link this ADR.
