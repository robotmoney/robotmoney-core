# ADR-0005: BasketVault multi-DEX routing — per-asset venue abstraction for Aerodrome and Uniswap V4

- **Status:** Accepted (amended 2026-10-05 — see [Amendment — 2026-10-05](#amendment--2026-10-05-venue-state-at-launch-and-the-uniswap-v4-restore))
- **Date:** 2026-06-03 (amended 2026-10-05)
- **Deciders:** Engineering lead, Product owner
- **Related:**
  - `docs/technical/basket-vault-gap-report.md` §1, §2, Appendix A
  - `docs/technical/real-four-vault-demo-seams.md` §2 Phase B
  - `docs/prd.md` §11.2, §11.3
  - `docs/architecture.md` §4.1, §4.4, §8
  - `contracts/vaults/BasketVault.sol`
  - `config/dex-pools.json`

## Context

`BasketVault` currently routes all swaps through a single hardcoded
`SWAP_ROUTER.exactInputSingle` call (Uniswap V3) and prices all basket
assets via `IUniswapV3Pool.observe()` TWAP. This works for assets whose
deepest liquidity lives on Uniswap V3.

For the Real four-vault demo (Plan #109, issues #541–#568) the basket vaults
must hold JUNO and RM tokens. On Base mainnet:

- **JUNO** — deepest liquidity is on **Uniswap V4**.
- **RM** — deepest liquidity is on **Aerodrome**.

Neither token has a meaningful Uniswap V3 pool, so `exactInputSingle` would
revert or produce catastrophic slippage. The swap-and-oracle abstraction must
be decided in an ADR before Phase B adapter issues (#552, #553) can begin.

This ADR decides:

1. The per-asset venue abstraction exposed in `addAsset` and `AssetInfo`.
2. The per-venue oracle source (swap pricing + TWAP).
3. The `amountOutMinimum` / slippage-floor computation per venue.
4. How the existing Uniswap V3 path is preserved as the default.

## Decisions

### 1. Per-asset venue abstraction

Each basket asset is registered with an explicit **venue tag** alongside its
pool address(es). The venue tag is a `uint8` enum stored in `AssetInfo`:

```solidity
enum SwapVenue { UniswapV3, UniswapV4, Aerodrome }
```

`addAsset` gains a fourth parameter:

```solidity
function addAsset(
    address token_,
    address pool_,      // primary pool for this venue
    uint24  poolParam_, // fee tier (V3/V4) or Aerodrome stable flag (0 = volatile, 1 = stable)
    SwapVenue venue_
) external onlyRole(ADMIN_ROLE)
```

`AssetInfo` is extended:

```solidity
struct AssetInfo {
    address   token;
    address   pool;       // primary pool address for swap + oracle
    uint24    poolParam;  // venue-specific: fee tier (V3/V4) or 0/1 stable flag (Aerodrome)
    SwapVenue venue;      // which DEX adapter to invoke
    bool      active;
}
```

Rationale: tagging each asset at registration time keeps the hot paths
(`_routeDeposit`, `_sellProportional`, `_twapUsdcValue`) simple — they
dispatch on `assetInfo.venue` rather than sniffing pool interface type at
runtime. The tag is set by `ADMIN_ROLE` at `addAsset` time and cannot be
changed without removing and re-adding the asset, preserving audit traceability.

### 2. Adapter interface (`IBasketSwapAdapter`)

Each venue is implemented as a stateless adapter contract behind a shared
interface. `BasketVault` holds a mapping from venue to adapter address:

```solidity
mapping(SwapVenue => address) public swapAdapter;
```

The interface is:

```solidity
interface IBasketSwapAdapter {
    /// @notice Execute a single-hop swap from tokenIn to tokenOut.
    /// @param pool       Pool address registered for this asset.
    /// @param poolParam  Venue-specific parameter (fee tier or stable flag).
    /// @param tokenIn    Token to sell.
    /// @param tokenOut   Token to receive.
    /// @param amountIn   Exact amount of tokenIn to sell.
    /// @param amountOutMinimum  Slippage floor; revert if output < this.
    /// @param recipient  Address to receive tokenOut.
    /// @return amountOut Actual tokenOut received.
    function swap(
        address pool,
        uint24  poolParam,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        address recipient
    ) external returns (uint256 amountOut);

    /// @notice Compute a TWAP-based quote of tokenIn → tokenOut.
    /// @param pool        Pool address registered for this asset.
    /// @param poolParam   Venue-specific parameter.
    /// @param tokenIn     Token to price.
    /// @param tokenOut    Quote token.
    /// @param amountIn    Amount of tokenIn.
    /// @param twapWindow  TWAP observation window in seconds.
    /// @return amountOut  TWAP-based tokenOut equivalent.
    function twapQuote(
        address pool,
        uint24  poolParam,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint32  twapWindow
    ) external view returns (uint256 amountOut);
}
```

The adapter is stateless. All USDC / token transfers are executed by
`BasketVault` before and after calling the adapter; the adapter only executes
the swap on behalf of the vault (using `SafeERC20.safeApprove` immediately
before the call, reset to 0 immediately after).

Rationale: stateless adapters can be upgraded by replacing the address in
`swapAdapter[venue]` without touching `BasketVault.sol`. Separating the swap
call from the USDC bookkeeping keeps `BasketVault` the single accounting
authority and avoids reentrancy surfaces inside the adapter.

### 3. Per-venue oracle source

| Venue | Oracle method | Notes |
|-------|--------------|-------|
| Uniswap V3 | `IUniswapV3Pool.observe()` arithmetic-mean tick TWAP (existing) | Unchanged. `twapWindow` per asset, MIN=600 s, DEFAULT=1800 s. |
| Uniswap V4 | `IUniswapV4Pool.observe()` arithmetic-mean tick TWAP | V4 pools expose the same `observe(uint32[] secondsAgos)` interface as V3 (EIP-7680 compatibility). The adapter calls it identically to the V3 path. |
| Aerodrome | `IAerodromePool.quote(amountIn, granularity)` TWAP | Aerodrome's native `quote` function returns a time-weighted price over `granularity` samples (each sample ≈ 30 minutes on Base). `granularity` is set to `ceil(twapWindow / 1800)` so that the window matches the asset's configured `twapWindow` as closely as possible. Aerodrome does not implement Uniswap V3/V4's `observe()` interface. |

Rationale for Aerodrome `quote` instead of `observe()`: Aerodrome's AMM is a
constant-sum/constant-product fork of Velodrome, which does not implement the
`TickMath` / `sqrtPriceX96` representation used by V3/V4. Its native `quote`
function is the documented TWAP surface and is read by Aerodrome's own
router. Using it avoids writing a tick-to-amount converter that has no
on-chain equivalent on Aerodrome pools.

**Observation cardinality gating** — the existing `MIN_POOL_CARDINALITY`
check (enforced in `addAsset`) applies to V3 and V4 pools. Aerodrome pools
do not have configurable observation cardinality; the `addAsset` gate instead
verifies that the pool's `observationLength()` covers at least
`ceil(twapWindow / 1800)` granularity samples. This check is encoded in the
Aerodrome adapter's `addAssetValidate` helper, called by `addAsset` after
the venue-agnostic zero-address checks.

### 4. `amountOutMinimum` / slippage-floor computation

The slippage floor formula is uniform across all venues:

```
amountOutMinimum = twapQuote(pool, poolParam, tokenIn, tokenOut, amountIn, twapWindow)
                   * (MAX_BPS − maxSlippageBps) / MAX_BPS
```

where `twapQuote` is dispatched through the registered adapter for the asset's
venue. This ensures:

- The floor is derived from a tamper-resistant TWAP, not spot price.
- The same `maxSlippageBps` governance parameter applies regardless of venue.
- A V3 asset and an Aerodrome asset in the same basket cannot have
  mismatched floor computation semantics.

Rationale: unified formula prevents subtle per-venue discrepancies from
causing router-eligibility inequivalence between basket assets.

### 5. Uniswap V3 path preserved as default

`SwapVenue.UniswapV3` (value `0`) is the default venue. Existing calls to
`addAsset` with three arguments (token, pool, fee) are source-compatible if
the compiler sees a fourth-argument default — but since Solidity does not
support default parameters, the Phase B implementation (#552) will provide
a migration wrapper:

```solidity
function addAsset(address token_, address pool_, uint24 swapFee_) external {
    addAsset(token_, pool_, swapFee_, SwapVenue.UniswapV3);
}
```

This overload preserves backward compatibility for scripts and tests that
call the three-argument form. Internal code uses the four-argument form.

### 6. `addAsset` venue-selection parameter: summary

| Parameter | Type | Required | Meaning |
|-----------|------|----------|---------|
| `token_` | `address` | yes | ERC-20 token address |
| `pool_` | `address` | yes | Primary pool address (venue-specific) |
| `poolParam_` | `uint24` | yes | V3/V4: fee tier (500 / 3000 / 10000). Aerodrome: `0` = volatile pool, `1` = stable pool |
| `venue_` | `SwapVenue` | yes | `UniswapV3` (default) / `UniswapV4` / `Aerodrome` |

`ADMIN_ROLE` chooses the venue based on off-chain liquidity analysis.
The seam doc (`docs/technical/real-four-vault-demo-seams.md` §2) records
the expected venue for each demo asset:

| Asset | Venue | Rationale |
|-------|-------|-----------|
| WETH, cbBTC, wSOL | Uniswap V3 | Deep V3 liquidity on Base |
| JUNO | Uniswap V4 | Primary JUNO/USDC pool is V4 on Base |
| RM | Aerodrome | Primary RM/USDC pool is Aerodrome on Base |

### 7. Scope boundary

This ADR governs the interface decision. The following are **out of scope**:

- Implementing `UniswapV4SwapAdapter.sol` or `AerodromeSwapAdapter.sol`
  (Phase B issue #553).
- Modifying `BasketVault.sol` to use `IBasketSwapAdapter` (Phase B issue #552).
- Any change to `config/dex-pools.json` (will be updated in Phase B/C as
  real pool addresses are confirmed).
- Any Solidity change in this issue.

## Amendment — 2026-10-05: Venue state at launch and the Uniswap V4 restore

Recorded against `impl/core-contracts` (core PR 1505) and the owner
decisions of 2026-10-05 (mainnet plan §2.2, §3.1, §3.5). The per-asset
venue abstraction and the uniform slippage-floor formula stand. The
following facts replace the venue and oracle claims above:

- **As built, the enum is `BasketVault.Venue { V3, V4, Aerodrome }`** and
  `addAsset(token, pool, swapFee, adapter, venue)` takes the adapter
  address directly.
- **The Uniswap V4 adapter was deleted** on PR 1505 in commit
  `11c9bfcd` (S4), together with `IUniswapV4Pool.sol` and
  `IUniswapV4SwapRouter.sol`. `Venue.V4` is kept only as a reserved
  ordinal. The owner decided on 2026-10-05 to **restore the V4 swap
  adapter as a supported venue option**, reversing the earlier "no V4
  adapter" ruling. The restore issue is not yet filed.
- **Every venue accepts only a token/USDC pool.** `addAsset` calls
  `BasketAssetConfigGuard.requirePoolUsable`, which reverts
  `PoolTokenMismatch` unless the pool pairs the token with USDC, then
  requires cardinality ≥ 2, a successful `observe()` over the 1800 s
  default window, and in-range liquidity ≥ 1e6. A token/WETH pool is
  refused on any venue. No WETH or multi-hop route exists.
- **Production deploy wiring was Uniswap V3 only on 2026-10-05; the 2026-10-08 amendment below adds Uniswap V4.**
  `BasketVaultDeployBase._addAssets` registers every asset with
  `Venue.V3`, through a `UniswapV3SwapAdapter` (rmAGENT, rmRWA) or the
  built-in router path (rmPROTO). `AerodromeSwapAdapter.sol` exists, but
  no deploy script registers it.
- **The §6 venue table is superseded for RM and JUNO.** RM's deepest
  pool is now Uniswap V4 RM/WETH, which `addAsset` refuses; RM's venue is
  decided (owner, 2026-10-06): the existing V3 RM/USDC pool
  `0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882` (fee 10000), funded by the
  owner before the mainnet run (see the
  [ADR-0001](ADR-0001-mvp-agent-token-shortlist.md) amendment). The V4
  adapter restore is a later option, not a launch blocker. JUNO is not in
  the launch shortlist; a V4 venue for it depends on the restore.

**Open verification item for the later V4 restore (not a decided fact;
not a launch blocker since 2026-10-06). RESOLVED by the 2026-10-08 amendment below.** The
§3 claim that V4 pools expose `observe()` like V3 ("EIP-7680
compatibility") is unverified. Uniswap V4 core keeps
pool state inside the singleton `PoolManager` and records no observation
history, so a V4 TWAP needs a hook that records observations. The
deleted adapter built its `PoolKey` with `hooks: address(0)`, so it could
reach only hookless pools, which have no such history. The restore must
first prove, on a fork, a TWAP source for the chosen V4 RM/USDC pool. It
must also show how `requirePoolUsable`, which reads `token0`, `slot0`,
`observe` and `liquidity` from a pool address, applies to a V4 pool. It
needs a deploy-script change and an audit item.

## Amendment — 2026-10-08: RM on the Uniswap V4 RM/USDC 2.91% pool, the restored V4 swap adapter and the price recorder (core 1676)

Owner decision 2026-10-08 (devops 72). It supersedes the 2026-10-06 RM venue decision above. rmAGENT trades RM on the Uniswap V4 RM/USDC pool
with fee 29100, tickSpacing 582, hooks `0x0` and pool id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391`
(Base PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b`). The owner's words: "It's sufficient for a test on mainnet, not the final
deployment. We have yet to make a successful test." **This is a contained Base mainnet test, not the final deployment.** A stronger price
source, such as a hooked oracle pool, is a later, separate owner decision. The V4 asset position adapter (core 1677) is deferred to the final
deployment. The `IBasketSwapAdapter` seam, the per-asset venue and the slippage-floor formula stand.

**What the restore had to change.** The deleted adapter reverted `UnsupportedFeeTier` for fee 29100, derived tickSpacing from a standard
table (this pool uses 582), called an `exactInputSingle` shape that matches no canonical V4 contract, and read `observe()` and `slot0()` from a
pool address that V4 does not have. `UniswapV4SwapAdapter` is a rewrite against the real PoolManager:

- **Explicit PoolKey.** The adapter is built with the full `PoolKey` (currencies sorted, hooks zero, the fee and tickSpacing as given) and the recorder
  for that key. It requires `keccak256(abi.encode(key))` to equal the recorder's `POOL_ID` and the recorder to sit on the same PoolManager. `swap`
  accepts only the configured token pair and fee. A caller cannot supply a different key.
- **Unlock flow.** `swap` pulls `amountIn` from the caller, pokes the recorder, calls `PoolManager.unlock`, and in `unlockCallback` runs an exact-input
  `PoolManager.swap`, then `sync`, a transfer of the input to the PoolManager, `settle` and `take` of the output to the recipient. The PoolManager reverts
  the unlock if any delta is left. `unlockCallback` answers only the PoolManager and only while a `swap` is open. `swap` is non-reentrant.
- **Bounds.** The caller-chosen deadline is enforced in the adapter. `amountIn` and `minAmountOut` above `uint128` revert. The output floor
  `minAmountOut` is checked against the delta the PoolManager returns. The price limit is the pool edge, so the floor is the slippage bound.
- **Authority.** Any caller may call `swap` (it spends the caller's own approved tokens and holds nothing between calls). `ADMIN_ROLE` pins the
  adapter by codehash (`setAdapterCodeHashAllowed`, ADP-2), and `addAsset` runs the unchanged guard checks.

**The price recorder (`UniswapV4PriceRecorder`).** V3-shaped, so `BasketVault`, `BasketAssetConfigGuard` and `TwapTickMath` read it unchanged (the vault
family has 65 to 107 bytes of EIP-170 headroom, so no vault logic changes). It is registered as the asset's `pool`, with `venue = V4` and
`swapFee = 29100`. It exposes `token0`, `token1`, `fee`, `liquidity` (live, read through the PoolManager `extsload`), `slot0` and `observe`.

- No owner, role or setter. `record()` and `grow()` are permissionless. The adapter pokes before every swap. A keeper may poke too. There is no keeper service.
- At most one snapshot per block timestamp. The constructor records the first tick (cumulative 0). The ring grows to 901 slots (`window / 2 s + 1`).
- **Lagged tick.** As in Uniswap V3 the interval since the last snapshot is weighted by the PREVIOUS recorded tick, so a tick pushed into the pool and
  recorded in block N weighs only the time after block N.
- **Clamp.** The recorded tick moves toward the live pool tick by at most 10 ticks per elapsed second, with elapsed capped at 60 s: one record moves it by at
  most 600 ticks (about 6.2 percent). A flash swap followed by a poke in the same block therefore moves the record by at most 20 to 600 ticks.
- `observe` never reads live spot. `slot0().tick` is live spot for the ORA-4 spot-versus-TWAP deposit guard only.
- **Stale fails closed.** If the last snapshot is older than 1800 s (one window), `observe` reverts `StaleRecorder`. Deposits, USDC redeems and `totalAssets()`
  then revert. `redeemInKind` reads no oracle and still pays the pro-rata RM, so withdrawals are never frozen (ADR-0007, core 1665). Any `record()` call
  makes the recorder fresh again.

**Security bound: pool depth.** A manipulator must move and hold the pool price. The clamp, the lagged tick, the ORA-4 guard and the slippage
floor bound the damage of a short move. A move held across many blocks drags the TWAP at up to 10 ticks per second, and its cost is the pool's depth.
`perDepositCap` and `tvlCap` MUST therefore be sized below the pool's depth. At the 2026-10-08 pin the pool holds in-range liquidity L of about
9.8e17, a virtual USDC reserve of about 1,750 USDC at spot: a deposit moves the price by about `2 x deposit / reserve`. The pool charges 2.91 percent, so the
vault default `maxSlippageBps` of 300 leaves 9 bps for impact. `config/agent-token-shortlist.json` sets `maxSlippageBps` 500 (the vault ceiling), which the
deploy script applies before the handover, leaving 209 bps and a single swap limit of about 18 USDC at that depth. The 8453 caps are an owner action.

**Liquidity floor unit (V4).** The floor for a V4 pool is the pool's in-range liquidity L (`StateView.getLiquidity(poolId)`), a raw `uint128`,
not a USDC amount. It is the same unit as the V3 floor. `BasketVault.addAsset` reads it through `recorder.liquidity()`. The deploy script reads it
through the PoolManager with the configured pool id, and the live config check reads it through StateView.

**Out of scope here.** A tick-clamp or truncated-oracle hardening beyond the clamp above, a hooked oracle pool, an automated keeper, and any WETH or
multi-hop route. The USDC-only pairing rule is unchanged.

## Consequences

**Positive.**

- `BasketVault` can hold assets from any venue without changing core logic.
- Adapters are upgradeable independently of the vault accounting logic.
- Oracle source and slippage floor are consistent across venues, satisfying
  `docs/architecture.md` §8 ("slippage bounds surface before signing").
- The existing V3 path is fully preserved; no existing test or script breaks.
- Phase B issues #552 and #553 have a fully specified interface to implement
  against.

**Negative / accepted risks.**

- The Aerodrome `quote` TWAP is less battle-tested in adversarial settings
  than Uniswap V3 `observe()`. The risk is mitigated by: (a) the same
  `maxSlippageBps` floor applies; (b) `ADMIN_ROLE` chooses venue at
  registration time with off-chain liquidity review; (c) the adapter can be
  replaced if the oracle proves manipulable.
- Adding a fourth `venue_` parameter to `addAsset` requires updating all
  existing scripts and tests that call `addAsset`. The three-argument
  overload mitigates this for existing callers.
- The `swapAdapter` mapping introduces an ADMIN_ROLE trust assumption: a
  malicious or compromised admin could point an adapter at an attacker-
  controlled contract. This is the same trust level as the current
  `SWAP_ROUTER` immutable; it is accepted for the MVP, with the expectation
  that adapters are audited before mainnet registration.

**Out of scope of this decision.**

- TWAP window per-asset governance (already specified in `BasketVault.sol` and
  the existing contract constants `MIN_TWAP_WINDOW` / `MAX_TWAP_WINDOW`).
- Rebalancing model — resolved in ADR-0003 (rebalancing model).
- Slippage-adjusted preview functions — resolved in ADR-0003 (slippage-
  adjusted preview).
- Shortlist governance for AgentTokenVault — separate ADR (issue #546).
- Any oracle source for ProtocolAssetVault assets that already have V3 pools.
