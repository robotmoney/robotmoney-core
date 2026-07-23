# InexactSellAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/UnifiedVault.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Inexact `IPositionAdapter`: a slippage-priced position. It custodies USDC
as its mark (`totalAssets` = held USDC), but a `withdraw` realizes only
`wanted x (1 - haircutBps)` — the haircut is burned to a sink so the mark
drops by the full consumed amount. `deploy` marks at par. `isExact() ==
false`. Never reverts on under-delivery above the floor. TEST FIXTURE.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### haircutBps

```solidity
uint256 public immutable haircutBps
```


### SINK

```solidity
address internal constant SINK = address(0xdEaD)
```


### BPS

```solidity
uint16 internal constant BPS = 10_000
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_, uint256 haircutBps_) ;
```

### onlyVault


```solidity
modifier onlyVault() ;
```

### deploy


```solidity
function deploy(uint256 usdcIn, uint256 minValueOut)
    external
    onlyVault
    returns (uint256 valueAdded);
```

### withdraw


```solidity
function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
    external
    onlyVault
    returns (uint256 usdcOut);
```

### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

### isExact


```solidity
function isExact() external pure returns (bool);
```

### harvestRewards


```solidity
function harvestRewards() external;
```

### sweepForeignToken


```solidity
function sweepForeignToken(address token) external;
```

## Errors
### TokenProtected

```solidity
error TokenProtected();
```

