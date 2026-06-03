# BasketVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/298fe53d078e3114670e9c65d370bad82c79d34b/contracts/vaults/BasketVault.sol)

**Inherits:**
ERC4626, AccessControl, Pausable, ReentrancyGuard

**Title:**
BasketVault

Abstract ERC-4626 USDC vault that holds a basket of ERC-20 assets.
Deposits are split equally across active basket assets via Uniswap V3
single-hop swaps. Withdrawals swap each asset back to USDC proportionally.
NAV is denominated in USDC using a Uniswap V3 TWAP (time-weighted
arithmetic-mean tick) over a per-asset, admin-configurable window.
Subclasses set the vault name/symbol, max basket size, and default slippage.


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE

```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### MAX_EXIT_FEE_BPS

```solidity
uint256 public constant MAX_EXIT_FEE_BPS = 100
```


### MAX_SLIPPAGE_BPS

```solidity
uint256 public constant MAX_SLIPPAGE_BPS = 500
```


### MAX_BPS

```solidity
uint256 public constant MAX_BPS = 10_000
```


### MIN_TWAP_WINDOW
Minimum permitted TWAP window in seconds. Floors the admin's
configuration so a single ADMIN_ROLE write cannot collapse the
oracle to near-spot pricing.


```solidity
uint32 public constant MIN_TWAP_WINDOW = 600
```


### MAX_TWAP_WINDOW
Maximum permitted TWAP window. Caps observation buffer pressure
and keeps NAV responsive on slow-moving assets.


```solidity
uint32 public constant MAX_TWAP_WINDOW = 86_400
```


### DEFAULT_TWAP_WINDOW
Default TWAP window applied when an asset is added before
ADMIN_ROLE has set an explicit per-asset window.


```solidity
uint32 public constant DEFAULT_TWAP_WINDOW = 1_800
```


### SWAP_ROUTER

```solidity
ISwapRouter public immutable SWAP_ROUTER
```


### _USDC

```solidity
IERC20 internal immutable _USDC
```


### MIN_POOL_CARDINALITY
Minimum observation cardinality required on the Uniswap V3 pool
when registering an asset via addAsset(). A cardinality of 1
(the Uniswap deployment default) means observe() can only return
the single stored slot and always reverts with "OLD" for any
non-zero secondsAgo, which would permanently break totalAssets(),
deposits, and withdrawals for the entire basket.


```solidity
uint16 public constant MIN_POOL_CARDINALITY = 2
```


### MIN_POOL_LIQUIDITY
Minimum in-range Uniswap V3 pool liquidity required when
registering an asset via addAsset(). Pools below this floor
cannot absorb vault-sized trades without exceeding the
configured slippage bound, which would leave depositors unable
to exit synchronously — a blocking router-eligibility gap
(basket-vault-gap-report.md §1). Callers must seed pool depth
before calling addAsset.
The value of 1e6 is a conservative floor that rejects completely
empty or dust-seeded pools while being easy for integration tests
to satisfy with a small seed. Production operators are expected
to seed pools well above this floor before activating assets.


```solidity
uint128 public constant MIN_POOL_LIQUIDITY = 1e6
```


## State Variables
### assets

```solidity
AssetInfo[] public assets
```


### tvlCap

```solidity
uint256 public tvlCap
```


### perDepositCap

```solidity
uint256 public perDepositCap
```


### exitFeeBps

```solidity
uint256 public exitFeeBps
```


### feeRecipient

```solidity
address public feeRecipient
```


### maxSlippageBps

```solidity
uint256 public maxSlippageBps
```


### shutdown

```solidity
bool public shutdown
```


### emergencyUnwindGuard

```solidity
mapping(address => EmergencyUnwindGuard) public emergencyUnwindGuard
```


### twapWindow
Per-asset TWAP window in seconds. `0` falls back to
`DEFAULT_TWAP_WINDOW` so newly registered assets are
immediately manipulation-resistant; ADMIN_ROLE may raise the
window per asset within `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.


```solidity
mapping(address => uint32) public twapWindow
```


## Functions
### constructor


