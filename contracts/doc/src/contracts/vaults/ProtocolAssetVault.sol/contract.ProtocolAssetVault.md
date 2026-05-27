# ProtocolAssetVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/715cd4b73a878654e7e004c208f153b328046fcf/contracts/vaults/ProtocolAssetVault.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

**Title:**
ProtocolAssetVault

PROTOTYPE ERC-4626 USDC vault holding a basket of protocol assets
(e.g. wETH, cbBTC, wSOL on Base) via Uniswap V3 swaps.
Depositors receive rmPROTO shares representing proportional USDC NAV
across the basket. Shares are redeemable for USDC at any time by swapping
the proportional basket back through Uniswap V3.
Risk label: VOLATILE — basket assets fluctuate against USDC.
Synchronous redemption may fail if swap liquidity is insufficient.
Base mainnet assets (add after deployment):
wETH  0x4200000000000000000000000000000000000006  pool fee 500
cbBTC 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf  pool fee 3000
wSOL  0x1C61629598e4a901136a81BC138E5828dc150d67  pool fee 3000 (verify liquidity)
Base mainnet SwapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481


## Constants
### _MAX_ASSETS

```solidity
uint256 private constant _MAX_ASSETS = 10
```


### _DEFAULT_SLIPPAGE_BPS

```solidity
uint256 private constant _DEFAULT_SLIPPAGE_BPS = 100
```


## Functions
### constructor


```solidity
constructor(
    IERC20 usdc_,
    ISwapRouter swapRouter_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    address feeRecipient_,
    address admin_
)
    BasketVault(
        "Robot Money Protocol",
        "rmPROTO",
        usdc_,
        swapRouter_,
        tvlCap_,
        perDepositCap_,
        exitFeeBps_,
        _DEFAULT_SLIPPAGE_BPS,
        feeRecipient_,
        admin_
    );
```

### maxAssets


```solidity
function maxAssets() public pure override returns (uint256);
```

