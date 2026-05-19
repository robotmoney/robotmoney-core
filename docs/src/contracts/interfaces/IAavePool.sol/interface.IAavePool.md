# IAavePool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75c9d821b281975c99c1bcf5090a766acfe071b0/contracts/interfaces/IAavePool.sol)

Minimal Aave V3 Pool interface used by AaveV3Adapter.


## Functions
### supply

Supply `amount` of `asset` to Aave on behalf of `onBehalfOf`.


```solidity
function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
```

### withdraw

Withdraw `amount` of `asset` from Aave and send to `to`.


```solidity
function withdraw(address asset, uint256 amount, address to) external returns (uint256 actual);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`asset`|`address`||
|`amount`|`uint256`|Use type(uint256).max to withdraw the full aToken balance.|
|`to`|`address`||

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`actual`|`uint256`|The actual amount of underlying asset withdrawn.|


