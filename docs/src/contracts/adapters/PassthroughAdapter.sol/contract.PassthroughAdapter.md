# PassthroughAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/5f3c3bfe955810832b34a58296a18cb976126c6d/contracts/adapters/PassthroughAdapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
PassthroughAdapter

A no-yield IStrategyAdapter that simply holds deposited USDC in this
contract with no external protocol calls. Intended solely for smoke-test
devnet deployments where real yield adapters (AaveV3, Morpho, etc.) are
unavailable or unnecessary.

This adapter satisfies the IStrategyAdapter interface required by
RobotMoneyVault.addAdapter(). No interest accrues — totalAssets() always
returns the raw USDC balance held by this contract.
Usage: deploy this adapter, then call vault.addAdapter(address(adapter), capBps)
from the ADMIN_ROLE account so the vault routes deposits through it.
This adapter must NOT be used on mainnet — it provides zero yield.


## Constants
### USDC
USDC token address.


```solidity
IERC20 public immutable USDC
```


### VAULT
Address of the RobotMoneyVault that owns this adapter.


```solidity
address public immutable VAULT
```


## Functions
### onlyVault


```solidity
modifier onlyVault() ;
```

### constructor


```solidity
constructor(address usdc_, address vault_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdc_`|`address`| Address of the USDC token (6-decimal ERC-20).|
|`vault_`|`address`|Address of the RobotMoneyVault that owns this adapter.|


### deploy

Receive `amount` USDC from the vault and deploy it into the underlying protocol.

USDC is already transferred to this contract by the vault before
`deploy` is called — nothing further is needed.


```solidity
function deploy(
    uint256 /* amount */
)
    external
    onlyVault;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`||


### withdraw

Withdraw `amount` USDC from the underlying protocol and return it to the vault.

Transfers up to `amount` USDC back to the vault. If the balance
is insufficient, transfers the entire remaining balance.


```solidity
function withdraw(uint256 amount) external onlyVault returns (uint256 actual);
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

USDC cannot be rescued (it is the protected vault asset). Any other
token accidentally sent to this contract may be rescued by the vault.


```solidity
function rescueTokens(address token, address to) external onlyVault;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Address of the ERC-20 token to rescue (must not be USDC or the protocol token).|
|`to`|`address`|   Recipient address for the rescued tokens.|


## Errors
### OnlyVault
Caller is not the configured `VAULT` address.


```solidity
error OnlyVault();
```

### ZeroAddress
Constructor received a zero address.


```solidity
error ZeroAddress();
```

### CannotRescueUsdc
Attempted to rescue USDC (the protected vault asset).


```solidity
error CannotRescueUsdc();
```

