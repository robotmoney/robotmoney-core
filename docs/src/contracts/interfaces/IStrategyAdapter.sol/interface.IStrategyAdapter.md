# IStrategyAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/interfaces/IStrategyAdapter.sol)

Minimal interface every Robot Money strategy adapter must implement.

All mutating functions are restricted to onlyVault inside implementations.


## Functions
### deploy

Receive `amount` USDC from the vault and deploy it into the underlying protocol.


```solidity
function deploy(uint256 amount) external;
```

### withdraw

Withdraw `amount` USDC from the underlying protocol and return it to the vault.


```solidity
function withdraw(uint256 amount) external returns (uint256 actual);
```
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

