# ShortfallMorphoVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/test/MorphoAdapter.t.sol)

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