```solidity
constructor(
    string memory name_,
    string memory symbol_,
    IERC20 usdc_,
    ISwapRouter swapRouter_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    uint256 initialSlippageBps_,
    address feeRecipient_,
    address admin_,
    address emergencyResponder_
) ERC4626(usdc_) ERC20(name_, symbol_);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`name_`|`string`||
|`symbol_`|`string`||
|`usdc_`|`IERC20`||
|`swapRouter_`|`ISwapRouter`||
|`tvlCap_`|`uint256`||
|`perDepositCap_`|`uint256`||
|`exitFeeBps_`|`uint256`||
|`initialSlippageBps_`|`uint256`||
|`feeRecipient_`|`address`||
|`admin_`|`address`|             Receives ADMIN_ROLE (cold/multisig key for parameter changes). Must not be address(0).|
|`emergencyResponder_`|`address`|Receives EMERGENCY_ROLE (hot key for rapid unwind/shutdown). Must not be address(0). May equal admin_ as a conscious choice (e.g. in test environments), but operators SHOULD use distinct addresses in production so a single key compromise cannot both alter parameters and trigger an emergency unwind.|


### maxAssets

Subclasses declare the maximum number of assets in the basket.


```solidity
function maxAssets() public view virtual returns (uint256);
```

### decimals


```solidity
function decimals() public pure override(ERC4626) returns (uint8);
```

### _decimalsOffset


```solidity
function _decimalsOffset() internal pure override returns (uint8);
```

### totalAssets

USDC value of all held assets (idle USDC + TWAP-priced basket assets).

Marked `virtual` so subclasses (e.g. RwaVault) can inject oracle-freshness
checks before delegating to this base implementation.


```solidity
function totalAssets() public view virtual override returns (uint256);
```

### _deposit


```solidity
function _deposit(address caller, address receiver, uint256 usdcAmount, uint256 shares)
    internal
    override
    whenNotPaused
    nonReentrant;
```

### _routeDeposit

Splits usdcAmount equally across active assets, swapping each portion via the
per-asset swap adapter (Aerodrome or Uniswap V3 default).
The first active asset absorbs any indivisible remainder.
Emits a WeightSnapshot event recording the equal-weight allocation applied.


```solidity
function _routeDeposit(address caller, uint256 usdcAmount) internal;
```

### previewRedeem

Worst-case floor of USDC received when redeeming `shares`.
The floor is: TWAP NAV × (1 − maxSlippageBps) × (1 − exitFeeBps).
This satisfies the ERC-4626 guarantee that `redeem(s, ...)` returns
at least `previewRedeem(s)` because:
1. `totalAssets()` is TWAP-priced (not slot0), so NAV is
manipulation-resistant.
2. `maxSlippageBps` is the worst-case slippage passed as
`amountOutMinimum` to the Uniswap V3 router. Actual swap
proceeds are always ≥ that floor (or the swap reverts).
3. The exit fee is deducted on the same proceeds in `_withdraw`.
Documented as a floor, not an exact quote — actual proceeds will
typically exceed this value when swap depth is healthy.
See docs/technical/basket-vault-gap-report.md §3, §5.


```solidity
function previewRedeem(uint256 shares) public view override returns (uint256);
```

### previewDeposit

Worst-case shares estimate for a deposit of `assets_` USDC.
The floor is computed by discounting the deposited USDC by
`maxSlippageBps` before converting to shares. This reflects that
the Uniswap V3 router guarantees at least
`amountOutMinimum = TWAP × (1 − maxSlippageBps)` tokens will be
acquired per leg. The resulting share count represents the minimum
shares a depositor can expect; actual shares may be higher when
swap depth is healthy.
Documented as a floor, not an exact quote.
See docs/technical/basket-vault-gap-report.md §3.


```solidity
function previewDeposit(uint256 assets_) public view override returns (uint256);
```

### previewWithdraw

Estimated shares required to receive `assets_` net USDC (spot-priced, pre-slippage).


```solidity
function previewWithdraw(uint256 assets_) public view override returns (uint256);
```

### _withdraw

Ignores the ERC-4626 `assets` parameter because actual USDC received depends
on swap execution. Users should use `redeem` for this vault type.
Actual net may be lower than `previewRedeem` by up to `maxSlippageBps`.


```solidity
function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256, /* assets — unused; actual determined by swaps */
    uint256 shares
)
    internal
    override
    whenNotPaused
    nonReentrant;
