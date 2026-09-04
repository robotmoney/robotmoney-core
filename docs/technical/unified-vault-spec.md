<!-- Canonical: build-from engineering specification for the unified vault
     architecture. Decision rationale: docs/adr/ADR-0010-unified-vault-architecture.md.
     (See also: docs/technical/adapter-architecture.md — current IStrategyAdapter layer;
      docs/technical/smart-contract-invariants.md — invariant catalog this spec preserves;
      docs/technical/basket-vault-gap-report.md — router-eligibility bar;
      docs/adr/ADR-0003-basketvault-rebalancing-model.md — rebalancing stub superseded here;
      docs/adr/ADR-0006-despxa-rwa-vault-design.md — deSPXA constraints carried into the
      Chronicle position adapter;
      docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md — NAV-haircut redemption
      policy carried into inexact compositions;
      docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md — v1 retirement path.) -->

# Unified Vault — Engineering Specification

> Scope: the buildable specification for collapsing the two production vault
> families — `RobotMoneyVault` (lending adapters behind `IStrategyAdapter`) and
> the `BasketVault` subclasses (`ProtocolAssetVault`, `AgentTokenVault`,
> `RwaVault`, which swap-and-custody basket tokens directly) — into a **single
> `Vault` contract** composed with **`IPositionAdapter`** implementations.
> Every behavioral difference between the two families becomes an adapter
> property, not a vault subclass. The *decision* and its alternatives live in
> `docs/adr/ADR-0010-unified-vault-architecture.md`; this document specifies
> what to build. Section 6 maps every named invariant/finding tag in the two
> source contracts to its enforcement locus in the unified design; Section 7
> defines the parity proof; Section 9 defines delivery phases.

Source contracts this spec unifies:

- `contracts/RobotMoneyVault.sol` (deployed, rmUSDC)
- `contracts/vaults/BasketVault.sol` + `contracts/vaults/ProtocolAssetVault.sol`
  (rmPROTO), `contracts/vaults/AgentTokenVault.sol` (rmAGENT),
  `contracts/vaults/RwaVault.sol` (rmRWA)
- `contracts/interfaces/IStrategyAdapter.sol` (superseded by `IPositionAdapter`)
- `contracts/interfaces/IBasketSwapAdapter.sol` (retained unchanged as the
  venue-execution seam *behind* the new `AssetPositionAdapter`)

---

## 1. Design summary

The unifying observation: both vault families are "route USDC into positions,
price positions in USDC, pull positions back to USDC proportionally." They
differ only in whether a position is **exact** (a lending balance whose deposit
and withdrawal are 1:1 in USDC — Morpho/Aave/Compound) or **inexact** (a token
holding acquired and exited through a swap, with slippage and oracle pricing —
wETH, cbBTC, wSOL, agent tokens, deSPXA).

The unified design:

1. **`IPositionAdapter`** — a superset of `IStrategyAdapter` that adds min-out
   parameters, a realized-value return on `deploy`, and an `isExact()`
   self-declaration (§2).
2. **Lending adapter retrofit** — Morpho/Aave/Compound adapters implement the
   new signatures trivially; `isExact() == true` (§3).
3. **`AssetPositionAdapter`** — a new adapter, one instance per basket asset,
   that custodies the token and absorbs all swap execution, TWAP/oracle
   pricing, and per-asset guard config that today lives on `BasketVault` (§4).
4. **Unified `Vault`** — `RobotMoneyVault`'s shell (registry, caps, lifecycle,
   fees) with `BasketVault`'s route-first, mint-on-realized-delta deposit core
   and redeem-only gating when any active adapter is inexact (§5).

A vault whose adapters are all exact behaves bit-identically to today's
`RobotMoneyVault` (including full ERC-4626 `withdraw()` exactness); a vault
with one or more inexact adapters behaves like today's `BasketVault`
(redeem-only, slippage-floored previews, ADR-0007 NAV-haircut redemption).

---

## 2. `IPositionAdapter`

Replaces `IStrategyAdapter` (`contracts/interfaces/IStrategyAdapter.sol`).
Lives at `contracts/interfaces/IPositionAdapter.sol`.

### 2.1 Interface

```solidity
interface IPositionAdapter {
    function deploy(uint256 usdcIn, uint256 minValueOut) external returns (uint256 valueAdded);
    function withdraw(uint256 usdcWanted, uint256 minUsdcOut) external returns (uint256 usdcOut);
    function totalAssets() external view returns (uint256); // USDC-denominated
    function isExact() external view returns (bool);
    function harvestRewards() external;
    function sweepForeignToken(address token) external;
    // Identity/compatibility views (required by the vault's eligibility probe):
    function USDC() external view returns (address);
    function VAULT() external view returns (address);
}
```

### 2.2 Method semantics

**`deploy(uint256 usdcIn, uint256 minValueOut) → uint256 valueAdded`**

- *Authority:* `onlyVault`. The vault `safeTransfer`s `usdcIn` USDC to the
  adapter **before** calling `deploy` (same choreography as today's
  `_allocateTo`); the adapter never pulls via `transferFrom` on this path.
- *Effect:* converts the received USDC into the adapter's position (a lending
  supply, or a token swap for `AssetPositionAdapter`).
- *Return:* `valueAdded` is the USDC-denominated increase in the adapter's
  `totalAssets()` attributable to this call, measured with the adapter's own
  pricing (live venue balance for exact adapters; TWAP/oracle mark for asset
  adapters). Exact adapters MUST return exactly `usdcIn`.
- *Min-out obligation:* the adapter MUST revert when `valueAdded <
  minValueOut`. There is no clamp-and-continue on the deploy path: a deploy
  that cannot capture the floor is a failed deploy. For asset adapters the
  venue-level `minAmountOut` (TWAP-derived) fires first; the `valueAdded`
  check is the belt-and-suspenders equivalent of AZ-BSK-1 at the adapter
  boundary.
- *Reverts:* venue failure, slippage floor breach, oracle staleness/deviation
  guard (asset adapters, §4), exposure cap (`MorphoAdapter.maxExposure`
  retained as-is).

**`withdraw(uint256 usdcWanted, uint256 minUsdcOut) → uint256 usdcOut`**

- *Authority:* `onlyVault`.
- *Effect:* liquidates position back to USDC and delivers it **to the vault**
  (directly from the venue where supported, e.g. Aave `POOL.withdraw(_,_,
  VAULT)`, otherwise adapter-forwarded). The adapter never delivers to a
  caller-supplied recipient (INV-1).
- *Sentinel:* `usdcWanted == type(uint256).max` means "withdraw everything"
  (used by emergency drains and adapter retirement).
- *Clamp vs revert rule:* the adapter clamps `usdcWanted` at its own
  liquidatable balance and returns the realized `usdcOut` (this preserves
  today's `IStrategyAdapter.withdraw` "actual may be ≤ amount" contract that
  `_pullProportional`'s two-pass sweep and `InsufficientAdapterLiquidity`
  accounting depend on). It MUST NOT clamp below `minUsdcOut`: if the realized
  proceeds would be `< minUsdcOut`, the adapter reverts. So: **shortfall
  against `usdcWanted` clamps; shortfall against `minUsdcOut` reverts.**
- *Floor composition rule:* the effective execution floor is
  `max(minUsdcOut, adapterInternalFloor)`. Asset adapters always enforce
  their own TWAP-derived (or emergency-guard) floor even when the caller
  passes `minUsdcOut == 0`; the caller parameter can only tighten, never
  loosen. `minUsdcOut == 0` therefore means "adapter's own floor applies",
  not "no floor". Exact adapters have no internal floor (`usdcOut ==
  min(usdcWanted, balance)` by construction), so any `minUsdcOut ≤ usdcOut`
  is trivially satisfied.

**`totalAssets() → uint256`** (view)

- USDC-denominated live value of the position: principal plus accrued
  interest for lending adapters; TWAP-priced token balance (or Chronicle
  NAV × balance) for asset adapters. Spot (`slot0`) is never read on this
  path (ORA-1).
- MAY revert fail-closed when the adapter's price source is unusable (stale
  Chronicle feed with a non-zero token balance, TWAP `observe()` "OLD") —
  the vault deliberately propagates this so price-sensitive operations halt
  (ORA-2). MUST NOT revert when the position balance is zero (the SUP-5
  idle-USDC redemption short-circuit moves from `RwaVault.totalAssets` into
  the adapter: zero balance ⇒ return 0 without touching the oracle).

**`isExact() → bool`** (view, effectively constant per implementation)

- `true` declares: `deploy(x, _)` adds exactly `x` and `withdraw(x, _)`
  returns exactly `x` whenever the venue has liquidity, and `totalAssets()`
  is a hard redemption claim, not a mark. Lending adapters return `true`;
  `AssetPositionAdapter` returns `false`.
- **The adapter's `isExact()` return is used ONLY as an at-registration
  cross-check, never as a per-call gate.** Share-value-critical paths read the
  vault-attested `AdapterInfo.isExact` bool (§5.1/§5.3), which ADMIN sets in
  the same `addAdapter` act that pins the codehash. The self-reported view is
  a bytecode-level property pinned by the codehash allowlist, but codehash
  pinning proves *bytecode identity, not pricing semantics* — a
  `true`-but-actually-inexact adapter would otherwise select the OZ-exact
  preview branch and discard the AZ-BSK-1/SUP-3 slippage discount, re-opening
  the round-trip leak SUP-3 closes (review S-F3). Attestation at
  `addAdapter` removes that per-call trust dependency; `addAdapter` MAY
  additionally `require(adapter.isExact() == attestedIsExact)` as a
  deploy-time sanity check, but the stored bool is authoritative thereafter.
  *Decision note:* the interface keeps the `isExact()` view for
  monitoring/differential-test use and the registration cross-check; the
  alternative (drop it from the interface entirely) is left open but not
  recommended, since the cross-check has value.

**`harvestRewards()`**

- Permissionless. Claims venue reward emissions, converts to USDC, credits
  the vault — never a caller-supplied address (INV-1), never stranded on the
  adapter (INV-2 / CUST-6 / ADP-3). MUST NOT revert when there is nothing to
  claim (no-op for Aave-style auto-accrual and for plain token holdings).

**`sweepForeignToken(address token)`**

- Permissionless quarantine sweep, unchanged semantics from
  `IStrategyAdapter`: destination is the fixed quarantine address, never
  caller-supplied (INV-1). Protected (unsweepable) tokens per adapter:
  USDC, the venue receipt/share token (lending adapters), and the custodied
  basket token (`AssetPositionAdapter`) — protected balances stay in NAV and
  accrue pro-rata (INV-2).

**`USDC()` / `VAULT()`** — identity views consumed unchanged by the vault's
`_isAdapterEligible` / `_requireAdapterCompatible` probes (asset match and
vault binding).

---

## 3. Lending adapter retrofit (Morpho / Aave / Compound)

`MorphoAdapter`, `AaveV3Adapter`, `CompoundV3Adapter` migrate from
`IStrategyAdapter` to `IPositionAdapter`. `isExact()` returns `true`. The
min-out parameters are trivially satisfiable and enforced with one comparison
each.

Exact signature changes versus today:

