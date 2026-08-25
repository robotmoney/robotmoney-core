# ADR-0013: Uniswap V4 NAV is priced by an external push feed and never by a pool read; the ORA-4 deviation guard is re-based onto realized execution price; router-eligibility is a vault-level registry act gated on a named feed and a corrected periphery ABI

- **Status:** Proposed (UNREVIEWED DRAFT — machine-generated, no decision has been taken)
- **Date:** 2026-08-25
- **Deciders:** TBD — no decision recorded. This draft was generated to unblock #1185; it must be reviewed and the decision explicitly taken before Status changes.
- **Supersedes (in part):**
  - `docs/audits.md:210` — audit finding **FS-VLT-17**
    (`accepted-with-rationale`, "V4 pricing assumes V3 `observe()` pool; demo
    vault, not router-eligible"). The **technical claim** of FS-VLT-17 stands
    and is reaffirmed below: the V4 pricing path really does assume a
    V3-shaped per-pool contract, and that assumption really is false against
    real v4-core. What is superseded is only its **remediation rationale** —
    "demo vault, not router-eligible" is no longer the accepted disposition.
  - `docs/adr/ADR-0005-basketvault-multi-dex-routing.md:144` — **§3's Uniswap
    V4 row only** ("`IUniswapV4Pool.observe()` arithmetic-mean tick TWAP …
    V4 pools expose the same `observe(uint32[] secondsAgos)` interface as V3
    (EIP-7680 compatibility)"). That row is factually wrong and is replaced by
    §1 below. **Everything else in ADR-0005 stands unchanged**: the per-venue
    swap/oracle abstraction itself (§2), the stateless-adapter rationale, the
    Aerodrome `quote()` oracle row, the V3 `observe()` row, the observation
    cardinality gating for V3, and the venue assignment table
    (`ADR-0005:210-218`).
- **Related:**
  - `contracts/adapters/UniswapV4AssetPositionAdapter.sol` — the adapter this
    decision redesigns; `POOL` immutable at `:97`, hooked-pool refusal at
    `:193`, ORA-4 guard at `:237-239`, feed-replaceable price reads at
    `:253`, `:298`, `:304`, `:329-334`
  - `contracts/adapters/UniswapV4SwapAdapter.sol` — the execution seam;
    `exactInputSingle` call at `:109-124`, `_tickSpacingForFee` at `:164-170`
  - `contracts/adapters/ChronicleOracleAdapter.sol` — the precedent combined
    executor (Aerodrome execution + Chronicle pricing); `MIN_NAV`/`MAX_NAV`
    at `:64`/`:72`, pool-and-window-ignoring `twapPrice` at `:204-236`,
    hardcoded `1e12` scaling at `:228`/`:232`
  - `contracts/adapters/DeSpxaAssetPositionAdapter.sol` — the precedent
    position adapter; adapter-local `StalePriceFeed` at `:135`,
    `_checkOracleFreshness` at `:338-350`
  - `contracts/lib/TwapTickMath.sol` — `meanTick` at `:43-49`, `deviationBps`
    at `:74-92`; DELEGATECALL-linked for EIP-170 headroom
  - `contracts/lib/BasketAssetConfigGuard.sol` — `requirePoolUsable` at
    `:66-89`, `requireExecutionPoolMatchesTwap` at `:133-142` with the
    `swapFee == 0` pool-independent-pricing sentinel at `:137`
  - `contracts/interfaces/IUniswapV4Pool.sol:5-9` and
    `contracts/interfaces/IObservablePool.sol:7-13` — the two NatSpec sites
    that repeat ADR-0005 §3's false `observe()` claim
  - `contracts/interfaces/IUniswapV4SwapRouter.sol:25-38` — the execution ABI
    the code review shows is wrong against real v4-periphery
  - `contracts/interfaces/IBasketSwapAdapter.sol:30,48` — the interface that
    conflates execution (`swap`) and pricing (`twapPrice`)
  - `contracts/interfaces/IPositionAdapter.sol:5-31` — the frozen adapter
    surface; SUP-5 zero-balance rule at `:91-96`
  - `contracts/VaultRegistry.sol:124,375-401` — `_routerEligible` state and
    `setRouterEligible`; the single-production-codebase rationale at `:115-123`
  - `contracts/PortfolioRouter.sol:33-38,1094-1096` — the one eligibility gate
  - `contracts/Vault.sol:1111-1148,1608-1623` — `addAdapter` and the
    codehash-pinned `_isAdapterEligible`; aggregate NAV-growth cap at
    `:176-193` and `:625-645`
  - `contracts/script/DeployDemoExtraVaults.s.sol:802,881-888` — the devnet
    agent basket that is *already* router-eligible with a `Venue.V4` leg
  - `contracts/test/UniswapV4AssetPositionAdapter.t.sol` — the unit suite that
    this redesign invalidates and #1186 must rewrite
  - `docs/technical/smart-contract-invariants.md:106,112,115,119,122,125` —
    ORA-1, ORA-3, ORA-4, ORA-5, ORA-6, ORA-7
  - `docs/technical/unified-vault-spec.md:402-403,958-964` — M-S6 read-only
    reentrancy enumeration and its conformance row
  - `docs/code-review/20260623-code-review-testmachine-azimuth.md:3392-3481` —
    "Uniswap V4 adapter calls a non-official router selector"
  - `docs/adr/ADR-0006-despxa-rwa-vault-design.md` §2 — the fail-closed
    external-feed posture this decision generalizes
  - `docs/development/single-production-codebase.md` — the principle the
    devnet contradiction (§Context) is reconciled against
  - `foundry.toml:6,9` — `solc_version = "0.8.24"`, `evm_version = "cancun"`
  - blocker issue #1169 (the blocker this ADR resolves), issue #1185 (this
    ADR), issue #1186 (the implementation this ADR constrains), issue #1165
    and PR #1166 (the parked fork-test realism work)

## Context

**The V4 NAV path is built on a pool contract that does not exist.** Real
Uniswap v4-core holds every pool as a state entry inside a singleton
`PoolManager`, keyed by `PoolId`/`PoolKey`. There is no per-pool contract, so
there is no `token0()`, `token1()`, `slot0()`, `liquidity()`, `fee()`, and
above all no `observe()` — v4-core ships **no native TWAP at all**; a V4 TWAP
requires either an oracle hook or an off-pool feed. This repository's V4 path
assumes the exact opposite at four independent sites, all of which take a pool
*address*: the constructor's `requireExecutionPoolMatchesTwap` reaching
`IUniswapV3Pool(pool).fee()` (`BasketAssetConfigGuard.sol:133-142`), the
constructor's `requirePoolUsable` reading `token0`/`token1`/`slot0`/`observe`/
`liquidity` (`BasketAssetConfigGuard.sol:66-89`), the ORA-4 deviation guard
(`UniswapV4AssetPositionAdapter.sol:237-239` → `TwapTickMath.sol:74-92`), and
every price read via `SWAP_ADAPTER.twapPrice(POOL, …)`
(`:253`, `:298`, `:304`, `:329-334` → `TwapTickMath.meanTick`,
`TwapTickMath.sol:43-49`). Against real v4-core **the constructor cannot
execute at all** — the adapter is un-deployable before any pricing question is
reached. This is not a fork-test gap; it is a production-code gap that a test
cannot close.

**The false claim is written down in three places, not one.** #1185 names only
FS-VLT-17. But `ADR-0005:144` asserts "V4 pools expose the same
`observe(uint32[] secondsAgos)` interface as V3 (EIP-7680 compatibility)";
`IUniswapV4Pool.sol:5-9` repeats it as the interface's own justification; and
`IObservablePool.sol:7-13` repeats it a third time as the reason the shared
tick math may be reused across venues. EIP-7680 is not a V4 pool-oracle
standard and no such per-pool surface is deployed. All three must be retracted
together, or the next reader re-derives the same wrong design from whichever
one was left standing.

**FS-VLT-17's disposition is already contradicted on devnet.** The accepted
rationale is "demo vault, not router-eligible". But
`DeployDemoExtraVaults.s.sol:881-888` adds JUNO at `BasketVault.Venue.V4` to
the agent basket, and `:802` calls `registry.setRouterEligible(agentVault,
true)`. The demo is router-eligible today, over a stub V4 router. The
containment FS-VLT-17 relies on is therefore not a property of the system; it
is a property of nobody having pointed the adapter at mainnet yet. Leaving the
finding as-is preserves a rationale that the deploy script has already
falsified.

**Router-eligibility is not an adapter property, and #1185/#1186 describe it
wrongly.** There is no adapter-level eligibility anywhere in the codebase.
Eligibility is registry state on a **vault**: `VaultRegistry._routerEligible`
(`:124`), flipped by `setRouterEligible` (`:375-401`), read at one place by
`PortfolioRouter` (`:1094-1096`). Expressing readiness as state rather than as
a code variant is the deliberate single-production-codebase choice documented
at `VaultRegistry.sol:115-123` and `PortfolioRouter.sol:33-38`. "The V4
adapter becomes router-eligible" has no referent. The decidable statement is:
*a vault holding a V4-venue asset may be marked router-eligible in
production*, which is a governance act on the registry, not a property the
adapter can carry.

**The Chronicle precedent already answers most of the shape — including the
part nobody wrote down.** `ChronicleOracleAdapter` is a *combined executor*:
it swaps through Aerodrome and prices through Chronicle, ignoring both the
`pool` and `window` arguments of `IBasketSwapAdapter.twapPrice`
(`:204-236`). `DeSpxaAssetPositionAdapter` pairs it with an adapter-local
`StalePriceFeed` error (`:135`) and an unconditional freshness gate
(`:338-350`) — and carries **no deviation guard at all**. So the deployed
answer to "what replaces ORA-4 under an external feed" is currently "nothing",
and that answer shipped. Whether V4 may inherit it is the one question this
ADR genuinely has to decide.

**Why V4 is not deSPXA.** deSPXA is a redemption-gated RWA whose feed is the
issuer-sanctioned NAV source; the secondary Aerodrome market is a convenience,
and divergence between the two is expected and documented (ADR-0006, FS-VLT-13
at `docs/audits.md:206`). A V4 agent token has no NAV outside its market — the
feed and the pool are two estimates of the *same* quantity, and any gap
between them is either feed error or market manipulation. Dropping the
deviation check is defensible when the feed is the definition of value; it is
not defensible when the feed is a proxy for a market the vault trades against
in the same transaction. That asymmetry is why the deSPXA posture is not
simply copied below.

**The `swapFee == 0` escape hatch exists but does not fit.**
`requireExecutionPoolMatchesTwap` already exempts `swapFee == 0` as the
pool-independent-pricing sentinel (`BasketAssetConfigGuard.sol:137`), written
for Chronicle. A V4 adapter cannot use it as-is: the same `SWAP_FEE` immutable
is passed to execution (`UniswapV4AssetPositionAdapter.sol:258,313`), and
`UniswapV4SwapAdapter._tickSpacingForFee(0)` reverts `UnsupportedFeeTier`
(`:164-170`). Feed pricing therefore requires decoupling the pricing
identifier from the execution fee tier — an interface change, not a drop-in.

**The execution ABI is separately broken.** #1185 says swaps "route through V4
periphery by interface". `docs/code-review/20260623-…:3392-3481` documents
that this repo's `IUniswapV4SwapRouter.ExactInputSingleParams`
(`:25-38`) does not match real v4-periphery: the fifth field is
`minHopPriceX36`, not `sqrtPriceLimitX96`, and real V4 routes through the
unlock/action-router flow rather than a plain `exactInputSingle`. Fixing the
NAV oracle without fixing this lands a correct price feed on top of a swap
call that still reverts against mainnet. #1186 does not scope it.

**Feed availability is unstated.** Chronicle exists for deSPXA because an
issuer publishes a NAV feed and its Base address is named
(`IChronicleOracle.sol:18-19`). The asset that motivated V4 in the first place
is JUNO (`ADR-0005:24,215`). No JUNO/USD push feed on Base is identified
anywhere in this repository. "External feed" is a mechanism; it is not
automatically available for the asset that drove the venue choice.

## Decision

### 1. V4 NAV is priced exclusively by an external push feed; the NAV path performs no v4-core read of any kind

The V4 position adapter's `totalAssets()`, its entry-side token estimate, and
its exit-side sizing all read a single external push oracle
(`latestAnswer`/`latestTimestamp`, the `IChronicleOracle` shape at
`contracts/interfaces/IChronicleOracle.sol:18-19`) and nothing else. No
`observe()`, no `slot0()`, no `StateView`, no `Quoter`, no `PoolManager`
storage read appears on the NAV path. Every price-sensitive entry point is
gated fail-closed on feed freshness by an adapter-local `StalePriceFeed`
error, exactly as `DeSpxaAssetPositionAdapter.sol:135,338-350` does today —
including on `withdraw`, and including on `totalAssets()` **only when the
balance is non-zero**, preserving SUP-5 (`IPositionAdapter.sol:91-96`;
today's zero-balance short-circuit at
`UniswapV4AssetPositionAdapter.sol:329-334` is retained verbatim).

The `MIN_NAV`/`MAX_NAV` sanity band is reused unchanged in intent from
`ChronicleOracleAdapter.sol:64,72` (ORA-5).

Decimals scaling is **not** inherited from Chronicle. That path hardcodes
`1e12` for an 18-decimal token (`ChronicleOracleAdapter.sol:228,232`), which
is the known ORA-6/F-17 weakness
(`docs/technical/smart-contract-invariants.md:122`, "🟡 TRUSTED (deSPXA =
18)"). V4 basket assets are not guaranteed 18-decimal. The V4 pricing path
reads `decimals()` on both legs at construction, stores the scaling factor as
an immutable, and asserts `usdc.decimals() == 6` — so ORA-6 moves from TRUSTED
to enforced for this venue. Copying the `1e12` literal is explicitly
prohibited.

### 2. The ORA-4 deviation guard is retained for V4, re-based onto realized execution price

This is the substantive choice. The existing guard compares TWAP against spot,
both read from the same pool (`TwapTickMath.sol:74-92`); remove the pool read
and the guard has no second leg. Dropping it — the deSPXA posture — would
reopen exactly the F-16 mint-vs-market asymmetry that issue #969 added the
guard to close: `deploy` credits `valueAdded` from `totalAssets()`, which
under §1 is a pure feed mark, while paying the pool. We do not accept that
for a market-priced asset (see Context, "Why V4 is not deSPXA").

For the V4 venue, ORA-4 is therefore enforced as a **two-sided realized-price
check inside `deploy`**, computed from the swap that `deploy` itself just
executed:

- Before the swap, compute `expectedToken = feedPrice(usdcIn)`.
- After the swap, measure `realizedToken` as the adapter's TOKEN balance
  delta.
- Revert `NavMarketDeviationExceeded` when
  `|realizedToken − expectedToken| / expectedToken > navDeviationGuardBps`.

Four properties make this the right form:

- **It is two-sided, and the dangerous direction is the one the min-out floor
  cannot see.** A stale-high feed makes `expectedToken` small, so the venue
  min-out (`UniswapV4AssetPositionAdapter.sol:253-258`) passes trivially — and
  then `totalAssets()` marks the acquired tokens at the inflated feed price
  and over-credits `valueAdded`. Only an upper-bound check on realized-vs-feed
  catches that. This is precisely the leak ORA-4 exists for.
- **It is entry-side and atomic.** The comparison runs after the swap call but
  inside the same `deploy` frame; a revert unwinds the swap. No deposit
  settles against a diverged mark, which is what
  `smart-contract-invariants.md:115` requires. The guard remains absent from
  `withdraw` — exit liveness (spec §5.3) is unchanged.
- **It reads the executable market price without reading v4-core.** The
  realized fill *is* the executable price, obtained from token balances the
  adapter already tracks. No `StateView`, no import, no solc question.
- **It composes with, rather than replaces, the vault-side backstop.**
  `Vault._enforceNavGrowthLimit` (`Vault.sol:176-193,625-645`) still bounds
  aggregate NAV growth rate on deposits.

Two consequences of this form must be carried into implementation and are
stated here so they are not discovered later. First, the realized price
includes the pool fee and slippage, so `navDeviationGuardBps` for a V4 adapter
must be configured **strictly above** the fee tier plus expected slippage or
routine deposits revert; it can therefore only catch gross divergence, not
tight mis-marks. **OPEN:** the numeric floor relative to fee tier and
`maxSlippageBps` — #1186 must calibrate it and encode the relationship as a
setter bound, not leave it to operator discretion. Second, the guard is
inoperative between deposits: NAV marks reported by `totalAssets()` are pure
feed values with no market cross-check, bounded only by staleness, the
`MIN_NAV`/`MAX_NAV` band, and the vault-side growth-rate cap. That residual is
accepted and recorded in Consequences.

### 3. The V4 feed path ships as a new combined executor; the pricing identifier is decoupled from the execution fee tier

`IBasketSwapAdapter` conflates execution and pricing in one interface
(`:30,48`). Rather than reopen that frozen-adjacent seam, V4 follows the
Chronicle precedent structurally: a **new** combined executor — V4 periphery
execution plus feed pricing — is written, and `UniswapV4SwapAdapter` is left
alone as the demo/stub-facing venue shim. `ChronicleOracleAdapter.sol:204-236`
is the template: `pool` and `window` arguments are accepted and ignored.

The position adapter's `POOL` immutable
(`UniswapV4AssetPositionAdapter.sol:97`) stops being a contract address it
calls. It becomes an inert `PoolKey`-derived pool identifier used only to
parameterize execution. Consequently the two constructor guards are **not
called** for V4: `requireExecutionPoolMatchesTwap` (which would call
`fee()` on a non-contract) and `requirePoolUsable` (which would call
`token0`/`slot0`/`observe`/`liquidity`). The `swapFee == 0` sentinel at
`BasketAssetConfigGuard.sol:137` is **not** the mechanism — it cannot be,
because the same value drives `_tickSpacingForFee`
(`UniswapV4SwapAdapter.sol:164-170`), which reverts on 0. The pricing
identifier and the execution fee tier are separate constructor arguments from
here on. Pool usability (liquidity depth sufficient for synchronous
redemption) does not disappear as a concern; against a singleton it is an
off-chain deployment-time check plus the realized-price guard of §2, not a
constructor assertion. **OPEN:** whether a cheap on-chain depth precondition
is available at construction against real v4-core, or whether the deployment
runbook carries it.

`IPositionAdapter` is untouched. The frozen eight members and the normative
`OnlyVault`/`SlippageExceeded` error set (`IPositionAdapter.sol:5-31`) are
unchanged; `StalePriceFeed` and `NavMarketDeviationExceeded` are adapter-local
additions, exactly as deSPXA's is. `isExact()` stays `false`, so no
`armExactnessTransition` delay (`Vault.sol:1158`) is triggered by this work.

### 4. `TwapTickMath` and `BasketAssetConfigGuard` change not at all

The change is **additive**: V4 stops calling the shared libraries; the
libraries themselves are not edited. Both are `public`/DELEGATECALL-linked
specifically to keep the EIP-170-tight vault family under 24,576 bytes
(`TwapTickMath.sol:43-49`; `BasketAssetConfigGuard.sol:14-16`), and V3,
Aerodrome, and `BasketVault` all link them. Any edit to either propagates to
three venues and the vault. This is stated as a decision, not an expectation,
because #1186's second acceptance criterion (no V3/Aerodrome regression)
depends on it and because "make the guard V4-aware" is the tempting shortcut.
`VaultCodeSizeGuard.t.sol` remains the gate.

### 5. Invariant dispositions for the V4 venue are declared explicitly, not left to inference

- **ORA-1** (`:106`) — holds trivially and more strongly than before: no
  `slot0` read exists anywhere on the V4 NAV path.
- **ORA-3** (`:112`, "TWAP pool == execution pool") — **not applicable** to
  V4, on the same footing as the Chronicle-priced deSPXA path. It is not
  violated; its premise (NAV derives from a pool) is absent. The invariants
  document must say "N/A (feed-priced venue)" for V4, never leave it green by
  omission.
- **ORA-4** (`:115`) — holds for V4 in the realized-execution form of §2. The
  invariant text gains a second, feed-venue clause; the V3/Aerodrome
  spot-vs-TWAP form is unchanged.
- **ORA-5** (`:119`) — holds via the reused `MIN_NAV`/`MAX_NAV` band.
- **ORA-6** (`:122`) — upgraded from TRUSTED to enforced for V4 via the
  constructor `decimals()` reads of §1. The deSPXA `1e12` weakness is not
  inherited and remains open on its own path.
- **ORA-7** (`:125`) — the sharpest tension, and it is **weakened on the exit
  leg**, which we accept explicitly. On entry, the realized-price guard of §2
  is genuinely independent of the feed, so the floor is not co-manipulable
  with the mark. On `withdraw`, the internal floor is feed-derived
  (`UniswapV4AssetPositionAdapter.sol:298-306`) and so shares a source with
  NAV; today's V3/V4 satisfaction of ORA-7 rests on ORA-3 pool-equality, which
  §3 removes. What remains on exit is the constant `maxSlippageBps` and the
  vault-side aggregate growth cap. This is the same posture the Chronicle path
  already ships with and is recorded as an accepted trade-off below.
- **M-S6** (`unified-vault-spec.md:402-403,958-964`) — unchanged and
  strengthened. The `hooks == address(0)` construction assert
  (`UniswapV4AssetPositionAdapter.sol:193`) survives verbatim, and because §1
  forbids any v4-core read there is no new view surface to enumerate. Had the
  ORA-4 market leg been sourced from `PoolManager` state, the read-only
  reentrancy enumeration would have had to be redone; §2 avoids that.

### 6. Router-eligibility is restated as a vault-level governance act, gated on two named preconditions

"The V4 adapter becomes router-eligible" is retired as a phrasing. The
decision authorized is: **a vault holding a `Venue.V4` asset may be marked
router-eligible in production** via `VaultRegistry.setRouterEligible`
(`:375-401`), once both of the following hold:

1. **A specific push feed is named for that asset**, with its Base address,
   heartbeat, and access model recorded the way
   `IChronicleOracle.sol:18-19` records deSPXA's. **OPEN:** no JUNO/USD feed
   on Base is identified anywhere in this repository. This decision therefore
   scopes to *V4 assets that have a qualifying feed*; JUNO specifically
   remains non-eligible in production until such a feed is named, and if none
   exists the venue assignment for JUNO (`ADR-0005:215`) must itself be
   revisited in a follow-up. Naming a feed is a precondition of eligibility,
   not of this ADR.
2. **The V4 execution ABI is corrected** (§8). A correct NAV oracle over a
   swap call that reverts against mainnet is not eligibility, it is a
   deferred failure.

Two mechanical notes for whoever performs the flip. `setRouterEligible`
reverts `StaleDefaultWeightsLength` unless the router's default weight vector
is re-set to the new eligible count (`VaultRegistry.sol:385-397`), so the flip
is a two-step dance or a single `migrateEligibility` call
(`:404+`); and `retire()` reverts `RetireWhileRouterEligible` while the flag
is set. Separately, replacing the V4 adapter's bytecode invalidates any pinned
runtime-codehash in `adapterCodeHashAllowed` (`Vault.sol:1608-1623`), so
`addAdapter` (`:1111-1148`) will reject the new adapter until governance pins
the new hash and the `USDC()`/`VAULT()` identity checks pass. This is a
governance action, not a redeploy.

### 7. The three false `observe()` claims are retracted at their sources

`ADR-0005:144`'s V4 row is superseded by §1 (recorded in this ADR's front
matter). The NatSpec at `IUniswapV4Pool.sol:5-9` and the V4 sentence in
`IObservablePool.sol:7-13` are corrected in the same change that lands the
implementation — `IObservablePool` remains correct and load-bearing for V3 and
Aerodrome Slipstream (its truncated-`slot0` reasoning at `:14-25` is unrelated
and stands); only its V4 claim is wrong. `IUniswapV4Pool` has no remaining
consumer once §3 lands and should be deleted rather than corrected. Leaving
any of the three in place would let the refuted design be re-derived from a
surviving source of truth.