```

### _sellProportional

Sells `shares / supplyBefore` fraction of each active asset and any idle USDC.
Returns total USDC collected (swap proceeds + idle USDC proportion).


```solidity
function _sellProportional(uint256 shares, uint256 supplyBefore)
    internal
    returns (uint256 usdcOut);
```

### _twapUsdcValue

Returns the USDC value of `tokenAmount` tokens, priced via the
adapter's TWAP (or the built-in Uniswap V3 path when adapter is address(0)).


```solidity
function _twapUsdcValue(address pool, address token, address adapter, uint256 tokenAmount)
    internal
    view
    returns (uint256);
```

### _twapTokenValue

Returns the estimated token amount for `usdcAmount` USDC, priced
via the adapter's TWAP (or the built-in Uniswap V3 path when adapter is address(0)).


```solidity
function _twapTokenValue(address pool, address token, address adapter, uint256 usdcAmount)
    internal
    view
    returns (uint256);
```

### effectiveTwapWindow

TWAP-derived window for `token`. Returns the configured
per-asset window or `DEFAULT_TWAP_WINDOW` when unset.

Exposed as a view so off-chain monitors and tests can sanity-check
the effective window without reading the raw mapping fallback.


```solidity
function effectiveTwapWindow(address token) public view returns (uint32);
```

### _twapQuote

Compute the time-weighted-average sqrtPriceX96 for `pool` over the
per-asset window and forward to the shared sqrtPriceX96 ratio math.
The non-USDC asset's window governs the read: when quoting
USDC->token (deposit minimums), the token's window is consulted;
when quoting token->USDC (NAV, withdrawal minimums) the same
window applies.


```solidity
function _twapQuote(address pool, address tokenIn, address tokenOut, uint256 amountIn)
    internal
    view
    returns (uint256 amountOut);
```

### addAsset

Register a new basket asset. Restricted to ADMIN_ROLE.

Reverts with InsufficientPoolCardinality when the pool's current
observationCardinality is below MIN_POOL_CARDINALITY. Callers must
invoke pool.increaseObservationCardinalityNext(n) and wait for the
cardinality to be populated before calling addAsset.


```solidity
function addAsset(address token_, address pool_, uint24 swapFee_, address adapter_)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token_`|`address`|   ERC-20 token address.|
|`pool_`|`address`|    DEX pool pairing `token_` with USDC (either token0 or token1). For the Uniswap V3 default path, this is the V3 pool address. For Aerodrome, this is the CL pool address used for TWAP reads.|
|`swapFee_`|`uint24`| Fee parameter forwarded to the adapter (Uniswap V3 fee tier; unused by Aerodrome adapters but kept for interface uniformity).|
|`adapter_`|`address`| Swap+TWAP adapter address implementing `IBasketSwapAdapter`. Pass `address(0)` to use the built-in Uniswap V3 default path.|


### removeAsset

Deactivate a basket asset. The vault must hold zero of that token. Restricted to ADMIN_ROLE.


```solidity
function removeAsset(uint256 index) external onlyRole(ADMIN_ROLE);
```

### pause


```solidity
function pause() external onlyRole(EMERGENCY_ROLE);
```

### unpause


```solidity
function unpause() external onlyRole(ADMIN_ROLE);
```

### _pauseIfNotPaused

Pause only when not already paused. Silently no-ops when the
contract is already paused so that the common incident sequence
pause() → emergencyUnwind() does not revert with EnforcedPause.


```solidity
function _pauseIfNotPaused() internal;
```

### emergencyUnwind

Pause and swap all basket assets back to USDC using live TWAP-derived floors.

The effective per-leg floor is max(TWAP-derived, configured minUsdcOut), so the
admin-set value acts as a secondary lower bound while the live TWAP guards against
stale configuration being exploited by a sandwich attacker.
Reverts when any router leg cannot satisfy its effective floor.


```solidity
function emergencyUnwind() external onlyRole(EMERGENCY_ROLE) nonReentrant;
```

### emergencyUnwindWithOverride

Explicit high-risk emergency unwind for tokens whose guard permits overrides.

Emits before each swap so off-chain operators can distinguish override use.
Even on the override path, swap outputs are bounded by an upper-loss
cap derived from the admin-configured `minUsdcOut` reference floor:
`appliedFloor = minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`.
Additionally a live TWAP floor (max(TWAP-derived, appliedFloor)) is applied
as a secondary guard to prevent sandwich exploitation of a stale `minUsdcOut`.
Swaps whose realized USDC output is below the effective floor revert with
`EmergencyUnwindLossCapExceeded`, preventing catastrophic loss even when
override is enabled.


```solidity
function emergencyUnwindWithOverride(address[] calldata tokens)
    external
    onlyRole(EMERGENCY_ROLE)
    nonReentrant;
