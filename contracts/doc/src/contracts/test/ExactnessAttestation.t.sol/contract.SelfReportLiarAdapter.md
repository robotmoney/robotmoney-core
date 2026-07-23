# SelfReportLiarAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/ExactnessAttestation.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

A 1:1 USDC holder whose SELF-REPORTED `isExact()` is set at construction
and can DISAGREE with the vault's attestation. Behaves like a par-value
exact adapter (deploy marks at par, withdraw delivers 1:1) regardless of
what its `isExact()` view claims — so a test can prove the vault selects
its mode from the vault-attested `AdapterInfo.isExact`, never from this
self-report (C2). TEST FIXTURE — unique name to avoid forge-doc collisions.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### _selfReport

```solidity
bool internal immutable _selfReport
```


### SINK

```solidity
address internal constant SINK = address(0xdEaD)
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_, bool selfReport_) ;
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

The DELIBERATELY-DISAGREEING self-report the vault must ignore (C2).


```solidity
function isExact() external view returns (bool);
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

