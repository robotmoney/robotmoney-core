# MockPositionAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/IPositionAdapter.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Minimal exact-style `IPositionAdapter` implementation used only to prove
the frozen surface is implementable end-to-end. It is a 1:1 USDC holder
(`isExact() == true`): `deploy` adds exactly `usdcIn`, `withdraw`
clamps at balance, `totalAssets()` is the held USDC balance. It is a
TEST FIXTURE — never a production adapter.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### QUARANTINE
Fixed quarantine sink for swept foreign tokens (INV-1: never
caller-supplied). A test-local constant mirrors the production
`ForeignTokenQuarantine.QUARANTINE` pattern without the dependency.


```solidity
address public constant QUARANTINE = address(0xdead)
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_) ;
```

### onlyVault


```solidity
modifier onlyVault() ;
```

### deploy

Convert `usdcIn` USDC (transferred to the adapter first, same
choreography as v1 `_allocateTo`) into the adapter's position.

`onlyVault` (reverts `OnlyVault`). Also reverts on venue failure,
the oracle staleness/deviation guard (asset adapters), and the
implementation exposure cap (e.g. `MorphoAdapter.maxExposure`).


```solidity
function deploy(uint256 usdcIn, uint256 minValueOut)
    external
    onlyVault
    returns (uint256 valueAdded);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdcIn`|`uint256`|USDC (6-decimal units) the vault has already `safeTransfer`ed.|
|`minValueOut`|`uint256`|Slippage floor; the adapter MUST revert `SlippageExceeded` when the realized USDC-denominated value added is below this (no clamp on the deploy path).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`valueAdded`|`uint256`|USDC-denominated increase in `totalAssets()` from this call. Exact adapters MUST return exactly `usdcIn`.|


### withdraw

Liquidate position back to USDC and deliver it to the vault.

`onlyVault` (reverts `OnlyVault`).


```solidity
function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
    external
    onlyVault
    returns (uint256 usdcOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdcWanted`|`uint256`|Target USDC; `type(uint256).max` means "withdraw all" (emergency drains, adapter retirement). Clamped at liquidatable balance — shortfall against `usdcWanted` clamps.|
|`minUsdcOut`|`uint256`|Effective floor is `max(minUsdcOut, adapterInternalFloor)`; shortfall against the floor REVERTS `SlippageExceeded`. `0` means "adapter's own floor" (not "no floor"). Shortfall against `usdcWanted` above the floor CLAMPS (returns the realized `usdcOut`).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`usdcOut`|`uint256`|Realized USDC delivered to the vault.|


### totalAssets

Live USDC-denominated value of the position (principal + accrued
interest for lending; TWAP/oracle-priced balance for assets).
Spot (`slot0`) is never read here (ORA-1). MAY revert fail-closed
when the price source is unusable; MUST return 0 (without touching
the oracle) on a zero balance (SUP-5).


```solidity
function totalAssets() external view returns (uint256);
```

### isExact

Bytecode-level exactness declaration: `true` iff `deploy`/`withdraw`
are 1:1 and `totalAssets()` is a hard redemption claim (lending),
`false` for slippage-priced asset adapters.

At-registration cross-check + monitoring ONLY — never a per-call
gate. Share-critical paths read the vault-attested
`AdapterInfo.isExact` (spec §2.2, C2).


```solidity
function isExact() external pure returns (bool);
```

### harvestRewards

Permissionlessly claim venue rewards, convert to USDC, and credit
the vault (never a caller-supplied address, INV-1; never stranded,
INV-2). MUST NOT revert when there is nothing to claim.


```solidity
function harvestRewards() external;
```

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (INV-1/INV-2). Protected set: USDC, the venue
receipt/share token, and the custodied basket token — reverts on
those; they stay in NAV and accrue pro-rata.


```solidity
function sweepForeignToken(address token) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to quarantine.|


## Errors
### ZeroAddress

```solidity
error ZeroAddress();
```

### TokenIsProtected

```solidity
error TokenIsProtected(address token);
```

