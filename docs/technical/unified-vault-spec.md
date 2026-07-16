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
4. **Unified `Vault`** — `RobotMoneyVault`'s shell (registry, caps, throttles,
   lifecycle, fees) with `BasketVault`'s route-first, mint-on-realized-delta
   deposit core and redeem-only gating when any active adapter is inexact
   (§5).

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
- The vault reads this to gate ERC-4626 `withdraw()`/`previewWithdraw()`
  (§5.3) and to select exact vs slippage-floored preview math. It is a
  bytecode-level property pinned by the adapter codehash allowlist: a lying
  `isExact()` is an ineligible adapter, same trust class as a lying
  `totalAssets()` (ADP-2).

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
| ORA-4 `navDeviationGuardBps`, `setNavDeviationGuardBps`, `MAX_NAV_DEVIATION_BPS` (2 000), `NavMarketDeviationExceeded` | Adapter storage + setter; checked inside `deploy()` **and** `withdraw()` | Vault-admin-derived (timelock) | Per-asset check runs where the asset lives; any vault entry path that reaches the adapter hits it. `0` disables (fixtures). |
| `maxSlippageBps` swap floors (`_applySlippage`, `_slippageFloor`) | Split: vault keeps one `maxSlippageBps` for preview math and the min-out it passes per call (§5.2); adapter enforces the venue `amountOutMinimum` from its own TWAP × the vault-supplied floor | Vault `ADMIN_ROLE` | `MAX_SLIPPAGE_BPS` (500) ceiling stays on the vault. |
| `SlippageBelowPoolFeeFloor` / `minSlippageFloorBps` (L-17 brick guard) | Adapter exposes `minOutFloorBps() view` (its pool fee in bps; lending adapters return 0); `Vault.setMaxSlippageBps` takes the max over active adapters | Vault `ADMIN_ROLE` | Same invariant: a single admin write can never make every swap unsatisfiable. |
| `adapterCodeHashAllowed` for swap adapters (ADP-2/NC-2) | Unchanged concept, one level down: the **vault** pins the `AssetPositionAdapter` codehash (which bakes in the venue-executor address and linked `TickMath`); the AssetPositionAdapter's venue executor is a constructor immutable | Vault `ADMIN_ROLE` | Codehash pinning subsumes hot-swap protection exactly as today. |
| `reabsorbRemovedAsset` (LIFE-6, AZ-BSK-5) | Adapter `reabsorb(uint256 minUsdcOut)` — permissionless; swaps a reappeared/donated token balance on a **retired-from-registry** adapter back to USDC delivered to the vault, TWAP-floored, `SlippageExceeded` on caller-floor breach, quarantine fallback when the TWAP read reverts | Permissionless | Same never-revert-and-strand contract. |
| Chronicle heartbeat (`oracleHeartbeat`, `MAX_HEARTBEAT`, `StalePriceFeed`), stale-unwind override (ACL-5/F-08 two-key split) | deSPXA adapter variant (§4.4) | Heartbeat setter and stale-override arm: vault-admin-derived; unwind execution: vault emergency path | Carried verbatim from `RwaVault`. |
| `maxAssets()` (subclass constant; 1 for RwaVault) | Vault constructor param `maxActiveAdapters_` (§8) | Deploy-time | rmRWA's single-asset constraint becomes an adapter-count cap. |

**"Vault-admin-derived" authority:** adapters carry no independent role tree.
Config setters are gated by a `onlyVaultAdmin` modifier that queries
`AccessControl(VAULT).hasRole(ADMIN_ROLE, msg.sender)` — the vault's
timelock-held admin governs its adapters transitively, preserving INV-3
(fee/guard/quarantine parameters change only via the timelock) without
duplicating role bookkeeping per adapter. Residual questions on this model
(emergency-tier grants, blast radius) are in §10.

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
  (SUP-5/NC-1), and keeps the F-08 two-key split: the stale-price override is
  armed by vault-admin authority, executed by the vault's emergency path.
  ADR-0006's constraints (no ERC-7540 primary redemption, Aerodrome
  secondary market only, issuer freeze-control risk) carry unchanged.

