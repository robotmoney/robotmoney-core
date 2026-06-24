# MockRouterVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/d4e061fc698a91b57b77eff38896e3a0f0dbbbdc/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
ERC20

ERC-4626-shaped vault mock for router tests. 1:1 deposit, previewDeposit returns
1:1 unless `_failOnDeposit` is set.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## State Variables
### failOnDeposit

```solidity
bool public failOnDeposit
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

### setFailOnDeposit


```solidity
function setFailOnDeposit(bool fail) external;
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

### retire

IRetirableVault deposit-halt stubs. MockRouterVault has no registry
link, so these are no-ops that satisfy the interface without reverting.


```solidity
function retire() external;
```

### unretire


```solidity
function unretire() external;
```

### redeem


```solidity
function redeem(uint256 shares, address receiver, address owner)
    external
    returns (uint256 assets);
```

## Events
### Deposit

```solidity
event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
```

