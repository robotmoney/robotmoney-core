# Ora3BasketVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/test/fv/DeployAssertions.t.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

Concrete BasketVault to exercise `addAsset` (BasketVault is abstract).


## Functions
### constructor


```solidity
constructor(IERC20 usdc_, ISwapRouter router_, address admin_)
    BasketVault(
        "ORA3 Basket",
        "bORA3",
        usdc_,
        router_,
        type(uint256).max,
        type(uint256).max,
        0,
        30,
        admin_,
        admin_,
        admin_
    );
```

### maxAssets


```solidity
function maxAssets() public pure override returns (uint256);
```