| Member | Today (`IStrategyAdapter`) | Unified (`IPositionAdapter`) | Retrofit behavior |
|---|---|---|---|
| `deploy` | `deploy(uint256 amount)` — no return | `deploy(uint256 usdcIn, uint256 minValueOut) returns (uint256 valueAdded)` | Supply `usdcIn` as today; return `usdcIn`; `require(usdcIn >= minValueOut)` (revert otherwise). `MorphoAdapter.maxExposure` / `ExposureCapExceeded` check unchanged. |
| `withdraw` | `withdraw(uint256 amount) returns (uint256 actual)` | `withdraw(uint256 usdcWanted, uint256 minUsdcOut) returns (uint256 usdcOut)` | Withdraw as today (clamped at balance, measured delta); `require(usdcOut >= minUsdcOut)`. `type(uint256).max` sentinel unchanged. |
| `totalAssets` | unchanged | unchanged | Live venue balance (aToken / Comet balance / `convertToAssets` of Morpho shares). |
| `isExact` | — (absent) | `isExact() view returns (bool)` | Hardcoded `return true;`. |
| `harvestRewards` | unchanged | unchanged | No-op where accrual is automatic. |
| `sweepForeignToken` | unchanged | unchanged | Same protected-token set. |
| `USDC()` / `VAULT()` | present (immutables) | now part of the interface | No change. |

The lending adapters are redeployed (new bytecode = new codehash for the
allowlist); the deployed `RobotMoneyVault` v1 and its `IStrategyAdapter`
instances are untouched and retire per ADR-0009 (§9, Phase 6).

---

## 4. `AssetPositionAdapter`

New contract, `contracts/adapters/AssetPositionAdapter.sol`. **One instance
per basket asset per vault.** It is the load-bearing move of the unification:
everything venue- and asset-specific that today lives on `BasketVault`
(custody of the token, swap execution, TWAP config, unwind guards, pool
preconditions, deviation guard) moves here, leaving the vault asset-agnostic.

### 4.1 Custody and flow

- The adapter — not the vault — holds the ERC-20 basket token. The vault
  holds only USDC (idle) and adapter registry entries.
- `deploy(usdcIn, minValueOut)`: swap USDC → token through the configured
  `IBasketSwapAdapter` venue executor; `valueAdded` = TWAP-priced value of
  tokens received; enforce venue `minAmountOut` (TWAP × (1 − slippage)) and
  the `minValueOut` floor.
- `withdraw(usdcWanted, minUsdcOut)`: swap token → USDC sized as
  `tokenBalance × usdcWanted / totalAssets()` (clamped at balance; the
  `type(uint256).max` sentinel sells everything); deliver proceeds to the
  vault; enforce `max(minUsdcOut, twapFloor)` per §2.2.
- `totalAssets()`: `twapUsdcValue(tokenBalance)` — or `chronicleNav ×
  balance` with the heartbeat check for deSPXA (§4.4). Zero balance short-
  circuits the oracle read (SUP-5).
- `isExact()` returns `false`.

### 4.2 Venue execution seam

Execution reuses the existing `IBasketSwapAdapter` interface
(`contracts/interfaces/IBasketSwapAdapter.sol`) **unchanged**:
`AerodromeSwapAdapter`, `UniswapV4SwapAdapter`, and `ChronicleOracleAdapter`
remain the stateless swap+TWAP executors. Two changes at the seam:

1. A concrete **`UniswapV3SwapAdapter`** is written (Phase 2) wrapping the
   immutable `SWAP_ROUTER` `exactInputSingle` path, so the `adapter ==
   address(0)` inline-V3 special case in `BasketVault._executeSwap` does not
   carry into `AssetPositionAdapter` — every venue goes through one seam.
2. Approval hygiene carries over verbatim: `forceApprove(venue, amount)`
   before, `forceApprove(venue, 0)` after (ADP-5).

The `Venue` enum (`V3`/`V4`/`Aerodrome`, plus Chronicle-priced Aerodrome for
deSPXA) is recorded on the adapter as an immutable for governance/monitoring
inspection, replacing `AssetInfo.venue`.

### 4.3 Moved controls — old home → new home and authority

| Control (today on `BasketVault`) | New home | New authority | Notes |
|---|---|---|---|
| Token custody (`IERC20(token).balanceOf(vault)`) | Adapter balance | — | Vault never holds basket tokens. |
| `AssetInfo {token, pool, swapFee, adapter, venue}` | Adapter constructor immutables | Deploy-time | Registering the asset = `Vault.addAdapter(assetPositionAdapter, capBps)`. |
| `twapWindow[token]`, `setTwapWindow`, `MIN_TWAP_WINDOW` (600 s) / `MAX_TWAP_WINDOW` (86 400 s) / `DEFAULT_TWAP_WINDOW` (1 800 s), `effectiveTwapWindow` | Adapter storage + setter, constants carried verbatim | Vault-admin-derived (see below) | Same bounds, same `0 → DEFAULT` fallback, same `TwapWindowUpdated` event. |
| `EmergencyUnwindGuard {minUsdcOut, overrideAllowed, maxLossBps}`, `setEmergencyUnwindGuard` | Adapter storage + setter | Vault-admin-derived | Consumed by the emergency drain path (§4.4). |
| `MIN_POOL_CARDINALITY` (2), `MIN_POOL_LIQUIDITY` (1e6), `InsufficientObservationHistory` — `BasketAssetConfigGuard.requirePoolUsable` | Adapter **constructor** precondition | Deploy-time | An adapter for an unusable pool cannot be constructed; `Vault.addAdapter` codehash+identity checks then gate registration. |
| ORA-3 execution-pool == TWAP-pool (`requireExecutionPoolMatchesTwap`) | Adapter constructor precondition | Deploy-time | Same guard library, invoked once at construction instead of per `addAsset`. |
| ORA-4 `navDeviationGuardBps`, `setNavDeviationGuardBps`, `MAX_NAV_DEVIATION_BPS` (2 000), `NavMarketDeviationExceeded` | Adapter storage + setter, checked inside `deploy()` **only** (entry-side); **plus** a vault-side residual independent check on `deploy` (see below) | Vault-admin-derived (timelock) | **Entry-side only (C3/M-A1 decision).** The adapter self-check is NOT sufficient alone — a codehash-pinned-but-buggy adapter mis-scales NAV *and* passes its own probe. The withdraw path deliberately omits this guard to preserve redemption liveness (§5.3). `0` disables (fixtures). |
| `maxSlippageBps` swap floors (`_applySlippage`, `_slippageFloor`) | Split: vault keeps one `maxSlippageBps` for preview math and the min-out it passes per call (§5.2); adapter enforces the venue `amountOutMinimum` from its own TWAP × the vault-supplied floor | Vault `ADMIN_ROLE` | `MAX_SLIPPAGE_BPS` (500) ceiling stays on the vault. |
| `SlippageBelowPoolFeeFloor` / `minSlippageFloorBps` (L-17 brick guard) | Adapter exposes `minOutFloorBps() view` (its pool fee in bps; lending adapters return 0); `Vault.setMaxSlippageBps` takes the max over active adapters | Vault `ADMIN_ROLE` | Same invariant: a single admin write can never make every swap unsatisfiable. |
| `adapterCodeHashAllowed` for swap adapters (ADP-2/NC-2) | Unchanged concept, one level down: the **vault** pins the `AssetPositionAdapter` codehash (which bakes in the venue-executor address and linked `TickMath`); the AssetPositionAdapter's venue executor is a constructor immutable | Vault `ADMIN_ROLE` | Codehash pinning subsumes hot-swap protection exactly as today. |
| `reabsorbRemovedAsset` (LIFE-6, AZ-BSK-5) | Adapter `reabsorb(uint256 minUsdcOut)` — permissionless; swaps a reappeared/donated token balance on a **retired-from-registry** adapter back to USDC delivered to the vault, TWAP-floored, `SlippageExceeded` on caller-floor breach, quarantine fallback when the TWAP read reverts | Permissionless | Same never-revert-and-strand contract. |
| Chronicle heartbeat (`oracleHeartbeat`, `MAX_HEARTBEAT`, `StalePriceFeed`), stale-unwind override (ACL-5/F-08) | deSPXA adapter variant (§4.4) | Heartbeat setter: vault-admin-derived (ADMIN timelock); stale-override + unwind: **atomic `EMERGENCY_ROLE` arm+execute** on the vault emergency path (M-S5) | Heartbeat bounds carried verbatim from `RwaVault`; the arm/execute split collapses to one EMERGENCY action. |
| `maxAssets()` (subclass constant; 1 for RwaVault) | Vault constructor param `maxActiveAdapters_` (§8) | Deploy-time | rmRWA's single-asset constraint becomes an adapter-count cap. |

**"Vault-admin-derived" authority:** adapters carry no independent role tree.
Config setters are gated by a `onlyVaultAdmin` modifier that queries
`AccessControl(VAULT).hasRole(ADMIN_ROLE, msg.sender)` — the vault's
timelock-held admin governs its adapters transitively, preserving INV-3
(fee/guard/quarantine parameters change only via the timelock) without
duplicating role bookkeeping per adapter. Incident-critical emergency actions
(Chronicle stale-override, emergency-unwind guard) are **atomic
`EMERGENCY_ROLE` arm+execute** — the responder arms and executes them in a
single hot-key action with no intervening ADMIN timelock, so a fresh arm is
never blocked by the 48h ADMIN latency mid-incident (§5.5, M-S5). Routine
per-adapter config stays on the full ADMIN timelock. Residual questions on this
model (blast radius, exact set of atomic actions) are in §10.

### 4.3a Residual vault-side price sanity check (C3)

The unification collapses **pricing** and its **sanity-check** into the same
self-pricing adapter: the adapter both *produces* `totalAssets()` and, in the
committed spec, *self-checks* its own deviation, while the vault sums
`Σ adapter.totalAssets()` with no second opinion. A codehash-pinned-but-buggy
adapter (wrong decimals scaling — ORA-6/F-17 is *already live* for
`ChronicleOracleAdapter` hardcoding `1e12`; or admin-set
`navDeviationGuardBps == 0`; or too-short TWAP window) mis-marks NAV **and**
passes its own probe with the same mis-scaling — collapsing the ORA-7
principle that a slippage/deviation floor is never derived solely from the
same oracle that prices the trade. Codehash proves bytecode, not correctness;
FEE-2 guards only the withdraw-fee path, nothing on deposit where over-marking
dilutes holders (last-out bank-run).

The unified vault therefore keeps a **residual, adapter-INDEPENDENT vault-side
price sanity check** on the `deploy`/entry path, structurally outside every
adapter's own pricing code. The check is a **single global cap on how fast the
vault's aggregate NAV may grow between observations**:

- The vault holds **one checkpoint for the whole vault** — the last aggregate
  `totalAssets()` and the timestamp it was observed — not one checkpoint per
  adapter.
- On a deposit, the vault computes the implied growth rate of aggregate NAV
  since the checkpoint and **rejects the deposit** when it exceeds a governance
  `maxNavGrowthRateBps` per unit time (a jump no honest set of venues
  produces), then updates the checkpoint. This is fully adapter-independent, it
  needs **no governance-registered per-adapter reference pools**, and it
  catches the mis-scale/over-mark class without a second oracle.

