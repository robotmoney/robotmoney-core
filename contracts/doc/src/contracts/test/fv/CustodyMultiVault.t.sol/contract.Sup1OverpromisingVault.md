# Sup1OverpromisingVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/ae9ab040de96dcd5638644fcfb59f6387e80803a/contracts/test/fv/CustodyMultiVault.t.sol)

Intentionally violates SUP-1: one holder can redeem twice the assets.
This test-only double proves the shared predicate is executed, not vacuous.


## Functions
### totalAssets


```solidity
function totalAssets() external pure returns (uint256);
```

### balanceOf


```solidity
function balanceOf(address) external pure returns (uint256);
```

### convertToAssets


```solidity
function convertToAssets(uint256) external pure returns (uint256);
```

