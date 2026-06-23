# MockAdapter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/test/RobotMoneyVault.t.sol)

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


### revertTotalAssets

```solidity
bool public revertTotalAssets
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

### setRevertTotalAssets


```solidity
function setRevertTotalAssets(bool enabled) external;
```

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (custody invariants INV-1/INV-2). Anyone may
call; the destination is a hardcoded constant, never caller-supplied.
Reverts when `token` is USDC or the adapter's strategy/share token.


```solidity
function sweepForeignToken(address) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`address`||


### harvestRewards

Claim any underlying-protocol reward tokens and forward them as
USDC to the owning vault (custody invariant INV-2 — no emissions
stranded on the adapter or router). Permissionless: anyone may
trigger the harvest; the destination is always the vault, never a
caller-supplied address (INV-1).

Adapters that have no on-chain claimable rewards (e.g. Aave
interest accrues automatically in the aToken balance) implement
this as a no-op. Adapters with discrete reward tokens claim them
here, swap to USDC, and credit the vault. This function MUST NOT
revert when there are no rewards to claim.


```solidity
function harvestRewards() external;
```

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

### TotalAssetsUnavailable

```solidity
error TotalAssetsUnavailable();
```