```

### shutdownVault


```solidity
function shutdownVault() external onlyRole(EMERGENCY_ROLE);
```

### rescueTokens

Recover accidentally sent ERC-20 tokens (not USDC or basket assets). ADMIN_ROLE.


```solidity
function rescueTokens(address token, address to) external onlyRole(ADMIN_ROLE);
```

### setTvlCap


```solidity
function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### setPerDepositCap


```solidity
function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### setExitFeeBps


```solidity
function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### setFeeRecipient


```solidity
function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE);
```

### setMaxSlippageBps


```solidity
function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### setEmergencyUnwindGuard

Configure per-token minimum USDC output, optional high-risk override
access, and the upper-loss cap that bounds override-path slippage.


```solidity
function setEmergencyUnwindGuard(
    address token,
    uint256 minUsdcOut,
    bool overrideAllowed,
    uint256 maxLossBps
) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|           Active basket asset to configure.|
|`minUsdcOut`|`uint256`|      Admin-set reference floor used as the upper-loss reference on the override path and as the hard minimum on the non-override path.|
|`overrideAllowed`|`bool`| Whether the override path may be invoked at all.|
|`maxLossBps`|`uint256`|      Maximum acceptable loss in basis points versus `minUsdcOut` when the override path executes a swap. Must be <= MAX_BPS. A value of `MAX_BPS` (10_000) reproduces the legacy zero-floor behaviour. ADMIN_ROLE is timelock-gated via the existing ADMIN_ROLE pattern (see `docs/technical/security-model.md`).|


### setTwapWindow

Set the TWAP window in seconds for `token`. ADMIN_ROLE only.

The window must fall inside `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.
ADMIN_ROLE is expected to verify off-chain that the pool's
observation cardinality is large enough to satisfy the requested
window; otherwise NAV / unwind reads will revert with the pool's
`"OLD"` error.


```solidity
function setTwapWindow(address token, uint32 window) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|  Active basket asset to configure.|
|`window`|`uint32`| TWAP window in seconds (10 min ≤ window ≤ 24 h).|


### rebalance

Reserved for Phase B: global vault rebalance.

Not implemented in MVP. Reverts with `NotImplemented()`.
Eventual signature (subject to Phase B ADR):
rebalance(uint256 maxSlippageBps, uint256 deadline)
-> (uint256[] swapAmounts, uint256[] gasEstimates)
See docs/adr/ADR-0003-basketvault-rebalancing-model.md


```solidity
function rebalance(uint256, uint256) external pure;
```

### previewDepositWeights

Pre-execution cost preview: shows how `usdcAmount` would be allocated
across active basket assets at current TWAP prices.
Returns parallel arrays of `(assets, amountsOut)` for active assets only.
This satisfies the cost-preview requirement in docs/architecture.md §8.
See docs/adr/ADR-0003-basketvault-rebalancing-model.md.


```solidity
function previewDepositWeights(uint256 usdcAmount)
    external
    view
    returns (address[] memory activeAssets, uint256[] memory amountsOut);
```

### realizedWeights

Per-depositor realized weight vector.
Returns each active asset's share of the depositor's pro-rata vault
holdings, expressed in basis points (0–10_000), where 10_000 = 100%.
A depositor with no shares gets all-zero weights.
See docs/adr/ADR-0003-basketvault-rebalancing-model.md.