### 8. No solc/EVM bump is required for pricing; the execution-ABI correction is hand-written and is scoped to its own issue

`foundry.toml:6,9` pins `solc_version = "0.8.24"` and `evm_version =
"cancun"`. Both stay. §1 guarantees this for the pricing path by construction:
no v4-core import exists, so v4-core's 0.8.26 + transient-storage floor never
applies. This half of #1185's claim holds unconditionally.

The execution half needs a qualification #1185 does not make. Real v4-periphery
routes through the unlock/action-router flow and its
`ExactInputSingleParams` carries `minHopPriceX36` where this repo has
`sqrtPriceLimitX96` (`docs/code-review/20260623-…:3392-3481`;
`IUniswapV4SwapRouter.sol:25-38`; `UniswapV4SwapAdapter.sol:109-124`). The
decision is to **hand-declare the corrected periphery ABI**, as this repo
already does for Chronicle and Aerodrome, rather than add a v4-periphery
submodule — hand-declaring keeps 0.8.24; importing does not. **OPEN:** whether
the unlock/action-router flow is fully expressible through a hand-written
interface without pulling in v4-periphery's action-encoding helpers; if it is
not, the compiler question reopens and this section must be amended by
addendum.

This correction is **explicitly out of scope for #1186** and belongs to a
separate issue, sequenced after #1186 and before any production eligibility
flip. #1186 may therefore state "no `solc_version`/EVM change" truthfully, but
**may not** claim router-eligibility against real v4-core as a delivered
outcome; see the constraints below.

