# BasketVaultHarnessForGuards
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/test/ConfusedDeputyGuards.t.sol)

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

