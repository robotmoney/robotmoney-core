# BasketVaultHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/e87e3c25f878d584d0de1f966dcf456f62dad87a/contracts/test/BasketVault.t.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)


## Functions
### constructor


```solidity
constructor(IERC20 usdc_, ISwapRouter swapRouter_, address admin_, address emergencyResponder_)
    BasketVault(
        "Basket Harness",
        "bTEST",
        usdc_,
        swapRouter_,
        1_000_000e6,
        100_000e6,
        0,
        100,
        admin_,
        admin_,
        emergencyResponder_
    );
```

### maxAssets


```solidity
function maxAssets() public pure override returns (uint256);
```

