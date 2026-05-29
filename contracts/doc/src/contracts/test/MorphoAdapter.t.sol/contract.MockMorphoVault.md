# MockMorphoVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/0e0f94d96bb3900f4fd22dd5ae7b5741099dfdba/contracts/test/MorphoAdapter.t.sol)

**Inherits:**
ERC20

Minimal ERC-4626 mock vault that supports both deposit and withdraw.
withdraw() sends `assets` USDC directly to `receiver` (normal behaviour).


## Constants
### asset

```solidity
IERC20 public immutable asset
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Mock Morpho Vault", "mmUSDC");
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

Standard ERC-4626 withdraw: transfer `assets` USDC to `receiver`, burn shares from `owner`.
Returns the number of shares burned (NOT the USDC amount).


```solidity
function withdraw(uint256 assets, address receiver, address owner)
    external
    virtual
    returns (uint256 shares);
```

### balanceOf


```solidity
function balanceOf(address account) public view override returns (uint256);
```

### convertToAssets


```solidity
function convertToAssets(uint256 shares_) external pure returns (uint256);
```

