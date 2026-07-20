# MockVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/1a25788704e847c258d9460b66a6534bffb0b77e/contracts/test/EligibilityWeightsInterlock.t.sol)

**Inherits:**
ERC20

Minimal ERC-4626-shaped vault mock exposing `asset()` = USDC, which
is all the router needs to accept it into a weight vector.


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

