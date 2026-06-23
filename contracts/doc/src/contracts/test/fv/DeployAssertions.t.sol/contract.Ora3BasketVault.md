# Ora3BasketVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/43d1c2f83429ede507d6169930f712ee7dbb8993/contracts/test/fv/DeployAssertions.t.sol)

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

