# Unified vault — resolution of open questions

Resolves the four ADR-0010 "Open decisions" and the seven still-open items in
`unified-vault-spec.md` §10, incorporating the ADR-0010 critical-review
findings (C1/C2/C3/C3a, H-A1, H-A2, M-E3, M-S2, M-S5). The forcing-function is
the governance constraint the protocol operates under: **the system runs
without active human admins**. Admins implement timelocked governance
decisions (add/remove adapters, set caps and weights) and intervene only on
smart-contract failure — never as routine operators. Any resolution that
depends on a human reacting in time — arming an override, draining within a
window, tuning a knob to market conditions — is disqualified. Every question
below is resolved for autonomy and fail-safe defaults, with the fewest
components and the fewest interventions.

## Design principles

### Principle 1 — Exactness is attested once and drives two behaviors

`isExact` is a parameter to `addAdapter`, stored immutably on the vault's
`AdapterInfo` entry (the struct at `contracts/RobotMoneyVault.sol:61-65`
gains the field). The attestation happens in the same governance act that
pins the adapter codehash — one timelocked call binds instance, codehash, cap,
and exactness. `allExact()` is a derived view over the active adapter set;
there is **no** new `VaultRegistry` state to keep synchronized.

The single attested bit gates two behaviors:

- **(a) Withdraw-exactness** — the exact `withdraw()` path is available only
  when `allExact()`; otherwise the vault is redeem-only with
  `maxWithdraw() == 0` (ERC-4626-safe, per C2).
- **(b) Deposit accounting mode** — the preview/mint branch selection.

Exactness does **not** gate rebalancing. Rebalancing is isomorphic across
every vault type (see the rebalancing rule): exactness and the rebalancing
model are **separate axes** and are not conflated. `isExact` governs the
withdraw surface and the deposit accounting mode; it says nothing about how
composition is corrected.

**Autonomy rationale.** C2 showed adapter-self-reported `isExact()` lets a
pinned-but-lying adapter select the wrong accounting branch per-call.
Vault-attestation removes the per-call trust decision entirely: the value is
fixed at the moment governance already exercises judgment (the `addAdapter`
timelock), and nothing afterwards can flip it without the same timelocked act.
No monitoring, no runtime check, no registry flag to keep in sync.

### Principle 2 — Fail-closed on entry, never on exit

All safety checks — the NAV-deviation guard, the price breaker (below),
oracle-staleness checks — gate **deposits only**. Redemption always proceeds
and settles at realized proceeds, per the ADR-0007 haircut model: the redeemer
receives what the positions actually return, so a mis-mark harms the redeemer
of the mis-marked share, not the remaining holders. No check can freeze user
funds.

**Autonomy rationale.** An exit-side guard that can revert `redeem()`
(the C3/M-A1 finding) is only tolerable if a human carries an emergency
override — which the governance constraint disqualifies. Entry-side-only
gating needs no override at all: when a check trips, the vault stops accepting
new capital (the only party a mis-mark can advantage) and everyone can still
leave. This upholds ADR-0009's redemption-never-revoked commitment
structurally rather than operationally.

### Principle 3 — Safety is permissionless and condition-triggered, not admin-armed

Adapter drain, force-remove, and NAV-exclusion fire on **objective on-chain
conditions** — oracle stale past its heartbeat, the price breaker tripped, the
adapter reverting — and are callable by **anyone**. Proceeds go to the vault;
the caller earns nothing, so there is no griefing incentive: if the condition
holds, draining is the correct action regardless of who triggers it, and if
the condition does not hold the call reverts. Drains use skip-and-continue
semantics — one failing adapter never blocks draining the others.

There is no `EMERGENCY_ROLE` arming step, no arming latency, and no
admin-swappable escape hatch (in particular, no secondary venue-executor
slot). Value stranded in a dead or frozen venue (e.g. a deSPXA transfer
freeze) is recovered later by ordinary governance: deploy a new adapter for
the same asset and reabsorb the tokens into it — a set-and-forget timelocked
config change, not an incident response.

