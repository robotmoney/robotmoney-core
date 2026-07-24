# MigVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/227c9c7cc512f0fdf37c470efb82ef9cefda1bf9/contracts/test/V2MigrationIntegration.t.sol)

**Inherits:**
ERC20

ERC-4626-shaped vault mock supporting the full deposit/redeem cycle
the router drives, plus the `IRetirableVault` deposit-halt hooks the
registry calls on `retire()`/`unretire()`. 1:1 shares. This is the
smallest mock that lets the integration test prove real allocation
(deposit) and real redemption (redeem) — not just view consistency.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## State Variables
### retired
Registry-driven deposit-halt flag (IRetirableVault). Deposits revert
once retired; redemptions are never gated (ADR-0009 withdraw-only).


```solidity
bool public retired
```


## Functions
### constructor


```solidity
constructor(address asset_, string memory sym) ERC20("Mig Vault Shares", sym);
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

### retire

IRetirableVault deposit-halt hooks. Registry-gated in production; the
integration test calls them only through the registry's retire path.


```solidity
function retire() external;
```

### unretire


```solidity
function unretire() external;
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

### redeem


```solidity
function redeem(uint256 shares, address receiver, address owner)
    external
    returns (uint256 assets);
```