Because the checkpoint is aggregate, the limiter bounds the **speed** of a
mis-mark but **cannot identify which adapter moved**. It is therefore an
aggregate deposit circuit-breaker, **not** a per-adapter drain trigger:
localizing a failing adapter is the EMERGENCY responder's job, driven by the
per-adapter failure conditions (oracle stale past heartbeat, adapter calls
reverting), not by this check (§4.4, §5.5).

This check is **entry-side only** — it does not run on withdraw (§5.3, M-A1),
and redemptions are never gated by it. It is a deposit circuit-breaker, not a
rebalance-safety precondition: ordinary rebalancing flow is composition-blind
and does not trade on an adapter's mark, and the one mechanism that does
(`forceRebalance`) is caller-funded, so there is no valuation-driven trading
loop for this check to precondition (§5.6, C3a). A single vault-wide
checkpoint is strictly smaller than a per-adapter checkpoint set and than a
registered-pool deviation check;
both of those variants are rejected in favor of the one global checkpoint.

### 4.4 Emergency and oracle semantics

- **Vault-initiated drain** (`Vault.emergencyWithdraw` /
  `emergencyWithdrawAdapter`, §5.5) calls `withdraw(type(uint256).max, 0)`.
  Per the §2.2 floor-composition rule the adapter enforces
  `max(TWAP floor, EmergencyUnwindGuard.minUsdcOut)`; if the TWAP read
  reverts and no configured floor exists, the adapter reverts
  `EmergencyFloorUnavailable` — which the vault's try/catch drain loop
  records as a per-adapter failure (`EmergencyWithdrawAdapterCalled` with
  `success == false`) and continues, exactly today's multi-adapter drain
  behavior.

- **Vault-side emergency floor + venue-independent recovery (M-S2).** ADP-2's
  "exclusion-not-confiscation" rests on cheap 1:1 USDC recovery via
  `emergencyWithdrawAdapter` — true for lending adapters, **false** for
  token-custody `AssetPositionAdapter`s where recovery needs a *swap*. A
  deSPXA freeze or a dead venue makes the drain revert
  `EmergencyFloorUnavailable`, leaving the token excluded-from-NAV =
  de-facto confiscated. Old `BasketVault` held tokens itself, so a freeze kept
  them **counted** and `reabsorbRemovedAsset`-able; the per-adapter
  `reabsorb()` has no path to re-count a revoked-but-active adapter's tokens
  without a live venue. Two additions close this:
  1. **Vault-side emergency floor (not the untrusted adapter's).** The
     `EmergencyUnwindGuard.minUsdcOut` used to bound an override-drain is a
     **vault-stored, timelock-set** value (mirrored into / read by the
     adapter), so a compromised adapter cannot lower or fabricate its own
     emergency floor to grief the drain. The vault passes this floor into the
     drain call rather than trusting an adapter-local one.
  2. **Venue-independent NAV-recount / reabsorb path.** For a revoked token
     adapter whose venue is dead/frozen, the vault provides
     `reabsorbRevokedAdapter(adapter, minUsdcOut)`: when a live venue exists
     again (or an admin-registered alternate venue executor, §10 Q2) it swaps
     the stranded balance back to USDC delivered to the vault, TWAP/floor
     bounded, quarantine-fallback on read revert (LIFE-6). Until a venue
     exists the tokens are **held on the adapter and remain drainable/
     recountable** — never burned, never permanently excluded. *Decision
     note:* re-counting a revoked adapter's frozen token into NAV without a
     venue would re-introduce an untrusted mark, so recovery is
     value-realized (swap) not mark-recounted; the interim state is
     "excluded-but-recoverable," which the incident runbook (§9 Phase 6.5)
     must document as a known non-instant path.
- **Override path**: `emergencyUnwindWithOverride` semantics (explicit
  opt-in per token, `maxLossBps` upper-loss cap, `EmergencyUnwindOverrideUsed`
  audit event, `EmergencyUnwindLossCapExceeded`) move onto the adapter as an
  `emergencyUnwindWithOverride()` entry callable only through the vault's
  emergency surface (EMERGENCY_ROLE at the vault; the adapter checks
  `msg.sender == VAULT`).
- **Chronicle variant** (deSPXA): a `ChronicleAssetPositionAdapter` (or a
  pricing-mode flag on `AssetPositionAdapter`; Phase 4 decides) prices
  `totalAssets`/floors from the Chronicle feed with the heartbeat check
  (default 24 h, cap `MAX_HEARTBEAT` 48 h), fails closed on staleness while
  the token balance is non-zero (ORA-2), short-circuits at zero balance
  (SUP-5/NC-1). The stale-price override is an **atomic `EMERGENCY_ROLE`
  arm+execute** action on the vault's emergency path — armed and executed in
  one hot-key action with no intervening ADMIN timelock (M-S5), so an incident
  is never blocked by the 48h ADMIN latency; the fast-EMERGENCY /
  timelocked-ADMIN asymmetry the F-08 posture protects is preserved by keeping
  routine config on the ADMIN timelock. ADR-0006's constraints (no ERC-7540
  primary redemption, Aerodrome secondary market only, issuer freeze-control
  risk) carry unchanged.

### 4.5 Read-only reentrancy enumeration (M-S6)

security-model §2 *requires* the external-call-graph reentrancy enumeration be
published and kept current; the unification changes the graph, so it is
re-published here. Deposit is now, per asset:

```
Vault._deposit (nonReentrant)
  └─ AssetPositionAdapter.deploy   (onlyVault)
       └─ IBasketSwapAdapter venue executor (V3 / V4 / Aerodrome)
            └─ Uniswap V4 PoolManager  → V4 hook callback   (rmPROTO/rmAGENT)
            └─ Aerodrome pool          → swap callback
```

- The vault `nonReentrant` blocks re-entry into `_deposit`/`_withdraw`, **but
  not view surfaces.** `totalAssets()`, `previewRedeem`, `maxWithdraw`, and
  `allExact()` can be read mid-callback (inside a V4 hook or an Aerodrome swap
  callback) while the adapter is in a **transient half-swapped NAV state** —
  the token is partly sold but proceeds not yet settled, so the mark is
  momentarily wrong. Any integrator/router/oracle reading vault views inside
  such a callback sees a manipulable NAV (read-only reentrancy). This
  enumeration MUST be kept current as venues are added and referenced from the
  security model.
- **Mitigation, asserted at construction:** V4 adapters MUST have
  `hooks == address(0)`. The `AssetPositionAdapter` (and its V4 venue executor)
  **require+assert `hooks == address(0)`** in the constructor — a V4 pool
  configured with a hook is un-constructable as an adapter — removing the hook
  callback edge entirely for V4. Aerodrome's swap-callback edge is bounded by
  the adapter's own `nonReentrant` on `deploy`/`withdraw` and by the fact that
  the vault never exposes a state-mutating re-entry point mid-callback; the
  enumeration flags the residual view-read exposure so integrators reading
  vault views inside a swap callback are on notice. A deploy-assertion test
  (`hooks == address(0)`) is required in Phase 2 (§9).

---

## 5. Unified `Vault`

`contracts/Vault.sol`. Non-abstract; every theme is a deployment
configuration, not a subclass.

### 5.1 Shell — carried from `RobotMoneyVault`

Carried structurally verbatim (same storage names, events, errors, and
semantics unless a row in §4.3 or a subsection below says otherwise):

- Adapter registry: `AdapterInfo[] {adapter, capBps, active, isExact}`,
  `MAX_ADAPTERS` (20), `addAdapter`/`removeAdapter` (`AdapterNotEmpty`
  guard)/`setAdapterCap`, `forceRemoveAdapter`. **`isExact` is a
  vault-attested `bool` set by `ADMIN_ROLE` at `addAdapter`** (the same act
  that pins the codehash and allowlist entry), not read from the adapter per
  call (§2.2, C2 fix). `addAdapter(adapter, capBps, isExact)` gains the
  attestation argument.
- **Exact→inexact composition transition (C2 / E-4 / A-M8).** Adding the
  first `isExact == false` adapter to a currently all-exact vault flips
  `allExact()` false, which turns `withdraw()`/`previewWithdraw()` from live
  to `RedeemOnly` for every integrator and reprices already-held shares onto
  the floored preview branch. This transition MUST route through the
  `ADMIN_ROLE` timelock like any other guard change (INV-3) and MUST emit
  `ExactnessTransition(bool wasAllExact, bool nowAllExact, address adapter)`
  so integrators/indexer observe the class change. A same-class `addAdapter`
  (inexact→inexact, or exact→exact) does not fire it. *Decision note:* the
  timelock here is the composition-class change, not a second delay on top of
  `addAdapter`; if `addAdapter` is already timelock-gated the event is the
  only new surface.
- Eligibility pinning: `adapterAllowed` (exact instance) +
  `adapterCodeHashAllowed` (runtime bytecode) + `USDC()`/`VAULT()` identity
  probes; `_isAdapterEligible` / `_requireAdapterEligible`.
- **ADP-2 / F-14**: `_isAdapterCounted` (active AND eligible) gates both
  `totalAssets()` NAV summation and `_pullProportional` — a revoked adapter
  neither prices NAV nor receives/returns withdrawal flow;
  exclusion-not-confiscation (EMERGENCY can still drain, eligibility is
  restorable).
- Target allocation weights (governance-set, equal-weight default) that only
  an explicit admin `forceRebalance` call ever moves composition toward
  (§5.6) — ordinary deposit/withdrawal flow is composition-blind.
  `forceRebalance` is NAV-non-decreasing: the caller supplies USDC covering
  realized slippage and fees or the call reverts, so no cost is socialized.
  There is **no** `rebalance()` / `adminRebalance()`, **no** `KEEPER_ROLE`
  rebalancer, and **no** rebalance throttles — `maxRebalanceBpsPerCall` /
  `minRebalanceInterval` are removed; correction is `forceRebalance`-only
  (§5.6).
- Split pause flags `depositsPaused` / `withdrawalsPaused` (authority changes
  in §5.5), `shutdownVault`/`restoreVault(newTvlCap)`, registry-driven
  `retire()`/`unretire()` with the set-once `setRegistry` link (DI-2).