**Autonomy rationale.** The shipped emergency surface assumes a responder:
`emergencyWithdraw`/`emergencyWithdrawAdapter`/`forceRemoveAdapter` are
`EMERGENCY_ROLE`-gated (`contracts/RobotMoneyVault.sol:906,934,966`), and
M-S5 showed the arm-then-execute split adds a ≥48h latency gap on top. Under
the no-admin constraint that surface is dead weight: a condition that needs a
human to notice it is a condition that goes unhandled. Binding the drain to
the same on-chain signal that already gates deposits (Principle 2) means one
mechanism serves both jobs, and the "who watches" question has the answer
"anyone, because watching is verifiable on-chain".

### Supporting rule — adapters own their configuration, set once

`isExact`, the per-adapter slippage bound, the price-breaker threshold, and
the pricing source are all fixed at adapter deploy / `addAdapter`. Each
adapter entry is immutable; there are no runtime tuning knobs. Changing a
parameter means governance adds a replacement adapter entry — the same
lifecycle as any other adapter change, behind the same timelock.

Consequences:

- **Per-adapter slippage** (spec Q5): each adapter carries its own bound,
  suited to its venue's liquidity; the vault enforces a global ceiling so no
  adapter can attest a bound looser than protocol policy.
- **Per-theme price-check selection** (spec Q3): "which check a theme uses"
  is simply which adapter contracts its governance adds — a deploy parameter,
  not a vault mode.
- **Pricing source** (spec Q7): one pricing source per contract. Chronicle
  pricing lives in a separate `ChronicleAssetPositionAdapter` rather than a
  pricing-strategy field on a multi-mode adapter — each contract has one
  auditable pricing path and one codehash to pin.

**Autonomy rationale.** A runtime knob exists to be tuned, and tuning is an
intervention. Immutable per-entry config turns every parameter change into
the one admin action the constraint permits: a timelocked governance config
change.

### The residual price check (C3) — a per-adapter NAV-growth-rate breaker

The C3 finding requires an adapter-independent check on adapter-reported
value. The vault-side-oracle option (a `checkNavDeviation` against
governance-registered pool addresses) is rejected: it rebuilds the pricing
infrastructure ADR-0010 pushes into adapters, and its pool registry is
exactly the kind of governance-maintained, market-condition-sensitive state
the autonomy constraint disqualifies.

Instead the vault checkpoints each adapter's reported `totalAssets()` and
trips a **per-adapter growth-rate bound** (bps per second, set at
`addAdapter`) when the reported value moves faster than the bound. No
external price reference is needed: the breaker detects the
**discontinuity** a mis-mark produces, in either direction. Because
`totalAssets()` is a `view` (`contracts/RobotMoneyVault.sol:414`), the
checkpoint write lives in the mutating deposit path — `_deposit` →
`_routeDeposit` already reads each adapter's `totalAssets()` while routing
(`contracts/RobotMoneyVault.sol:433-500`, adapter reads at lines 473 and
487), so the snapshot-compare-update adds one storage slot read/write per
adapter to a loop that already makes the external calls. The permissionless
drain entry point (Principle 3) evaluates and checkpoints the same condition.

A tripped breaker does two jobs with one mechanism:

1. **Fails closed on entry** — deposits into the vault revert while the
   adapter's reported value is outside the bound (Principle 2 keeps
   redemption open at realized proceeds).
2. **Authorizes the permissionless drain** — the tripped breaker *is* the
   objective condition of Principle 3 for that adapter.

**Honest limit** (stated, not hidden): the breaker bounds the *speed* of a
mis-mark, not slow adversarial drift. An adapter that lies by a few bps per
checkpoint interval stays under any usable bound. Slow drift, however,
requires adversarially authored pinned code — and codehash pinning plus audit
of the adapter is the primary control for that threat. The breaker is
defense-in-depth against bugs and oracle faults (the class ORA-6/F-17
represents), not a substitute for adapter review.

### Rebalancing — one isomorphic flow mechanism, with an optional self-funded admin lever

Rebalancing is **isomorphic across every vault type** and is **not** gated on
exactness. Lending themes and heterogeneous baskets correct composition by the
same mechanism. Composition tends toward a per-instance target allocation
(governance-set weights; equal-weight default) through two flows plus one
optional lever.