---

## 5. Unified `Vault`

`contracts/Vault.sol`. Non-abstract; every theme is a deployment
configuration, not a subclass.

### 5.1 Shell — carried from `RobotMoneyVault`

Carried structurally verbatim (same storage names, events, errors, and
semantics unless a row in §4.3 or a subsection below says otherwise):

- Adapter registry: `AdapterInfo[] {adapter, capBps, active}`, `MAX_ADAPTERS`
  (20), `addAdapter`/`removeAdapter` (`AdapterNotEmpty` guard)/`setAdapterCap`,
  `forceRemoveAdapter`.
- Eligibility pinning: `adapterAllowed` (exact instance) +
  `adapterCodeHashAllowed` (runtime bytecode) + `USDC()`/`VAULT()` identity
  probes; `_isAdapterEligible` / `_requireAdapterEligible`.
- **ADP-2 / F-14**: `_isAdapterCounted` (active AND eligible) gates both
  `totalAssets()` NAV summation and `_pullProportional` — a revoked adapter
  neither prices NAV nor receives/returns withdrawal flow;
  exclusion-not-confiscation (EMERGENCY can still drain, eligibility is
  restorable).
- `rebalance()` (ADMIN or KEEPER) + `adminRebalance(targetBalances)` with
  `maxRebalanceBpsPerCall` (default 2 500, ceiling 5 000) and
  `minRebalanceInterval` (default 12 h, floor 1 h) throttles.
- Split pause flags `depositsPaused` / `withdrawalsPaused` (authority changes
  in §5.5), `shutdownVault`/`restoreVault(newTvlCap)`, registry-driven
  `retire()`/`unretire()` with the set-once `setRegistry` link (DI-2).
- Exit fee (`exitFeeBps` ≤ `MAX_EXIT_FEE_BPS` 100, `feeRecipient`,
  `ExitFeeCharged`), `tvlCap`/`perDepositCap` with cross-validation,
  timelock-settable `quarantineAddress` + permissionless
  `sweepForeignToken` (protected: USDC, share token).
- Share scale: `decimals() == 6`, `_decimalsOffset() == 18` (CUST-5).
- Roles: `ADMIN_ROLE` (self-admin), `EMERGENCY_ROLE`, `KEEPER_ROLE` (not
  granted at launch), pause/unpause and shutdown/restore trust asymmetry.
- **Plus, imported from `BasketVault`:** the ACL-3/F-06 last-admin floor
  (`adminCount` counter in `_grantRole`/`_revokeRole` hooks,
  `LastAdminFloor`) — `RobotMoneyVault` lacks this today; the unified vault
  gets it.
- Views: `getAdapterInfo`, `getAdapterDrift`, `adapterCount`,
  `activeAdapterCount`, `currentTargetBps`, `isRebalanceAvailable`,
  `nextRebalanceAt`, `paused()`, `isShutdown`. Plus `allExact() view returns
  (bool)` — true iff every active adapter's `isExact()` is true (integrators
  and the router use this to know whether `withdraw()` is live).

### 5.2 Deposit path — carried from `BasketVault`

`_deposit` is replaced with the route-first, mint-on-realized-delta model
(SUP-3/F-16/NC-6 fix), adapted to the adapter registry:

1. Guards: `depositsPaused`, `shutdown`, `retired`, `perDepositCap`,
   `NoActiveAdapters`; TVL cap checked against pre-deposit `taBefore +
   assets` (`TVLCapExceeded`).
2. Snapshot `supplyBefore`, `taBefore = totalAssets()`.
3. Pull USDC from the caller. **No shares minted yet.**
4. Route via `RobotMoneyVault`'s two-pass `_routeDeposit` (equal-weight
   target min'd with `capBps`, then cap headroom; ineligible-but-active
   adapters skipped, not reverted — audit L-4; `UnroutedDeposit` on
   leftover). Each `_allocateTo(i, amount)` transfers USDC and calls
   `adapter.deploy(amount, amount × (MAX_BPS − maxSlippageBps) / MAX_BPS)`.
