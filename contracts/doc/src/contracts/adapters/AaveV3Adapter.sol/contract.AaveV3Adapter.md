# AaveV3Adapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e30069c8df8fc8c637d65bc2f991adfaf60a1079/contracts/adapters/AaveV3Adapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
AaveV3Adapter

Strategy adapter that supplies USDC to Aave V3 Pool on Base.

aTokens are rebasing — `A_TOKEN.balanceOf(this)` returns live underlying with accrued interest.
Aave's `Pool.withdraw` sends USDC directly to the `to` address (we pass VAULT) — clean, no hop.
Deployed: 0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun


## Constants
### USDC
USDC token address used for deposits and withdrawals.


```solidity
IERC20 public immutable USDC
```


### A_TOKEN
aBasUSDC rebasing token; `balanceOf(this)` returns live underlying USDC.


```solidity
IERC20 public immutable A_TOKEN
```


### POOL
Aave V3 Pool contract used for `supply` and `withdraw`.


```solidity
IAavePool public immutable POOL
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
constructor(address pool_, address usdc_, address aToken_, address vault_) ;
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

### ZeroAddress
Constructor passed `address(0)` for one of the immutable addresses.


```solidity
error ZeroAddress();
```

### WithdrawShortfall
`Pool.withdraw` returned fewer USDC than requested.


```solidity
error WithdrawShortfall(uint256 requested, uint256 actual);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`requested`|`uint256`|Amount of USDC requested for withdrawal.|
|`actual`|`uint256`|   Amount of USDC actually received from the pool.|

### CannotRescueProtectedToken
`rescueToken` refused — the token is USDC or the aToken (protected vault assets).


```solidity
error CannotRescueProtectedToken();
```