## Consequences

**Positive.**

- **Blocker #1169 is resolved and #1165 unparks.** #1165 has been parked
  eleven times waiting for exactly this decision; PR #1166 is an empty
  placeholder (0 additions, 0 deletions) precisely because no code could be
  written without it. #1165 now has a defined target: fork-test the feed path
  and the realized-price guard, not a hand-rolled `PoolManager`.
- **The un-deployable constructor is fixed.** Removing the two
  `BasketAssetConfigGuard` calls for V4 (§3) is what makes the adapter
  constructible against a singleton at all. Every other benefit is downstream
  of that.
- **ORA-4 survives the transition with a real mechanism**, and in the one
  direction that matters most it is *stronger* than the min-out floor it sits
  beside. The alternative on offer — the shipped deSPXA posture — would have
  left the invariant with no enforcement while still reading green.
- **ORA-6 is enforced rather than trusted for this venue**, closing the F-17
  class for V4 instead of propagating it.
- **The shared oracle libraries and the V3/Aerodrome venues are untouched**
  (§4), so the EIP-170 budget and the existing conformance and formal suites
  are unaffected by construction rather than by testing.
- **The devnet contradiction is resolved rather than perpetuated.** The
  already-eligible V4 leg at `DeployDemoExtraVaults.s.sol:802,881-888` stops
  being an embarrassment and becomes the ordinary configuration case: same
  contracts, different seeded state.