- **Deposits fill the largest deficits first.** New capital routes to the
  adapters furthest below target, moving composition toward the weights. This
  is exactly the two-pass fill `RobotMoneyVault._routeDeposit` implements
  (`contracts/RobotMoneyVault.sol:449-500`): Pass 1 fills each adapter up to
  `min(equal target, capBps)`, largest-deficit first (`:463-480`); Pass 2
  spreads any leftover into remaining cap headroom (`:482-495`). The basket
  path adopts this allocator. `BasketVault._routeDeposit` splits a deposit
  **evenly** across active assets (`contracts/vaults/BasketVault.sol:621`,
  `perAsset = usdcAmount / n` at `:625`) — a weight-neutral even split, not a
  target-seeking fill; replacing that even split with the deficit-first fill
  is the basket-side change.
- **Withdrawals draw down the largest surpluses first.** A redemption pulls
  (lending) or sells (basket) from the adapters furthest **above** target, so
  capital leaving moves composition toward the weights. Each leg is bounded by
  the existing per-swap slippage guard — that guard is the redeemer's
  protection. The fairness point: the redeemer realizes the overweight /
  appreciated leg, and the per-swap slippage floor caps how much a thin venue
  can cost them on that leg, so surplus-first drawdown cannot be turned into a
  catastrophic-slippage extraction against the redeemer. The in-tree
  redemption paths draw strictly **proportionally** — weight-neutral, leaving
  composition unchanged: `RobotMoneyVault._pullProportional`
  (`contracts/RobotMoneyVault.sol:647`) and `BasketVault._sellProportional`
  (`contracts/vaults/BasketVault.sol:839`, per-swap floor `_slippageFloor` at
  `:858`). Replacing proportional drawdown with surplus-first drawdown is the
  redemption-side change; the per-swap floor already present is the fairness
  bound.
- **Optional admin `forceRebalance`, where the caller eats the cost.** An
  admin may move composition toward target at any time, but the call **must
  leave NAV non-decreasing**: the vault measures NAV before and after and
  requires the caller to supply the USDC covering realized slippage and fees (a
  top-up), or the call reverts. Holders can **never** lose value to a
  `forceRebalance` — the admin buys tighter tracking with their own funds. On a
  lending theme this top-up is ~zero (exact adapters move value 1:1, no
  slippage); on a basket the admin pays the swap slippage out of pocket. One
  function, isomorphic across vault types.

There is **no** scheduled, automatic, or keeper rebalance, **no** drift band,
**no** per-epoch cost cap, and **no** keeper bounty. Correction is the emergent
result of deposit and withdrawal flow, plus the optional self-funded admin
lever. C3a's valuation-mis-directs-capital hazard is closed structurally: no
mechanism trades on an adapter's mark to socialize a cost onto holders.

**Autonomy rationale.** With no admin on the medium-term horizon,
`forceRebalance` is simply never called: correction reduces to pure flow,
composition drift is tolerated, and the ADR-0007 NAV-haircut redemption model
means drift never harms holders — each redeemer receives their true pro-rata
slice at realized proceeds regardless of composition. `forceRebalance` degrades
gracefully to "absent". One flow mechanism plus one optional lever deletes, at
once: the socialized rebalance cost, the sandwich/MEV surface a predictable
scheduled rebalance creates (M-E3), the exact/inexact rebalance split, and
every rebalance tuning parameter.

This is a change on both sides of the in-tree code. `RobotMoneyVault
.rebalance()` is role-gated to `ADMIN_ROLE`/`KEEPER_ROLE`
(`contracts/RobotMoneyVault.sol:791-794`, `UnauthorizedRebalancer`): it pulls
excess from over-weight adapters and re-routes it, and any realized cost is
borne by vault NAV — a socialized, keeper-operable rebalance this design
removes. `BasketVault.rebalance()` is a `NotImplemented()` stub
(`contracts/vaults/BasketVault.sol:1500-1501`). Both are replaced by the flow
mechanism above and the single NAV-non-decreasing `forceRebalance`.

### The migration interlock fix (H-A1) — one atomic entry point

