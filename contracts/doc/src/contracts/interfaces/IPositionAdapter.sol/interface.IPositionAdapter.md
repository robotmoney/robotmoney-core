# IPositionAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/06e93a147dd5f250d8cfcca46a9208cf7f648710/contracts/interfaces/IPositionAdapter.sol)

Position-adapter boundary for the unified Vault (ADR-0010). A
superset of the v1 `IStrategyAdapter`: it adds min-out parameters, a
realized-value return on `deploy`, and the `isExact()` /
`USDC()` / `VAULT()` identity views the vault's eligibility probe
requires. Every vault theme (rmUSDC/rmPROTO/rmAGENT/rmRWA) is one
Vault deployment composed with a set of these adapters.

All mutating functions are `onlyVault` inside implementations. The
normative semantics (choreography, floor-composition, sentinel,
clamp-vs-revert, protected-token sets) live in
docs/technical/unified-vault-spec.md §2.2 and are finalized by #1116.


## Functions
### deploy

Convert `usdcIn` USDC (transferred to the adapter first, same
choreography as v1 `_allocateTo`) into the adapter's position.


```solidity
function deploy(uint256 usdcIn, uint256 minValueOut) external returns (uint256 valueAdded);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdcIn`|`uint256`|USDC (6-decimal units) the vault has already `safeTransfer`ed.|
|`minValueOut`|`uint256`|Slippage floor; the adapter MUST revert when the realized USDC-denominated value added is below this (no clamp).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`valueAdded`|`uint256`|USDC-denominated increase in `totalAssets()` from this call. Exact adapters MUST return exactly `usdcIn`.|


### withdraw

Liquidate position back to USDC and deliver it to the vault.


```solidity
function withdraw(uint256 usdcWanted, uint256 minUsdcOut) external returns (uint256 usdcOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdcWanted`|`uint256`|Target USDC; `type(uint256).max` means "withdraw all" (emergency drains, adapter retirement). Clamped at liquidatable balance — shortfall against `usdcWanted` clamps.|
|`minUsdcOut`|`uint256`|Effective floor is `max(minUsdcOut, adapterInternalFloor)`; shortfall against the floor REVERTS. `0` means "adapter's own floor".|

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
function isExact() external view returns (bool);
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


### USDC

The USDC token address this adapter denominates in. Consumed
unchanged by the vault's `_isAdapterEligible` asset-match probe.


```solidity
function USDC() external view returns (address);
```

### VAULT

The single vault this adapter is bound to. Load-bearing identity
binding that prevents cross-vault authority substitution; MUST NOT
be relaxed for adapter reuse (spec §2, ADR-0010 §2).


```solidity
function VAULT() external view returns (address);
```

