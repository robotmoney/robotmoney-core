# MarkSpikeAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/NavGrowthLimiter.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Mis-marking `IPositionAdapter` test fixture: it custodies real USDC 1:1
but its self-reported `totalAssets()` is `heldUSDC + phantomMark`, where
`phantomMark` is a test lever (`setPhantomMark`) that inflates the
adapter's mark with NO backing USDC — exactly the ORA-6/F-17
over-mark/mis-scale class the §4.3a limiter defends against. Attested
INEXACT so redemptions take the no-revert `_sellProportional` path;
`withdraw` delivers what it actually holds and NEVER reverts on the floor
(a mis-marking adapter cannot realize its inflated mark — the honest
shortfall, not a fault). UNIQUE name to avoid forge-doc re-link.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### SINK

```solidity
address internal constant SINK = address(0xdEaD)
```


## State Variables
### phantomMark

```solidity
uint256 public phantomMark
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_) ;
```

### onlyVault


```solidity
modifier onlyVault() ;
```

### setPhantomMark

TEST LEVER: inflate the adapter's self-reported NAV without any
backing USDC, simulating an over-mark / mis-scale bug.


```solidity
function setPhantomMark(uint256 mark) external;
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
function withdraw(
    uint256 usdcWanted,
    uint256 /*minUsdcOut*/
)
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