The ADR-0002 stale-weights interlock deadlocks any eligibility change once a
router carries a full-length default vector. Verified against the shipped
contracts:

- `VaultRegistry.setRouterEligible` reverts `StaleDefaultWeightsLength`
  whenever a linked router's non-empty default-vector length differs from the
  new eligible count (`contracts/VaultRegistry.sol:318-345`, guard at
  335-340; the empty vector, length 0, is exempt).
- `PortfolioRouter.setDefaultWeights` requires
  `vaults.length == registry.routerEligibleCount()`
  (`contracts/PortfolioRouter.sol:347`) **and** weights summing to 10 000
  (`:358`, `InvalidWeightSum`) — so it **never accepts an empty vector** (an
  empty vector sums to 0), and no `clearDefaultWeights` exists.
- `VaultRegistry.setRouter(address(0))` reverts `RouterUnlinkBlocked` while
  the default is non-empty (`contracts/VaultRegistry.sol:358-364`).

Every escape is closed; with four eligible vaults and a length-4 default,
every eligibility flip reverts.

**Fix (chosen): one atomic `VaultRegistry` entry point** that flips a vault's
router-eligibility **and** sets the router's default-weights vector in the
same call, so the length invariant is never observed mid-transition. One
function, no new subsystem; the invariant stays enforced at every observable
state.

**Alternative (even smaller): relax `setDefaultWeights` to accept the empty
vector** (skip the sum check at length 0). The empty default is already
exempt from the eligibility guard, so a single governance batch —
clear → flip eligibility (any number of times) → set the new full-length
vector — completes any transition. The trade-off is a transient
empty-default state inside the batch (router falls back to no-default
behavior if the batch is not atomic), which is why the atomic entry point is
the primary choice.

## Resolution of each open question

| # | Question (source) | Resolution | Driven by |
|---|---|---|---|
| D1 | Inexact rebalancing: enable (gated) vs no-rebalance (ADR) | Isomorphic flow-based rebalancing for **every** vault type: deposits fill largest deficits, withdrawals draw down largest surpluses (per-swap slippage floor bounds each leg). Optional NAV-non-decreasing admin `forceRebalance` (caller funds the cost). No keeper, drift band, or cost cap; not gated on exactness. | Rebalancing rule; ADR-0007 |
| D2 | `isExact` attestation site (ADR) | Vault-attested: `addAdapter` parameter, immutable on `AdapterInfo`; `allExact()` a derived view; no registry state. | Principle 1 |
| D3 | Residual price-check mechanism (ADR) | Per-adapter NAV-growth-rate breaker, checkpointed in the deposit path; registered-pool option rejected. | Price-check rule; Principle 3 |
| D4 | Exit-side deviation guard (ADR) | Entry-side only. Redemption always proceeds at realized proceeds; no override needed because nothing gates exit. | Principle 2 |
| Q1 | EMERGENCY-armable surface / blast radius (spec §10.1, M-S5) | Surface eliminated: no arming, no `EMERGENCY_ROLE` drain path. Permissionless condition-triggered drain; blast-radius question dissolves. | Principle 3 |
| Q2 | Who drains a compromised venue executor (spec §10.2) | Permissionless `forceRemove` on the objective condition + governance redeploy of a replacement adapter + reabsorb. No hot-swap executor slot. Also the M-S2 stranded-token answer. | Principle 3 |
| Q3 | Per-theme price-check option (spec §10.3) | Uniform mechanism (growth-rate breaker); per-theme variation is a deploy parameter (`maxNavGrowthRateBps` per adapter). Value is a deploy-time governance parameter, not an intervention. | Supporting rule |
| Q4 | Inexact rebalancing tuning (spec §10.4, M-E3) | Dissolved: rebalancing is uniform flow-based, not a tuned trading loop. No `rebalanceDriftBandBps`, no `maxRebalanceCostPerEpochBps`, no keeper bounty; `forceRebalance` has no tuning knobs — its only bound is NAV-non-decreasing. | Rebalancing rule |
| Q5 | Per-adapter slippage (spec §10.5) | Per-adapter bound set at `addAdapter`, immutable; vault enforces a global ceiling. | Supporting rule |
| Q6 | Drain: all-or-nothing vs skip-and-continue (spec §10.6) | Skip-and-continue, permissionless, condition-triggered. `BasketVault.emergencyUnwind`'s all-or-nothing revert (`EmergencyFloorUnavailable`, `contracts/vaults/BasketVault.sol:1250-1269`) does not carry over. | Principle 3 |
| Q7 | Chronicle adapter shape (spec §10.7) | Separate `ChronicleAssetPositionAdapter`: one pricing source per contract, one codehash per pricing path. | Supporting rule |
| T2 | Migration deadlock (H-A1) | Atomic registry entry point flipping eligibility + default weights in one call; smaller alternative: empty-vector-accepting `setDefaultWeights`. | Interlock fix |