5. `realizedDelta = totalAssets() − taBefore`. Revert
   `DepositBelowSlippageFloor(realizedDelta, floor)` when `realizedDelta <
   assets × (MAX_BPS − maxSlippageBps) / MAX_BPS` (**AZ-BSK-1**: the floor is
   a revert guard, never a credit cap).
6. Mint on the full realized delta against the **eligible-NAV denominator**
   (**AZ-BSK-3**): `mintShares = realizedDelta × (supplyBefore + 10^18) /
   (taBefore − idleUSDC + 1)` where `idleUSDC` is the vault's post-route USDC
   balance.
7. `_lastMintedShares = mintShares`; the overridden `deposit()` returns it
   (**AZ-BSK-2**) so `PortfolioRouter.minSharesPerLeg` compares against
   reality, not OZ's precomputed preview.
8. ORA-4 enforcement note: the NAV-vs-market deviation check moves into each
   asset adapter's `deploy`/`withdraw` (§4.3), so the vault-level
   `BasketViews.checkNavDeviation` pre-loop is not carried.

**Exact-set equivalence (bit-identity claim).** For an all-exact adapter set
with `maxSlippageBps == 0`: every `deploy` adds exactly its allocation, any
unrouted remainder stays idle and is counted by `totalAssets`, so
`realizedDelta == assets` always, the floor check is `assets >= assets`, and
`mintShares = assets × (supplyBefore + 10^18) / (taBefore − idle + 1)`. This
is bit-identical to today's `RobotMoneyVault` (OZ `previewDeposit` computed
before transfer) **whenever pre-deposit idle USDC is zero — the steady
state**. With non-zero pre-existing idle, OZ's denominator includes idle and
the AZ-BSK-3 denominator excludes it; see §10 Q4. `previewDeposit`/
`previewMint` are exact (OZ semantics) when `allExact()`, slippage-floored
(`BasketVault` semantics, incl. the H-1 `previewMint` ceil gross-up) when
not.

### 5.3 Withdraw / redeem

- **`withdraw()` / `previewWithdraw()` gate:** permitted iff `allExact()`.
  When any active adapter is inexact, both revert `RedeemOnly()` — exact-set
  vaults keep full ERC-4626 withdraw conformance (incl. `maxWithdraw` net-of-
  fee floor rounding and paused-→-0 behavior from `RobotMoneyVault`);
  inexact-set vaults are redeem-only exactly like today's `BasketVault`.
- **`redeem()`** for all compositions: burn, pull proportionally, deliver
  realized proceeds; the override returns `_lastWithdrawnAssets` (**AZ-BSK-2**)
  — actual net USDC, not `previewRedeem`'s precomputed value.