```solidity
function realizedWeights(address depositor)
    external
    view
    returns (address[] memory activeAssets, uint256[] memory bpsWeights);
```

### assetCount


```solidity
function assetCount() external view returns (uint256);
```

### activeAssetCount


```solidity
function activeAssetCount() external view returns (uint256);
```

### isShutdown


```solidity
function isShutdown() external view returns (bool);
```

### _activeAssetCount


```solidity
function _activeAssetCount() internal view returns (uint256 count);
```

### _activeAssetForToken


```solidity
function _activeAssetForToken(address token) internal view returns (AssetInfo memory);
```

### _emergencyUnwindAsset


```solidity
function _emergencyUnwindAsset(AssetInfo memory assetInfo, uint256 minUsdcOut) internal;
```

### _emergencyUnwindAssetWithCap

Override-path swap helper. Passes `appliedFloor` as the router-level
`amountOutMinimum` and additionally enforces the cap with a typed
`EmergencyUnwindLossCapExceeded` revert so off-chain consumers see
a stable error surface regardless of the underlying router's
slippage revert format.


```solidity
function _emergencyUnwindAssetWithCap(AssetInfo memory assetInfo, uint256 appliedFloor)
    internal;
```

### _executeSwap

Routes a swap through the per-asset adapter when set, or falls back
to the immutable Uniswap V3 SWAP_ROUTER.  Centralises approval
management: forceApprove before the call, clear after.


```solidity
function _executeSwap(
    address adapter,
    address tokenIn,
    address tokenOut,
    uint24 fee,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient
) internal returns (uint256 amountOut);
```

## Events
### AssetAdded

```solidity
event AssetAdded(
    uint256 indexed index, address indexed token, address pool, uint24 swapFee, address adapter
);
```

### AssetRemoved

```solidity
event AssetRemoved(uint256 indexed index, address indexed token);
```

### Swapped

```solidity
event Swapped(
    address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
);
```

### ExitFeeCharged

```solidity
event ExitFeeCharged(
    address indexed owner, address indexed receiver, uint256 gross, uint256 fee, uint256 net
);
```

### TvlCapUpdated

```solidity
event TvlCapUpdated(uint256 oldCap, uint256 newCap);
```

### PerDepositCapUpdated

```solidity
event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
```

### ExitFeeUpdated

```solidity
event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
```

### FeeRecipientUpdated

```solidity
event FeeRecipientUpdated(address oldRecipient, address newRecipient);
```

### MaxSlippageUpdated

```solidity
event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
```

### Shutdown

```solidity
event Shutdown();
```

### EmergencyTokenRecovered

```solidity
event EmergencyTokenRecovered(address indexed token, address indexed to, uint256 amount);
```

### EmergencyUnwindGuardSet

```solidity
event EmergencyUnwindGuardSet(
    address indexed token,
    uint256 oldMinUsdcOut,
    uint256 newMinUsdcOut,
    bool overrideAllowed,
    uint256 maxLossBps
);
```

### EmergencyUnwindOverrideUsed
Emitted whenever the override path is exercised. `appliedFloor` is the
`amountOutMinimum` actually passed to the router after the upper-loss
cap was applied, so off-chain operators can audit how much loss
versus `minUsdcOut` the EMERGENCY_ROLE accepted on this swap.


```solidity
event EmergencyUnwindOverrideUsed(
    address indexed token,
    uint256 amountIn,
    uint256 minUsdcOut,
    uint256 appliedFloor,
    address indexed caller
);
```

### TwapWindowUpdated
Emitted when ADMIN_ROLE updates the TWAP window for an asset.
Off-chain monitors can use the delta between `oldWindow` and
`newWindow` to detect governance shortening the oracle window.


```solidity
event TwapWindowUpdated(address indexed token, uint32 oldWindow, uint32 newWindow);
```

### WeightSnapshot
Emitted on every deposit, recording the equal-weight allocation applied
to the depositor's inflow. Satisfies the event-stream cost-disclosure
requirement from docs/architecture.md §8 and ADR-0003.
`bpsWeights` contains the basis-point weight for each element of `assets`
(10_000 / n for each active asset, with the remainder allocated to the first).


