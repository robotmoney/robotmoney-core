# AeroPositionMockVenue
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/test/AerodromeAssetPositionAdapter.t.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

Deterministic IBasketSwapAdapter mock: a fixed-price USDC<->TOKEN venue
with a configurable execution-slippage haircut and an optional
expected-window assertion (to prove the adapter threads the configured
TWAP window into pricing). Pre-funded with both tokens. TEST FIXTURE.


## Constants
### PRICE
USDC (6-dec) per 1e18 whole TOKEN.


```solidity
uint256 public constant PRICE = 2000e6
```


### BPS

```solidity
uint256 internal constant BPS = 10_000
```


### USDC

```solidity
address public immutable USDC
```


### TOKEN

```solidity
address public immutable TOKEN
```


## State Variables
### venueSlippageBps

```solidity
uint256 public venueSlippageBps
```


### expectedWindow

```solidity
uint32 public expectedWindow
```


## Functions
### constructor


```solidity
constructor(address usdc_, address token_) ;
```

### setVenueSlippageBps


```solidity
function setVenueSlippageBps(uint256 bps) external;
```

### setExpectedWindow


```solidity
function setExpectedWindow(uint32 window) external;
```

### _quote


```solidity
function _quote(address base, address quote, uint256 amount) internal view returns (uint256);
```

### twapPrice


```solidity
function twapPrice(address, address base, address quote, uint256 amount, uint32 window)
    external
    view
    returns (uint256);
```

### swap


```solidity
function swap(
    address tokenIn,
    address tokenOut,
    uint24,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient,
    uint256
) external returns (uint256 amountOut);
```

## Errors
### WrongWindow

```solidity
error WrongWindow(uint32 got, uint32 want);
```

### VenueMinOut

```solidity
error VenueMinOut(uint256 got, uint256 want);
```

### BadPair

```solidity
error BadPair();
```

