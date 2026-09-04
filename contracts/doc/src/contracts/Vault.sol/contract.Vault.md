# Vault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/2b01a1006295a36fa4f656f7aeda0a98b3de7411/contracts/Vault.sol)

**Inherits:**
ERC4626, [AdminFloorAccessControlCounter](/contracts/lib/AdminFloorAccessControlCounter.sol/abstract.AdminFloorAccessControlCounter.md), ReentrancyGuard

**Title:**
Vault (unified — ADR-0010)

The single ERC-4626 USDC allocator that replaces both vault families.
A pure USDC-in / USDC-out allocator over a registry of
`IPositionAdapter` contracts, running in one of two pinned accounting
modes selected by `allExact()`:
* EXACT mode  (`allExact() == true`):  every active adapter is a 1:1
redemption claim (lending). `withdraw()`/`previewWithdraw()` are
live, drawdown is an assets-proportional pull, the exit fee is
charged on the gross redeemed value, and a per-adapter shortfall
is a fault that reverts `InsufficientAdapterLiquidity`.
* INEXACT mode (`allExact() == false`): at least one active adapter
is slippage-priced (assets). `withdraw()`/`previewWithdraw()`
revert `RedeemOnly`, `maxWithdraw()` is `0`, drawdown is a
no-revert share-proportional sell, and the exit fee is charged on
the realized proceeds.
Deposits mint on the REALIZED NAV delta against the idle-INCLUSIVE OZ
denominator `taBefore − revokedIdle + 1` (SUP-3 / C1 fix), so a
round-trip on a vault holding pre-existing idle USDC can never profit.
This contract owns the vault CORE (issue #1119). Documented insertion
seams are left for the serialized downstream issues that build on it:
the global NAV-growth-rate limiter (#1120), the EMERGENCY-gated
emergency-model refinements (#1121), the `forceRebalance`-only,
composition-blind rebalancing model (#1122, §5.6), and the exactness-
transition timelock + `ExactnessTransition` event (#1123).

Every theme (rmUSDC/rmPROTO/rmAGENT/rmRWA) is one deployment of this
non-abstract contract composed with a set of adapters — never a
subclass. Swap/TWAP code lives entirely on the adapters, so the vault
stays a thin allocator well within the EIP-170 runtime-size limit.


## Constants
### ADMIN_ROLE
Role that manages adapters and sets parameters (TimelockController
in production — INV-3). Self-administered.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE
Role that can pause deposits and perform emergency drains. A
compromised emergency hot key can only halt the ENTRY path (DoS
deposits) and drain adapters into idle — it can never freeze
withdrawals (LIFE-3) nor permanently brick the vault (recovery is
`ADMIN_ROLE`-only, LIFE-4).


```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### MAX_EXIT_FEE_BPS
Absolute ceiling on the exit fee (100 bps = 1%).


```solidity
uint256 public constant MAX_EXIT_FEE_BPS = 100
```


### MAX_ADAPTERS
Maximum number of adapters the vault can hold active at once.


```solidity
uint256 public constant MAX_ADAPTERS = 20
```


### EXACTNESS_TRANSITION_DELAY
Minimum delay an exact→inexact composition-class flip must sit
armed before it can be executed (§5.1, C2 / #1123). Adding the
first inexact adapter to an operating all-exact vault reprices
already-held shares onto the floored preview branch and turns
`withdraw()` into `RedeemOnly` — a SHARE-SEMANTICS change that
may not land in one undelayed call. Mirrors the ≥48h ADMIN
timelock forcing-function so the class flip is announced (the
`ExactnessTransition` event) and can never surprise a holder.


```solidity
uint256 public constant EXACTNESS_TRANSITION_DELAY = 48 hours
```


### MAX_BPS
Basis-points denominator (10 000 = 100%). Narrowed to `uint16`
from `BpsMath.BPS_DENOMINATOR` to preserve call-site arithmetic.


```solidity
uint16 public constant MAX_BPS = uint16(BpsMath.BPS_DENOMINATOR)
```


### NAV_GROWTH_RATE_PERIOD
The reference interval the `maxNavGrowthRateBps` rate is quoted per.
The allowed aggregate-NAV growth budget over an elapsed interval is
`maxNavGrowthRateBps * elapsed / NAV_GROWTH_RATE_PERIOD` bps.


```solidity
uint256 public constant NAV_GROWTH_RATE_PERIOD = 1 hours
```


## State Variables
### adapters
Ordered registry of all adapters (active and inactive).


```solidity
AdapterInfo[] public adapters
```


### maxActiveAdapters
Per-theme cap on how many adapters may be simultaneously `active`
(spec §8, Q7/L4). Distinct from the bytecode `MAX_ADAPTERS` ceiling
on the monotonically-growing `adapters` array: `MAX_ADAPTERS` bounds
total registry entries, `maxActiveAdapters` bounds the ACTIVE subset.
Defaults to `MAX_ADAPTERS` at construction (the rmUSDC/rmPROTO/rmAGENT
common case) and is narrowed post-deploy by `setMaxActiveAdapters`
(ADMIN/timelock) for a theme with a tighter bound — it is the
`RwaVault.maxAssets()==1` single-asset constraint expressed as an
active-adapter-count cap (rmRWA sets `1`). Counting ACTIVE adapters
(not total entries) is load-bearing: it permits the remove-then-add
deSPXA migration under a cap of 1 (drain+deactivate the outgoing
adapter — freeing the active slot — before adding the replacement),
which a total-entry cap would wedge permanently (§8).


```solidity
uint256 public maxActiveAdapters
```


### exactnessTransitionReadyAt
Timestamp at/after which an ADMIN-armed exact→inexact
composition-class flip may be executed for a given adapter (the
earliest `addAdapter(adapter, _, false)` that would flip
`allExact()` true→false is accepted). Zero means unarmed. Set by
`armExactnessTransition`, consumed by `addAdapter` (§5.1, C2).


```solidity
mapping(address adapter => uint64 readyAt) public exactnessTransitionReadyAt
```


### adapterAllowed
Exact adapter instances approved by governance to receive USDC.


```solidity
mapping(address adapter => bool allowed) public adapterAllowed
```


### adapterCodeHashAllowed
Runtime bytecode hashes approved by governance for onboarding.


```solidity
mapping(bytes32 codeHash => bool allowed) public adapterCodeHashAllowed
```


### protectedToken
Governance-mirrored protected-token set (M-S4 / INV-2). Tokens an
adapter custodies that could be donated/mis-sent to the vault and
must never be sweepable. `IPositionAdapter` is frozen without a
`custodiedTokens()` view, so the protected set is maintained by
governance here (spec §5.1 fallback: the governance-mirrored set).


```solidity
mapping(address token => bool protectedFlag) public protectedToken
```


### tvlCap
Maximum total assets under management; deposits revert above this.


```solidity
uint256 public tvlCap
```


### perDepositCap
Maximum USDC a single deposit may contribute.


```solidity
uint256 public perDepositCap
```


### exitFeeBps
Exit fee in basis points charged on withdrawal/redemption.


```solidity
uint256 public exitFeeBps
```


### maxSlippageBps
Worst-case per-leg slippage bound (bps). Bounds the deposit
realized-delta floor, the min-out passed to `adapter.deploy`, the
min-out passed to `adapter.withdraw` in INEXACT mode, and the
INEXACT-mode `previewRedeem`/`previewMint` floors.


```solidity
uint256 public maxSlippageBps
```


### feeRecipient
Recipient of collected exit fees.


```solidity
address public feeRecipient
```


### quarantineAddress
Destination for permissionless foreign-token sweeps (INV-1/INV-2).
Timelock-settable (`ADMIN_ROLE`, INV-3); never caller-supplied.


```solidity
address public quarantineAddress
```


### revokedIdle
USDC recovered into idle from a revoked/excluded adapter (an
ADP-2 exclusion drained via `emergencyWithdrawAdapter` /
`emergencyDrainAndExclude`) and therefore NOT backing counted
shares. Subtracted from the deposit mint denominator so recovered
idle is not repriced onto new depositors. NORMALLY ZERO.

#1121 (emergency-model refinements) owns the full lifecycle of
this accumulator: it is INCREMENTED when a NOT-counted (ADP-2
ineligible) adapter is drained on the EMERGENCY path — the
recovered USDC that was outside NAV becomes idle inside NAV — and
DECREMENTED by `redeployRevokedIdle` when that recovered idle is
routed back into the (healthy) active adapter set. The #1119 core
wired it into the denominator (the C1-correct formula); see
`_deposit`. Draining a still-counted (eligible) adapter leaves it
at zero — those funds already backed shares.


```solidity
uint256 public revokedIdle
```


### maxNavGrowthRateBps
The residual, adapter-INDEPENDENT vault-side price check: a SINGLE
GLOBAL cap on how fast the vault's AGGREGATE `totalAssets()` may
grow between observations, expressed in basis points of the last
checkpoint NAV permitted per `NAV_GROWTH_RATE_PERIOD` of elapsed
time. The allowed budget scales LINEARLY with elapsed time, so long
gaps between deposits widen the permitted aggregate move (§4.3a
checkpoint cadence). Governed by `ADMIN_ROLE` (a deploy-time
parameter, not an intervention).

HONEST LIMIT: this bounds the *speed* of an aggregate mis-mark, not
slow drift. Because the checkpoint is aggregate it cannot identify
*which* adapter moved — it is a deposit circuit-breaker, NOT a
per-adapter drain trigger (localizing a bad adapter is the EMERGENCY
responder's job, §4.4/§5.5). It is defense-in-depth against the
ORA-6/F-17 bug/oracle-fault class, never a substitute for the
codehash-pinning + adapter audit that guards adversarial slow drift.


```solidity
uint256 public maxNavGrowthRateBps
```


### lastNavCheckpoint
The SINGLE vault-wide NAV checkpoint: the last aggregate
`totalAssets()` observed on the deposit path. Zero means the
checkpoint is uninitialized (bootstrapped on the first deposit and
never gated). Deliberately one slot for the WHOLE vault — never one
per adapter, and no governance-registered reference pools (§4.3a).

Written only inside `_deposit` (`totalAssets()` is a `view`), so the
snapshot-compare-update is one storage read/write on the entry path,
not a per-adapter loop. Starts at the zero sentinel until the first
deposit initializes it — a documented seam default, not a bug.


```solidity
uint256 public lastNavCheckpoint
```


### lastNavCheckpointTime
The `block.timestamp` at which `lastNavCheckpoint` was written.


```solidity
uint64 public lastNavCheckpointTime
```


### shutdown
Whether the vault has been permanently shut down (EMERGENCY entry
hard-stop; recoverable only by `ADMIN_ROLE` via `restoreVault`).


```solidity
bool public shutdown
```


### retired
Whether the vault has been retired by the governance `retire()`
lifecycle action (DI-2). Distinct from `shutdown` so the two
deposit-halt paths never alias.


```solidity
bool public retired
```


### registry
Linked `VaultRegistry`; set once by `ADMIN_ROLE`. The only address
allowed to drive `retire()` / `unretire()` (DI-2).


```solidity
address public registry
```


### depositsPaused
When true, new deposits and mints are blocked.


```solidity
bool public depositsPaused
```


### withdrawalsPaused
When true, withdrawals and redeems are blocked. Settable ONLY by
`ADMIN_ROLE` (timelock) — the EMERGENCY hot key can never freeze
withdrawals (LIFE-3).


```solidity
bool public withdrawalsPaused
```


### _lastMintedShares
Actual shares minted by the most recent `_deposit`; surfaced by the
`deposit()` override so `PortfolioRouter.minSharesPerLeg` compares
against reality, not OZ's precomputed preview.


```solidity
uint256 internal _lastMintedShares
```


### _lastWithdrawnAssets
Actual net USDC delivered by the most recent `_withdraw`; surfaced by
the `redeem()` override (AZ-BSK-2).


```solidity
uint256 internal _lastWithdrawnAssets
```


## Functions
### constructor


```solidity
constructor(
    IERC20 asset_,
    string memory name_,
    string memory symbol_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    uint256 maxSlippageBps_,
    uint256 maxNavGrowthRateBps_,
    address feeRecipient_,
    address admin_,
    address emergency_
) ERC4626(asset_) ERC20(name_, symbol_);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`asset_`|`IERC20`|         The USDC token this vault denominates in.|
|`name_`|`string`|          ERC-20 share name (theme-specific, e.g. "Robot Money USDC").|
|`symbol_`|`string`|        ERC-20 share symbol (theme-specific, e.g. "rmUSDC").|
|`tvlCap_`|`uint256`|        Maximum total assets under management (6-decimal USDC).|
|`perDepositCap_`|`uint256`| Maximum single-deposit amount.|
|`exitFeeBps_`|`uint256`|    Exit fee in basis points (≤ `MAX_EXIT_FEE_BPS`).|
|`maxSlippageBps_`|`uint256`|Worst-case per-leg slippage bound (< `MAX_BPS`).|
|`maxNavGrowthRateBps_`|`uint256`|Global aggregate NAV-growth-rate cap in bps of the checkpoint NAV per `NAV_GROWTH_RATE_PERIOD` (§4.3a). The residual vault-side price check; deposit-entry only, never gates redemptions.|
|`feeRecipient_`|`address`|  Recipient of collected exit fees.|
|`admin_`|`address`|         `ADMIN_ROLE` holder (TimelockController in production).|
|`emergency_`|`address`|     `EMERGENCY_ROLE` holder.|


### decimals

Share-token precision, fixed at 6 to match USDC.


```solidity
function decimals() public pure override(ERC4626) returns (uint8);
```

### _decimalsOffset

ERC-4626 virtual-share decimal offset (18) — donation/inflation
resistance. See docs/technical/security-model.md.


```solidity
function _decimalsOffset() internal pure override returns (uint8);
```

### totalAssets

Idle USDC + the sum of every eligible-and-active adapter's
`totalAssets()`. A revoked (ADP-2-excluded) adapter is not counted
(exclusion-not-confiscation; EMERGENCY can still drain it).


```solidity
function totalAssets() public view override returns (uint256 sum);
```

### _isAdapterCounted

An adapter contributes to NAV / receives withdrawal flow only when it
is registered-active AND currently eligible (ADP-2 / F-14).


```solidity
function _isAdapterCounted(uint256 i) internal view returns (bool);
```

### allExact

True iff every ACTIVE adapter's VAULT-ATTESTED `isExact` is true
(never the adapter's self-report). Integrators, the dapp, the
router and rmpc gate `withdraw`-shaped flows on this STATICALLY.
Vacuously true when no adapter is active.

Registry-visible view; `VaultRegistry` SHOULD mirror it so the
router/gateway can gate without a direct vault call (spec §5.1).


```solidity
function allExact() public view returns (bool);
```

### deposit

Override OZ `deposit()` to return the ACTUAL minted share count
(AZ-BSK-2), not OZ's precomputed `previewDeposit`.


```solidity
function deposit(uint256 assets, address receiver) public override returns (uint256);
```

### _deposit

Route-first, mint-on-realized-delta core. The OZ `deposit`/`mint`
entrypoints route here; the `shares` arg OZ precomputed from a
preview is DISCARDED — shares are minted on the REALIZED post-route
NAV delta against the idle-INCLUSIVE denominator (SUP-3 / C1).


```solidity
function _deposit(
    address caller,
    address receiver,
    uint256 assets,
    uint256 /*shares*/
)
    internal
    override
    nonReentrant;
```

### _enforceNavGrowthLimit

The global NAV-growth-rate limiter (§4.3a). Compares the pre-deposit
aggregate NAV (`navBefore`) against the single vault-wide checkpoint
and reverts `NavGrowthRateExceeded` when the aggregate grew faster than
`maxNavGrowthRateBps` per `NAV_GROWTH_RATE_PERIOD` allows since the
checkpoint, then advances the checkpoint to the post-route NAV
(`navAfter`). Entry-side only — this is called ONLY from `_deposit`, so
redemptions are structurally never gated by it. Growth is measured in
bps of the checkpoint NAV so no overflow-prone absolute cap is formed;
NAV DECREASES are never gated (a drop cannot exceed a positive budget).
The zero checkpoint bootstraps on the first deposit without gating.


```solidity
function _enforceNavGrowthLimit(uint256 navBefore, uint256 navAfter) internal;
```

### _routeDeposit

Flat, composition-blind two-pass allocator (§5.6, mirroring
pre-unification `BasketVault._routeDeposit`'s `perAsset = usdcAmount
n` split): pass 1 gives every active+eligible adapter an EQUAL
share of `amount`, capped at its `capBps` headroom; pass 2 spreads
any leftover into adapters that still have headroom. No adapter's
current balance or deviation from target is ever consulted here —
an overweight adapter gets exactly the same equal/capped share as
every other eligible adapter. Ineligible-but-active adapters are
SKIPPED, not reverted (audit L-4); any unrouted remainder stays idle
(counted by `totalAssets`) and emits `UnroutedDeposit`. This is the
ordinary deposit routing entrypoint (also reused by
`redeployRevokedIdle`); `forceRebalance`'s self-funded re-route leg
uses the separate deficit-first `_fillDeficitFirst` instead — no
deficit is ever fixed by an ordinary deposit.


```solidity
function _routeDeposit(uint256 amount) internal returns (uint256 remainingOut);
```

### _spreadCapHeadroom

Shared "pass 2" of both allocators: spread `remaining` USDC into
every active+eligible adapter that still has absolute cap headroom,
in registry order, capping each leg at its headroom, and return the
still-unrouted remainder. Extracted verbatim from the identical
leftover-spread pass `_routeDeposit` and `_fillDeficitFirst` each
carried so the shared loop is coded once (EIP-170 fit — issue #1127).


```solidity
function _spreadCapHeadroom(uint256 remaining, uint256 totalAfter) internal returns (uint256);
```

### _fillDeficitFirst

Deficit-first two-pass allocator: fill toward `min(equal-target,
capBps)` first, then spread leftover into remaining cap headroom.
Ineligible-but-active adapters are SKIPPED, not reverted (audit L-4);
any unrouted remainder stays idle (counted by `totalAssets`) and
emits `UnroutedDeposit`. Used ONLY by `forceRebalance`'s self-funded
re-route leg (§5.6) — its caller pays for realized slippage via the
existing top-up, so it is the one path that may still target the
worst deficit. Ordinary deposit flow never calls this; see
`_routeDeposit` for the composition-blind path ordinary deposits use.


```solidity
function _fillDeficitFirst(uint256 amount) internal returns (uint256 remainingOut);
```

### _allocateTo

Transfer USDC to an eligible adapter and deploy it with the per-leg
slippage floor as min-out (spec §5.2 step 4).


```solidity
function _allocateTo(uint256 i, uint256 amount) internal;
```

### previewDeposit

EXACT sets: OZ floor conversion. INEXACT sets: slippage-discounted
floor (BasketVault semantics).


```solidity
function previewDeposit(uint256 assets) public view override returns (uint256);
```

### previewMint

EXACT sets: OZ ceil conversion. INEXACT sets: ceil gross-up so
`mint()` cannot undercharge relative to `deposit()` (H-1).


```solidity
function previewMint(uint256 shares) public view override returns (uint256);
```

### previewRedeem

EXACT sets: gross minus exit fee. INEXACT sets: the ADR-0007
NAV-haircut floor `gross × (1 − maxSlippageBps) × (1 − exitFeeBps)`.
The fee base differs by composition — integrators MUST branch on
`allExact()` (documented per-composition property, review L-E6).


```solidity
function previewRedeem(uint256 shares) public view override returns (uint256);
```

### previewWithdraw

EXACT sets: shares required for `assets` net (net→gross→shares).
INEXACT sets: reverts `RedeemOnly` (withdraw is redeem-only).


```solidity
function previewWithdraw(uint256 assets) public view override returns (uint256);
```

### maxDeposit


```solidity
function maxDeposit(address) public view override returns (uint256);
```

### maxMint


```solidity
function maxMint(address receiver) public view override returns (uint256);
```

### maxWithdraw

EXACT sets: net-of-fee floor (0 while withdrawals paused). INEXACT
sets: `0` — withdraw is unavailable, so `withdraw(maxWithdraw())`
is a safe no-op and never hits `RedeemOnly` (E-4).


```solidity
function maxWithdraw(address owner) public view override returns (uint256);
```

### maxRedeem

EXACT sets: the owner's share balance (0 while withdrawals paused).
INEXACT sets: `0` (spec §5.1). `maxRedeem` UNDERSTATING the
redeemable amount is ERC-4626-safe; redeem itself stays live via
the `redeem()` override, which caps on the true share balance.


```solidity
function maxRedeem(address owner) public view override returns (uint256);
```

### _grossToNet


```solidity
function _grossToNet(uint256 gross) internal view returns (uint256);
```

### _netToGross


```solidity
function _netToGross(uint256 net) internal view returns (uint256);
```

### withdraw

EXACT sets: standard ERC-4626 withdraw. INEXACT sets: reverts
`RedeemOnly` (except the E-4 `withdraw(maxWithdraw()==0)` no-op).


```solidity
function withdraw(uint256 assets, address receiver, address owner)
    public
    override
    returns (uint256);
```

### redeem

Redeem `shares` for realized proceeds in BOTH modes. Returns the
ACTUAL net USDC delivered (AZ-BSK-2), not `previewRedeem`.

Drives `_withdraw` directly with the TRUE share-balance cap rather
than routing through OZ's `maxRedeem` guard: `maxRedeem()` returns 0
in INEXACT mode for withdraw-safety, which would otherwise brick the
redeem-only exit. `_withdraw` enforces `withdrawalsPaused`.


```solidity
function redeem(uint256 shares, address receiver, address owner)
    public
    override
    returns (uint256);
```

### _withdraw

Two accounting modes gated on the vault-attested `allExact()`. Both
are implemented in full — neither is deferred (H-A2).


```solidity
function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
) internal override nonReentrant;
```

### _withdrawExact

Mode A — EXACT set (carried from `RobotMoneyVault`). Assets-driven
proportional pull, shortfall REVERTS, fee-on-GROSS.


```solidity
function _withdrawExact(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
) internal;
```

### _withdrawInexact

Mode B — INEXACT set (carried from `BasketVault._sellProportional`).
No-revert share-proportional sell, fee-on-REALIZED proceeds.


```solidity
function _withdrawInexact(address caller, address receiver, address owner, uint256 shares)
    internal;
```

### _pullProportional

Source `assetsNeeded` USDC, returning the amount ACTUALLY realized
(idle applied + genuinely pulled). Idle first; then an assets-driven
proportional pass; then a rounding-sweep pass.
`InsufficientAdapterLiquidity` is raised early and on residual
under-delivery. Over-delivery is clamped so surplus stays idle for
all holders. Only eligible-and-active adapters are pulled from (ADP-2).
Proportional-by-balance drawdown (§5.6): composition-blind — every
counted adapter is pulled in proportion to its CURRENT balance, never
by its deviation from target. No surplus is ever fixed by an ordinary
withdrawal; only an explicit `forceRebalance` moves composition.


```solidity
function _pullProportional(uint256 assetsNeeded) internal returns (uint256);
```

### _executePull

Withdraw `amount` (min-out `minOut`) from adapter `i` back to the
vault and emit `Pulled`, returning the realized USDC. Shared by the
exact pull, the inexact sell, and the rebalance surplus-draw so the
withdraw+emit leg is coded once (EIP-170 fit — issue #1127).


```solidity
function _executePull(uint256 i, uint256 amount, uint256 minOut)
    internal
    returns (uint256 received);
```

### _sellProportional

Sell the `shares / supplyBefore` fraction of idle USDC and of each
eligible adapter's position. NO all-or-nothing shortfall revert — an
inexact adapter systematically delivers `realized ≈ wanted ×
(1 − slippage)`; each leg's `minUsdcOut = max(caller floor, adapter
floor)` reverts `SlippageExceeded` only below the floor. Proceeds
accrue as realized; no socialization.
Proportional-by-balance sell (§5.6): composition-blind — each
counted adapter sells the same `shares / supplyBefore` fraction of
its CURRENT balance, never by its deviation from target. No surplus
is ever fixed by an ordinary withdrawal; only an explicit
`forceRebalance` moves composition.


```solidity
function _sellProportional(uint256 shares, uint256 supplyBefore)
    internal
    returns (uint256 usdcOut);
```

### addAdapter

Register a new adapter with a vault-attested exactness flag.

#1123: when this add flips the composition class true→false (the
first inexact adapter on an OPERATING all-exact vault — one with at
least one active adapter), it is a SHARE-SEMANTICS change: it
reprices held shares onto the floored branch and turns `withdraw()`
into `RedeemOnly` for every integrator. That flip may not land in a
single undelayed call — it must first be ARMED via
`armExactnessTransition` and sit for `EXACTNESS_TRANSITION_DELAY`,
and it emits `ExactnessTransition(true, false, adapter_)`. A
same-class add (exact→exact, inexact→inexact) and the empty-vault
bootstrap (no active adapters yet, no holders relying on exact mode)
are unaffected. The class is observable via `allExact()` before/after
the push.


```solidity
function addAdapter(address adapter_, uint16 capBps_, bool isExact_)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`adapter_`|`address`|`IPositionAdapter`-compatible address (allowlisted + codehash-pinned + identity-bound).|
|`capBps_`|`uint16`| Maximum allocation cap in basis points (1–10 000).|
|`isExact_`|`bool`|VAULT-ATTESTED exactness (C2). ADMIN pins this at registration alongside the codehash and allowlist entry; it is immutable on the `AdapterInfo` and is what `allExact()` reads — never `adapter.isExact()` per call.|


### armExactnessTransition

Arm an exact→inexact composition-class flip for `adapter_`
(§5.1, C2 / #1123). Required before `addAdapter(adapter_, _,
false)` can flip an operating all-exact vault out of exact mode.
The armed transition may be executed no earlier than
`block.timestamp + EXACTNESS_TRANSITION_DELAY`, giving holders who
rely on live `withdraw()` an announced window to exit before the
vault becomes `RedeemOnly`. `ADMIN_ROLE` (timelock) only.


```solidity
function armExactnessTransition(address adapter_) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`adapter_`|`address`|The inexact adapter that will be added to flip the class.|


### setAdapterAllowed

Approve or revoke an exact adapter instance for this vault.


```solidity
function setAdapterAllowed(address adapter_, bool allowed_) external onlyRole(ADMIN_ROLE);
```

### setAdapterCodeHashAllowed

Approve or revoke an adapter runtime bytecode hash.


```solidity
function setAdapterCodeHashAllowed(bytes32 codeHash_, bool allowed_)
    external
    onlyRole(ADMIN_ROLE);
```

### removeAdapter

Deactivate an adapter (must hold zero assets).


```solidity
function removeAdapter(uint256 index) external onlyRole(ADMIN_ROLE);
```

### setAdapterCap

Update the allocation cap for an existing adapter.


```solidity
function setAdapterCap(uint256 index, uint16 newCapBps) external onlyRole(ADMIN_ROLE);
```

### setMaxActiveAdapters

Set the per-theme active-adapter-count cap (§8). ADMIN/timelock
only. Bounded to `1..MAX_ADAPTERS` and never below the CURRENT
active-adapter count (tightening can only apply to future adds, it
never silently invalidates already-active adapters). rmRWA narrows
this to `1` at deploy; the default is `MAX_ADAPTERS`.


```solidity
function setMaxActiveAdapters(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### pause

Pause DEPOSITS (entry hard-stop). Withdrawals stay open (LIFE-3).


```solidity
function pause() external onlyRole(EMERGENCY_ROLE);
```

### unpause

Resume deposits. `ADMIN_ROLE` only (trust asymmetry).


```solidity
function unpause() external onlyRole(ADMIN_ROLE);
```

### setWithdrawalsPaused

Set the withdrawal pause. `ADMIN_ROLE` (timelock) ONLY — the
EMERGENCY hot key can never freeze withdrawals (LIFE-3).


```solidity
function setWithdrawalsPaused(bool paused_) external onlyRole(ADMIN_ROLE);
```

### emergencyWithdraw

Pause deposits and drain every active adapter into idle USDC.
`try/catch` so one failed adapter does not block the others.


```solidity
function emergencyWithdraw() external onlyRole(EMERGENCY_ROLE) nonReentrant;
```

### emergencyWithdrawAdapter

Pause deposits and drain a single adapter into idle USDC.


```solidity
function emergencyWithdrawAdapter(uint256 index)
    external
    onlyRole(EMERGENCY_ROLE)
    nonReentrant;
```

### _emergencyDrainToIdle

Best-effort drain of one ACTIVE adapter into idle USDC, shared by
`emergencyWithdraw` (bulk) and `emergencyWithdrawAdapter` (single) so
the try/catch drain + `revokedIdle` credit + event is coded once
(EIP-170 fit — issue #1127). Snapshots counted-status BEFORE draining:
only funds that were NOT in NAV (an ADP-2 ineligible-but-active
adapter) become `revokedIdle`; a still-counted adapter's funds already
backed shares, so nothing is credited. `emitOnEmpty` controls whether a
zero-balance adapter emits a success event (single path) or is silently
skipped (bulk sweep) — preserving each caller's original semantics.


```solidity
function _emergencyDrainToIdle(uint256 index, bool emitOnEmpty) internal;
```

### emergencyDrainAndExclude

Atomic EMERGENCY arm+execute (M-S5): drain AND exclude a set of
adapters in a SINGLE `EMERGENCY_ROLE` action, with no intervening
ADMIN timelock. Each listed adapter is drained best-effort and then
deactivated (excluded from NAV) regardless of whether the drain
reverted — skip-and-continue, so one failing adapter never blocks
the rest. Recovered USDC from a NOT-counted (ADP-2 ineligible)
adapter is credited to `revokedIdle`. Invalid / already-inactive
indices are skipped. Pauses deposits (LIFE-3: withdrawals stay open).


```solidity
function emergencyDrainAndExclude(uint256[] calldata indices)
    external
    onlyRole(EMERGENCY_ROLE)
    nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`indices`|`uint256[]`|The adapter indices to drain and exclude.|


### _creditRevokedIdle

Accumulate `amount` of recovered-but-not-counted USDC into the
`revokedIdle` exclusion. Single writer used by every EMERGENCY drain.


```solidity
function _creditRevokedIdle(uint256 amount) internal;
```

### redeployRevokedIdle

Re-deploy recovered revoked-idle USDC back into the (now-healthy)
active adapter set and DECREMENT `revokedIdle` by the amount that
was actually routed. This is the recovery side of the ADP-2
lifecycle: once governance has registered a trustworthy replacement
adapter, the recovered idle stops being excluded and rejoins the
counted NAV backing new mints. `ADMIN_ROLE` (timelock) — a recovery
action, not an emergency hot-key one. Reverts if `amount` exceeds
the outstanding `revokedIdle`.


```solidity
function redeployRevokedIdle(uint256 amount) external onlyRole(ADMIN_ROLE) nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|The revoked-idle USDC to redeploy (<= `revokedIdle`).|


### forceRebalance

Move composition toward the per-instance target weights at any time
(the ONLY rebalance lever — there is no keeper/scheduled/flow-based
rebalance; ordinary deposits/withdrawals stay composition-blind).
Overweight adapters are drawn down to target and the recovered
USDC is re-routed deficit-first via `_fillDeficitFirst`, the same
mechanism across exact and inexact sets. The call MUST leave
aggregate NAV NON-DECREASING: the caller pre-funds `topUp` USDC
covering realized slippage + fees, or the whole call reverts
(`NavWouldDecrease`). Holders can NEVER lose value to it — on an
exact set the top-up is ~zero (1:1 moves), on an inexact set the
admin pays the swap slippage out of pocket (§5.6).

`ADMIN_ROLE` (timelock) — a discretionary lever, not an emergency one.


```solidity
function forceRebalance(uint256 topUp) external onlyRole(ADMIN_ROLE) nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`topUp`|`uint256`|USDC the caller supplies up front to cover realized cost. Any excess stays as vault NAV (a donation to holders); nothing is refunded, so the caller SHOULD size `topUp` to the expected cost.|


### _drawSurplusToIdle

Withdraw the ABOVE-target surplus of every counted adapter into idle,
returning the USDC actually recovered. Each leg is bounded by the
vault per-swap slippage floor (`minUsdcOut`), the same bound the
redemption paths use — so a thin venue cannot turn a rebalance into a
catastrophic-slippage extraction. Only used by `forceRebalance`.


```solidity
function _drawSurplusToIdle() internal returns (uint256 moved);
```

### forceRemoveAdapter

Force-remove an adapter without withdrawing its assets (last
resort). Assets in the adapter are treated as lost.


```solidity
function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE);
```

### setRegistry

Set the linked `VaultRegistry` once. `ADMIN_ROLE` (timelock).


```solidity
function setRegistry(address newRegistry) external onlyRole(ADMIN_ROLE);
```

### retire

Retire the vault (hard-stop deposits/mints). Registry-only.
Withdrawals/redemptions stay open (ADR-0009).


```solidity
function retire() external;
```

### unretire

Reactivate a retired vault (governance abort). Registry-only.


```solidity
function unretire() external;
```

### shutdownVault

Shut down the vault: set `shutdown` and zero the TVL cap.
`EMERGENCY_ROLE`; recoverable only by `ADMIN_ROLE`.


```solidity
function shutdownVault() external onlyRole(EMERGENCY_ROLE);
```

### restoreVault

Reverse a shutdown and re-open deposits under a fresh TVL cap.
`ADMIN_ROLE`.


```solidity
function restoreVault(uint256 newTvlCap) external onlyRole(ADMIN_ROLE);
```

### setTvlCap


```solidity
function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### setPerDepositCap


```solidity
function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### setExitFeeBps


```solidity
function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### setMaxSlippageBps


```solidity
function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### setMaxNavGrowthRateBps

Update the global NAV-growth-rate cap (§4.3a). A governance
parameter, not an intervention: raising it loosens the residual
price check, lowering it tightens the deposit circuit-breaker. Must
be non-zero (zero would gate every deposit); set very high to make
the limiter effectively inert. Never affects redemptions.


```solidity
function setMaxNavGrowthRateBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### setFeeRecipient


```solidity
function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE);
```

### setQuarantineAddress


```solidity
function setQuarantineAddress(address newAddr) external onlyRole(ADMIN_ROLE);
```

### setProtectedToken

Add or remove a token from the governance-mirrored protected set
(M-S4 / INV-2). A protected token can never be swept — used to
shield adapter-custodied tokens donated/mis-sent to the vault.


```solidity
function setProtectedToken(address token, bool protectedFlag) external onlyRole(ADMIN_ROLE);
```

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the
governed quarantine address (INV-1/INV-2). USDC, the share token,
and any governance-flagged protected token are unsweepable.


```solidity
function sweepForeignToken(address token) external nonReentrant;
```

### _setDepositsPaused


```solidity
function _setDepositsPaused(bool paused_) internal;
```

### _setWithdrawalsPaused


```solidity
function _setWithdrawalsPaused(bool paused_) internal;
```

### _isAdapterEligible

Non-reverting eligibility probe (allowlist + codehash + identity).


```solidity
function _isAdapterEligible(address adapter_) internal view returns (bool);
```

### _requireAdapterEligible


```solidity
function _requireAdapterEligible(address adapter_) internal view;
```

### _requireAdapterCompatible


```solidity
function _requireAdapterCompatible(address adapter_) internal view;
```

### _targetBpsFor


```solidity
function _targetBpsFor() internal view returns (uint256);
```

### _activeAdapterCount


```solidity
function _activeAdapterCount() internal view returns (uint256 count);
```

### paused

Legacy convenience: `depositsPaused || withdrawalsPaused` (M-A4).
Redefined from the old AND semantics so a deposits-only EMERGENCY
pause is not silently masked. Off-chain consumers SHOULD read the
first-class `depositsPaused` / `withdrawalsPaused` views to
distinguish a deposit-halt from a full halt.


```solidity
function paused() external view returns (bool);
```

### adapterCount

Total adapters in the registry (active and inactive).


```solidity
function adapterCount() external view returns (uint256);
```

### isShutdown

Whether the vault has been permanently shut down.


```solidity
function isShutdown() external view returns (bool);
```

### getAdapterInfo

Detailed information about a single adapter entry.


```solidity
function getAdapterInfo(uint256 index)
    external
    view
    returns (
        address adapterAddr,
        uint16 capBps,
        bool active,
        bool isExact,
        uint256 currentBalance,
        uint256 targetBps
    );
```

### getAdapterDrift

Current vs. target balances and signed drift for every adapter —
describes the target allocation the flow tends toward (§5.6).


```solidity
function getAdapterDrift()
    external
    view
    returns (
        uint256[] memory currentBalances,
        uint256[] memory targetBalances,
        int256[] memory drifts
    );
```

### activeAdapterCount

Number of currently active adapters.


```solidity
function activeAdapterCount() external view returns (uint256);
```

### currentTargetBps

Equal-weight target allocation per active adapter in basis points.


```solidity
function currentTargetBps() external view returns (uint256);
```

## Events
### AdapterAdded
Emitted when a new adapter is registered.


```solidity
event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps, bool isExact);
```

### AdapterAllowedSet
Emitted when governance approves or revokes an exact adapter instance.


```solidity
event AdapterAllowedSet(address indexed adapter, bool allowed);
```

### AdapterCodeHashAllowedSet
Emitted when governance approves or revokes an adapter runtime code hash.


```solidity
event AdapterCodeHashAllowedSet(bytes32 indexed codeHash, bool allowed);
```

### AdapterRemoved
Emitted when an adapter is deactivated (normal removal).


```solidity
event AdapterRemoved(uint256 indexed index, address indexed adapter);
```

### AdapterCapUpdated
Emitted when an adapter's allocation cap is updated.


```solidity
event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
```

### AdapterForceRemoved
Emitted when an adapter is force-removed without withdrawing assets.


```solidity
event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
```

### Allocated
Emitted when USDC is allocated from the vault into an adapter.
Byte-identical to the source contracts' `Allocated` (indexer decode).


```solidity
event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
```

### Pulled
Emitted when USDC is pulled from an adapter back to the vault.
Byte-identical to the source contracts' `Pulled`; fires in BOTH
accounting modes (exact pull and inexact sell).


```solidity
event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
```

### ExitFeeCharged
Emitted when an exit fee is charged on a withdrawal/redemption.


```solidity
event ExitFeeCharged(
    address indexed owner,
    address indexed receiver,
    uint256 grossAssets,
    uint256 fee,
    uint256 netAssets
);
```

### TvlCapUpdated
Emitted when the TVL cap is updated.


```solidity
event TvlCapUpdated(uint256 oldCap, uint256 newCap);
```

### PerDepositCapUpdated
Emitted when the per-deposit cap is updated.


```solidity
event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
```

### MaxActiveAdaptersUpdated
Emitted when the active-adapter-count cap is updated (§8).


```solidity
event MaxActiveAdaptersUpdated(uint256 oldCap, uint256 newCap);
```

### ExitFeeUpdated
Emitted when the exit fee is updated.


```solidity
event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
```

### MaxSlippageBpsUpdated
Emitted when the max-slippage bound is updated.


```solidity
event MaxSlippageBpsUpdated(uint256 oldBps, uint256 newBps);
```

### MaxNavGrowthRateBpsUpdated
Emitted when the global NAV-growth-rate cap is updated (§4.3a).


```solidity
event MaxNavGrowthRateBpsUpdated(uint256 oldBps, uint256 newBps);
```

### FeeRecipientUpdated
Emitted when the fee recipient is updated.


```solidity
event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
```

### QuarantineAddressUpdated
Emitted when the quarantine address is updated.


```solidity
event QuarantineAddressUpdated(address indexed oldAddr, address indexed newAddr);
```

### ProtectedTokenSet
Emitted when a token's protected-set membership changes.


```solidity
event ProtectedTokenSet(address indexed token, bool protectedFlag);
```

### EmergencyWithdrawCalled
Emitted when the emergency withdrawal flow is triggered (all adapters).


```solidity
event EmergencyWithdrawCalled();
```

### EmergencyWithdrawAdapterCalled
Emitted per-adapter during an emergency withdrawal.


```solidity
event EmergencyWithdrawAdapterCalled(
    uint256 indexed index, address indexed adapter, uint256 amount, bool success
);
```

### AdapterDrainedAndExcluded
Emitted per-adapter by the atomic EMERGENCY arm+execute
`emergencyDrainAndExclude`: the adapter was drained (best-effort)
and excluded (deactivated) from NAV in a single action. `recovered`
is the USDC pulled back; `drainSucceeded` is false when the drain
reverted but the adapter was still excluded (skip-and-continue).


```solidity
event AdapterDrainedAndExcluded(
    uint256 indexed index, address indexed adapter, uint256 recovered, bool drainSucceeded
);
```

### RevokedIdleUpdated
Emitted whenever the `revokedIdle` accumulator changes — credited
when a not-counted adapter's recovered USDC lands in idle, and
decremented when that recovered idle is re-deployed (#1121).


```solidity
event RevokedIdleUpdated(uint256 oldValue, uint256 newValue);
```

### Shutdown
Emitted when the vault is shut down.


```solidity
event Shutdown();
```

### VaultRestored
Emitted when a shut-down vault is restored and deposits re-open.


```solidity
event VaultRestored(uint256 newTvlCap);
```

### DepositsPausedChanged
Emitted when deposit pause state changes.


```solidity
event DepositsPausedChanged(bool paused);
```

### WithdrawalsPausedChanged
Emitted when withdrawal pause state changes.


```solidity
event WithdrawalsPausedChanged(bool paused);
```

### UnroutedDeposit
Emitted when a deposit cannot be fully routed into adapters.


```solidity
event UnroutedDeposit(uint256 amount);
```

### RegistrySet
Emitted when the linked `VaultRegistry` reference is set.


```solidity
event RegistrySet(address indexed oldRegistry, address indexed newRegistry);
```

### Retired
Emitted when the vault is retired by the governance `retire` action.


```solidity
event Retired();
```

### Unretired
Emitted when a retired vault is reactivated (governance abort).


```solidity
event Unretired();
```

### ExactnessTransitionArmed
Emitted when ADMIN arms an exact→inexact composition-class flip
(§5.1, C2). `readyAt` is the earliest timestamp the armed
`adapter` may be added via `addAdapter` to flip the vault out of
all-exact mode — `block.timestamp + EXACTNESS_TRANSITION_DELAY`.


```solidity
event ExactnessTransitionArmed(address indexed adapter, uint64 readyAt);
```

### ExactnessTransition
Emitted when a composition-class flip actually lands through
`addAdapter` (§5.1, C2). Fires ONLY on the true→false flip — the
first inexact adapter added to an operating all-exact vault, which
reprices held shares onto the floored branch and makes the vault
`RedeemOnly`. A same-class add (exact→exact, inexact→inexact, or
the improving inexact→exact direction) never fires it. Integrators
and the indexer observe the class change here.


```solidity
event ExactnessTransition(bool wasAllExact, bool nowAllExact, address indexed adapter);
```

### Rebalanced
Emitted by the self-funded admin `forceRebalance` (§5.6):
`totalMoved` is the USDC value actually drawn from overweight
adapters and re-routed deficit-first toward target. The call is
NAV-non-decreasing — the caller funds any realized slippage/fees.


```solidity
event Rebalanced(uint256 totalMoved);
```

## Errors
### TVLCapExceeded

```solidity
error TVLCapExceeded();
```

### PerDepositCapExceeded

```solidity
error PerDepositCapExceeded();
```

### ZeroAddress

```solidity
error ZeroAddress();
```

### VaultShutdown

```solidity
error VaultShutdown();
```

### VaultRetired

```solidity
error VaultRetired();
```

### OnlyRegistry

```solidity
error OnlyRegistry();
```

### RegistryAlreadySet

```solidity
error RegistryAlreadySet();
```

### NotShutdown

```solidity
error NotShutdown();
```

### InvalidFee

```solidity
error InvalidFee();
```

### InvalidParam

```solidity
error InvalidParam();
```

### InvalidCap

```solidity
error InvalidCap();
```

### MaxAdaptersReached

```solidity
error MaxAdaptersReached();
```

### AdapterNotFound

```solidity
error AdapterNotFound();
```

### AdapterNotEmpty

```solidity
error AdapterNotEmpty();
```

### NoActiveAdapters

```solidity
error NoActiveAdapters();
```

### DepositsPaused

```solidity
error DepositsPaused();
```

### WithdrawalsPaused

```solidity
error WithdrawalsPaused();
```

### RedeemOnly
`withdraw()` / `previewWithdraw()` are unavailable because the
vault is in INEXACT mode (`allExact() == false`). Use `redeem()`.


```solidity
error RedeemOnly();
```

### DepositBelowSlippageFloor
Realized NAV delta on a deposit fell below the slippage floor.


```solidity
error DepositBelowSlippageFloor(uint256 realizedDelta, uint256 floor);
```

### NavGrowthRateExceeded
The global NAV-growth-rate limiter (§4.3a) tripped: aggregate NAV
grew faster than `maxNavGrowthRateBps` allows since the last
checkpoint. Fails the deposit closed. `elapsed` is the seconds since
the checkpoint (the allowed budget scales with it).


```solidity
error NavGrowthRateExceeded(uint256 observedNav, uint256 checkpointNav, uint256 elapsed);
```

### AdapterNotAllowed

```solidity
error AdapterNotAllowed(address adapter);
```

### AdapterCodeHashNotAllowed

```solidity
error AdapterCodeHashNotAllowed(address adapter, bytes32 codeHash);
```

### AdapterCompatibilityCheckFailed

```solidity
error AdapterCompatibilityCheckFailed(address adapter);
```

### AdapterAssetMismatch

```solidity
error AdapterAssetMismatch(address adapter, address expected, address actual);
```

### AdapterVaultMismatch

```solidity
error AdapterVaultMismatch(address adapter, address expected, address actual);
```

### InsufficientAdapterLiquidity
Active adapters cannot deliver the USDC required for an EXACT-mode
withdrawal (raised before any transfer, spec §5.3).


```solidity
error InsufficientAdapterLiquidity(uint256 requested, uint256 available);
```

### FeeNotCovered
Defensive: the exact-mode exit fee could not be covered by the
proceeds `_pullProportional` actually realized. Unreachable on a
clean shortfall (`_pullProportional` reverts
`InsufficientAdapterLiquidity` first) — kept as a fail-closed guard.


```solidity
error FeeNotCovered();
```

### NavWouldDecrease
A `forceRebalance` would leave aggregate NAV below where it started
(the caller's top-up did not cover realized slippage + fees). The
whole call reverts so holders can never lose value (§5.6).


```solidity
error NavWouldDecrease(uint256 navBefore, uint256 navAfter);
```

### ExactnessTransitionNotReady
An `addAdapter` would flip `allExact()` true→false (the first
inexact adapter on an operating all-exact vault) without a
matching armed transition whose `EXACTNESS_TRANSITION_DELAY` has
elapsed (§5.1, C2). `readyAt` is the armed timestamp (0 = unarmed).


```solidity
error ExactnessTransitionNotReady(address adapter, uint64 readyAt);
```

## Structs
### AdapterInfo
A registered position adapter and its vault-attested metadata.

`isExact` is a VAULT-ATTESTED bool set by `ADMIN_ROLE` at
`addAdapter` — the same act that pins the codehash and the allowlist
entry. It is NEVER read from `adapter.isExact()` per call: a
self-reported exactness cannot be allowed to select share-value-
critical branches (spec §2.2, C2). The adapter's own `isExact()`
view is for the at-registration cross-check and monitoring only.


```solidity
struct AdapterInfo {
    IPositionAdapter adapter;
    uint16 capBps; // max allocation % out of MAX_BPS
    bool active;
    bool isExact; // vault-attested exactness (C2)
}
```

