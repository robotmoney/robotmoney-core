# ShortfallMorphoVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/6aebcae7361098e1770e9b79c53f0125f87edaa3/contracts/test/MorphoAdapter.t.sol)

**Inherits:**
[MockMorphoVault](/contracts/test/MorphoAdapter.t.sol/contract.MockMorphoVault.md)

Vault that delivers fewer USDC than requested on withdraw (simulates shortfall).


## State Variables
### shortfall

```solidity
uint256 public shortfall
```


## Functions
### constructor


```solidity
constructor(address asset_, uint256 shortfall_) MockMorphoVault(asset_);
```

### withdraw


```solidity
function withdraw(uint256 assets, address receiver, address owner)
    external
    override
    returns (uint256 shares);
```

