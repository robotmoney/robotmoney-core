# ThemeRegAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/efa707be563fbb6d1823fd15d523cb09e2f05d55/contracts/test/PerThemeDeploy.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Minimal `IPositionAdapter` fixture bound to a vault, used only to exercise
the deploy-time REGISTRATION path (allowlist + codehash + addAdapter). It
never receives deposits in these tests, so `deploy`/`withdraw`/`totalAssets`
are trivial. `isExact()` is a self-report (constructor-set) that the vault
does NOT read at registration — the attested bool comes from the deploy
script's `AdapterSpec` (spec §5.1, C2). UNIQUE name to avoid forge-doc
re-link collisions with the other suites' fixtures.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### _exact

```solidity
bool internal immutable _exact
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_, bool exact_) ;
```

### deploy


```solidity
function deploy(uint256 usdcIn, uint256) external view returns (uint256);
```

### withdraw


```solidity
function withdraw(uint256, uint256) external view returns (uint256);
```

### totalAssets


```solidity
function totalAssets() external pure returns (uint256);
```

### isExact


```solidity
function isExact() external view returns (bool);
```

### harvestRewards


```solidity
function harvestRewards() external;
```

### sweepForeignToken


```solidity
function sweepForeignToken(address) external;
```

