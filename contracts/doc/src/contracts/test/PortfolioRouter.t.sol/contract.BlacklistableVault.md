# BlacklistableVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a2a6d8e4e2a61d93030482a63145fd865f67cc02/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
ERC20

ERC-4626-shaped vault that uses a BlacklistableUSDC instance.
Identical to MockRouterVault but typed to BlacklistableUSDC so the
blacklist test can pass the address check in setWeights / _requireRouterEligible.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Blacklistable Vault Shares", "BVS");
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

## Events
### Deposit

```solidity
event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
```

