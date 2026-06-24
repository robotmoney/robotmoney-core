# Ora3BasketVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/7d568c59b4026ccbeb96c8683b875a28e63a7d18/contracts/test/fv/DeployAssertions.t.sol)

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

