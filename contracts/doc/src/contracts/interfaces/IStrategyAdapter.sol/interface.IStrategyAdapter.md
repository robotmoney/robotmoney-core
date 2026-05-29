# IStrategyAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/03e3eaf8da3896078274cb45e36fd811b4fed616/contracts/interfaces/IStrategyAdapter.sol)

Minimal interface every Robot Money strategy adapter must implement.

All mutating functions are restricted to onlyVault inside implementations.


## Functions
### deploy

Receive `amount` USDC from the vault and deploy it into the underlying protocol.


```solidity
function deploy(uint256 amount) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|Amount of USDC (6-decimal units) to deploy into the protocol.|


### withdraw

Withdraw `amount` USDC from the underlying protocol and return it to the vault.


```solidity
function withdraw(uint256 amount) external returns (uint256 actual);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|Amount of USDC to withdraw; pass `type(uint256).max` to withdraw all.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`actual`|`uint256`|The amount of USDC actually withdrawn (may be ≤ amount on shortfall).|


### totalAssets

Live USDC value held by this adapter (principal + accrued interest).


```solidity
function totalAssets() external view returns (uint256);
```

### rescueTokens

Rescue non-USDC tokens accidentally sent to this contract.


```solidity
function rescueTokens(address token, address to) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Address of the ERC-20 token to rescue (must not be USDC or the protocol token).|
|`to`|`address`|   Recipient address for the rescued tokens.|