- Exit fee (`exitFeeBps` ≤ `MAX_EXIT_FEE_BPS` 100, `feeRecipient`,
  `ExitFeeCharged`), `tvlCap`/`perDepositCap` with cross-validation,
  timelock-settable `quarantineAddress` + permissionless
  `sweepForeignToken`. **Protected (unsweepable) set — M-S4 / INV-2 fix:**
  USDC, the share token, **and the union of every registered adapter's
  custodied token**. `RobotMoneyVault` today protects only USDC + share token
  (`RobotMoneyVault.sol:1125-1130`) because its lending adapters custody their
  own receipts; but an `AssetPositionAdapter`'s basket token can be
  donated/mis-sent to the *vault*, and the un-augmented set would let anyone
  sweep it to the burn address — depositor-asset confiscation (`BasketVault`
  protected every registered basket asset, active or inactive, for exactly
  this reason). The vault computes the protected set by querying each
  registered adapter for its custodied token(s) (an adapter view, e.g.
  `custodiedTokens() returns (address[])`, lending adapters returning the
  venue receipt + USDC, asset adapters returning their basket token) **over
  the full `adapters` array including inactive/removed-but-still-registered
  entries**, or by mirroring a governance-maintained protected set. *Q7
  removed-then-readded case:* because the set spans registered entries not
  just active ones, a token whose adapter was removed and later re-added stays
  protected across the gap as long as *any* registration referencing it
  persists; if `removeAdapter` fully deletes the entry, the vault MUST fall
  back to the governance-mirrored set so a token mid-migration is never
  transiently sweepable (resolves Q7's sweep half — see §10).
- Share scale: `decimals() == 6`, `_decimalsOffset() == 18` (CUST-5).
- Roles: `ADMIN_ROLE` (self-admin) and `EMERGENCY_ROLE`, with the
  pause/unpause and shutdown/restore trust asymmetry. There is no
  `KEEPER_ROLE` — rebalancing is `forceRebalance`-only (§5.6), so no keeper is
  granted or wired.
- **Plus, shared with `BasketVault` and `RobotMoneyVault`:** the ACL-3/F-06
  last-admin floor, consolidated into the single base contract
  `lib/AdminFloorAccessControlCounter.sol` (`adminCount` counter in
  `_grantRole`/`_revokeRole` hooks, `LastAdminFloor`) that all three
  inherit — issue #1284 backported it to `RobotMoneyVault`, which had no
  such protection before, and replaced the two independent hand-rolled
  copies on `Vault`/`BasketVault` with one owner.
- Views: `getAdapterInfo`, `getAdapterDrift`, `adapterCount`,
  `activeAdapterCount`, `currentTargetBps`, `isShutdown`, plus the
  pause/exactness views below. The throttle views `isRebalanceAvailable` /
  `nextRebalanceAt` are removed with the throttles (§5.6); `getAdapterDrift` /
  `currentTargetBps` remain, describing the target allocation the flow tends
  toward.
- **`allExact() view returns (bool)`** — true iff every active adapter's
  **vault-attested** `AdapterInfo.isExact` is true (never the adapter's
  self-report). Integrators, the dapp, and the router gate `withdraw`-shaped
  flows on this **statically** (C2). It SHOULD also be surfaced by
  `VaultRegistry` (mirrored on eligibility/registration, or read through a
  registry view) so the router/gateway can gate without a direct vault call.
- **`maxWithdraw(owner)` / `maxRedeem(owner)` when `!allExact()`** — MUST
  return `0` (not a positive value), so an ERC-4626 integrator calling
  `withdraw(maxWithdraw(owner), …)` can never hit `RedeemOnly` (ERC-4626
  requires `withdraw(maxWithdraw(owner))` not revert; a positive `maxWithdraw`
  alongside a reverting `withdraw` is a conformance violation — review E-4).
  *Decision note:* returning `0` is the ERC-4626-safe choice and the one
  specified here. A documented alternative — return a `convertToAssets`-based
  value and keep `withdraw` live but internally re-route through the
  redeem/floored path — is left open but rejected here because it would
  silently change the exactness guarantee integrators rely on. When
  `allExact()`, `maxWithdraw`/`maxRedeem` keep `RobotMoneyVault`'s net-of-fee
  floor rounding and paused→0 behavior.
- **`paused()`, `depositsPaused`, `withdrawalsPaused` views** — see §5.5;
  `depositsPaused`/`withdrawalsPaused` are exposed as first-class public views
  (not only the composite `paused()`), because the deposits-only pause
  narrowing changes what the composite means for off-chain consumers (M-A4).

### 5.2 Deposit path — carried from `BasketVault`

`_deposit` is replaced with the route-first, mint-on-realized-delta model
(SUP-3/F-16/NC-6 fix), adapted to the adapter registry:

1. Guards: `depositsPaused`, `shutdown`, `retired`, `perDepositCap`,
   `NoActiveAdapters`; TVL cap checked against pre-deposit `taBefore +
   assets` (`TVLCapExceeded`).
2. Snapshot `supplyBefore`, `taBefore = totalAssets()`, **and `idleBefore =
   IERC20(asset()).balanceOf(address(this))` — the vault's idle USDC BEFORE
   the caller's USDC is pulled.** This ordering is load-bearing (C1): the
   denominator must reflect the idle that already backs existing shares, not
   the caller's incoming deposit and not the post-route residual.
3. Pull USDC from the caller. **No shares minted yet.**
4. Route via the two-pass `_routeDeposit` allocator: a flat,
   **composition-blind** equal split across active+eligible adapters, min'd
   with each adapter's `capBps` headroom, then a second pass spreading any
   leftover into remaining cap headroom (ineligible-but-active adapters
   skipped, not reverted — audit L-4; `UnroutedDeposit` on leftover). This
   mirrors the pre-unification `BasketVault._routeDeposit` weight-neutral even
   split — an ordinary deposit does **not** fill the largest deficit first
   (§5.6); only an explicit `forceRebalance` call ever does, via its own
   internal deficit-first re-route leg. Each `_allocateTo(i, amount)`
   transfers USDC and calls `adapter.deploy(amount, amount × (MAX_BPS −
   maxSlippageBps) / MAX_BPS)`.
5. `realizedDelta = totalAssets() − taBefore`. Revert
   `DepositBelowSlippageFloor(realizedDelta, floor)` when `realizedDelta <
   assets × (MAX_BPS − maxSlippageBps) / MAX_BPS` (**AZ-BSK-1**: the floor is
   a revert guard, never a credit cap).
6. Mint on the full realized delta against the **idle-INCLUSIVE OZ
   denominator** (**AZ-BSK-3, C1-corrected**):

   ```
   mintShares = realizedDelta × (supplyBefore + 10^18)
              / (taBefore − revokedIdle + 1)
   ```

   where `taBefore` is the pre-deposit NAV (which already *includes*
   `idleBefore`, per `totalAssets()` at `RobotMoneyVault.sol:415`) and
   `revokedIdle` is USDC that entered idle *from a revoked/excluded adapter*
   (`emergencyWithdrawAdapter` on an ADP-2-excluded adapter) and is therefore
   NOT backing counted shares. In the common case `revokedIdle == 0` and the
   denominator is simply `taBefore + 1` — the exact OZ mint denominator.
   **The whole-vault idle balance is NEVER subtracted** (the committed
   `taBefore − _USDC.balanceOf(this) + 1` at `BasketVault.sol:604-609` is the
   bug this replaces): existing shares are backed by idle+adapter-NAV, so
   pricing new shares against adapter-NAV-only over-credits every depositor
   by `(I0+A0)/A0` whenever third-party idle `I0 > 0` (review E-1). The idle
   *exclusion* is narrowed to its only legitimate purpose — recovered USDC
   from an adapter the vault no longer trusts to be a redemption claim.
7. `_lastMintedShares = mintShares`; the overridden `deposit()` returns it
   (**AZ-BSK-2**) so `PortfolioRouter.minSharesPerLeg` compares against
   reality, not OZ's precomputed preview.
8. Residual vault-side price sanity (C3): before crediting the delta the vault
   runs the **adapter-independent global aggregate** NAV sanity check — the
   single vault-wide checkpoint that caps how fast `totalAssets()` may grow
   between observations (§4.3a). The per-asset ORA-4 NAV-vs-market deviation
   guard *also* runs inside each asset adapter's `deploy`, but that guard is
   adapter-self-computed; the vault-side global limiter is the independent
   second opinion. It gates the deposit (entry) only and does not localize
   which adapter moved. This check is **entry-side only** (see §5.3 for why it
   is not added to the withdraw path).

**Underflow / liveness (A-H2, resolved).** The corrected denominator
`taBefore − revokedIdle + 1` can no longer underflow on an unrouted deposit:
a first deposit into a cap-full adapter set has `taBefore == 0` and
`revokedIdle == 0` → denominator `1`, and the deposit mints against realized
delta = idle-and-continue (v1's `UnroutedDeposit` behavior at
`RobotMoneyVault.sol:497-499` is preserved), rather than reverting on
`0 − unrouted + 1`. The over-mint case (`taBefore=100`, unrouted 50 →
denominator 101 not 51) is likewise gone. The C1 over-mint exploit (mint
1000 on a `S0=A0=I0=1000` vault, redeem 1500, drain 500 from existing
holders) is closed because new shares are now priced against the same
idle-inclusive NAV that backs existing shares.

**Exact-set equivalence (bit-identity claim, re-derived).** For an all-exact
adapter set with `maxSlippageBps == 0` and `revokedIdle == 0`: every `deploy`
adds exactly its allocation, any unrouted remainder stays idle and is counted
by `totalAssets`, so `realizedDelta == assets` always, the floor check is
`assets >= assets`, and `mintShares = assets × (supplyBefore + 10^18) /
(taBefore + 1)`. Because `taBefore` already includes idle USDC, **this is now
bit-identical to today's `RobotMoneyVault` OZ `previewDeposit` (which uses
`totalAssets` including idle as its denominator) for ALL idle states, not
only the zero-idle steady state** — resolving Q4: the exact-set differential
test's domain is unrestricted (any idle level), and the deposit path does NOT
need to branch on `allExact()` for the denominator. The only residual
divergence from raw OZ is when `revokedIdle > 0`, a state v1 cannot reach
(v1 has no ADP-2 revoked-adapter recovery into idle); the differential test
excludes that intentionally-different state and asserts identity everywhere
else. `previewDeposit`/`previewMint` are exact (OZ semantics) when
`allExact()`, slippage-floored (`BasketVault` semantics, incl. the H-1
`previewMint` ceil gross-up) when not.

### 5.3 Withdraw / redeem — two pinned modes selected by `allExact()`

**This is the single most audit-sensitive function of the unification. It is
genuinely two accounting modes, not one carried "unchanged" (H-A2). Both are
specified in full below; neither is deferred to the parity suites.** The vault
branches on the vault-attested `allExact()` (§5.1) through `_withdraw`, the
pull loop, shortfall semantics, fee base, and all four previews.

- **`withdraw()` / `previewWithdraw()` gate:** permitted iff `allExact()`.
  When any active adapter is inexact, both revert `RedeemOnly()` — exact-set
  vaults keep full ERC-4626 withdraw conformance (incl. `maxWithdraw` net-of-
  fee floor rounding and paused-→-0 behavior from `RobotMoneyVault`);
  inexact-set vaults are redeem-only exactly like today's `BasketVault`.
  `maxWithdraw`/`maxRedeem` return `0` when `!allExact()` (§5.1) so
  `withdraw(maxWithdraw(owner))` never reverts (E-4).
- **`redeem()`** for all compositions: burn, pull, deliver realized proceeds;
  the override returns `_lastWithdrawnAssets` (**AZ-BSK-2**) — actual net
  USDC, not `previewRedeem`'s precomputed value.

**Drawdown ordering — proportional-by-balance, composition-blind (§5.6).** In
both modes the pull draws down adapters **proportionally to their current
balance**, not by deviation from target: a redemption pulls (Mode A) `pull =
remainingNeeded × adapterBalance / totalInAdapters` or sells (Mode B)
`adapterTokenBalance × shares / supplyBefore` of each active/eligible adapter
— the weight-neutral proportional drawdown both source contracts already
carry (`RobotMoneyVault._pullProportional`, `BasketVault._sellProportional`),
undoing the surplus-first reordering of that base algorithm. An ordinary
withdrawal does **not** fix a surplus preferentially — the only mechanism
that ever targets a deviation from target is the admin `forceRebalance` lever
(§5.6). Each leg is bounded by the existing per-swap slippage floor (§2.2),
the redeemer's protection. This ordering is **orthogonal to exactness**:
exactness (Mode A vs Mode B) governs the shortfall rule (revert vs clamp),
the fee base, and the preview branch — never which adapters are drawn down.