Per-item notes beyond the table:

- **D1/Q4.** Rebalancing is one mechanism for every vault type, decoupled from
  exactness. Deposit flow fills the largest deficits, withdrawal flow draws
  down the largest surpluses, and each drawdown leg is bounded by the per-swap
  slippage floor already present in both vaults (`_slippageFloor` on the basket
  sell path, the 1:1 move on the exact lending pull). The optional
  `forceRebalance` is the only admin lever, and its NAV-non-decreasing
  invariant makes it holder-safe by construction: the admin supplies the USDC
  covering realized slippage and fees, so a `forceRebalance` can only tighten
  tracking, never dilute holders. Because equal weight is a target the flow
  tends toward — not an invariant maintained by trading (the ADR-0007 posture)
  — the exact/inexact split, the drift band, the per-epoch cost cap, and the
  keeper all disappear, and with the keeper goes M-E3's predictable-schedule
  MEV surface.
- **D3/Q3.** The breaker is the same signal on both sides of Principle 2/3:
  it closes the deposit gate and opens the drain gate. `maxNavGrowthRateBps`
  per adapter is a deploy-time governance parameter.
- **Q1/Q2/Q6.** Together these replace the entire role-gated emergency
  surface (`emergencyWithdraw`/`emergencyWithdrawAdapter`/
  `forceRemoveAdapter` on the unified vault) with one permissionless,
  condition-gated drain plus governance redeploy for stranded value. The
  shipped skip-and-continue try/catch semantics
  (`contracts/RobotMoneyVault.sol:906-961`) carry over; the role gate does
  not.
- **Q5.** The vault-level ceiling also answers L-E5 (a mixed set's aggregate
  floor masking a bad leg): the per-adapter bound *is* the per-leg floor.

## Residual admin surface

Everything admins do is a timelocked governance config change:

- `addAdapter` (binds instance, codehash, `capBps`, `isExact`, slippage
  bound, breaker bound — one call, all immutable per entry).
- `removeAdapter` / allowlist and codehash-pin changes.
- Weights and caps: default weight vector (via the atomic entry point when
  eligibility changes), TVL/per-deposit/router/vault caps.
- Lifecycle: registry retire/unretire, router-eligibility flips (atomic entry
  point).
- Recovery-by-redeploy: adding a replacement adapter and reabsorbing stranded
  tokens (the same `addAdapter` machinery, not a special path).

Nothing on this list is time-critical, market-condition-sensitive, or
incident-triggered. There is no arming step, no keeper, no emergency drain
role on the routine path, and no parameter whose safety depends on being
retuned.

Beyond timelocked config, admins hold one discretionary lever, `forceRebalance`.
It is not a config change and needs no timelock because it cannot harm holders:
the NAV-non-decreasing invariant forces the caller to fund any realized cost, so
the worst outcome of any call — or of the call never happening — is unchanged
composition, never a loss to holders. It is optional, self-funded, and
absent-safe.

## Honest residuals and limits

- **The breaker bounds speed, not drift.** A slow adversarial mis-mark stays
  under any usable growth-rate bound. The control for that threat is codehash
  pinning plus adapter audit; the breaker is defense-in-depth for bugs and
  oracle faults, and the design must not be described as detecting arbitrary
  mis-marks.
