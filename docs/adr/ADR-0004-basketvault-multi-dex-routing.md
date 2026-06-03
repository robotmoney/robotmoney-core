# ADR-0004: BasketVault multi-DEX routing — per-asset venue abstraction for Aerodrome and Uniswap V4

- **Status:** Accepted
- **Date:** 2026-06-03
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
must hold JUNO and ROBOTMONEY tokens. On Base mainnet:

- **JUNO** — deepest liquidity is on **Uniswap V4**.
- **ROBOTMONEY** — deepest liquidity is on **Aerodrome**.

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
| ROBOTMONEY | Aerodrome | Primary ROBOTMONEY/USDC pool is Aerodrome on Base |

### 7. Scope boundary

This ADR governs the interface decision. The following are **out of scope**:

- Implementing `UniswapV4SwapAdapter.sol` or `AerodromeSwapAdapter.sol`
  (Phase B issue #553).
- Modifying `BasketVault.sol` to use `IBasketSwapAdapter` (Phase B issue #552).
- Any change to `config/dex-pools.json` (will be updated in Phase B/C as
  real pool addresses are confirmed).
- Any Solidity change in this issue.

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