**Mode A — exact set (`allExact()`), carried from `RobotMoneyVault`.**

- Pull via `_pullProportional(grossAssets)` (`RobotMoneyVault.sol:643-719`):
  idle USDC first; eligible-adapter **assets-driven** proportional pass
  (`pull = remainingNeeded × adapterBalance / totalInAdapters`), then a
  rounding-sweep pass; `InsufficientAdapterLiquidity(requested, available)`
  raised early (`remainingNeeded > totalInAdapters`) and on residual
  under-delivery; over-delivery clamped to `assetsNeeded` so surplus stays
  idle for all holders.
- Per-adapter sizing: **proportional-by-balance** (§5.3 drawdown ordering) —
  `pull = remainingNeeded × adapterBalance / totalInAdapters`, each `pull`
  capped at `min(remaining, adapterBalance)`; this is `_pullProportional`'s
  base algorithm, unreordered by target deviation.
- Shortfall rule: **revert.** An exact adapter that under-delivers is a fault,
  not a slippage event; `require(realized >= grossAssets)` holds because
  `_pullProportional` reverts `InsufficientAdapterLiquidity` before the
  require can fail on a clean shortfall.
- Fee base: **fee-on-gross.** `assets + fee` disbursed with fee = `exitFeeBps
  × grossAssets`, `realized >= grossAssets` first (§5.4).
- Events: `Pulled(i, adapter, actual)` per adapter, `ExitFeeCharged`.

**Mode B — inexact set (`!allExact()`), carried from `BasketVault._sell-
Proportional` (`BasketVault.sol:839-872`).**

- Pull is **share-proportional, not assets-driven**: idle USDC owed
  = `idleBefore × shares / supplyBefore` (captured before swaps); then each
  active/eligible adapter sells `sellAmount = adapterTokenBalance × shares /
  supplyBefore` of its position via `adapter.withdraw`. There is **no
  `InsufficientAdapterLiquidity` all-or-nothing revert on under-delivery** —
  an inexact adapter systematically delivers `realized ≈ wanted × (1 −
  slippage)`, so the exact-mode require would make every inexact redeem
  revert. Instead proceeds accumulate as realized.
- Per-adapter sizing: **share-proportional** (§5.3 drawdown ordering) — each
  adapter sells `adapterTokenBalance × shares / supplyBefore` of its own
  position, independent of the other adapters' marks; this is
  `_sellProportional`'s base algorithm, unreordered by target deviation.
- Shortfall/clamp rule: each adapter enforces `minUsdcOut = max(caller floor,
  adapter TWAP floor)` per §2.2 and reverts only if realized `< minUsdcOut`
  (`SlippageExceeded`); a delivery below the *wanted* USDC but above the floor
  is accepted (the design's no-shortfall-revert pull). No socialization: the
  redeemer receives exactly their share-proportional realized proceeds.
- Fee base: **fee-on-realized-proceeds.** fee = `exitFeeBps × Σ realized swap
  proceeds`, net to receiver, `_lastWithdrawnAssets = net` (§5.4).
- Events: `Swapped(token, USDC, sellAmount, received)` per adapter (or the
  adapter-boundary equivalent), `ExitFeeCharged` on the realized base.

- **`previewRedeem`:** exact sets — gross minus exit fee (today's
  `RobotMoneyVault`); inexact sets — `gross × (1 − maxSlippageBps) × (1 −
  exitFeeBps)` documented as a floor (ADR-0007 NAV-haircut policy: pro-rata
  drawdown, no queue, revert-above-bounded-haircut). The fee base differs by
  composition (fee-on-gross vs fee-on-realized) — each internally consistent
  but integrators MUST branch on `allExact()`; documented as a
  per-composition property (review L-E6, §10 Q5(a) scope).

**Residual price check is entry-side only (C3 / M-A1 decision).** The
adapter-independent vault-side price sanity check (§4.3) runs on `deploy`
(deposit) but is **NOT** added to this withdraw/redeem path. The committed
spec moved the ORA-4 deviation guard into `withdraw()`, which would let
`redeem()` revert `NavMarketDeviationExceeded` during divergence — a new
exit-liveness failure contradicting "redemption is never revoked" (ADR-0009,
review M-A1). Redemption liveness outranks exit-side mis-mark protection: an
over-marked adapter on exit hurts only the redeemer taking the mark (the
adapter's own TWAP floor + `SlippageExceeded` still bound realized proceeds),
whereas an entry-side mis-mark dilutes *all* holders. *Decision note:* if a
future ADR does want an exit-side deviation guard, it MUST ship with an
EMERGENCY override so redemption can never be permanently blocked; that is
explicitly out of scope here and flagged for ADR-0010's consequences.

### 5.4 Fees — FEE-2 / NC-11

The exit fee is only ever paid out of realized proceeds. **Exact sets
(Mode A):** `realized = _pullProportional(grossAssets)`,
`require(realized >= grossAssets)` before disbursing `assets + fee`; fee base
= gross. **Inexact sets (Mode B):** fee = `exitFeeBps` of the **realized**
swap proceeds, net to receiver, `_lastWithdrawnAssets = net`; fee base =
realized. In both, an over-reporting adapter can never have its shortfall
socialized from other holders' idle USDC — Mode A raises
`InsufficientAdapterLiquidity`; Mode B pays out only that redeemer's
share-proportional realized proceeds.

### 5.5 Pause and lifecycle — LIFE-3 / LIFE-4 alignment

The unified vault keeps the split flags but **narrows the hot key**: 

- `pause()` (EMERGENCY_ROLE) sets `depositsPaused` only.
- `withdrawalsPaused` is settable **only by `ADMIN_ROLE`** (timelock), for
  genuine incident response; `maxWithdraw`/`maxRedeem` return 0 while set.
- `unpause()` remains ADMIN_ROLE.

This is a deliberate change from today's `RobotMoneyVault`, whose
EMERGENCY `pause()` freezes both sides; it adopts the LIFE-3/LIFE-4 posture
already enforced on the basket family (a hot key can DoS deposits, never
withdrawals; every withdrawal-blocking state is reversible by a
still-available authority, guaranteed by the last-admin floor).
`emergencyWithdraw`/`emergencyWithdrawAdapter` continue to pause deposits
while leaving withdrawals open. `retire()`/`unretire()` (registry-only,
DI-2) and `shutdownVault`/`restoreVault` carry over unchanged; redemption is
never revoked in any lifecycle state (ADR-0009).

**`paused()` semantics after the narrowing (M-A4).** `RobotMoneyVault.paused()`
today returns `depositsPaused && withdrawalsPaused`
(`RobotMoneyVault.sol:1215-1216`). Under the deposits-only EMERGENCY pause an
incident sets `depositsPaused = true` while `withdrawalsPaused == false`, so
the composite `paused()` returns **`false`** — incident state becomes invisible
to any consumer reading the single boolean. This is a real off-chain-visible
authority change and MUST be recorded in ADR-0010 (LIFE-3 authority change),
not presented as "split pause applies identically." The unified vault
therefore **exposes `depositsPaused` and `withdrawalsPaused` as first-class
public views** and treats `paused()` as a legacy convenience whose value is
`depositsPaused || withdrawalsPaused` (either-side) — a deliberate change from
the AND semantics so a deposits-only pause is not silently masked. *Decision
note:* the OR redefinition is the low-risk choice for keeping the composite
truthful; the alternative (keep AND, force all consumers onto the split flags)
is left open but requires migrating every consumer atomically.

**Off-chain consumers that read pause state (must migrate to the split
flags):**

- **Explorer indexer** snapshots `paused` per vault (`indexer.rs:1363`); with
  the OR redefinition a deposits-only pause now shows as paused (correct), but
  the indexer SHOULD decode `depositsPaused`/`withdrawalsPaused` separately to
  distinguish deposit-halt from full-halt on dashboards.
- **rmpc withdraw preflight** surfaces `ErrVaultPaused` from this flag; it MUST
  read `withdrawalsPaused` (not the composite) so a deposits-only pause does
  not spuriously block withdrawals in the preflight.

**Adapter emergency-arming authority (M-S5).** ACL-5's two-key split (ADMIN
arms a guard, EMERGENCY executes the unwind) is atomic on one contract today
(`RwaVault`). A naive vault+adapter split would make arming an adapter write
that must clear the ≥48h ADMIN timelock while execution comes from the vault
EMERGENCY surface — so vault EMERGENCY **could not atomically** reach an adapter
action that needs a fresh arm (e.g. arming the Chronicle stale-override
mid-incident). The spec therefore makes **incident-critical emergency actions
atomic `EMERGENCY_ROLE` arm+execute** — the stale-override and the
emergency-unwind guard are armed **and** executed in a single EMERGENCY hot-key
action with no intervening ADMIN timelock, so the 48h ADMIN latency cannot
block an in-progress incident response. This solves the latency by collapsing
arm and execute, not by making the action permissionless: the action stays
`EMERGENCY_ROLE`-gated. All other adapter config (TWAP window, deviation guard,
cap, fee) stays on the full ADMIN timelock (INV-3), preserving the
fast-EMERGENCY / timelocked-ADMIN asymmetry. *Blast-radius review requirement:*
because per-adapter `onlyVaultAdmin` already multiplies one ADMIN compromise
across N adapters × guard params, the auditors MUST review the atomic-EMERGENCY
surface before Phase 2 (§9); the atomic action set is scoped as narrowly as the
incident-response runbook allows.

### 5.6 Rebalancing — `forceRebalance`-only, composition-blind ordinary flow

Rebalancing is **isomorphic across every vault type** and is **not** gated on
exactness. **No deficit is ever fixed by an ordinary deposit, and no surplus
is ever fixed by an ordinary withdrawal** — ordinary deposit and withdrawal
flow is composition-blind with respect to the per-instance **target
allocation** (governance-set weights; equal-weight default), by the same
mechanism for lending themes and heterogeneous baskets. The **only**
mechanism that ever moves composition toward target is an explicit admin
`forceRebalance` call. There is no scheduled, automatic, or keeper rebalance,
no drift band, no per-epoch cost cap, and no keeper bounty; rebalancing has
**no off-chain component**. Exactness governs the withdraw surface and the
deposit accounting mode (§5.3) — a **separate axis** that says nothing about
how composition is corrected.

**Deposit flow — composition-blind.** New capital routes without regard to
any adapter's deviation from target — the two-pass `_routeDeposit` allocator
(§5.2, step 4) does a flat, weight-neutral equal split across active+eligible
adapters min'd with `capBps`, mirroring the pre-unification
`BasketVault._routeDeposit` behavior. An ordinary deposit never fills a
deficit preferentially.

**Withdrawal flow — composition-blind.** A redemption pulls (exact) or sells
(inexact) proportionally to current balances (§5.3) — the weight-neutral
proportional drawdown both source contracts already carry
(`RobotMoneyVault._pullProportional`, `BasketVault._sellProportional`). Each
leg is bounded by the existing per-swap slippage floor (§2.2), the redeemer's
protection. An ordinary withdrawal never draws down a surplus preferentially.

**The only lever: admin `forceRebalance` — self-funded, NAV-non-decreasing.**
An admin MAY move composition toward target at any time, but the call **MUST
leave NAV non-decreasing**: the vault measures aggregate NAV before and after
and `require`s the caller to supply the USDC covering realized slippage and
fees (a top-up), or the whole call reverts. Holders can **never** lose value
to a `forceRebalance` — the admin buys tighter tracking with their own funds.
On an exact (lending) set the top-up is ~zero (positions move 1:1, no
slippage); on an inexact (basket) set the admin pays the swap slippage out of
pocket. `forceRebalance`'s internal re-route leg still fills the largest
deficit first (the pre-reversal `_routeDeposit` logic, retained as an
internal `forceRebalance`-only helper) even though ordinary deposit flow no
longer does. One function, isomorphic across vault types, replacing the
socialized role-gated `rebalance()` / `adminRebalance()` pair.

**No socialized cost either way (C3a, reconciles ADR-0007).**
`forceRebalance` is the **only** thing that ever trades between adapters, and
it is self-funded, so no realized cost is ever socialized to holders. C3a's
hazard — an adapter's mark mis-directing real capital (an over-marked adapter
read as over-weight, sold, realizing below its mark, the loss socialized) —
is closed structurally: ordinary flow never trades on an adapter's mark, and
the one mechanism that does is caller-funded. ADR-0007's "no socialized
rebalance costs" is upheld, not overridden, and needs no drift band or cost
cap to bound a socialized-cost surface that does not exist. The residual
vault-side price sanity check (§4.3a) stays a deposit-entry circuit-breaker;
with no valuation-driven trading loop on ordinary flow it is **not** a
rebalance-safety precondition.

