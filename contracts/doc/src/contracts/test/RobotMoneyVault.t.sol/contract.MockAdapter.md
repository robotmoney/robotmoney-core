# MockAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/03e3eaf8da3896078274cb45e36fd811b4fed616/contracts/test/RobotMoneyVault.t.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

Holds USDC in the adapter (simulates deployed yield position).
Supports direct "donation" by crediting extra assets without going
through the vault — modelling the Aave / Morpho / Compound donation path.


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
### donatedAmount
Extra USDC credited directly (simulates protocol-level donation).


```solidity
uint256 public donatedAmount
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

### deploy

Receive `amount` USDC from the vault and deploy it into the underlying protocol.


```solidity
function deploy(uint256 amount) external onlyVault;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|Amount of USDC (6-decimal units) to deploy into the protocol.|


### withdraw

Withdraw `amount` USDC from the underlying protocol and return it to the vault.


```solidity
function withdraw(uint256 amount) external onlyVault returns (uint256);
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
function rescueTokens(address, address) external onlyVault;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`address`||
|`<none>`|`address`||


### donateFromAttacker

Simulate a protocol-level donation: credits USDC directly to the adapter
without going through the vault (models Aave `supply(onBehalfOf=adapter)`,
Morpho `deposit(receiver=adapter)`, or Compound `supply` to adapter).


```solidity
function donateFromAttacker(address attacker, uint256 amount) external;
```

## Errors
### OnlyVault

```solidity
error OnlyVault();
```

