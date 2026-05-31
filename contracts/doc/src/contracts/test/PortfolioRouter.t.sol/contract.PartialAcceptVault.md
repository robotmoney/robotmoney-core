# PartialAcceptVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cfe094f56f7148155d6999efbd87ac66367ad208/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
ERC20

A misbehaving vault that only accepts half of the legAmount,
leaving the other half stranded in the router. Used to exercise
the UsdcCustodyInvariantViolated post-loop check.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Partial Vault Shares", "PVS");
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

Accepts only half of `assets`, leaving the remainder in the router.


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

## Events
### Deposit

```solidity
event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
```

