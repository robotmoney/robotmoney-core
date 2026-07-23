# CompoundV3Adapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/adapters/CompoundV3Adapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md), [IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

**Title:**
CompoundV3Adapter

Strategy adapter that supplies USDC to Compound V3 (Comet) on Base.

Compound V3 is non-ERC-4626. The Comet contract is itself the cUSDCv3 token.
`supply` always credits msg.sender. `withdraw` always sends to msg.sender.
So this adapter must FORWARD withdrawn USDC to the vault.
`COMET.balanceOf(account)` returns live underlying USDC with interest applied.
Deployed: 0x8247da22a59fce074c102431048d0ce7294c2652 (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun, viaIR=true
ADR-0010 retrofit: implements BOTH the v1 `IStrategyAdapter` (still
called by the deployed RobotMoneyVault) and the unified-vault
`IPositionAdapter`. The v2 `deploy`/`withdraw` add min-out slippage
floors and a realized-value return; Comet USDC supply/redemption is
exact (1:1), so the floors are trivially satisfied but still enforced
(revert `SlippageExceeded` below the floor). `isExact()` returns true.


## Constants
### USDC
USDC token address used for deposits and withdrawals.

Stored as `address` so the auto-generated getter satisfies the
`IPositionAdapter.USDC()` identity view (returns `address`).


```solidity
address public immutable USDC
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

### _supply

Shared supply choreography for the v1 and v2 `deploy` entry points.


```solidity
function _supply(uint256 amount) private;
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

Comet USDC supply/redemption is 1:1 exact. Registration cross-check +
monitoring only — never a per-call gate.


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

Compound V3 (Comet) interest accrues continuously in the principal
balance — there are no discrete claimable reward tokens on the USDC
supply market. This function is a no-op and always succeeds.


```solidity
function harvestRewards() external override(IStrategyAdapter, IPositionAdapter);
```

## Errors
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

