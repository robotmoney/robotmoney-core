# RouterMockVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/9261c12d1be5f94820a0955546db76c69aef496d/contracts/test/GatewayRouter.t.sol)

**Inherits:**
ERC20

Minimal ERC-4626-shaped vault for router integration tests. 1:1 deposit.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## Functions
### constructor


```solidity
constructor(address asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_);
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

