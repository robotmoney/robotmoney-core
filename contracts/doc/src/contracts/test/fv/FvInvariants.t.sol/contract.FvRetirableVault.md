# FvRetirableVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a1b6b48f865d2de1de96090713e0f0b3ad707db7/contracts/test/fv/FvInvariants.t.sol)

**Inherits:**
ERC20

Minimal USDC-backed ERC-4626-shaped vault for the router-deposit FV
harness, with the registry-driven `retire()`/`unretire()` deposit-halt
legs so `VaultRegistry.setVaultStatus` can keep the vault flag in sync
(LIFE-1). 1:1 share accounting. `retire()`/`unretire()` are restricted to
the linked registry, mirroring `RobotMoneyVault`'s narrow authority.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


### registry

```solidity
address public immutable registry
```


## State Variables
### retired

```solidity
bool public retired
```


## Functions
### constructor


```solidity
constructor(address asset_, address registry_) ERC20("FV Vault Shares", "FVVS");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### asset


```solidity
function asset() external view returns (address);
```

### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

### previewDeposit


```solidity
function previewDeposit(uint256 assets) external pure returns (uint256);
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

### retire

Deposit-halt leg driven by the registry (LIFE-1). Idempotent.


```solidity
function retire() external;
```

### unretire

Re-open deposits, driven by the registry. Idempotent.


```solidity
function unretire() external;
```

## Errors
### OnlyRegistry

```solidity
error OnlyRegistry();
```

### VaultRetired

```solidity
error VaultRetired();
```

