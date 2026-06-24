# BasketVaultHarnessForGuards
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/4b9f1e53ce2923a3a2346fb7de25157672f7633c/contracts/test/ConfusedDeputyGuards.t.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

Concrete BasketVault harness (BasketVault is abstract).


## Functions
### constructor


```solidity
constructor(IERC20 usdc_, ISwapRouter swapRouter_, address admin_, address emergency_)
    BasketVault(
        "GuardHarness",
        "gTEST",
        usdc_,
        swapRouter_,
        type(uint256).max,
        type(uint256).max,
        0, // exitFeeBps
        100, // initialSlippageBps (1%)
        admin_, // feeRecipient
        admin_,
        emergency_
    );
```

### maxAssets


```solidity
function maxAssets() public pure override returns (uint256);
```

