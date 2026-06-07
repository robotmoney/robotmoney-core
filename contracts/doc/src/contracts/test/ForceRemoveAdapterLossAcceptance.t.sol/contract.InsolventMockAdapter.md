# InsolventMockAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/fd1e1fc4dc2a5a456dd5a95f2ef21cdd86bf1dfa/contracts/test/ForceRemoveAdapterLossAcceptance.t.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)


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
### reportedAssets
Simulated insolvent balance — what the adapter reports via
`totalAssets()` even though the funds are gone.


```solidity
uint256 public reportedAssets
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

### setReportedAssets

Set the amount the adapter claims it holds (decoupled from
actual balance to simulate insolvency).


```solidity
function setReportedAssets(uint256 amount) external;
```

### deploy

Receive `amount` USDC from the vault and deploy it into the underlying protocol.


```solidity
function deploy(uint256) external onlyVault;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`||


### withdraw

Withdraw `amount` USDC from the underlying protocol and return it to the vault.


```solidity
function withdraw(uint256) external onlyVault returns (uint256 recovered);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`||

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`recovered`|`uint256`|actual The amount of USDC actually withdrawn (may be ≤ amount on shortfall).|


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


## Errors
### OnlyVault

```solidity
error OnlyVault();
```