- **The decision becomes durable.** The 2026-07-25 `/superfield-decision`
  currently exists only inside issue bodies and in no repository file. This
  ADR is the artifact that survives issue archival.

**Negative / accepted trade-off.**

- **NAV between deposits has no market cross-check.** `totalAssets()` is a
  pure feed mark bounded only by staleness, the `MIN_NAV`/`MAX_NAV` band, and
  `Vault._enforceNavGrowthLimit` (`Vault.sol:625-645`) — and that cap is
  aggregate and entry-side, so it bounds the *speed* of a mis-mark, not slow
  drift, and cannot attribute drift to an adapter (`Vault.sol:181-187` says so
  in its own NatSpec). **Accepted cost:** feed-quality risk moves onto the
  operator's feed-selection and monitoring, as it already has for deSPXA.
- **ORA-7 is weakened on the exit leg** (§5). The withdraw-side internal floor
  and the NAV mark share a source. **Accepted cost:** the residual is the
  constant `maxSlippageBps` and the vault-side cap; this matches the deployed
  Chronicle posture rather than introducing a new class of exposure.
- **The realized-price guard cannot be tight.** It must clear fee plus
  slippage (§2), so it detects gross divergence only, and it burns gas on a
  swap that then reverts. **Accepted cost:** a coarse guard that exists beats
  a precise guard that does not.