- **Checkpoint cadence.** The bound is evaluated against elapsed time since
  the last checkpoint; long gaps between mutating interactions widen the
  allowed move. The permissionless drain entry point also checkpoints, which
  narrows but does not eliminate the effect.
- **Values from the Phase-2 cost spike.** `maxNavGrowthRateBps` per adapter and
  the per-adapter slippage bounds and vault ceiling are deploy-time parameters
  whose numbers come from the spec's Phase-2 gas/cost spike. These are
  parameters, not interventions — set once at governance time.
- **Surplus-first withdrawal drawdown needs precise spec.** The rule
  "withdrawals draw down the largest surpluses first" and its fairness bound
  (each leg capped by the per-swap slippage floor) is fixed in shape, but the
  exact ordering, tie-breaking, and interaction with the proportional
  idle-USDC pass require a precise specification of the
  `_pullProportional` / `_sellProportional` replacement.
- **`forceRebalance` NAV-non-decreasing invariant needs precise spec.** The
  before-vs-after NAV measurement, the admin top-up accounting, and the
  atomicity that makes "NAV after ≥ NAV before" hold within a single call
  require a precise specification — which NAV definition, where the top-up
  enters, and how a shortfall reverts the whole call.
- **Composition drifts under sustained one-directional price movement with
  thin flow.** With little deposit/withdrawal flow and no `forceRebalance`, a
  persistent one-directional price move leaves composition away from target
  until flow resumes or an admin force-rebalances. This is an accepted product
  characteristic — risk exposure wanders, but no value leaks, because ADR-0007
  haircut redemption gives each holder their true pro-rata slice at any
  composition. It is disclosed here, not engineered against by default.
- **Reabsorb path.** The venue-independent reabsorb (M-S2) is resolved in
  shape (redeploy + reabsorb into a new adapter entry) but its NAV-recount
  semantics while tokens sit in a revoked adapter follow spec §4.4; this
  document does not restate that algorithm.
- **Code-verification notes.** All four flagged assumptions were confirmed
  against the shipped contracts (citations inline above). One sharpening:
  `setDefaultWeights` rejects the empty vector through **two** independent
  checks (`LengthMismatch` at `contracts/PortfolioRouter.sol:347` whenever
  the eligible count is non-zero, and `InvalidWeightSum` at `:358`
  unconditionally, since an empty vector sums to 0) — the empty-vector
  alternative must relax both.

## Simplifications enabled

The resolved design lets the implementation retire code and architecture whose
only purpose is to make keeper-driven rebalancing and admin-armed emergencies
safe. Each removable member below is grounded in the current sources; the list
is organized by the driving decision, then by what falls away.

### From flow-only rebalancing + self-funded `forceRebalance` — the keeper throttle apparatus

A NAV-non-decreasing `forceRebalance` is protected by an invariant, not by
rate-limiting, so the throttle machinery has nothing left to bound. Removable
from `contracts/RobotMoneyVault.sol`:

- `KEEPER_ROLE` (`:42`, admin wired at `:347`) — it exists solely for
  rebalancing.
- The throttle state and bounds: `maxRebalanceBpsPerCall` (`:126`),
  `minRebalanceInterval` (`:128`), `lastRebalanceAt` (`:130`),
  `MAX_REBALANCE_BPS_CEILING` (`:55`), `MIN_REBALANCE_INTERVAL_FLOOR` (`:57`),
  `isRebalanceAvailable()` (`:1287`), the setters `setMaxRebalanceBpsPerCall`
  (`:871`) and `setMinRebalanceInterval` (`:880`) with their events, and the
  errors `RebalanceTooSoon` (`:283`) and `UnauthorizedRebalancer` (`:285`).
- Both rebalance entry points collapse into the single `forceRebalance`: the
  keeper/admin `rebalance()` (`:791`) **and** `adminRebalance(uint256[])`
  (`:831`). `adminRebalance` must also be removed or converted — it is a second
  socialized-cost path (it is the mirror writer of `lastRebalanceAt` at `:865`,
  the counterpart to `rebalance()` at `:799`). If it survives, realized cost can
  still be socialized onto NAV around the invariant-protected `forceRebalance`.

