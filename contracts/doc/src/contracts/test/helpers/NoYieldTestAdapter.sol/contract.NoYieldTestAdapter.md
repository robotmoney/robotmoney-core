# NoYieldTestAdapter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/d4e061fc698a91b57b77eff38896e3a0f0dbbbdc/contracts/test/helpers/NoYieldTestAdapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
NoYieldTestAdapter

A test-only, no-yield IStrategyAdapter that simply holds deposited
USDC in this contract with no external protocol calls. It exists
purely to give RobotMoneyVault unit tests a lossless, deterministic
adapter that satisfies the IStrategyAdapter interface without
depending on real Aave/Compound/Morpho protocol state.

Lives under `contracts/test/` so it is NOT part of the production
artifact set (`foundry.toml` `src = "contracts"`, `test =
"contracts/test"`). No interest accrues — `totalAssets()` always
returns the raw USDC balance held by this contract.
This adapter must NEVER be deployed to a live chain — it provides zero
yield and exists only as a unit-test fixture.


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

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (custody invariants INV-1/INV-2). Anyone may
call; the destination is a hardcoded constant, never caller-supplied.
Reverts when `token` is USDC or the adapter's strategy/share token.

USDC (the protected vault asset) cannot be swept. Any other token
accidentally sent to this contract is permissionlessly quarantined.


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

No-yield test adapter holds only raw USDC with no reward tokens —
harvest is a no-op and always succeeds.


```solidity
function harvestRewards() external;
```

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

