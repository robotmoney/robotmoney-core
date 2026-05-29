# CompoundV3Adapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d46930cf8672ef941b507edf186b49886ff48c8a/contracts/adapters/CompoundV3Adapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
CompoundV3Adapter

Strategy adapter that supplies USDC to Compound V3 (Comet) on Base.

Compound V3 is non-ERC-4626. The Comet contract is itself the cUSDCv3 token.
`supply` always credits msg.sender. `withdraw` always sends to msg.sender.
So this adapter must FORWARD withdrawn USDC to the vault.
`COMET.balanceOf(account)` returns live underlying USDC with interest applied.
Deployed: 0x8247da22a59fce074c102431048d0ce7294c2652 (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun, viaIR=true


## Constants
### USDC
USDC token address used for deposits and withdrawals.


```solidity
IERC20 public immutable USDC
```


### COMET
Compound V3 (Comet) contract; also the cUSDCv3 share token.


```solidity
IComet public immutable COMET
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
constructor(address comet_, address usdc_, address vault_) ;
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
`Comet.withdrawTo` returned fewer USDC than requested.


```solidity
error WithdrawShortfall(uint256 requested, uint256 actual);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`requested`|`uint256`|Amount of USDC requested for withdrawal.|
|`actual`|`uint256`|   Amount of USDC actually received from Compound.|

### CannotRescueProtectedToken
`rescueToken` refused — the token is USDC or the Comet share (protected vault assets).


```solidity
error CannotRescueProtectedToken();
```