### From "never gate the exit path" — the withdrawal half of split pause

Redemption is always reachable, so the withdrawal-side pause has nothing to
guard. Removable from `contracts/RobotMoneyVault.sol`:

- `withdrawalsPaused` state (`:121`), the `WithdrawalsPaused` error (`:289`),
  `_setWithdrawalsPaused` (`:1143`) with its `WithdrawalsPausedChanged` event
  (`:235`), and the three exit-gating branches `if (withdrawalsPaused) …` in
  `maxWithdraw` (`:542`), `maxRedeem` (`:553`), and `_withdraw` (`:596`).
- Only a deposit-side halt remains, and it is the condition-driven breaker.

### From "adapters own their config, set once (immutable)" — per-asset runtime knobs

Per-asset parameters move into adapter constructors as immutable values: no
vault state, no setter, no event, no timelocked governance action. Removable
from `contracts/vaults/BasketVault.sol`:

- `twapWindow` mapping (`:195`) + `setTwapWindow` (`:1481`).
- `emergencyUnwindGuard` mapping (`:190`) + `setEmergencyUnwindGuard` (`:1458`).
- `maxSlippageBps` (`:179`) + `setMaxSlippageBps` (`:1423`), with
  `SlippageBelowPoolFeeFloor` (`:348`) and `MaxSlippageUpdated` (`:258`).
- `navDeviationGuardBps` (`:213`) + `setNavDeviationGuardBps` (`:1412`) +
  `MAX_NAV_DEVIATION_BPS` (`:219`).

### From "residual price check = NAV-growth-rate breaker" — the second-oracle deviation apparatus

The breaker (checkpoint-and-compare in the deposit path) is strictly less code
than a slot0-vs-TWAP deviation check plus a governance-registered pool.
Removable:

- `BasketViews.checkNavDeviation` (definition `contracts/lib/BasketViews.sol:82`,
  invocation `contracts/vaults/BasketVault.sol:565`) and its supporting vault
  state `navDeviationGuardBps`, error `NavMarketDeviationExceeded` (`:324`), and
  event `NavDeviationGuardUpdated` (`:290`).

This is a behavior change, not only a deletion: the NAV-growth-rate breaker is
the **sole** vault-side price check. Reviewers should not expect both a
second-oracle deviation guard and the breaker — the design carries one, and it
bounds the speed of a mark discontinuity rather than an absolute deviation from
a second reference.

### From the ADR-0010 core — one Vault, positions behind `IPositionAdapter`

- Five vault contracts — `RobotMoneyVault`, `BasketVault`, `ProtocolAssetVault`,
  `AgentTokenVault`, `RwaVault` — collapse to one implementation.
- `BasketVault`'s inline swap/TWAP code and its delegatecall-linked libraries —
  `TickMath` (`contracts/lib/TickMath.sol`), `TwapTickMath`
  (`contracts/lib/TwapTickMath.sol`), `BasketViews`
  (`contracts/lib/BasketViews.sol`), `BasketAssetConfigGuard`
  (`contracts/lib/BasketAssetConfigGuard.sol`) — leave the vault for adapters,
  dissolving the EIP-170 pressure the basket family fights.
- The two divergent deposit routings — `RobotMoneyVault._routeDeposit`
  fill-toward-target (`contracts/RobotMoneyVault.sol:449-500`) and
  `BasketVault._routeDeposit` even-split (`contracts/vaults/BasketVault.sol:621`)
  — unify to one path, and redemption unifies to one surplus-first drawdown
  path. The `WeightSnapshot` event
  (`contracts/vaults/BasketVault.sol:296`, emitted at `:663`) — nothing
  off-chain consumes it — drops.

### Architecture and off-chain

- No keeper service: no rebalance bot, no scheduling, no drift monitoring, no
  MEV protection for scheduled rebalances. Rebalancing has no off-chain
  component.
- Fewer steady-state governance operations: per-adapter config is set once at
  deploy.
- One ABI and one audit surface for the indexer, gateway, rmpc, and dapp.

### Honest caveats

