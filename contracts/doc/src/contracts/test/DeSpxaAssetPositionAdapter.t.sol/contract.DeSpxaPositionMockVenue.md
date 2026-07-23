# DeSpxaPositionMockVenue
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/20a28674ed248f52a2865a2d77d65dc7c7a00bed/contracts/test/DeSpxaAssetPositionAdapter.t.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

Deterministic IBasketSwapAdapter mock standing in for a
`ChronicleOracleAdapter`-shaped venue: a fixed-price USDC<->TOKEN venue
with a configurable execution-slippage haircut. `pool`/`window` are
accepted but ignored (Chronicle pricing is pool- and epoch-independent,
matching the real `ChronicleOracleAdapter.twapPrice`). Pre-funded with
both tokens. TEST FIXTURE.


## Constants
### PRICE
USDC (6-dec) per 1e18 whole TOKEN — mirrors a 5 USD Chronicle NAV mark.


```solidity
uint256 public constant PRICE = 5e6
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


## Functions
### constructor


```solidity
constructor(address usdc_, address token_) ;
```

### setVenueSlippageBps


```solidity
function setVenueSlippageBps(uint256 bps) external;
```

### _quote


```solidity
function _quote(address base, address quote, uint256 amount) internal view returns (uint256);
```

### twapPrice


```solidity
function twapPrice(address, address base, address quote, uint256 amount, uint32)
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
### VenueMinOut

```solidity
error VenueMinOut(uint256 got, uint256 want);
```

### BadPair

```solidity
error BadPair();
```

