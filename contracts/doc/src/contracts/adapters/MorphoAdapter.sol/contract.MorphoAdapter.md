# MorphoAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/adapters/MorphoAdapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md), [IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

**Title:**
MorphoAdapter

Wraps the Morpho Gauntlet USDC Prime vault on Base.

MORPHO_VAULT is itself an ERC-4626 vault; shares are held by this adapter.
Deployed: 0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9 (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
ADR-0010 retrofit: implements BOTH the v1 `IStrategyAdapter` (still
called by the deployed RobotMoneyVault) and the unified-vault
`IPositionAdapter`. The v2 `deploy`/`withdraw` add min-out slippage
floors and a realized-value return; because Morpho USDC↔share
conversion is treated as exact (1:1 redemption claim), the min-out
checks are trivially satisfied but still enforced (revert
`SlippageExceeded` below the floor). `isExact()` returns true; the vault
attests exactness separately at `addAdapter` (spec §2.2, C2).


## Constants
### MORPHO_VAULT
Morpho Gauntlet USDC Prime ERC-4626 vault address.


```solidity
IERC4626 public immutable MORPHO_VAULT
```


### USDC
USDC token address used for deposits and withdrawals.

Stored as `address` so the auto-generated getter satisfies the
`IPositionAdapter.USDC()` identity view (returns `address`).


```solidity
address public immutable USDC
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


### _deposit

Shared deposit choreography for the v1 and v2 `deploy` entry points.
Enforces the exposure cap, then does the exact-allowance deposit.


```solidity
function _deposit(uint256 amount) private;
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
function totalAssets()
    external
    view
    override(IStrategyAdapter, IPositionAdapter)
    returns (uint256);
```

### isExact

Bytecode-level exactness declaration: `true` iff `deploy`/`withdraw`
are 1:1 and `totalAssets()` is a hard redemption claim (lending),
`false` for slippage-priced asset adapters.

Morpho USDC↔share redemption is treated as exact (1:1 hard claim).
Registration cross-check + monitoring only — never a per-call gate.


```solidity
function isExact() external pure returns (bool);
```

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (INV-1/INV-2). Protected set: USDC, the venue
receipt/share token, and the custodied basket token — reverts on
those; they stay in NAV and accrue pro-rata.


```solidity
function sweepForeignToken(address token)
    external
    override(IStrategyAdapter, IPositionAdapter);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to quarantine.|


### harvestRewards

Permissionlessly claim venue rewards, convert to USDC, and credit
the vault (never a caller-supplied address, INV-1; never stranded,
INV-2). MUST NOT revert when there is nothing to claim.

Morpho Gauntlet USDC Prime yield accrues automatically into the
ERC-4626 share price — there are no discrete claimable reward tokens
on this venue. This function is a no-op and always succeeds.


```solidity
function harvestRewards() external override(IStrategyAdapter, IPositionAdapter);
```

## Errors
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

