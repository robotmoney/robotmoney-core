# IBasketVaultViews
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/lib/BasketViews.sol)

Minimal read surface of `BasketVault` consumed by the weight-preview
views. Declared here (not imported from BasketVault) to avoid a cyclic
library↔contract import.


## Functions
### activeAssetCount


```solidity
function activeAssetCount() external view returns (uint256);
```

### assetCount


```solidity
function assetCount() external view returns (uint256);
```

### assets


```solidity
function assets(uint256 index)
    external
    view
    returns (
        address token,
        address pool,
        uint24 swapFee,
        bool active,
        address adapter,
        uint8 venue
    );
```

### assetUsdcValue


```solidity
function assetUsdcValue(uint256 index, uint256 amount) external view returns (uint256);
```

### assetTokenValue


```solidity
function assetTokenValue(uint256 index, uint256 usdcAmount) external view returns (uint256);
```

### balanceOf


```solidity
function balanceOf(address account) external view returns (uint256);
```

### totalSupply


```solidity
function totalSupply() external view returns (uint256);
```

### effectiveTwapWindow


```solidity
function effectiveTwapWindow(address token) external view returns (uint32);
```

