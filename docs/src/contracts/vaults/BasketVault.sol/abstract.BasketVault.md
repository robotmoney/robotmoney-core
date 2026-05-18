# BasketVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/31a8dcee8651b68de6fb5481acf7c895437acde1/contracts/vaults/BasketVault.sol)

**Inherits:**
ERC4626, AccessControl, Pausable, ReentrancyGuard

**Title:**
BasketVault

Abstract ERC-4626 USDC vault that holds a basket of ERC-20 assets.
Deposits are split equally across active basket assets via Uniswap V3
single-hop swaps. Withdrawals swap each asset back to USDC proportionally.
NAV is denominated in USDC using Uniswap V3 slot0 spot price.
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


### SWAP_ROUTER

```solidity
ISwapRouter public immutable SWAP_ROUTER
```


### _USDC

```solidity
IERC20 internal immutable _USDC
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
    address admin_
) ERC4626(usdc_) ERC20(name_, symbol_);
```

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

USDC value of all held assets (idle USDC + spot-priced basket assets).


```solidity
function totalAssets() public view override returns (uint256);
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

Splits usdcAmount equally across active assets, swapping each portion via Uniswap V3.
The first active asset absorbs any indivisible remainder.


```solidity
function _routeDeposit(uint256 usdcAmount) internal;
```

### previewRedeem

Estimated USDC received when redeeming `shares` (spot-priced, pre-slippage).


```solidity
function previewRedeem(uint256 shares) public view override returns (uint256);
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

### _spotUsdcValue

Returns the USDC value of `tokenAmount` tokens, priced via Uniswap V3 slot0.
PROTOTYPE: slot0 is manipulable. Replace with a TWAP via observe() before production.


```solidity
function _spotUsdcValue(address pool, address token, uint256 tokenAmount)
    internal
    view
    returns (uint256);
```

### _spotTokenValue

Returns the estimated token amount for `usdcAmount` USDC, priced via slot0.


```solidity
function _spotTokenValue(address pool, address token, uint256 usdcAmount)
    internal
    view
    returns (uint256);
```

### _quote

Overflow-safe spot quote using Uniswap V3 pool slot0 sqrtPriceX96.
Mirrors the OracleLibrary getQuoteAtTick ratio math without TickMath dependency.


```solidity
function _quote(address pool, address tokenIn, address tokenOut, uint256 amountIn)
    internal
    view
    returns (uint256 amountOut);
```

### addAsset

Register a new basket asset. Restricted to ADMIN_ROLE.


```solidity
function addAsset(address token_, address pool_, uint24 swapFee_)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token_`|`address`|  ERC-20 token address.|
|`pool_`|`address`|   Uniswap V3 pool pairing `token_` with USDC (either token0 or token1).|
|`swapFee_`|`uint24`|Uniswap V3 fee tier (500, 3000, or 10000).|


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

### emergencyUnwind

Pause and attempt to swap all basket assets back to USDC. Restricted to EMERGENCY_ROLE.


```solidity
function emergencyUnwind() external onlyRole(EMERGENCY_ROLE) nonReentrant;
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

## Events
### AssetAdded

```solidity
event AssetAdded(uint256 indexed index, address indexed token, address pool, uint24 swapFee);
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

## Structs
### AssetInfo

```solidity
struct AssetInfo {
    address token;
    address pool; // Uniswap V3 pool pairing token with USDC
    uint24 swapFee; // Uniswap V3 fee tier for exactInputSingle swaps
    bool active;
}
```