- **`EMERGENCY_ROLE` shrinks but is not deleted.** Drains, force-removes, and
  NAV-exclusion become permissionless-on-condition, and withdrawals are never
  pausable, but a thin EMERGENCY hot key is retained to halt the **entry** path
  on contract-failure intervention, preserving the pause/unpause trust
  asymmetry. The role gates `pause` (`contracts/RobotMoneyVault.sol:890`),
  `emergencyWithdraw` (`:906`), `emergencyWithdrawAdapter` (`:936`),
  `forceRemoveAdapter` (`:966`), and `shutdownVault` (`:1038`); it contracts to
  the entry-path halt. Role count goes three (ADMIN, KEEPER, EMERGENCY) to
  effectively ADMIN plus a thin EMERGENCY.
- **`adminRebalance` must be removed or converted, not only `rebalance()`.** It
  is the second writer of `lastRebalanceAt`
  (`contracts/RobotMoneyVault.sol:865`); the only other write is `rebalance()`
  at `:799`. If it survives, cost can still be socialized around
  `forceRebalance`.
- **The breaker replacing the deviation guard is a real behavior change** (see
  the residual-price-check simplification above): the growth-rate breaker is the
  sole vault-side price check, and it bounds the speed of a mis-mark rather than
  an absolute deviation from a second oracle.

## Impact on ADR-0010 / spec

Edits a follow-up makes (this document changes neither file):

- **ADR-0010 "Open decisions"** — all four bullets close: D1 →
  isomorphic flow-based rebalancing for every vault type (deficit-first
  deposits, surplus-first withdrawals) plus an optional NAV-non-decreasing
  `forceRebalance`, reconciling ADR-0007 without a cost cap or keeper and
  decoupled from exactness; D2 → vault-attested confirmed,
  registry-attested alternative dropped (no registry state); D3 →
  NAV-growth-rate breaker chosen, registered-pool option dropped; D4 →
  entry-side only, the "exit-side with emergency override" consequence bullet
  deleted.
- **ADR-0010 §5/§6** — replace the drift-band + per-epoch-cost-cap
  rebalancing text and the keeper references with isomorphic flow-based
  rebalancing (deficit-first deposits, surplus-first withdrawals) and the
  self-funded NAV-non-decreasing `forceRebalance`; record that the breaker
  doubles as the drain condition.
- **Spec §4.3a** — pin the breaker as the sole residual check; add the
  checkpoint placement (deposit path + drain entry point) and the
  speed-not-drift limit.
- **Spec §4.4 / §5.5** — replace the `EMERGENCY_ROLE`-gated drain and the
  M-S5 direct-EMERGENCY-grant mitigation with the permissionless
  condition-triggered drain; fold Q1/Q2/Q6 answers in; keep
  skip-and-continue.
- **Spec §5.6** — replace the rebalance mechanism with surplus-first
  withdrawal drawdown (bounded by the per-swap slippage floor) and the
  NAV-non-decreasing self-funded `forceRebalance`; delete the exact/inexact
  split and the rebalance throttles.
- **Spec §8 / Phase 6** — replace "shift weights" with the atomic
  eligibility+weights entry point (or the empty-vector relaxation) and its
  ordering.
- **Spec §10** — move Q1-Q7 into the resolved list, cross-referenced here.
- **Adapter inventory** — add `ChronicleAssetPositionAdapter` as its own
  contract (also touches architecture.md §4.3 per L2).

---

**Summary.** Exactness is attested once at `addAdapter` and gates the withdraw
surface and the deposit accounting mode — a separate axis from rebalancing;
safety checks gate deposits only and never exits; drains are permissionless and
condition-triggered with proceeds to the vault; all adapter config is immutable
per entry. A per-adapter NAV-growth-rate breaker is both the deposit gate and
the drain trigger. Rebalancing is isomorphic across every vault type: deposit
and withdrawal flow tends composition toward target (deficit-first deposits,
surplus-first withdrawals bounded by the per-swap slippage floor), with an
optional NAV-non-decreasing admin `forceRebalance` the only lever — no keeper,
drift band, or cost cap. One atomic registry call fixes the H-A1 migration
deadlock. Admins retain timelocked config changes plus the single self-funded
`forceRebalance` lever.
