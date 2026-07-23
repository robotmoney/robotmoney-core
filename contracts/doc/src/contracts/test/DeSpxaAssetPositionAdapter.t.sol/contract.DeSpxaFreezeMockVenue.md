# DeSpxaFreezeMockVenue
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/20a28674ed248f52a2865a2d77d65dc7c7a00bed/contracts/test/DeSpxaAssetPositionAdapter.t.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

Freeze-aware IBasketSwapAdapter mock: identical pricing/execution to
`DeSpxaPositionMockVenue` but works against the freezable TOKEN fixture.
Its `swap` legitimately reverts (bubbling `TransfersFrozen`) when either
leg moves the frozen token — this IS the expected fail-closed behavior
the freeze test asserts on `deploy`/`withdraw`. TEST FIXTURE.


## Constants
### PRICE

```solidity
uint256 public constant PRICE = 5e6
```


### USDC

```solidity
address public immutable USDC
```


### TOKEN

```solidity
address public immutable TOKEN
```


## Functions
### constructor


```solidity
constructor(address usdc_, address token_) ;
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
### BadPair

```solidity
error BadPair();
```

