# IComet
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/interfaces/IComet.sol)

Minimal Compound V3 Comet interface used by CompoundV3Adapter.

Comet is not ERC-4626. supply/withdraw always credit/debit msg.sender.
balanceOf returns live underlying USDC including accrued interest.


## Functions
### supply

Supply `amount` of `asset` into Compound V3 (credits msg.sender).


```solidity
function supply(address asset, uint256 amount) external;
```

### withdraw

Withdraw `amount` of `asset` from Compound V3 (sends to msg.sender).


```solidity
function withdraw(address asset, uint256 amount) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`asset`|`address`||
|`amount`|`uint256`|Use type(uint256).max to withdraw the full balance.|


### balanceOf

Live USDC balance of `account` including accrued interest.


```solidity
function balanceOf(address account) external view returns (uint256);
```

