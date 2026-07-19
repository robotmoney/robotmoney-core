# ADR-0010: Unified Vault architecture — one Vault class, position adapters for every theme

- **Status:** Proposed
- **Date:** 2026-07-16
- **Deciders:** Product owner
- **Related:**
  - `docs/technical/unified-vault-spec.md` (companion engineering spec — the
    normative detail for everything summarized here, including the precise
    `IPositionAdapter` interface, both `allExact()` accounting branches, and
    the Phase-2 gas budget)
  - `contracts/RobotMoneyVault.sol` — adapter registry, `totalAssets`,
    `_routeDeposit`, `_pullProportional`
  - `contracts/vaults/BasketVault.sol` — realized-delta `_deposit`
    (AZ-BSK-1/-3), `_sellProportional`, `RedeemOnly`,
    `_lastMintedShares`/`_lastWithdrawnAssets`, ORA-4 NAV-deviation guard
  - `contracts/interfaces/IStrategyAdapter.sol`,
    `contracts/interfaces/IBasketSwapAdapter.sol`
  - `docs/adr/ADR-0002-portfolio-router-default-weights.md` (registry/router
    eligibility interlock — a Phase-6 migration blocker; see Decision §8)
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` (superseded in part —
    see Decision §6)
  - `docs/adr/ADR-0005-basketvault-multi-dex-routing.md` (venue seam retained)
  - `docs/adr/ADR-0006-despxa-rwa-vault-design.md` (rmRWA constraints retained)
  - `docs/adr/ADR-0007-basketvault-no-socialized-rebalance-costs.md`
    (reconciled — see Decision §6 and Open decisions)
  - `docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md` (migration
    model applied to v1 → v2)

## Context

The protocol today ships two structurally different vault families:

1. **`RobotMoneyVault`** (rmUSDC) — an ERC-4626 vault that owns no positions
   directly. It routes USDC through a registry of `IStrategyAdapter` lending
   adapters (Morpho/Aave/Compound), each with an instance allowlist, codehash
   pinning, a per-adapter `capBps`, ADP-2 NAV exclusion for revoked adapters,
   proportional withdrawal pulls (`InsufficientAdapterLiquidity`), and the
   FEE-2 realized-proceeds fee rule.

2. **`BasketVault` and its subclasses** (`ProtocolAssetVault` → rmPROTO,
   `AgentTokenVault` → rmAGENT, `RwaVault` → rmRWA) — vaults that custody
   basket tokens directly, execute swaps through the `IBasketSwapAdapter`
   venue seam (ADR-0005), price via TWAP or Chronicle oracle (ADR-0006), mint
   on the realized NAV delta (AZ-BSK-1/-3), operate redeem-only
   (`RedeemOnly`, `_lastWithdrawnAssets`, no-revert `_sellProportional`), and
   enforce the ORA-4 NAV-deviation guard and per-asset emergency-unwind guards.

The families duplicate lifecycle machinery (pause, shutdown, retirement, fee
accounting, TVL caps) while diverging on accounting semantics, and hardening
applied to one family (e.g. FEE-2, ADP-2) does not automatically protect the
other. `BasketVault` also concentrates swap execution, TWAP/oracle pricing,
and per-asset guards inside the vault itself, keeping it under EIP-170
pressure and forcing every new theme to be a new subclass with its own audit
surface.

The observation motivating this ADR: **a basket asset held via a swap venue
is just another yield-bearing position** — deposit USDC in, report a
USDC-denominated value, return USDC out. The one semantic difference from a
lending position is that the conversion is **inexact** (slippage), and — as
the design review of this ADR made explicit — that single difference forks the
vault's accounting, redemption, pricing-integrity, and rebalancing behavior in
ways that must be pinned before engineering starts. This revision folds those
findings in.

## Decision

**Unify the two families into a single `Vault` contract whose only position
mechanism is a registry of `IPositionAdapter` contracts. All vault themes
become isomorphic deployments of that one class, differing only in their
adapter set and parameters.** The vault runs in one of **two pinned modes**,
selected by whether every active adapter is exact (`allExact()`); the mode
determines the accounting, redemption, and fee semantics described in §5.

### 1. Direction of unification

`RobotMoneyVault`'s adapter architecture is the general case. Unification
means making basket assets look like strategy adapters — **not** making
`RobotMoneyVault` a `BasketVault` subclass. The vault stays a pure
USDC-in/USDC-out allocator; everything asset-specific moves behind the
adapter boundary. The vault is therefore a functional **superset** of
`RobotMoneyVault`: it retains the lending-adapter machinery and *adds* the
realized-delta core, dual preview/accounting math, and residual price checks.

### 2. `IPositionAdapter` — superset of `IStrategyAdapter`

Interface shape (the spec carries the normative signatures, error set, and
`AdapterInfo` layout):

- `deploy(uint256 usdcIn, uint256 minValueOut) returns (uint256 valueAdded)`
- `withdraw(uint256 usdcWanted, uint256 minUsdcOut) returns (uint256 usdcOut)`
- `totalAssets() view returns (uint256)` — USDC-denominated self-pricing
- `USDC() view returns (address)`, `VAULT() view returns (address)` —
  **mandatory** identity members (matching the spec's `IPositionAdapter`);
  `VAULT()` is the load-bearing identity binding that prevents cross-vault
  authority substitution and must not be relaxed for adapter reuse.
- `harvestRewards()`, `sweepForeignToken(address)` — unchanged from
  `IStrategyAdapter`

**`isExact` is vault-attested, not adapter-reported.** The exact/inexact
classification is a `bool` on the vault's `AdapterInfo`, set by ADMIN at
`addAdapter` in the **same act that pins the codehash** — it is never read
from the adapter per call. Codehash pinning proves bytecode identity, not
pricing semantics, so a self-reported `isExact()` cannot be allowed to select
share-value-critical branches (C2). The vault exposes `allExact()` as a
**registry-visible flag** so the gateway, dapp, and router gate statically
rather than probing per call. Any composition change that flips
`allExact()` from true to false (adding the first inexact adapter to an
all-exact vault) is a **share-semantics change** and MUST require a timelock
delay plus an explicit event; the spec specifies `maxWithdraw() == 0` when
`!allExact()` so ERC-4626 `withdraw(maxWithdraw(owner))` cannot revert.

### 3. Lending adapters retrofit trivially

Morpho/Aave/Compound adapters are attested `isExact == true`; the min-out
parameters are trivially satisfied because the USDC conversion is 1:1.

### 4. Basket assets become `AssetPositionAdapter`s

Each basket asset becomes one adapter owning: token custody, swap execution
via the existing `IBasketSwapAdapter` venue seam (Uniswap V3/V4, Aerodrome —
ADR-0005 unchanged), pricing (TWAP window config, or Chronicle oracle +
heartbeat for deSPXA per ADR-0006), the per-asset emergency-unwind guard, and
the adapter's own NAV-deviation check. Most of this moves **out of the vault**
into the adapter — but pricing is **not wholly delegated** to the adapter (see
§5, residual price check).

### 5. Unified vault semantics

- **NAV:** `totalAssets() = idle USDC + Σ eligible adapter.totalAssets()`.

- **Deposit / mint denominator (C1):** route USDC into adapters **first**,
  then mint on the realized NAV delta with a slippage-floor revert guard —
  `BasketVault`'s AZ-BSK-1 model, which degenerates to exact behavior for
  lending adapters (realized delta == deposit). The mint denominator MUST be
  the **idle-inclusive** OZ denominator (`taBefore − revokedIdle + 1`, where
  `taBefore` already includes idle USDC and `revokedIdle` — normally `0` — is
  only USDC recovered from a revoked/excluded adapter, so the common-case
  denominator is the exact OZ value `taBefore + 1`; `taBefore` is read before
  pulling the caller's USDC). Existing
  shares are backed by `totalAssets()`, which **includes** idle USDC; pricing
  new shares on adapter-NAV only over-mints when pre-existing idle USDC is
  present (a normal steady state after `emergencyWithdraw` or a cap-full
  `UnroutedDeposit`), breaking the SUP-3 no-round-trip-profit invariant and
  underflowing the first deposit into a cap-full adapter set. The idle
  **exclusion** (AZ-BSK-3) applies **only** to recovered USDC from a
  revoked/excluded adapter — never to the whole vault balance.

- **Withdrawal — two pinned redemption modes (H-A2):** the redemption path
  **branches on `allExact()`**; the two modes are distinct algorithms, not one
  carried over unchanged.
  - *Exact mode (`allExact()`):* `withdraw()`/`previewWithdraw()` are
    permitted; the proportional pull is `RobotMoneyVault._pullProportional`
    with its `InsufficientAdapterLiquidity` revert on under-delivery, and the
    fee is charged fee-on-gross.
  - *Inexact mode (`!allExact()`):* `withdraw()`/`previewWithdraw()` revert
    `RedeemOnly`; `redeem()` returns realized proceeds
    (`_lastWithdrawnAssets`). The pull is **BasketVault's no-revert
    `_sellProportional`**, not `_pullProportional` — an inexact adapter
    under-delivers systematically (realized ≈ wanted × (1 − slippage)), which
    would make the exact pull revert on every redeem — and the fee is charged
    fee-on-realized proceeds. The spec pins per-adapter sizing, shortfall/clamp
    rules, fee base, events, and all four previews for both branches.

- **Residual price sanity check (C3) — required design element:** the vault
  MUST retain an **adapter-independent** price sanity check; pricing is not
  wholly delegated to the self-pricing adapter that also self-checks its own
  deviation (a mis-scaling or mis-configured adapter passes its own probe with
  the same buggy code, and collapses the ORA-7 "floor never derived solely
  from the oracle that prices the trade" principle). The mechanism is a
  **single global cap on how fast the vault's aggregate NAV (`totalAssets()`)
  may grow between observations**, held as one vault-wide checkpoint (last
  aggregate NAV + timestamp) written in the deposit path. It gates **deposits
  only** and needs no governance-registered per-adapter reference pools. Being
  an aggregate signal, it bounds the speed of a mis-mark but does not identify
  which adapter moved — so it is a deposit circuit-breaker, not a per-adapter
  drain trigger; localizing a failing adapter is the EMERGENCY responder's job
  (§6, Open decisions).

- **Rebalancing consumes valuation as its setpoint (C3a, M-E3):**
  `rebalance()` moves capital toward **valuation-derived** targets
  (`targetBalance = totalAssets() × targetWeight`; each `currentBalance =
  adapter.totalAssets()`), so valuation is the control input that decides which
  adapters are sold/bought and by how much. For **exact** adapters valuation ==
  redeemable USDC, so the decided metric equals the realized metric and moving
  capital is free — which is why ADR-0003's `NotImplemented` posture was fine.
  For **inexact** adapters the **setpoint** is a TWAP/oracle *mark* while the
  **executable price** is an AMM *spot* paying fee + slippage, and the **same
  untrusted adapter supplies both** — so a mis-mark does not merely dilute
  shares statically, it **mis-directs real capital** (an over-marked adapter
  reads over-weight, gets sold, realizes below its mark, socializes the loss).
  Inexact rebalancing is therefore **gated on a drift band** (wide enough that
  the correction's realized cost is justified by the mark-measured drift it
  closes) **plus a per-epoch cumulative-cost cap**; the residual price check
  above is a rebalance-safety precondition, not only a share-price one.

### 6. Governance and lifecycle carry over — with two recorded changes

`adapterAllowed` instance allowlist + `adapterCodeHashAllowed` codehash
pinning, per-adapter `capBps`, ADP-2 NAV exclusion of revoked adapters,
keeper rebalance throttles, registry `retire()`/`unretire()`, and
shutdown/restore apply uniformly across themes. Two carry-overs change and are
recorded here rather than presented as parity:

- **Rebalancing for basket themes (supersedes ADR-0003, reconciles ADR-0007):**
  basket themes gain `rebalance()` through the shared allocator, which
  supersedes the ADR-0003 `NotImplemented()` stub and lifts its
  new-deposits-only restriction. But ADR-0007's "no socialized rebalance
  costs" rationale is *not* free for inexact themes — every inexact rebalance
  is a two-swap round-trip paying fee + slippage socialized to NAV, and a
  scheduled keeper is a predictable sandwich target. This ADR reconciles
  ADR-0007 via the §5 drift-band + per-epoch cost cap, and flags "rebalance vs.
  keep no-rebalance for inexact themes" as an Open decision rather than
  silently overriding ADR-0007.
- **Split pause is not identical (LIFE-3, M-A4):** narrowing `pause()` to
  deposits-only changes the LIFE-3 authority/semantics, and `paused()`
  observability changes for off-chain consumers — after an EMERGENCY deposits
  pause, `paused()` no longer reflects withdrawal state, which the indexer and
  rmpc withdraw-preflight read. The spec must define `paused()` (or expose
  `depositsPaused`/`withdrawalsPaused` and migrate consumers).

### 7. Themes are deployments, not subclasses

- **rmUSDC** = lending adapters, `maxSlippage` 0.
- **rmPROTO** = wETH/cbBTC/wSOL Uniswap V3 adapters.
- **rmAGENT** = shortlist token adapters per
  `config/agent-token-shortlist.json` (mixed venues — BNKR V3, JUNO **V4**, RM
  **Aerodrome**), making it a **Phase-4** deliverable, not Phase-2/3. Per-theme
  ADR-0004 timelock semantics require a per-theme `TimelockController` instance
  as the adapter admin — one `ADMIN_ROLE` cannot express per-theme delays.
- **rmRWA** = a single deSPXA Chronicle-priced Aerodrome adapter
  (`maxAssets = 1` becomes an active-adapter-count cap parameter).

### 8. Migration: fresh v2 deployment, ADR-0009 retirement of v1 — with a required registry/router unlock

v1 contracts are immutable and untouched. v2 is a fresh deployment: register in
`VaultRegistry`, make it router-eligible, then governance `retire()` on each v1
vault per ADR-0009 (withdrawals stay open on v1 indefinitely; no assisted
migration).

**"Shift `PortfolioRouter` weights" is not an executable step as-is (H-A1).**
The ADR-0002 stale-default-weights interlock deadlocks Phase 6: making any v2
vault router-eligible moves `routerEligibleCount`, and `setRouterEligible`
reverts `StaleDefaultWeightsLength` whenever the router's non-empty default
vector length ≠ the new count; every escape is closed (`setDefaultWeights`
requires already-eligible + matching length; no `clearDefaultWeights`;
`setRouter(0)` blocked while default non-empty). This is exactly the state
demo/CI/fork environments boot into. Phase 6 therefore **requires a
registry/router change**, scoped as its own issue: a superset-spanning
`setDefaultWeights` with eligibility-transition semantics, or an atomic
`migrateEligibility` that swaps flag + default in one call, or a router
redeploy against a fresh registry link — with explicit ordering.

Phase 6 also carries two workstreams that must be scheduled, not assumed:

- **Phase 6.5 — environment migration:** CI four-vault assertions
  (`suite-14` demo_seeding asserts exactly four Active vaults; `suite-01`
  `--match-contract` hardcodes subclass names; `suite-16` ABI-drift;
  `suite-22` CoverageMap ↔ invariants-doc 1:1 gate — the §6 loci re-homing
  never schedules the doc rewrite); and deploy scripts assuming fixed-length-4
  weight arrays.
- **Retired-v1 operations obligation:** ADR-0009 promises indefinite v1
  redemption, which depends on a **maintained Chronicle feed and pool
  liquidity indefinitely** for retired rmRWA/basket vaults. A runbook must
  assign that feed/pool maintenance obligation.

## Open decisions

These are genuine design choices the review surfaced; each folds in the
review's recommended option but records the alternative rather than
foreclosing it. The spec resolves them before engineering.

- **Rebalancing for inexact themes — enable (gated) vs. keep no-rebalance.**
  This ADR takes the gated-rebalance option (§5/§6 drift band + per-epoch cost
  cap). The alternative — retain ADR-0007/ADR-0003's no-rebalance posture for
  inexact themes — remains available if the cost cap cannot be made tight
  enough to beat the socialized bleed.
- **`isExact` attestation — vault-attested (chosen) vs. registry-attested.**
  This ADR pins vault-attested at `addAdapter`. A registry-level attestation
  (flag maintained in `VaultRegistry`) is the alternative; both remove the
  per-call self-report, and the choice affects where the timelock transition
  lives.
- **Residual price-check mechanism (C3).** A single global cap on aggregate
  NAV (`totalAssets()`) growth rate, held as one vault-wide checkpoint in the
  deposit path. It satisfies the adapter-independence requirement with no
  per-adapter reference pools, gates deposits only, and does not localize the
  misbehaving adapter. The per-adapter-checkpoint and registered-pool variants
  are rejected in favor of the single global checkpoint.
- **Exit-side deviation guard (C3/M-A1).** Whether the NAV-deviation guard is
  entry-side only, or also gates `redeem()` (introducing a redeem-can-revert
  behavior). This ADR keeps the guard but requires the exit-side case carry an
  emergency override; see Consequences.

## Alternatives considered

- **Make `RobotMoneyVault` a `BasketVault` subclass (invert the direction)** —
  rejected: bakes swap/TWAP/oracle machinery into the base class every theme
  inherits, keeps EIP-170 pressure in the vault, and turns the clean
  USDC-allocator into the special case.
- **Keep two families and backport hardening piecemeal** — rejected: every
  fix (FEE-2, ADP-2, AZ-BSK-*) must be applied and audited twice, and the
  families continue to drift; this is the status quo the ADR exists to end.
- **Upgrade v1 in place** — not available: v1 contracts are immutable by
  design; any unification is necessarily a fresh deployment.

## Consequences

**Positive.**

- One class, one audit surface. Hardening added to the Vault or the adapter
  contract protects every theme at once; the FEE-2 and ADP-2 protections now
  cover basket themes too. (Accounting is **two pinned modes**, not one — see
  §5.)
- New themes are configuration (an adapter set + parameters), not new
  Solidity subclasses.
- ERC-4626 behavior is uniform and predicate-driven: exact mode when all
  adapters are attested exact, redeem-only otherwise.
- Resolving the open decisions retires the machinery that exists only for
  keeper rebalancing and for a second-oracle deviation check — the keeper
  throttle, the withdrawal-side pause, per-adapter runtime setters, and the
  second-oracle deviation guard (replaced by the single global aggregate
  NAV-growth-rate cap). The `EMERGENCY_ROLE` drain/removal surface is
  retained, not retired. See "Simplifications enabled" in
  `docs/technical/unified-vault-open-questions-resolution.md`.

**Negative / accepted risks.**

- **EIP-170 pressure moves, it does not disappear (M-A2).** The unified vault
  is a functional superset of `RobotMoneyVault` (which sheds nothing — it has
  no swap/TWAP code to shed) and *adds* the realized-delta core, dual preview
  math, dual redemption/fee paths, and residual price checks; the swap/TWAP
  code moves into adapters. Fit must be **proven, not assumed** (a Phase-2
  spike), including whether library-linking carries into the unified vault.
- **Gas is not "one extra call per asset" (M-A3).** Each leg adds ~two hops
  (vault → `AssetPositionAdapter` → venue executor → router; inline-V3 becomes
  a `UniswapV3SwapAdapter` contract) plus cross-contract `totalAssets()` reads
  in both routing passes and two full NAV summations — a 3-asset deposit gains
  roughly 9–15 external calls. The budget is set **per composition from the
  Phase-2 spike**, not a blanket 10%.
- **The adapter trust boundary widens, and pricing + its sanity-check must not
  collapse (C3).** Adapters both custody assets and self-price them; the
  residual adapter-independent price check (§5) is a required mitigation
  alongside codehash pinning, ADP-2 exclusion, and FEE-2.
- **`redeem()` can acquire exit-side revert behavior (ORA-4 / C3 / M-A1).**
  Moving the deviation guard into `withdraw()` lets `redeem()` revert
  `NavMarketDeviationExceeded` during divergence — a change from today's
  exit-liveness, not parity, and in tension with ADR-0009's "redemption never
  revoked". If retained on the exit side it MUST carry an emergency override.
- **Split-pause observability change (LIFE-3 / M-A4).** Recorded in §6:
  `paused()` semantics change for the indexer and rmpc withdraw-preflight.
- The following residual adapter-boundary hardening MUST be carried by the
  spec:
  - **Foreign-token protected set (INV-2 / M-S4).** The vault's
    `sweepForeignToken` protected set must include the union of all adapters'
    custodied tokens (not just USDC + shares), or a basket token mis-sent to
    the vault becomes permissionlessly sweepable — depositor-asset
    confiscation.
  - **Venue-independent emergency floor + NAV-recount (M-S2 / ADP-2).** ADP-2's
    "exclusion-not-confiscation" assumes cheap 1:1 USDC recovery, false for
    token-custody adapters whose recovery needs a live swap venue. The spec
    must define a vault-side emergency floor (not the untrusted adapter's) and
    a venue-independent NAV-recount / reabsorb path for a revoked token
    adapter.
  - **Adapter emergency arming-latency vs. vault EMERGENCY (ACL-5 / M-S5).**
    Two-key arming is atomic on one contract today; unified, a naive split
    would make arming an adapter write behind a ≥48h ADMIN timelock while
    execution comes from the vault EMERGENCY surface, which cannot atomically
    reach a fresh adapter arm. The resolution is **atomic EMERGENCY
    arm+execute**: incident-critical emergency actions are `EMERGENCY_ROLE`
    hot-key actions the responder arms and executes in a single action, with no
    intervening ADMIN timelock — preserving the fast-EMERGENCY / timelocked-ADMIN
    asymmetry. A blast-radius review scoping which actions are atomic is
    required before Phase 2. The latency is closed by collapsing arm and
    execute, not by making the action permissionless.
  - **Read-only-reentrancy enumeration (M-S6).** The per-asset deposit call
    graph is now vault → adapter → router → (V4 hook / Aerodrome callback);
    `nonReentrant` blocks re-entry into `_deposit`/`_withdraw` but not **view**
    surfaces (`totalAssets`, `previewRedeem`, `maxWithdraw`) read mid-callback
    in a half-swapped NAV state. The enumeration must be re-published for this
    call graph and `hooks == address(0)` asserted on V4 adapters at
    construction.
- A full re-audit of the Vault plus the adapter set is required; v1 audit
  results do not transfer wholesale.
- ERC-4626 conformance must be re-verified per composition — exact mode
  versus redeem-only mode behave differently and both must be exercised;
  the exit-fee base also differs per composition (fee-on-gross exact vs.
  fee-on-realized inexact), which integrators must branch on.

**Out of scope of this decision.**

- The engineering detail — the normative `IPositionAdapter` interface, both
  `allExact()` accounting branches, storage layout, rounding, guard
  thresholds, the residual-price-check mechanism, the Phase-2 gas budget, and
  deployment scripts — lives in `docs/technical/unified-vault-spec.md`.
- v1 retirement mechanics and depositor communication — governed by ADR-0009.
- Venue adapter mechanics (`IBasketSwapAdapter`) — governed by ADR-0005,
  unchanged; the seam is consumed by `AssetPositionAdapter`s instead of the
  vault.
- deSPXA asset constraints (KYC, freeze risk, Chronicle heartbeat) — governed
  by ADR-0006, unchanged.