- **A feed dependency is a liveness dependency.** Fail-closed freshness means
  a stalled feed halts deposits *and* redemptions for that asset, exactly as
  ORA-2 does for deSPXA (`smart-contract-invariants.md:109` notes the tension
  with user `redeem`). **Accepted cost:** halting is preferred to pricing off
  a stale mark; the SUP-5 zero-balance exemption limits the blast radius to
  vaults actually holding the asset.
- **The unit suite is invalidated.**
  `contracts/test/UniswapV4AssetPositionAdapter.t.sol` is written against the
  `observe()`-shaped mock and must be rewritten wholesale, not patched.
- **Two governance interlocks are now on the critical path** — the codehash
  re-pin (`Vault.sol:1608-1623`) and the default-weight-vector re-set
  (`VaultRegistry.sol:385-397`). Neither is new, but both now apply to a
  change that previously touched only a demo.
- **The motivating asset may not be servable.** If no JUNO feed exists (§6,
  OPEN), this ADR authorizes a mechanism that the venue's only current asset
  cannot use. That is still an improvement over the status quo — the mechanism
  is decided and the gap is named — but it is a real possibility and is not
  papered over.

**Reconciliation with the accepted-audit-finding reversal.**

Reversing an `accepted-with-rationale` audit finding could read as
audit-shopping, so the grounds are stated plainly. FS-VLT-17's **finding** is
not disputed and is reaffirmed: V4 pricing does assume a V3-shaped pool, and
that is wrong. What is reversed is only its **disposition**. Three things
changed since it was accepted: (a) the containment it relies on — "demo vault,
not router-eligible" — was already false in the deploy script
(`DeployDemoExtraVaults.s.sol:802,881-888`), so the finding was accepted
against a premise the repository does not satisfy; (b) the deSPXA work
(#1126) shipped a working feed-priced adapter, so the remediation that was
speculative in June is now a pattern with production precedent; and (c) the
finding's own remediation is now implemented rather than deferred — this is
the strictly stronger disposition. `docs/audits.md:210` is amended in place by
appending a pointer to this ADR to its rationale cell; the row, its severity,
and its `accepted-with-rationale` history are not rewritten, per the
append-only convention at `docs/adr/README.md:3-5`.

**Reconciliation with the single-production-codebase principle.**

`VaultRegistry.sol:115-123` and `PortfolioRouter.sol:33-38` bind the project to
one contract path across every environment, differing only by configuration
and seeded state. This decision could read as a violation in two ways, and is
not one in either. First, §6 keeps eligibility as registry state — there is no
"mainnet V4 adapter" versus "demo V4 adapter" code variant; the same adapter
deploys everywhere and the operator's `setRouterEligible` call is the only
difference. Second, §3 leaves `UniswapV4SwapAdapter` in place for the devnet
stub path while the new combined executor serves the feed path — these are two
*configurations* of `swapAdapter[venue]`, the substitutability that
ADR-0005 §2 exists to provide, not two builds of one contract. **OPEN:**
whether the devnet agent basket keeps the `observe()`-shaped stub or moves to
a demo feed stub; keeping the stub means devnet exercises a path production
never takes, which is exactly the drift the principle is meant to prevent, so
the preference is to move devnet onto a feed stub in #1186.

**How this constrains issue #1186.**

- **In scope, mandatory:** the feed-priced NAV path (§1) with `decimals()`-
  derived scaling and **no `1e12` literal**; the fail-closed staleness gate
  with an adapter-local `StalePriceFeed`; the realized-execution ORA-4 guard
  of §2 including a setter bound tying `navDeviationGuardBps` to the fee tier
  and `maxSlippageBps`; the new combined executor of §3; decoupled pricing-
  identifier and execution-fee-tier constructor arguments; the retractions of
  §7; the invariant-document edits of §5; and a rewritten
  `UniswapV4AssetPositionAdapter.t.sol`.
- **Forbidden:** editing `TwapTickMath.sol` or `BasketAssetConfigGuard.sol`
  (§4); using the `swapFee == 0` sentinel as the V4 mechanism (§3); changing
  `IPositionAdapter` (§3); importing v4-core or v4-periphery, or touching
  `foundry.toml:6,9` (§8); deploying an oracle hook or otherwise relaxing the
  `hooks == address(0)` assert at `UniswapV4AssetPositionAdapter.sol:193`.
- **Out of scope, deferred:** the v4-periphery execution-ABI correction (§8) —
  its own issue, sequenced after #1186; and the production eligibility flip
  (§6), which additionally requires a named feed.
- **Acceptance-criteria correction:** #1186's AC #3 ("the V4 adapter is
  router-eligible") is not satisfiable as written and must be restated as *a
  vault composed with the V4 adapter can be marked router-eligible in the
  registry and accepted by `PortfolioRouter`, exercised in tests against the
  corrected feed path* — with the mainnet claim withheld until §8's issue
  lands. Adapter-level eligibility does not exist (`VaultRegistry.sol:124`).
- **CI note for #1185's own AC #4:** there is no ADR-index, docs-freshness, or
  markdown-link job covering `docs/adr/`.
  `.github/workflows/suite-13-doc-checks.yml` runs bespoke Python validators
  whose three "ADR" checks target `docs/technical/` documents
  (`:68-81`), and `generated-docs-freshness` runs `forge doc`, which only
  engages when `contracts/` changes — i.e. for #1186, not for this ADR. AC #4
  is satisfied vacuously; no job is being invented to satisfy it. The
  `docs/audits.md:210` change is a one-line rationale-cell edit, and the
  `docs/adr/README.md` index gains one row.

## Out of scope of this decision

- **The v4-periphery execution ABI correction** (§8) — decided in principle,
  scoped to a separate issue.
- **Which feed serves which V4 asset** (§6) — a per-asset operator decision
  requiring a named contract, heartbeat, and access model; JUNO specifically
  is unresolved.
- **The deSPXA/Chronicle `1e12` ORA-6 weakness** (`ChronicleOracleAdapter.sol:
  228,232`) — this ADR declines to inherit it for V4 but does not fix it on
  the deSPXA path.
- **The ORA-7 exit-leg independence gap** for feed-priced venues generally
  (§5) — recorded as an accepted trade-off shared with the deSPXA path;
  closing it for both would be a separate decision.
- **Fork-test realism against real v4-core** (#1165) — re-scoped under this
  ADR, not decided by it.
- **Whether `BasketVault` and the unified `Vault` should ever price a venue
  without any market cross-check on the marking path** — the aggregate
  NAV-growth cap (`Vault.sol:176-193`) is the current vault-wide answer and is
  not revisited here.
- **Any change to `IPositionAdapter`** — the frozen surface
  (`IPositionAdapter.sol:5-31`) requires its own coordinating issue.