**Absent `forceRebalance` activity, composition drifts and is not forced
back.** With no `forceRebalance` call, composition wanders from target under
ordinary flow alone — risk exposure drifts, but no value leaks: ADR-0007
NAV-haircut redemption gives each holder their true pro-rata slice at
realized proceeds at any composition. This is an accepted, disclosed
characteristic, not a condition engineered against. `forceRebalance` degrades
gracefully to absent — never called, composition simply does not correct.

This supersedes ADR-0003's `NotImplemented()` basket-rebalance stub with the
`forceRebalance`-only model, not a keeper rebalancer, and not by reordering
`_pullProportional` / `_sellProportional` — ordinary withdrawal flow keeps
the same weight-neutral proportional drawdown both source contracts already
specify. The `forceRebalance` before-vs-after NAV measurement, admin top-up
accounting, and shortfall-revert atomicity are specified per §10 item 4. Cost
disclosure on a `forceRebalance`: realized swap costs are bounded per leg by
the min-out floors and emitted via `Pulled` / `Allocated` / `Rebalanced`.

### 5.7 Event / view off-chain compatibility (M-A5, replaces old Q3)

The event-contract inventory in the committed spec was inverted: Q3 fretted
over `WeightSnapshot` survival, but **nothing off-chain decodes it.** The
explorer indexer decodes only `Allocated` / `Pulled` / `Rebalanced` /
`ExitFeeCharged` + ERC-4626 `Deposit` / `Withdraw` (`abi.rs:236-265`). The
build-from contract for off-chain compatibility is this table, not an open
question:

