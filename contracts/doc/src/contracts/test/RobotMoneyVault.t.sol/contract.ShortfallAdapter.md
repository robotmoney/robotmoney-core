# ShortfallAdapter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/81ebda9fb866d28c4df795b2e6ba65abe2af5e0b/contracts/test/RobotMoneyVault.t.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

Adapter that over-reports `totalAssets` by a configurable phantom amount and
can leak real USDC out, modelling a buggy or lying adapter. Used for the
`_pullProportional` shortfall tests (audit 2026-06-09, L-2).


## Constants
### USDC

```solidity
IERC20 public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


## State Variables
### phantom
Phantom assets added on top of the real balance in `totalAssets()`.


```solidity
uint256 public phantom
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_) ;
```

### setPhantom


```solidity
function setPhantom(uint256 phantom_) external;
```

### leak

Simulate a loss: move real USDC out without adjusting reporting.


```solidity
function leak(address to, uint256 amount) external;
```

### deploy

Receive `amount` USDC from the vault and deploy it into the underlying protocol.


```solidity
function deploy(uint256) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`||


### withdraw

Withdraw `amount` USDC from the underlying protocol and return it to the vault.


```solidity
function withdraw(uint256 amount) external returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|Amount of USDC to withdraw; pass `type(uint256).max` to withdraw all.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`|actual The amount of USDC actually withdrawn (may be ≤ amount on shortfall).|


### totalAssets

Live USDC value held by this adapter (principal + accrued interest).


```solidity
function totalAssets() external view returns (uint256);
```

### rescueTokens

Rescue non-USDC tokens accidentally sent to this contract.


```solidity
function rescueTokens(address, address) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`address`||
|`<none>`|`address`||


