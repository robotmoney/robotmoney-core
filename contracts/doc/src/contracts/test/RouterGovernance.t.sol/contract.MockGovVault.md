# MockGovVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60363b48a75d8bae8417fc6771b479b3f86ed62c/contracts/test/RouterGovernance.t.sol)

**Inherits:**
ERC20

Minimal ERC-4626-shaped vault mock.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Mock Vault Shares", "MVS");
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

