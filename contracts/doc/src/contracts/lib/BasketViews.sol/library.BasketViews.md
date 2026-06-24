# BasketViews
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/lib/BasketViews.sol)

**Title:**
BasketViews

Off-chain weight-preview views for `BasketVault`, extracted into an
externally-linked (DELEGATECALL) library so the array-building loops
are NOT inlined into every vault in the already-EIP-170-tight basket
family. Arithmetic is identical to the prior inline implementations.


## Constants
### MAX_BPS

```solidity
uint256 internal constant MAX_BPS = 10_000
```


## Functions
### shortlist

Build the per-asset shortlist (token, pool, fee, active, balance)
for off-chain/rmpc display. Externally linked so the array-building
loop is not inlined into the EIP-170-tight `AgentTokenVault`.


```solidity
function shortlist(IBasketVaultViews vault)
    public
    view
    returns (
        address[] memory tokens,
        address[] memory pools,
        uint24[] memory fees,
        bool[] memory active,
        uint256[] memory balances
    );
```

### checkNavDeviation

ORA-4 / F-10 — revert if any active basket asset's executable
market (slot0 spot) price diverges from its NAV-pricing TWAP
beyond `thresholdBps`. No-op when `thresholdBps` is 0. Externally
linked so the per-asset loop is not inlined into the EIP-170-tight
vault family.


```solidity
function checkNavDeviation(IBasketVaultViews vault, address usdc, uint256 thresholdBps)
    public
    view;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`IBasketVaultViews`|      The basket vault (read surface).|
|`usdc`|`address`|       The quote token (USDC).|
|`thresholdBps`|`uint256`|Max permitted spot-vs-TWAP divergence in bps.|


### previewDepositWeights

Equal-weight cost preview: how `usdcAmount` would be allocated
across active assets at current TWAP prices.


```solidity
function previewDepositWeights(IBasketVaultViews vault, uint256 usdcAmount)
    public
    view
    returns (address[] memory activeAssets, uint256[] memory amountsOut);
```

### _tokenActive

Read only the (token, active) fields of asset `index`, isolating the
6-tuple destructure so the caller loops stay shallow enough to compile
without viaIR.


```solidity
function _tokenActive(IBasketVaultViews vault, uint256 index)
    private
    view
    returns (address token, bool active);
```

### realizedWeights

Per-depositor realized weight vector in basis points.


```solidity
function realizedWeights(IBasketVaultViews vault, address depositor)
    public
    view
    returns (address[] memory activeAssets, uint256[] memory bpsWeights);
```

### _fillRealizedValues

Populate `activeAssets`/`valuesOut` with each active asset's token and
the depositor's pro-rata USDC value; returns the summed value. Split
out of `realizedWeights` to keep both frames shallow (no viaIR).


```solidity
function _fillRealizedValues(
    IBasketVaultViews vault,
    address depositor,
    address[] memory activeAssets,
    uint256[] memory valuesOut
) private view returns (uint256 totalValue);
```

