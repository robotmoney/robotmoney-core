# MorphoAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/c43fbb392825b11d010cdb5df06c784303c7dcd7/contracts/adapters/MorphoAdapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
MorphoAdapter

Wraps the Morpho Gauntlet USDC Prime vault on Base.

MORPHO_VAULT is itself an ERC-4626 vault; shares are held by this adapter.
Deployed: 0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9 (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun


## Constants
### MORPHO_VAULT
Morpho Gauntlet USDC Prime ERC-4626 vault address.


```solidity
IERC4626 public immutable MORPHO_VAULT
```


### USDC
USDC token address used for deposits and withdrawals.


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
constructor(address morphoVault_, address usdc_, address vault_) ;
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

### WithdrawShortfall
`MORPHO_VAULT.withdraw` delivered fewer USDC to VAULT than requested.


```solidity
error WithdrawShortfall(uint256 requested, uint256 actual);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`requested`|`uint256`|Amount of USDC requested for withdrawal.|
|`actual`|`uint256`|   Amount of USDC actually received by VAULT.|

### CannotRescueProtectedToken
`rescueToken` refused — the token is USDC or the Morpho vault share (protected vault assets).


```solidity
error CannotRescueProtectedToken();
```

### ZeroAddress
Constructor passed `address(0)` for one of the immutable addresses.


```solidity
error ZeroAddress();
```

