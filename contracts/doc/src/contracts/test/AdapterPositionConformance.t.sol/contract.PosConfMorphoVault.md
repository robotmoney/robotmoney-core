# PosConfMorphoVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/AdapterPositionConformance.t.sol)

**Inherits:**
ERC20

1:1 ERC-4626 mock supporting deposit / withdraw / redeem (the Morpho
retrofit's withdraw-all + over-ask paths drain via `redeem(shares)`).


## Constants
### asset

```solidity
IERC20 public immutable asset
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Pos Morpho", "pmUSDC");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

### withdraw


```solidity
function withdraw(uint256 assets, address receiver, address owner)
    external
    returns (uint256 shares);
```

### redeem


```solidity
function redeem(uint256 shares, address receiver, address owner)
    external
    returns (uint256 assets);
```

### convertToAssets


```solidity
function convertToAssets(uint256 shares_) external pure returns (uint256);
```