| Surface | Requirement under unification |
|---|---|
| `Deposit` / `Withdraw` (ERC-4626) | **Byte-identical** signatures; indexer decode path unchanged. |
| `Allocated(i, adapter, amount)` | **Byte-identical**; now also fires for basket-theme routing (per-adapter). |
| `Pulled(i, adapter, actual)` | **Byte-identical**; fires in both accounting modes. |
| `ExitFeeCharged` | **Byte-identical**; base differs by composition (§5.4) but the event shape does not. |
| `Rebalanced(totalMoved)` | **Byte-identical**; now fires on an admin `forceRebalance` (§5.6), including basket themes (ADR-0003's stub was `NotImplemented`) → new dashboard rows are expected, not a regression. No keeper or scheduled rebalance emits it. |
| Indexer per-vault **view probe** | MUST keep succeeding against the unified vault, or the vault is silently skipped by the indexer. The probe's view set must be re-verified against the unified ABI (`allExact()`, split-pause views added; no view removed). |
| Vault **address map** | v2 vault addresses MUST be added to the indexer/explorer address map (v1+v2 coexist, L3 disambiguation). |
| `WeightSnapshot` | **Free choice** — nothing decodes it. Keep with adapter addresses, drop in favor of `Allocated`, or replace with adapter-emitted per-leg events, at the schema owner's discretion. |
| `depositsPaused` / `withdrawalsPaused` / `paused()` | New/redefined views (§5.5) — indexer + rmpc preflight migrate per M-A4. |
| `ExactnessTransition` | New event (§5.1) — integrators/indexer observe exact→inexact class flips. |

**Router error taxonomy (L5).** Unified deposit reverts —
`DepositBelowSlippageFloor`, adapter `NavMarketDeviationExceeded`, the
vault-side residual price-check revert (§4.3a), and oracle-stale `totalAssets`
— all collapse into `PortfolioRouter`'s `UsdcLegTransferFailed` at the router
boundary (the router sees only a failed leg). rmpc maps router errors to
**stable reason codes**, so this collapse MUST be enumerated and mapped: the
router either surfaces a reason sub-code or rmpc treats `UsdcLegTransferFailed`
on a unified vault as a composite "deposit-leg-rejected" code. This is added to
the **Q5(a) re-verification scope** (§10) alongside the `previewDeposit`
leg-availability and gateway `paymentId`/GW-2 hash coverage checks.

---

## 6. Invariant-preservation matrix

Every named invariant/finding tag appearing in the two source contracts, its
enforcement locus in the unified design, and the test that proves it (existing
tests re-pointed at the unified vault per §7; "NEW" = written in the phase
that lands the locus).

| Tag | Property (short) | Enforced in unified design | Proving test |
|---|---|---|---|
| INV-1 | No caller-supplied recipient for protocol/depositor assets | Vault `sweepForeignToken` → governed `quarantineAddress`; adapter sweeps → fixed quarantine; adapter `withdraw`/`harvestRewards` deliver only to `VAULT` | `CustodyInvariantGuard.t.sol` (no `rescue*` selector) re-pointed; NEW adapter-boundary static guard |
| INV-2 | Nothing stranded; dust favors holders | Vault: idle USDC in NAV, `UnroutedDeposit` monitored, **`sweepForeignToken` protects USDC + share + union of adapters' custodied tokens (M-S4)**; adapter: `harvestRewards`, protected-token sweep rejection, `reabsorb` on retired adapters, **vault-side reabsorb for revoked token adapters (M-S2)** | `CustodyInvariant.t.sol` handler extended to unified compositions; NEW: donated-basket-token-to-vault sweep-rejection test; NEW: revoked-token-adapter recovery test |
| INV-3 | Fee/quarantine/guard params timelock-only | Vault ADMIN_ROLE = timelock; adapter setters gated `onlyVaultAdmin` (transitive timelock) | `DeployTimelock.t.sol` deploy-assertions extended to adapter setters (NEW) |
| ADP-2 / F-14 | Only eligible adapters price NAV or move funds | `_isAdapterCounted` gating `totalAssets` + `_pullProportional`; allowlist + codehash pinning at `addAdapter`; codehash pins venue executor + linked libs | `RobotMoneyVault.t.sol::test_ADP2_revokedAdapterExcludedFromNavAndPulls` re-pointed; NEW asset-adapter variant |
| FEE-2 / NC-11 | Fee paid from realized proceeds only | Vault `_withdraw` **two modes (§5.3/§5.4)**: Mode A exact — `realized >= grossAssets` require, fee-on-gross; Mode B inexact — fee on realized swap proceeds, no shortfall-revert; `InsufficientAdapterLiquidity` guards Mode A | `RobotMoneyVault.t.sol::test_FEE2_*` (Mode A), `BasketVault.t.sol` fee-on-realized tests (Mode B), `FvInvariants.t.sol::test_FEE2_*` re-pointed |
| AZ-BSK-1 | Slippage floor is a revert guard, not a credit cap | Vault `_deposit` step 5 (`DepositBelowSlippageFloor`); adapter `deploy` min-out | `BasketVault.t.sol` AZ-BSK-1/SUP-3 fuzz suite re-pointed — **gated in Phase 3 (vault-mint path), not Phase 2 (M-A6)** |
| AZ-BSK-2 | `deposit()`/`redeem()` return realized amounts | Vault `deposit()`/`redeem()` overrides reading `_lastMintedShares`/`_lastWithdrawnAssets` | Router-integration tests (`PortfolioRouter.t.sol` minSharesPerLeg / minAssetsPerLeg legs) re-pointed |
| AZ-BSK-3 (C1-corrected) | Mint denominator = **idle-INCLUSIVE** NAV (`taBefore − revokedIdle + 1`); only revoked-adapter idle excluded | Vault `_deposit` steps 2/6 (snapshot `idleBefore` before pulling caller USDC) | `BasketVault.t.sol` denominator tests re-pointed; NEW C1 over-mint exploit regression (`S0=A0=I0` no-profit); NEW cap-full underflow/idle-and-continue test; NEW exact-set bit-identity test at all idle levels (§5.2) |
| AZ-BSK-5 | Caller `minUsdcOut` honored on reabsorption (`SlippageExceeded`) | Adapter `reabsorb(minUsdcOut)` | `BasketVault.t.sol::test_LIFE6_*`/AZ-BSK-5 tests re-pointed to adapter |
| ORA-3 / F-09 | TWAP pool == execution pool | `AssetPositionAdapter` constructor (`requireExecutionPoolMatchesTwap`) | `DeployAssertions.t.sol::test_ORA3_*` re-pointed to adapter construction |
| ORA-4 / F-10 | No settlement beyond NAV-vs-market deviation band | Adapter-level check in **`deploy` only (entry-side, C3/M-A1)** (`NavMarketDeviationExceeded`); **NOT on `withdraw` — redemption liveness (§5.3)** | `BasketVault.t.sol::test_ORA4_*` re-pointed to `deploy`; NEW: `redeem` does NOT revert on deviation (exit-liveness) |
| ORA-7 (C3) | Deviation/slippage floor not derived solely from the pricing oracle | **Residual adapter-INDEPENDENT vault-side price check on `deploy`** — a single global cap on aggregate `totalAssets()` growth rate, one vault-wide checkpoint, gating deposits only (§4.3a) | NEW: aggregate mis-scale/over-mark that grows NAV too fast is rejected on deposit even when the adapter passes its own probe |
| SUP-3 / F-16 / NC-6 | Round trip never profits | Route-first mint-on-realized-delta `_deposit` (C1 idle-inclusive denominator) + slippage-discounted `previewDeposit` on inexact sets | `test_SUP3_roundTripNeverProfits_fuzz` + stateful variants re-pointed — **gated in Phase 3 (M-A6)**; NEW: no-round-trip-profit with pre-existing third-party idle |
| SUP-5 / NC-1 | Idle-USDC redemption survives stale oracle | Adapter `totalAssets` zero-balance short-circuit | `StaleOracleRedemption.t.sol::test_SUP5_*` re-pointed to Chronicle adapter composition |
| ACL-3 / F-06 | Last-admin floor | Vault `_grantRole`/`_revokeRole` hooks (`adminCount`, `LastAdminFloor`) — now also covering the lending theme | `BasketVault.t.sol` last-admin-floor tests re-pointed; NEW rmUSDC-composition case |
| ACL-5 / F-08 (M-S5) | Stale-price override armed by EMERGENCY, not blocked by 48h latency mid-incident | Stale-override/unwind-guard is an **atomic `EMERGENCY_ROLE` arm+execute** (armed and executed in one hot-key action, no intervening ADMIN timelock); all other config on full ADMIN timelock; fast-EMERGENCY / timelocked-ADMIN asymmetry preserved | `RwaVault.t.sol::test_emergencyUnwindStaleOverride_requiresAdminNotEmergency` re-pointed to the atomic path; NEW: EMERGENCY can arm+execute the stale-override without the ADMIN timelock; blast-radius review (Phase 1) |
| LIFE-3 / LIFE-4 (M-A4) | Withdrawals never pausable by hot key; no permanent freeze; incident state off-chain-visible | `pause()` = deposits-only; `withdrawalsPaused` ADMIN-only; `paused()` redefined to `depositsPaused \|\| withdrawalsPaused`; `depositsPaused`/`withdrawalsPaused` first-class views; last-admin floor guarantees reversal authority | `BasketVault.t.sol::test_pause_doesNotFreezeWithdrawals` re-pointed; NEW: EMERGENCY cannot set `withdrawalsPaused`; NEW: deposits-only pause is visible via split views |
| LIFE-6 | Reabsorption never reverts-and-strands | Adapter `reabsorb` try/catch → quarantine fallback | `BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool` re-pointed |
| DI-2 | Unified governance retire (registry flip + deposit halt, atomic) | `setRegistry`/`retire`/`unretire` carried verbatim; `retired` flag distinct from `shutdown` | `FvInvariants.t.sol::test_LIFE1_retireSyncsRegistryAndVaultFlag` re-pointed |
| ADP-1 | No DELEGATECALL on NAV/deposit/withdraw path (lending adapters) | Unchanged for lending adapters; `AssetPositionAdapter` legitimately DELEGATECALLs linked `TickMath`/`TwapTickMath` — codehash pinning subsumes the guarantee (as for today's swap adapters) | `AdapterDelegatecallGuard.t.sol` scoped to exact adapters; codehash deploy-assertion for asset adapters |
| ADP-5 | Approvals zeroed after every call | Adapter `forceApprove(_, amount)` / `forceApprove(_, 0)` convention | Post-call allowance assertions re-pointed |
| CUST-5 | Inflation-attack resistance | `decimals() == 6`, `_decimalsOffset() == 18` | ERC-4626 conformance suite (§7) |
| C2 (exactness attestation) | `isExact`/`allExact()` never adapter-self-reported on share-critical paths | Vault-attested `AdapterInfo.isExact` set by ADMIN at `addAdapter`; `allExact()` registry-surfaced; `maxWithdraw/maxRedeem == 0` when `!allExact()`; `ExactnessTransition` on class flip | NEW: `true`-but-inexact adapter cannot select the exact preview branch; NEW: `withdraw(maxWithdraw(owner))` never reverts on a redeem-only vault (ERC-4626) |
| M-S6 (read-only reentrancy) | View surfaces not manipulable mid-callback; V4 hook edge removed | `hooks == address(0)` required+asserted at V4 adapter construction (§4.5); published call-graph enumeration | `AdapterConstruction.t.sol::test_v4Adapter_rejectsNonZeroHooks` (NEW); enumeration referenced from security-model §2 |

---

## 7. Test-parity plan

The acceptance bar is: **both existing suites pass against the one `Vault`
contract in the matching composition.** No invariant test is deleted; tests
are re-pointed (fixture swap) or ported.

1. **Lending composition parity (rmUSDC config).** The full
   `RobotMoneyVault.t.sol` suite — including the ERC-4626 property-based
   conformance suite and exact-`withdraw()` semantics, FEE-2, ADP-2/F-14,
   `InsufficientAdapterLiquidity`, the NAV-non-decreasing `forceRebalance`
   invariant (§5.6), emergency drains, retire/shutdown — runs against `Vault`
   + retrofitted
   Morpho/Aave/Compound adapters, `maxSlippageBps = 0`. Includes a
   bit-identity differential test: same operation sequence against v1 and
   unified vault, assert identical share/asset outcomes **at all idle levels**
   (Q4 resolved — the C1-corrected idle-inclusive denominator matches OZ for
   any idle; the only excluded state is `revokedIdle > 0`, unreachable in v1).
2. **Basket composition parity (per theme).** The `BasketVault.t.sol` /
   `ProtocolAssetVault` / `AgentTokenVault` / `RwaVault` suites — redeem-only
   gating (`RedeemOnly` on `withdraw`/`previewWithdraw`), AZ-BSK-1/2/3/5,
   SUP-3 round-trip fuzz, ORA-3/ORA-4, TWAP-window bounds, emergency unwind
   incl. override + loss cap, LIFE-6, Chronicle staleness (SUP-5/ORA-2/ACL-5)
   — run against `Vault` + `AssetPositionAdapter` sets per theme.
3. **Mixed-composition tests (NEW).** One exact + one inexact adapter:
   `withdraw()` reverts `RedeemOnly`, previews use floored math,
   `_pullProportional` spans both adapter kinds, ADP-2 revocation of either
   kind.
4. **Fork tests per theme** (Base mainnet fork): Morpho/Aave/Compound venues;
   wETH/cbBTC/wSOL V3 pools; a shortlist token per
   `config/agent-token-shortlist.json`; Aerodrome deSPXA pool + Chronicle
   feed. Fork tests assert real deploy→totalAssets→withdraw round trips and
   the ORA-3 constructor guard against live pools.
5. **Gas-delta benchmark.** `forge snapshot` comparison, per theme, for
   `deposit`, `redeem`, `forceRebalance`, `totalAssets` — unified vs v1.
   Budget:
   no path regresses > 10% without a written justification in the PR (the
   extra external calls per asset adapter are the expected cost driver).
6. **EIP-170 size check.** `forge build --sizes` gate for `Vault`,
   `AssetPositionAdapter`, and each retrofitted adapter (the vault sheds the
   swap/TWAP code paths; the asset adapter inherits them — both sides must be
   proven under 24 576 bytes in CI, not assumed).
7. **CI requirements (loud-skip policy,**
   `skills/_shared/test-coverage-policy.md`**).** Fork-test jobs FAIL — not
   skip — when the RPC secret is absent in a context that requires them;
   "no tests collected" is red; the parity suites run in a **required**
   branch-protection context per composition, so a green signal means every
   composition executed its suite. Nightly keeps the Halmos/symbolic sweep
   for the `symbolic`-strategy invariants (smart-contract-invariants.md).

---

## 8. Theme deployment table and constructor

| Theme | Shares | Position adapters | `isExact` | `maxSlippageBps_` | `maxActiveAdapters_` | Pricing | Notes |
|---|---|---|---|---|---|---|---|
| rmUSDC | Robot Money USDC | `MorphoAdapter`, `AaveV3Adapter`, `CompoundV3Adapter` (retrofit, §3) | true | 0 | 20 (default `MAX_ADAPTERS`) | Venue balances | `withdraw()` live; full ERC-4626 exactness |
| rmPROTO | Robot Money Protocol | 3 × `AssetPositionAdapter`: wETH (V3, fee 500), cbBTC (V3, 3000), wSOL (V3, 3000) | false | 100 | 10 | Uniswap V3 TWAP per asset | Redeem-only |
| rmAGENT | Robot Money Agent Tokens | 1 × `AssetPositionAdapter` per shortlist entry (`config/agent-token-shortlist.json`): **BNKR (V3), JUNO (V4), RM (Aerodrome)** | false | 300 | 15 | **Mixed per asset — V3 TWAP / V4 TWAP / Aerodrome** | **Phase-4 deliverable** (needs V4 + Aerodrome executors, not just V3). Per-theme `TimelockController` as `admin_` supplies the ADR-0004 add/remove delays — see below |
| rmRWA | Robot Money RWA | 1 × Chronicle `AssetPositionAdapter` (deSPXA, Aerodrome execution) | false | 50 | **1** | Chronicle NAV + heartbeat | ADR-0006 constraints; `maxAssets()==1` becomes the adapter-count cap; migration needs active-only counting (see below) |

**rmAGENT corrections (M-A9).** (a) Venues are **not** "Uniswap V3 TWAP per
asset": per `config/agent-token-shortlist.json` the shortlist is BNKR (V3),
JUNO (**V4**), RM (**Aerodrome**) — so rmAGENT depends on the V4 and Aerodrome
executors and is a **Phase-4** deliverable, not Phase-2/3. (b) "ADR-0004
timelock delays gate `addAdapter`/`removeAdapter` (48h/24h)" is
**unrepresentable** in one vault with one `ADMIN_ROLE` and no per-theme
`TimelockController`. The honest topology: `admin_` is a **per-theme
`TimelockController` instance** whose min-delay encodes the ADR-0004 add/remove
delays; distinct delays for add vs remove need either two timelock roles or an
operation-scoped delay. This is a constructor/deployment-wiring fact, not an
in-vault role — the vault sees a single `ADMIN_ROLE` held by that timelock.

**`maxActiveAdapters_` semantics (Q7 / L4, resolved).** The cap counts
**active adapters only**, not total registry entries. `MAX_ADAPTERS` bounds
the monotonically-growing array; `maxActiveAdapters_` bounds how many are
simultaneously `active`. This is load-bearing for rmRWA (cap **1**): deSPXA
must be migratable to a repriced adapter, which requires **remove-then-add
under an active-only cap** — a total-entry cap would wedge rmRWA permanently at
its first adapter. The `removeAdapter` drain-ordering constraint: the outgoing
adapter must be drained to empty (`AdapterNotEmpty` guard) and marked inactive
(freeing an active slot) **before** the replacement is added; the interim
state is 0 active adapters, during which deposits revert `NoActiveAdapters`
(acceptable for a governed migration). This resolves Q7's constructor-semantics
half; the sweep-protected-set half is resolved in §5.1.

Constructor (single contract, theme = parameters):

```solidity
constructor(
    IERC20  asset_,               // USDC
    string memory name_,          // e.g. "Robot Money Protocol"
    string memory symbol_,        // e.g. "rmPROTO"
    uint256 tvlCap_,
    uint256 perDepositCap_,       // must be <= tvlCap_ when tvlCap_ > 0
    uint256 exitFeeBps_,          // <= MAX_EXIT_FEE_BPS (100)
    uint256 maxSlippageBps_,      // <= MAX_SLIPPAGE_BPS (500); 0 for all-exact themes
    uint256 maxActiveAdapters_,   // 1..MAX_ADAPTERS; replaces maxAssets()
    address feeRecipient_,
    address admin_,               // timelock in production
    address emergencyResponder_   // hot key, distinct from admin_ in production
)
```

Post-deploy configuration (not constructor args, all ADMIN/timelock):
`setAdapterAllowed` / `setAdapterCodeHashAllowed` + **`addAdapter(adapter,
capBps, isExact)`** per position (the `isExact` bool is vault-attested here,
§5.1/C2); `setRegistry`; the target allocation weights (`setTargetWeights`;
equal-weight default) the deposit/withdrawal flow tends composition toward
(§5.6) — there are no rebalance-throttle, drift-band, or cost-cap parameters,
and `forceRebalance` is a runtime admin call (NAV-non-decreasing, self-funded),
not deploy config; adapter-level `setTwapWindow`, `setEmergencyUnwindGuard`
(vault-side floor, §4.4), `setNavDeviationGuardBps`; the single vault-level
residual price-check bound (`maxNavGrowthRateBps` — one global aggregate cap,
§4.3a), Chronicle heartbeat.
`quarantineAddress` defaults to `ForeignTokenQuarantine.QUARANTINE`.

---

## 9. Phased delivery

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | ADR-0010 accepted (`docs/adr/ADR-0010-unified-vault-architecture.md`) | ADR review |
| 1 | `IPositionAdapter` + Morpho/Aave/Compound retrofit (§2–3); **C2 vault-attested `isExact` bool + `allExact()`** interface decision landed | Retrofit adapters pass existing adapter suites + new min-out/isExact tests; blast-radius review of the per-adapter authority + EMERGENCY-armable surface (M-S5) |
| 2 | **Spike:** V3 `AssetPositionAdapter` + `UniswapV3SwapAdapter` (§4) + **mock-vault harness** | Gated on **adapter-LOCAL** invariants only (M-A6): ORA-3/4, TWAP-window bounds, unwind floors, LIFE-6, min-out reverts, `hooks == address(0)` construction assert (§4.5). AZ-BSK-1 / SUP-3 are **NOT** gated here (they are vault-mint properties — the adapter mints nothing). Needs the mock-vault harness below. |
| 3 | Unified `Vault` (§5) — both accounting modes (§5.3), C1 mint denominator, residual price check | Lending-composition parity (§7.1) + mixed-composition tests (§7.3); **AZ-BSK-1 / SUP-3 vault-mint gates land here** (M-A6); C1 over-mint + underflow regression tests |
| 4 | V4 / Aerodrome / Chronicle asset adapters (**rmAGENT: BNKR-V3 / JUNO-V4 / RM-Aerodrome**, M-A9) | Basket-composition parity per theme (§7.2), fork tests (§7.4) |
| 5 | Parity proof | Full §7 matrix green in required CI contexts; gas-delta + EIP-170 gates |
| 6 | Deploy scripts, `VaultRegistry`/`PortfolioRouter` **interlock change** (see below), external audit, v2 mainnet deploy, eligibility migration v1→v2, retire v1 vaults per ADR-0009 | Registry/router unlock lands and is tested; `retire(v1)` after eligibility migration; v1 redemption stays open indefinitely |
| 6.5 | **Environment / CI migration + retired-v1 operations runbook** (see below) | All CI/demo surfaces updated and green; runbook owner assigned |

**Phase 2 mock-vault harness (M-A6).** Adapters are `onlyVault` machines, so
exercising `deploy`/`withdraw`/emergency paths at the adapter boundary needs a
minimal mock vault that (a) holds `ADMIN_ROLE` for the `onlyVaultAdmin` config
setters, (b) drives `deploy`/`withdraw`/`emergencyWithdrawAdapter`, and (c)
exposes the identity views (`USDC()`/`VAULT()`) the adapter binds to. Specify
it as a Phase-2 test fixture; the adapter-local invariant suite runs against
it. AZ-BSK-1/SUP-3 can only be observed once the real mint path exists
(Phase 3).

**Phase 6 registry/router interlock (H-A1).** Making any v2 vault
router-eligible changes `routerEligibleCount`; `VaultRegistry.setRouterEligible`
reverts `StaleDefaultWeightsLength` whenever the router's non-empty default
vector length ≠ new count (`VaultRegistry.sol:335-340`), and every escape is
closed: `PortfolioRouter.setDefaultWeights` requires `vaults.length ==
routerEligibleCount()` and all-already-eligible (`PortfolioRouter.sol:347` +
`_requireActiveAndEligible` at 355) so it cannot pre-grow to include a
not-yet-eligible v2 vault; there is no `clearDefaultWeights`; `setRouter(0)` is
blocked while the default is non-empty. With 4 eligible v1 vaults + a length-4
default, **every** eligibility change (grow/shrink/swap) reverts per-call —
batching does not help, and this is exactly the state demo/CI/fork
environments boot into. "Shift weights" is therefore **not an executable
step.** Phase 6 MUST ship the real unlock, scoped as its own issue, as one of:

- a **superset-spanning `setDefaultWeights`** with eligibility-transition
  semantics (accepts a vector spanning both current and about-to-be-eligible
  vaults), **or**
- an atomic **`migrateEligibility`** on the registry that swaps the eligibility
  flag and the default vector in one call, **or**
- a **router redeploy** against a fresh registry link, with explicit ordering.

Whichever is chosen is a `VaultRegistry`/`PortfolioRouter` code change, not a
config step — Phase 6 depends on it landing first.

**Phase 6.5 environment / CI migration + retired-v1 runbook (M-A7).** Enumerated
so the parity plan's environments actually boot:

- `suite-14` demo_seeding asserts **exactly four Active vaults** — update the
  four-vault assertion for the v1→v2 coexistence/transition window.
- `suite-01` forge `--match-contract` hardcodes subclass names
  (`RobotMoneyVault`/`BasketVault`/…) — re-point to the single `Vault` contract
  name.
- `suite-16` ABI-drift gate — regenerate/rebaseline for the unified ABI
  (new `addAdapter` arg, `allExact()`, split-pause views, new events).
- `suite-22` CoverageMap ↔ invariants-doc 1:1 gate — the §6 matrix re-homes
  loci but the invariants-doc rewrite must be **scheduled**, not implied, or
  suite-22 goes red.
- `DeployDemoExtraVaults.s.sol` fixed-length-4 weight arrays — generalize for
  the migrated eligible set.
- **Retired-v1 operations runbook:** ADR-0009 promises indefinite redemption,
  which for retired rmRWA depends on a **maintained Chronicle feed
  indefinitely** and for retired baskets on **persistent pool liquidity**. A
  named owner must carry the feed/pool-maintenance obligation; the runbook
  also covers the M-S2 "excluded-but-recoverable" interim state and the L3
  v1/v2 same-name disambiguation in `listVaults()`/explorer.

---

## 10. Open questions

Genuinely unresolved items; each needs an owner before (at latest) the phase
that touches it. Items resolved by the ADR-0010 critical review are moved to
the "Resolved" list below and cross-referenced to the section that now
specifies them.

**Still open:**

1. **Blast-radius boundary for the atomic-EMERGENCY adapter surface (Phase 1).**
   §4.3/§5.5/M-S5 resolve *that* incident-critical actions (stale-override,
   emergency-unwind guard) are atomic `EMERGENCY_ROLE` arm+execute — armed and
   executed in one hot-key action with no intervening ADMIN timelock. Still
   open: the exact enumerated set of atomic-EMERGENCY actions, pending the
   auditors' blast-radius review of one ADMIN/EMERGENCY compromise reaching N
   adapters × guard params.
2. **Who drains a compromised *venue executor*?** An `AssetPositionAdapter`
   whose venue executor turns hostile can only exit through that executor.
   Secondary admin-swappable venue-executor slot vs `forceRemoveAdapter` + loss
   acceptance (as for lending venues). Interacts with the M-S2 venue-independent
   reabsorb path (§4.4) but the "alternate executor" mechanism is unspecified.
3. **Residual price-check bound value (§4.3a).** The C3 residual is fully
   specified as a single global cap on aggregate NAV growth (one vault-wide
   checkpoint, no per-theme or per-adapter variant). What remains open is only
   the concrete `maxNavGrowthRateBps` value — one global vault-level cap — as a
   governance/tuning decision for Phase 3/4.
4. **`forceRebalance`-only rebalancing — `forceRebalance` accounting (§5.6).**
   The *model* is settled: `forceRebalance`-only correction toward the target
   allocation — ordinary deposit and withdrawal flow stays composition-blind
   (the weight-neutral `_routeDeposit` split and the `_pullProportional` /
   `_sellProportional` proportional drawdown both source contracts already
   specify, unchanged) — plus an optional NAV-non-decreasing admin
   `forceRebalance`. There is **no tuning surface** — the drift-band /
   per-epoch-cost-cap tuning question is dissolved (`forceRebalance`-only
   correction has no knobs), and no exact/inexact rebalance split remains.
   The ordinary-flow ordering is **not** open (it is the unchanged,
   already-specified weight-neutral behavior); what is open is only the
   `forceRebalance` before-vs-after NAV measurement, admin top-up accounting,
   and shortfall-revert atomicity that make "NAV after ≥ NAV before" hold
   within a single call.
5. **Per-adapter slippage.** One vault-level `maxSlippageBps` today; a
   mixed-liquidity basket may want per-adapter bounds (adapter-local, vault
   value as ceiling). Defer or include in Phase 2/4.
6. **Emergency drain all-or-nothing vs skip-and-continue.** This spec picks
   skip-and-continue + per-adapter override (§4.4); `BasketVault.emergencyUnwind`
   reverts the whole unwind today. The incident-response runbook owner should
   confirm before Phase 4.
7. **Chronicle adapter shape.** Separate `ChronicleAssetPositionAdapter` vs a
   pricing-strategy field on one `AssetPositionAdapter`. Phase 4 decision;
   interface (§2) unaffected.

**Resolved by the ADR-0010 critical review (now specified in-spec):**

- **Q3 `WeightSnapshot` survival → resolved (M-A5, §5.7).** Nothing off-chain
  decodes it; it is a **free choice**. The real compatibility contract is the
  event/view table in §5.7 (`Allocated`/`Pulled`/`Rebalanced`/`ExitFeeCharged`
  + ERC-4626 `Deposit`/`Withdraw` byte-identical; view-probe must keep
  succeeding; v2 addresses into the map; `Rebalanced` now fires for baskets).
- **Q4 idle-USDC denominator → resolved (C1, §5.2).** The denominator is
  **idle-INCLUSIVE** (`taBefore − revokedIdle + 1`); only revoked-adapter idle
  is excluded. The exact-set bit-identity claim holds at **all** idle levels,
  the deposit path does **not** branch on `allExact()` for the denominator,
  and the §7.1 differential test's domain is unrestricted (excluding only the
  v1-unreachable `revokedIdle > 0` state).
- **Q5 `withdraw()`→`RedeemOnly` on composition transition + router deltas →
  resolved (C2, §5.1/§5.3; L5, §5.7).** `allExact()` is registry-surfaced;
  `maxWithdraw/maxRedeem == 0` when `!allExact()` (ERC-4626-safe);
  `ExactnessTransition` event + timelock on the class flip. Q5(a)
  re-verification scope now explicitly includes the router `UsdcLegTransferFailed`
  error-taxonomy mapping to rmpc stable reason codes (L5), plus `previewDeposit`
  leg-availability and gateway `paymentId`/GW-2 hash coverage.
- **Q7 `maxActiveAdapters_` semantics → resolved (L4, §8).** Cap counts
  **active** adapters only; remove-then-add drain-ordering specified; sweep
  protected-set spans registered (not only active) adapters, mirrored by a
  governance set across a full removal (§5.1).
