# UniswapV4AssetPositionAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/590a2c3bf7bb1b2abde217714163eb9576c910c7/contracts/adapters/UniswapV4AssetPositionAdapter.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

**Title:**
UniswapV4AssetPositionAdapter

The Uniswap V4 sibling of `UniswapV3AssetPositionAdapter` (#1118):
the second *inexact* `IPositionAdapter` (ADR-0010 §4). It custodies a
single basket token and makes it look like a yield-bearing position to
the unified Vault. `deploy` swaps USDC→token, `withdraw` swaps
token→USDC (both through the venue-agnostic `IBasketSwapAdapter` seam,
concretely `UniswapV4SwapAdapter`), `totalAssets()` prices the held
token at a configurable TWAP window, and every mutating path is
`onlyVault`. Invariant shape is parity-identical to the V3 adapter
(spec §4.3); the only V4-specific addition is the constructor-time
`hooks == address(0)` assertion (spec §4.5, M-S6).

`isExact()` is hardcoded `false`: `deploy`/`withdraw` are slippage-priced
swaps, and `totalAssets()` is a TWAP mark, NOT a 1:1 redemption claim.
The vault reads its own attested `AdapterInfo.isExact` for share-critical
branches (spec §2.2, C2); this view is registration cross-check +
monitoring only.
Custody invariants (INV-1/INV-2): `harvestRewards()` is a no-op (spot V4
custody has no discrete claimable rewards) and never reverts;
`sweepForeignToken` refuses the protected set (USDC + the custodied
`TOKEN`) and routes everything else to the fixed quarantine sink — never
a caller-supplied recipient, and never the custodied token.
M-S6 (read-only reentrancy, spec §4.5): a V4 pool configured with a
hook exposes a callback edge (`Vault._deposit → deploy → SWAP_ADAPTER →
PoolManager → hook`) that can read this adapter's/the vault's view
surfaces mid-swap, while `totalAssets()` is in a transient
half-swapped state. The constructor closes that edge entirely by
requiring `hooks_ == address(0)` — a hooked pool is un-constructable
as an adapter, matching `UniswapV4SwapAdapter`'s own hardcoded
`hooks: address(0)` PoolKey field.


## Constants
### MAX_BPS

```solidity
uint256 internal constant MAX_BPS = 10_000
```


### MAX_SLIPPAGE_BPS
Hard ceiling for the per-swap slippage tolerance (5%). Mirrors
`BasketVault.MAX_SLIPPAGE_BPS`.


```solidity
uint256 public constant MAX_SLIPPAGE_BPS = 500
```


### MIN_TWAP_WINDOW
TWAP window bounds + default (10 min / 24 h / 30 min), verbatim
from `BasketVault.{MIN,MAX,DEFAULT}_TWAP_WINDOW`.


```solidity
uint32 public constant MIN_TWAP_WINDOW = 600
```


### MAX_TWAP_WINDOW

```solidity
uint32 public constant MAX_TWAP_WINDOW = 86_400
```


### DEFAULT_TWAP_WINDOW

```solidity
uint32 public constant DEFAULT_TWAP_WINDOW = 1_800
```


### MAX_NAV_DEVIATION_BPS
Hard ceiling for `navDeviationGuardBps` (20%), verbatim from
`BasketVault.MAX_NAV_DEVIATION_BPS`.


```solidity
uint256 public constant MAX_NAV_DEVIATION_BPS = 2_000
```


### MIN_POOL_CARDINALITY
Pool-usability floors asserted in the constructor, verbatim from
`BasketVault.{MIN_POOL_CARDINALITY,MIN_POOL_LIQUIDITY}`.


```solidity
uint16 public constant MIN_POOL_CARDINALITY = 2
```


### MIN_POOL_LIQUIDITY

```solidity
uint128 public constant MIN_POOL_LIQUIDITY = 1e6
```


### NAV_DEVIATION_PROBE
Fixed probe amount used only for the ORA-4 spot-vs-TWAP divergence
ratio. Decimals cancel in the |spot − twap|/twap ratio, so the
absolute value is irrelevant as long as it is non-zero.


```solidity
uint256 internal constant NAV_DEVIATION_PROBE = 1e18
```


### ADMIN_ROLE
The `ADMIN_ROLE` bytes32 queried on `VAULT` for config setters.

Matches `BasketVault.ADMIN_ROLE` / `RobotMoneyVault.ADMIN_ROLE`.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### USDC
The USDC token address this adapter denominates in. Consumed
unchanged by the vault's `_isAdapterEligible` asset-match probe.


```solidity
address public immutable USDC
```


### VAULT
The single vault this adapter is bound to. Load-bearing identity
binding that prevents cross-vault authority substitution; MUST NOT
be relaxed for adapter reuse (spec §2, ADR-0010 §2).


```solidity
address public immutable VAULT
```


### TOKEN
The single basket token this adapter custodies and prices.


```solidity
address public immutable TOKEN
```


### POOL
The Uniswap V4 pool pairing `TOKEN` with `USDC` used for TWAP reads
(`observe()`-compatible per EIP-7680, see `IUniswapV4Pool`).


```solidity
address public immutable POOL
```


### SWAP_FEE
Uniswap V4 fee tier for the execution pool (must resolve to `POOL`).


```solidity
uint24 public immutable SWAP_FEE
```


### HOOKS
The V4 pool key's hook contract address. Constructor-asserted
`address(0)` (M-S6) and stored purely for identity/monitoring —
no code path ever calls it.


```solidity
address public immutable HOOKS
```


### SWAP_ADAPTER
Venue executor implementing the `IBasketSwapAdapter` swap+TWAP seam.


```solidity
IBasketSwapAdapter public immutable SWAP_ADAPTER
```


## State Variables
### twapWindow
Per-asset TWAP window in seconds. `0` ⇒ `DEFAULT_TWAP_WINDOW`.


```solidity
uint32 public twapWindow
```


### maxSlippageBps
Per-swap slippage tolerance in bps (the min-out floor). Bounded
above by `MAX_SLIPPAGE_BPS`.


```solidity
uint256 public maxSlippageBps
```


### navDeviationGuardBps
ORA-4 NAV-deviation guard threshold in bps. `0` disables the guard.
Bounded above by `MAX_NAV_DEVIATION_BPS`.


```solidity
uint256 public navDeviationGuardBps
```


## Functions
### onlyVault

Every mutating position path is `onlyVault` (INV-1 authority binding).


```solidity
modifier onlyVault() ;
```

### onlyVaultAdmin

Config setters are gated by the VAULT's transitive `ADMIN_ROLE`; the
adapter carries no independent role tree (seam-map contracts/adapters/).


```solidity
modifier onlyVaultAdmin() ;
```

### constructor

Asserts `hooks_ == address(0)` FIRST (cheapest check, M-S6), then the
pool-usability preconditions (pair match, TWAP cardinality +
observation history over `DEFAULT_TWAP_WINDOW`, in-range liquidity)
via the shared `BasketAssetConfigGuard`, and pins the execution pool
resolved from `swapFee_` to `pool_` (ORA-3).


```solidity
constructor(
    address usdc_,
    address vault_,
    address token_,
    address pool_,
    uint24 swapFee_,
    address hooks_,
    address swapAdapter_
) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdc_`|`address`|       USDC token this adapter denominates in.|
|`vault_`|`address`|      The single vault this adapter is bound to (INV-1).|
|`token_`|`address`|      The basket token custodied and priced.|
|`pool_`|`address`|       The Uniswap V4 pool pairing `token_`/`usdc_` (TWAP source).|
|`swapFee_`|`uint24`|    Uniswap V4 fee tier of the execution pool (ORA-3: resolves to `pool_`).|
|`hooks_`|`address`|      The V4 pool key's hook contract address. MUST be `address(0)` — hooked pools are out of scope/unsafe for this integration (M-S6) and revert construction.|
|`swapAdapter_`|`address`|Venue executor implementing `IBasketSwapAdapter` (concretely `UniswapV4SwapAdapter`, which itself only ever trades hookless pools).|


### deploy

Convert `usdcIn` USDC (transferred to the adapter first, same
choreography as v1 `_allocateTo`) into the adapter's position.

Choreography: the vault has already `safeTransfer`ed `usdcIn` USDC to
this adapter. Guards the entry mark with the ORA-4 NAV-deviation check,
swaps USDC→TOKEN through the venue seam with a TWAP-derived min-out, and
credits the realized USDC-denominated increase in `totalAssets()`.
Reverts `SlippageExceeded` when `valueAdded < minValueOut` (no clamp).


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

Liquidates enough TOKEN to raise `usdcWanted` USDC (TWAP-estimated),
clamped at the held balance (`type(uint256).max` ⇒ sell all). The
effective floor is `max(minUsdcOut, adapterInternalFloor)` where the
internal floor is the slippage-haircut TWAP value of the tokens sold;
shortfall against the floor reverts `SlippageExceeded`, shortfall
against `usdcWanted` above the floor clamps. Proceeds are delivered
straight to `VAULT`.


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

TWAP-priced USDC value of the held TOKEN. Returns 0 on a zero balance
WITHOUT touching the oracle (SUP-5). Spot is never read here (ORA-1):
pricing is the arithmetic-mean-tick TWAP over the configured window,
via the venue seam.


```solidity
function totalAssets() public view returns (uint256);
```

### isExact

Bytecode-level exactness declaration: `true` iff `deploy`/`withdraw`
are 1:1 and `totalAssets()` is a hard redemption claim (lending),
`false` for slippage-priced asset adapters.

Always `false`: swap-priced asset custody is never a 1:1 redemption claim.


```solidity
function isExact() external pure returns (bool);
```

### harvestRewards

Permissionlessly claim venue rewards, convert to USDC, and credit
the vault (never a caller-supplied address, INV-1; never stranded,
INV-2). MUST NOT revert when there is nothing to claim.

Spot Uniswap V4 custody has no discrete claimable reward tokens — this
is a no-op and MUST NOT revert (INV-2). Price appreciation accrues in
the held TOKEN balance and is already reflected in `totalAssets()`.


```solidity
function harvestRewards() external;
```

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (INV-1/INV-2). Protected set: USDC, the venue
receipt/share token, and the custodied basket token — reverts on
those; they stay in NAV and accrue pro-rata.

Protected set: USDC and the custodied `TOKEN` (both stay in NAV and
accrue pro-rata) — reverts on those (INV-2). There is no venue
receipt/share token for spot V4 custody. Everything else is swept
permissionlessly to the fixed quarantine sink (never caller-supplied,
INV-1).


```solidity
function sweepForeignToken(address token) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to quarantine.|


### effectiveTwapWindow

Effective TWAP window: the configured per-asset value or
`DEFAULT_TWAP_WINDOW` when unset. Mirrors
`BasketVault.effectiveTwapWindow`.


```solidity
function effectiveTwapWindow() public view returns (uint32);
```

### setTwapWindow

Set the per-asset TWAP window. Must fall in
`[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.


```solidity
function setTwapWindow(uint32 window) external onlyVaultAdmin;
```

### setMaxSlippageBps

Set the per-swap slippage tolerance (min-out floor). Bounded above
by `MAX_SLIPPAGE_BPS`.


```solidity
function setMaxSlippageBps(uint256 newBps) external onlyVaultAdmin;
```

### setNavDeviationGuardBps

Set the ORA-4 NAV-deviation guard threshold. `0` disables the
guard; any non-zero value must be `<= MAX_NAV_DEVIATION_BPS`.


```solidity
function setNavDeviationGuardBps(uint256 newBps) external onlyVaultAdmin;
```

## Events
### TwapWindowUpdated

```solidity
event TwapWindowUpdated(uint32 oldWindow, uint32 newWindow);
```

### MaxSlippageUpdated

```solidity
event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
```

### NavDeviationGuardUpdated

```solidity
event NavDeviationGuardUpdated(uint256 oldBps, uint256 newBps);
```

### Deployed

```solidity
event Deployed(uint256 usdcIn, uint256 valueAdded);
```

### Withdrawn

```solidity
event Withdrawn(uint256 usdcWanted, uint256 usdcOut);
```

## Errors
### ZeroAddress
A constructor immutable was the zero address.


```solidity
error ZeroAddress();
```

### InvalidParam
A config setter received an out-of-range value.


```solidity
error InvalidParam();
```

### OnlyVaultAdmin
The caller is not the `VAULT`'s ADMIN_ROLE holder (config setters).


```solidity
error OnlyVaultAdmin();
```

### HookedPoolNotSupported
M-S6: the V4 pool key's hooks address was non-zero at construction.
Hooked pools are un-constructable as this adapter (spec §4.5).


```solidity
error HookedPoolNotSupported(address hooks);
```