- **Pull path:** `RobotMoneyVault`'s `_pullProportional` carried: idle USDC
  first; eligible-adapter proportional pass then rounding-sweep pass;
  `InsufficientAdapterLiquidity(requested, available)` raised early and on
  under-delivery (audit L-2); over-delivery clamped so surplus stays idle for
  all holders. Adapter calls pass `minUsdcOut = pull × (MAX_BPS −
  maxSlippageBps) / MAX_BPS` (0-floor semantics per §2.2 still leave the
  adapter's own TWAP floor in force).
- **For inexact sets** the redeem quantity is share-proportional (each
  adapter sells `shares/supplyBefore` of its position), reproducing
  `_sellProportional`; for exact sets it is the assets-driven proportional
  pull. Unifying note: both reduce to "pull `grossAssets` proportionally
  across eligible adapters"; the exact formula per composition is pinned by
  the parity suites (§7).
- **`previewRedeem`:** exact sets — gross minus exit fee (today's
  `RobotMoneyVault`); inexact sets — `gross × (1 − maxSlippageBps) × (1 −
  exitFeeBps)` documented as a floor (ADR-0007 NAV-haircut policy: pro-rata
  drawdown, no queue, revert-above-bounded-haircut).

### 5.4 Fees — FEE-2 / NC-11

The exit fee is only ever paid out of realized proceeds. Exact sets keep
`RobotMoneyVault._withdraw`'s construction: `realized = _pullProportional(
grossAssets)`, `require(realized >= grossAssets)` before disbursing
`assets + fee`. Inexact sets keep `BasketVault`'s: fee = `exitFeeBps` of the
**realized** swap proceeds, net to receiver, `_lastWithdrawnAssets = net`. In
both, an over-reporting adapter can never have its shortfall socialized from
other holders' idle USDC (`InsufficientAdapterLiquidity` fires instead).

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

### 5.6 Rebalancing — supersedes the ADR-0003 stub

`BasketVault.rebalance()`'s `NotImplemented()` Phase-B stub is superseded:
the unified vault's throttled equal-weight `rebalance()` and
`adminRebalance()` operate uniformly over position adapters, which gives the
basket themes the rebalancing model ADR-0003 deferred (trigger: admin/keeper;
target: equal-weight min'd with `capBps`; cost disclosure: `Pulled`/
`Allocated`/`Rebalanced` events, with realized swap costs bounded per leg by
the min-out floors). Note the cost asymmetry: rebalancing inexact adapters
executes real swaps (token→USDC→token), socialized to holders and bounded by
`maxSlippageBps` per leg — the throttles (`maxRebalanceBpsPerCall`,
`minRebalanceInterval`) are the blast-radius control.

---

## 6. Invariant-preservation matrix

Every named invariant/finding tag appearing in the two source contracts, its
enforcement locus in the unified design, and the test that proves it (existing
tests re-pointed at the unified vault per §7; "NEW" = written in the phase
that lands the locus).

| Tag | Property (short) | Enforced in unified design | Proving test |
|---|---|---|---|
| INV-1 | No caller-supplied recipient for protocol/depositor assets | Vault `sweepForeignToken` → governed `quarantineAddress`; adapter sweeps → fixed quarantine; adapter `withdraw`/`harvestRewards` deliver only to `VAULT` | `CustodyInvariantGuard.t.sol` (no `rescue*` selector) re-pointed; NEW adapter-boundary static guard |
| INV-2 | Nothing stranded; dust favors holders | Vault: idle USDC in NAV, `UnroutedDeposit` monitored; adapter: `harvestRewards`, protected-token sweep rejection, `reabsorb` on retired adapters | `CustodyInvariant.t.sol` handler extended to unified compositions |
| INV-3 | Fee/quarantine/guard params timelock-only | Vault ADMIN_ROLE = timelock; adapter setters gated `onlyVaultAdmin` (transitive timelock) | `DeployTimelock.t.sol` deploy-assertions extended to adapter setters (NEW) |
| ADP-2 / F-14 | Only eligible adapters price NAV or move funds | `_isAdapterCounted` gating `totalAssets` + `_pullProportional`; allowlist + codehash pinning at `addAdapter`; codehash pins venue executor + linked libs | `RobotMoneyVault.t.sol::test_ADP2_revokedAdapterExcludedFromNavAndPulls` re-pointed; NEW asset-adapter variant |
| FEE-2 / NC-11 | Fee paid from realized proceeds only | Vault `_withdraw`: `realized >= grossAssets` require (exact) / fee on realized swap proceeds (inexact); `InsufficientAdapterLiquidity` | `RobotMoneyVault.t.sol::test_FEE2_*`, `FvInvariants.t.sol::test_FEE2_*` re-pointed |
| AZ-BSK-1 | Slippage floor is a revert guard, not a credit cap | Vault `_deposit` step 5 (`DepositBelowSlippageFloor`); adapter `deploy` min-out | `BasketVault.t.sol` AZ-BSK-1/SUP-3 fuzz suite re-pointed |
| AZ-BSK-2 | `deposit()`/`redeem()` return realized amounts | Vault `deposit()`/`redeem()` overrides reading `_lastMintedShares`/`_lastWithdrawnAssets` | Router-integration tests (`PortfolioRouter.t.sol` minSharesPerLeg / minAssetsPerLeg legs) re-pointed |
| AZ-BSK-3 | Mint denominator = eligible NAV (excl. idle USDC) | Vault `_deposit` step 6 | `BasketVault.t.sol` denominator tests re-pointed; NEW exact-set bit-identity test (§10 Q4) |
| AZ-BSK-5 | Caller `minUsdcOut` honored on reabsorption (`SlippageExceeded`) | Adapter `reabsorb(minUsdcOut)` | `BasketVault.t.sol::test_LIFE6_*`/AZ-BSK-5 tests re-pointed to adapter |
| ORA-3 / F-09 | TWAP pool == execution pool | `AssetPositionAdapter` constructor (`requireExecutionPoolMatchesTwap`) | `DeployAssertions.t.sol::test_ORA3_*` re-pointed to adapter construction |
| ORA-4 / F-10 | No settlement beyond NAV-vs-market deviation band | Adapter-level check in `deploy`/`withdraw` (`NavMarketDeviationExceeded`) | `BasketVault.t.sol::test_ORA4_*`, `FvInvariants.t.sol::test_ORA4_*` re-pointed |
| SUP-3 / F-16 / NC-6 | Round trip never profits | Route-first mint-on-realized-delta `_deposit` + slippage-discounted `previewDeposit` on inexact sets | `test_SUP3_roundTripNeverProfits_fuzz` + stateful variants re-pointed |
| SUP-5 / NC-1 | Idle-USDC redemption survives stale oracle | Adapter `totalAssets` zero-balance short-circuit | `StaleOracleRedemption.t.sol::test_SUP5_*` re-pointed to Chronicle adapter composition |
| ACL-3 / F-06 | Last-admin floor | Vault `_grantRole`/`_revokeRole` hooks (`adminCount`, `LastAdminFloor`) — now also covering the lending theme | `BasketVault.t.sol` last-admin-floor tests re-pointed; NEW rmUSDC-composition case |
| ACL-5 / F-08 | Stale-price override needs a higher tier than the unwind executor | Adapter stale-override armed via vault-admin authority; unwind runs via vault EMERGENCY path | `RwaVault.t.sol::test_emergencyUnwindStaleOverride_requiresAdminNotEmergency` re-pointed |
| LIFE-3 / LIFE-4 | Withdrawals never pausable by hot key; no permanent freeze | `pause()` = deposits-only; `withdrawalsPaused` ADMIN-only; last-admin floor guarantees reversal authority | `BasketVault.t.sol::test_pause_doesNotFreezeWithdrawals` re-pointed; NEW: EMERGENCY cannot set `withdrawalsPaused` |
| LIFE-6 | Reabsorption never reverts-and-strands | Adapter `reabsorb` try/catch → quarantine fallback | `BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool` re-pointed |
| DI-2 | Unified governance retire (registry flip + deposit halt, atomic) | `setRegistry`/`retire`/`unretire` carried verbatim; `retired` flag distinct from `shutdown` | `FvInvariants.t.sol::test_LIFE1_retireSyncsRegistryAndVaultFlag` re-pointed |
| ADP-1 | No DELEGATECALL on NAV/deposit/withdraw path (lending adapters) | Unchanged for lending adapters; `AssetPositionAdapter` legitimately DELEGATECALLs linked `TickMath`/`TwapTickMath` — codehash pinning subsumes the guarantee (as for today's swap adapters) | `AdapterDelegatecallGuard.t.sol` scoped to exact adapters; codehash deploy-assertion for asset adapters |
| ADP-5 | Approvals zeroed after every call | Adapter `forceApprove(_, amount)` / `forceApprove(_, 0)` convention | Post-call allowance assertions re-pointed |
| CUST-5 | Inflation-attack resistance | `decimals() == 6`, `_decimalsOffset() == 18` | ERC-4626 conformance suite (§7) |

---

## 7. Test-parity plan

The acceptance bar is: **both existing suites pass against the one `Vault`
contract in the matching composition.** No invariant test is deleted; tests
are re-pointed (fixture swap) or ported.

1. **Lending composition parity (rmUSDC config).** The full
   `RobotMoneyVault.t.sol` suite — including the ERC-4626 property-based
   conformance suite and exact-`withdraw()` semantics, FEE-2, ADP-2/F-14,
   `InsufficientAdapterLiquidity`, rebalance throttles, emergency drains,
   retire/shutdown — runs against `Vault` + retrofitted
   Morpho/Aave/Compound adapters, `maxSlippageBps = 0`. Includes a
   bit-identity differential test: same operation sequence against v1 and
   unified vault, assert identical share/asset outcomes from a zero-idle
   start (§10 Q4 bounds the claim).
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
   `deposit`, `redeem`, `rebalance`, `totalAssets` — unified vs v1. Budget:
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
| rmAGENT | Robot Money Agent Tokens | 1 × `AssetPositionAdapter` per shortlist entry (`config/agent-token-shortlist.json`) | false | 300 | 15 | Uniswap V3 TWAP per asset | ADR-0004 timelock delays now gate `addAdapter`/`removeAdapter` (48 h / 24 h) |
| rmRWA | Robot Money RWA | 1 × Chronicle `AssetPositionAdapter` (deSPXA, Aerodrome execution) | false | 50 | **1** | Chronicle NAV + heartbeat | ADR-0006 constraints; `maxAssets()==1` becomes the adapter-count cap |

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
`setAdapterAllowed` / `setAdapterCodeHashAllowed` + `addAdapter(adapter,
capBps)` per position; `setRegistry`; rebalance throttles (defaults 2 500
bps / 12 h); adapter-level `setTwapWindow`, `setEmergencyUnwindGuard`,
`setNavDeviationGuardBps`, Chronicle heartbeat. `quarantineAddress` defaults
to `ForeignTokenQuarantine.QUARANTINE`.

---

## 9. Phased delivery

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | ADR-0010 accepted (`docs/adr/ADR-0010-unified-vault-architecture.md`) | ADR review |
| 1 | `IPositionAdapter` + Morpho/Aave/Compound retrofit (§2–3) | Retrofit adapters pass existing adapter suites + new min-out/isExact tests |
| 2 | **Spike:** V3 `AssetPositionAdapter` + `UniswapV3SwapAdapter` (§4) | Gated on reproducing the BasketVault invariant set at the adapter boundary (AZ-BSK-1, ORA-3/4, TWAP windows, unwind guards, LIFE-6) before any vault work proceeds |
| 3 | Unified `Vault` (§5) | Lending-composition parity (§7.1) + mixed-composition tests (§7.3) |
| 4 | V4 / Aerodrome / Chronicle asset adapters | Basket-composition parity per theme (§7.2), fork tests (§7.4) |
| 5 | Parity proof | Full §7 matrix green in required CI contexts; gas-delta + EIP-170 gates |
| 6 | Deploy scripts, `VaultRegistry`/`PortfolioRouter` integration, external audit, v2 mainnet deploy, router weight shift v1→v2, retire v1 vaults per ADR-0009 | Registry `retire(v1)` after weight shift; v1 redemption stays open indefinitely |

---

## 10. Open questions

Genuinely unresolved items found while reading the source; each needs an
owner before (at latest) the phase that touches it.

1. **Adapter-level authority model (Phase 2).** Adapters today are pure
   `onlyVault` machines with no role tree. §4.3 proposes `onlyVaultAdmin`
   (query `hasRole(ADMIN_ROLE)` on `VAULT`) for config setters and routing
   all emergency execution through the vault's EMERGENCY surface. Unresolved:
   whether any adapter action needs a *direct* emergency grant (e.g. arming
   the Chronicle stale override during an incident when the timelock is the
   only admin — timelock latency may be unacceptable for ACL-5's *arming*
   key), and whether a vault-admin key compromise now transitively controls
   every adapter's guard config (blast-radius review for the auditors).
2. **Who drains a compromised *venue executor*?** Swap adapters
   (`AerodromeSwapAdapter` etc.) are stateless and custody nothing, so
   `emergencyWithdrawAdapter` has no meaning for them today — but an
   `AssetPositionAdapter` whose venue executor turns hostile can only exit
   through that executor. Does the asset adapter need a secondary
   venue-executor slot (admin-swappable exit route), or is
   `forceRemoveAdapter` + loss acceptance the answer (as for lending venues)?
3. **`WeightSnapshot` event survival.** `BasketVault._routeDeposit` emits
   `WeightSnapshot(depositor, assets[], bpsWeights[], ts)` per ADR-0003's
   cost-disclosure requirement, keyed by token addresses. The unified vault
   routes to adapter addresses. Options: (a) emit with adapter addresses and
   have the explorer resolve `adapter.token()`; (b) drop it in favor of
   `Allocated` events; (c) adapter-emitted per-leg events. Explorer/indexer
   schema owners must decide before Phase 3.
4. **AZ-BSK-3 denominator vs OZ formula under idle USDC.** OZ's mint math
   (today's rmUSDC) uses `totalAssets` *including* idle USDC as the
   denominator; AZ-BSK-3 excludes idle. With non-zero pre-deposit idle
   (post-emergency-drain, unrouted deposits) the unified vault mints more
   shares per USDC than v1 would. Is the exact-set bit-identity requirement
   scoped to zero-idle states (spec'd here, §5.2), or must the deposit path
   branch on `allExact()` to use the OZ denominator? Affects the §7.1
   differential test's domain.
5. **`PortfolioRouter` / gateway integration deltas.** `minSharesPerLeg`
   already compares against the AZ-BSK-2 realized return, so exact-set legs
   are unaffected; but (a) router `previewDeposit` leg-availability logic and
   the gateway `paymentId` hash coverage (GW-2) must be re-verified against
   the unified vault's preview branching, and (b) any integrator calling
   `withdraw()` on a composition that later adds an inexact adapter starts
   receiving `RedeemOnly` — does `allExact()` need to be a registry-surfaced
   flag so the router/gateway can gate `withdraw`-shaped flows statically?
6. **Per-adapter slippage.** This spec keeps one vault-level
   `maxSlippageBps` (as `BasketVault` does). A mixed-liquidity basket (e.g.
   rmAGENT with one deep and one thin token) may want per-adapter bounds; the
   adapter already enforces its own TWAP floor, so the change would be
   adapter-local (`maxSlippageBps` on `AssetPositionAdapter`,
   vault value as ceiling). Defer or include in Phase 2?
7. **`maxActiveAdapters_` semantics.** Is the cap on *active* adapters
   (allowing retire-and-replace under the cap, recommended) or on total
   registry entries (today's `MAX_ADAPTERS` counts active only in
   `addAdapter`'s check but the array grows monotonically)? rmRWA with cap 1
   must still be able to migrate deSPXA to a repriced adapter
   (remove-then-add ordering constraint).
8. **Emergency drain vs adapter floors.** §4.4 has the vault's try/catch
   drain skip an adapter whose floor is unsatisfiable
   (`EmergencyFloorUnavailable`), leaving the position in place. Today's
   `BasketVault.emergencyUnwind` *reverts the whole unwind* in that case
   (all-or-nothing), while `RobotMoneyVault.emergencyWithdraw` is
   skip-and-continue. The unified vault must pick one; this spec picks
   skip-and-continue + per-adapter override path, but the incident-response
   runbook owner should confirm.
9. **Chronicle adapter shape.** Separate `ChronicleAssetPositionAdapter`
   contract vs a pricing-strategy field on one `AssetPositionAdapter`
   (bytecode size and codehash-allowlist ergonomics cut both ways). Phase 4
   decision; the interface in §2 is unaffected.
