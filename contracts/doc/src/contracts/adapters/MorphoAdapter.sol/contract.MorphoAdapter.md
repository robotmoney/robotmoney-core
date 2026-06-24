# MorphoAdapter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/adapters/MorphoAdapter.sol)

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


## State Variables
### maxExposure
Maximum USDC that may be deployed into Morpho at one time.
Zero means uncapped (default). Set via `setMaxExposure`.


```solidity
uint256 public maxExposure
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

### setMaxExposure

Set the governance-configurable per-adapter max-exposure cap.
Only callable by the `VAULT` address.


```solidity
function setMaxExposure(uint256 cap) external onlyVault;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`cap`|`uint256`|Maximum USDC that may be deployed into Morpho at one time. Set to 0 to disable the cap (uncapped, default behavior).|


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

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (custody invariants INV-1/INV-2). Anyone may
call; the destination is a hardcoded constant, never caller-supplied.
Reverts when `token` is USDC or the adapter's strategy/share token.


```solidity
function sweepForeignToken(address token) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Address of the foreign ERC-20 to quarantine.|


### harvestRewards

Claim any underlying-protocol reward tokens and forward them as
USDC to the owning vault (custody invariant INV-2 — no emissions
stranded on the adapter or router). Permissionless: anyone may
trigger the harvest; the destination is always the vault, never a
caller-supplied address (INV-1).

Morpho Gauntlet USDC Prime yield accrues automatically into the
ERC-4626 share price — there are no discrete claimable reward tokens
on this venue. This function is a no-op and always succeeds.


```solidity
function harvestRewards() external;
```

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

### ZeroAddress
Constructor passed `address(0)` for one of the immutable addresses.


```solidity
error ZeroAddress();
```

### ExposureCapExceeded
Proposed deployment would push adapter balance above `maxExposure`.


```solidity
error ExposureCapExceeded(uint256 current, uint256 amount, uint256 cap);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`current`|`uint256`|  Current deployed balance (totalAssets) before this deploy.|
|`amount`|`uint256`|   Amount being deployed.|
|`cap`|`uint256`|      Configured maxExposure cap.|