```solidity
event WeightSnapshot(
    address indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp
);
```

## Errors
### TVLCapExceeded

```solidity
error TVLCapExceeded();
```

### PerDepositCapExceeded

```solidity
error PerDepositCapExceeded();
```

### ZeroAddress

```solidity
error ZeroAddress();
```

### VaultShutdown

```solidity
error VaultShutdown();
```

### InvalidFee

```solidity
error InvalidFee();
```

### InvalidParam

```solidity
error InvalidParam();
```

### MaxAssetsReached

```solidity
error MaxAssetsReached();
```

### AssetNotFound

```solidity
error AssetNotFound();
```

### AssetStillHeld

```solidity
error AssetStillHeld();
```

### NoActiveAssets

```solidity
error NoActiveAssets();
```

### CannotRescueUsdc

```solidity
error CannotRescueUsdc();
```

### EmergencyUnwindOverrideDisabled

```solidity
error EmergencyUnwindOverrideDisabled();
```

### PoolTokenMismatch

```solidity
error PoolTokenMismatch();
```

### AssetInBasket

```solidity
error AssetInBasket();
```

### EmergencyUnwindLossCapExceeded
Raised when a router swap on the override path returns less USDC than
the upper-loss cap permits. The cap is configured per-token via
`setEmergencyUnwindGuard` and bounds the realized loss versus the
admin-set reference floor `minUsdcOut`.


```solidity
error EmergencyUnwindLossCapExceeded(address token, uint256 received, uint256 appliedFloor);
```

### InvalidTwapWindow
Raised when ADMIN_ROLE attempts to set a TWAP window outside the
`[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]` range. Surfaces a typed error
rather than a generic `InvalidParam` so off-chain governance
tooling can pin-point the failure mode.


```solidity
error InvalidTwapWindow(uint32 window);
```

### NotImplemented
Raised by the `rebalance()` stub. Global vault rebalancing is not
implemented in the MVP. The selector is reserved for Phase B.
See docs/adr/ADR-0003-basketvault-rebalancing-model.md.


```solidity
error NotImplemented();
```

### InsufficientPoolCardinality
Raised by addAsset() when the pool's observation cardinality is
below the minimum required to service TWAP reads over
`DEFAULT_TWAP_WINDOW`. Cardinality=1 (the Uniswap default) means
`observe()` reverts with "OLD" for any non-zero secondsAgo, which
permanently breaks totalAssets(), deposits, and withdrawals for
every asset in the basket. Call
`pool.increaseObservationCardinalityNext(required)` before adding
the asset, then wait until the pool has accumulated enough
observations to cover the full window before depositing.


```solidity
error InsufficientPoolCardinality(address pool, uint16 required, uint16 actual);
```

### InsufficientPoolLiquidity
Raised by addAsset() when the pool's in-range liquidity (as
returned by `IUniswapV3Pool.liquidity()`) is below
`MIN_POOL_LIQUIDITY`. Thin pools cannot guarantee synchronous
withdrawal at the TWAP-derived slippage bound — a core router-
eligibility requirement (gap-report §1). Provide depth before
registering the asset.


```solidity
error InsufficientPoolLiquidity(address pool, uint128 required, uint128 actual);
```

## Structs
### AssetInfo

```solidity
struct AssetInfo {
    address token;
    address pool; // DEX pool pairing token with USDC (venue-specific)
    uint24 swapFee; // Fee parameter forwarded to the adapter (e.g. Uniswap V3 fee tier)
    bool active;
    /// @dev Swap + TWAP adapter for this asset. address(0) falls back to the
    ///      default Uniswap V3 path via SWAP_ROUTER, preserving backward compat.
    address adapter;
}
```

### EmergencyUnwindGuard

```solidity
struct EmergencyUnwindGuard {
    uint256 minUsdcOut;
    bool overrideAllowed;
    // Maximum acceptable loss (in basis points) versus `minUsdcOut` when the
    // override path is used. The override floor is computed as
    // `minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`. A `maxLossBps` of
    // `MAX_BPS` reproduces the legacy zero-floor behaviour; a value of `0`
    // forbids any loss versus the reference floor.
    uint256 maxLossBps;
}
```

