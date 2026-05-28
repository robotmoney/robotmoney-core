# ADR-0002 — On-chain default weights for the Portfolio Router

- **Status:** Accepted
- **Supersedes / relates to:** `docs/development/open-questions.md` §3.9 (router-weight
  vote rules — default-weight-vector residual)
- **Code:** `contracts/PortfolioRouter.sol`, `contracts/RouterGovernance.sol`,
  `contracts/VaultRegistry.sol`, `contracts/script/DeployDemoExtraVaults.s.sol`

## Context

`RouterGovernance` lets governance vote a target allocation onto the
`PortfolioRouter`. When a proposal fails to reach quorum it becomes `Defeated`
and cannot execute, so historically the router simply held whatever weight
vector was last in effect — the *implicit* status quo. Below quorum, or before
any vote has ever passed, there was no inspectable, on-chain answer to "what
split does the router actually use?".

The public allocation surface (`robotmoney.net/allocation`) must render exactly
the split the router applies, and it must read that split **from the chain** —
not from numbers baked into the front end ("we don't want to just read these
numbers from the website as someone might hack the front end"). Without an
explicit on-chain fallback vector, below-quorum behaviour is undefined to the
site and to integrators.

## Decision

Introduce an explicit, admin-settable **`defaultWeights`** vector that the
router routes by whenever the voted vector is not in effect.

- `PortfolioRouter` holds two vectors: the **voted** vector (set on a successful
  proposal execution via `setWeights`) and the **default** vector (set by
  `setDefaultWeights`). A boolean `votedWeightsActive` selects which is in
  effect. `previewDeposit` and `deposit` route by the **effective** vector:
  the voted vector when active, otherwise the default vector.
- A passed vote overrides the default (`setWeights` sets
  `votedWeightsActive = true`); `defaultWeights` itself is left untouched so it
  remains the post-vote fallback.
- `clearVotedWeights` reverts routing to the default — the path governance uses
  to fall back to the default after the most recent proposal failed quorum.
- `setDefaultWeights` is gated by `ADMIN_ROLE` (reached via the
  Safe → Timelock → ADMIN_ROLE path), enforces `sum(bps) == 10_000`, and
  requires the vector length to equal `VaultRegistry.routerEligibleCount()` so
  the default can never carry a stale length relative to eligibility.
- `RouterGovernance` exposes `setDefaultWeights` / `clearVotedWeights`
  forwarders (gated by its own `ADMIN_ROLE`) that call the router, mirroring how
  `execute` forwards to `router.setWeights`.
- `VaultRegistry` tracks `routerEligibleCount` and, when a `PortfolioRouter` is
  linked via `setRouter`, blocks any `setRouterEligible` change that would leave
  a **non-empty** default vector with a stale length. The operator re-sets
  `defaultWeights` to span the new eligible set first, then changes eligibility.
  An empty default vector (length 0) is exempt — it means "no default
  configured yet", which is always consistent.
- The demo seed (`DeployDemoExtraVaults.s.sol`) populates a non-empty
  `defaultWeights` vector spanning the three demo vaults so `/allocation`
  renders out of the box with no governance activity.

## Consequences

- The public allocation surface has a single, hack-resistant on-chain source of
  truth: `PortfolioRouter.getEffectiveWeights()`.
- Below-quorum behaviour is explicit and inspectable rather than an implicit
  status-quo hold.
- Updating `defaultWeights` follows the same ADMIN_ROLE governance path as every
  other admin action and takes effect at the next below-quorum window.

## Out of scope

- Continuous smoothing / governance-whiplash blending between voted and default
  weights (deferred).
- First-deployment production `defaultWeights` values (an ops decision).
- The indexer / `robotmoney.net/allocation` read-path implementation
  (downstream).
- Per-tier or token-holder voting over the default itself (not in MVP).
