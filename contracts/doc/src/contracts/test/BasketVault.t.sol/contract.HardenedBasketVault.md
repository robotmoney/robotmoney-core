# HardenedBasketVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/09526bad1d1fc83318c95c5e3ae875b62d6bb960/contracts/test/BasketVault.t.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

Hardened subclass: opts out of the prototype gate after the TWAP
hardening (issue #451) is wired and the subclass author has
certified pool-cardinality and per-asset-window prerequisites
off-chain. Used by the router-eligibility test to prove that a
TWAP-hardened basket vault can become router-eligible while the
base abstract (un-hardened) vault remains gated.


## Functions
### constructor


```solidity
constructor(IERC20 usdc_, ISwapRouter swapRouter_, address admin_)
    BasketVault(
        "Hardened Basket",
        "hBASKET",
        usdc_,
        swapRouter_,
        1_000_000e6,
        100_000e6,
        0,
        100,
        admin_,
        admin_
    );
```

### maxAssets


```solidity
function maxAssets() public pure override returns (uint256);
```

### isPrototype


```solidity
function isPrototype() public pure override returns (bool);
```

