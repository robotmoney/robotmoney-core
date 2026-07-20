# Vault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3d0125a0ee72af9f51ed36ec0b328a085a948116/contracts/Vault.sol)

**Inherits:**
ERC4626, AccessControl, ReentrancyGuard

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
emergency-model refinements (#1121), the isomorphic surplus-first
flow-based rebalancing + `forceRebalance` (#1122), and the exactness-
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


### MAX_BPS
Basis-points denominator (10 000 = 100%). Narrowed to `uint16`
from `BpsMath.BPS_DENOMINATOR` to preserve call-site arithmetic.


```solidity
uint16 public constant MAX_BPS = uint16(BpsMath.BPS_DENOMINATOR)
```


## State Variables
### adapters
Ordered registry of all adapters (active and inactive).


```solidity
AdapterInfo[] public adapters
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
ADP-2 exclusion drained via `emergencyWithdrawAdapter`) and
therefore NOT backing counted shares. Subtracted from the deposit
mint denominator so recovered idle stays with existing holders and
is not repriced onto new depositors. NORMALLY ZERO.

#1121 (emergency-model refinements) owns the full lifecycle of
this accumulator — incrementing it when a revoked adapter is
drained and decrementing it as the recovered idle is re-deployed.
The #1119 core wires it into the denominator (the C1-correct
formula) and leaves it at zero; see `_deposit`.


```solidity
uint256 public revokedIdle
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


### adminCount
Live count of `ADMIN_ROLE` holders. Maintained by the
`_grantRole`/`_revokeRole` hooks so the last admin can never be
removed — guaranteeing a still-available authority can always
reverse a withdrawal-blocking state (LIFE-4).


```solidity
uint256 public adminCount
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

### _grantRole


```solidity
function _grantRole(bytes32 role, address account)
    internal
    virtual
    override
    returns (bool granted);
```

### _revokeRole


```solidity
function _revokeRole(bytes32 role, address account)
    internal
    virtual
    override
    returns (bool revoked);
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

### _routeDeposit

Deficit-first two-pass allocator: fill toward `min(equal-target,
capBps)` first, then spread leftover into remaining cap headroom.
Ineligible-but-active adapters are SKIPPED, not reverted (audit L-4);
any unrouted remainder stays idle (counted by `totalAssets`) and
emits `UnroutedDeposit`. This is the deposit half of flow-based
rebalancing.
SEAM (#1122): the surplus-first / deficit-first FLOW refinement of
the ordering lives here and in `_pullProportional`/`_sellProportional`
— this two-pass fill is the baseline it reorders. Keep this the sole
deposit routing entrypoint.


```solidity
function _routeDeposit(uint256 amount) internal;
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
SEAM (#1122): surplus-first drawdown ordering reorders this
proportional pass; the shortfall-revert semantics stay.


```solidity
function _pullProportional(uint256 assetsNeeded) internal returns (uint256);
```

### _sellProportional

Sell the `shares / supplyBefore` fraction of idle USDC and of each
eligible adapter's position. NO all-or-nothing shortfall revert — an
inexact adapter systematically delivers `realized ≈ wanted ×
(1 − slippage)`; each leg's `minUsdcOut = max(caller floor, adapter
floor)` reverts `SlippageExceeded` only below the floor. Proceeds
accrue as realized; no socialization.
SEAM (#1122): surplus-first sell ordering reorders this
share-proportional pass.


```solidity
function _sellProportional(uint256 shares, uint256 supplyBefore)
    internal
    returns (uint256 usdcOut);
```

### addAdapter

Register a new adapter with a vault-attested exactness flag.

SEAM (#1123): when this add flips the composition class (the first
inexact adapter on an all-exact vault, or vice-versa), #1123 routes
the transition through the ADMIN timelock and emits
`ExactnessTransition(wasAllExact, allExact(), adapter_)`. The class
is observable here via `allExact()` before/after the push.


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

### LastAdminFloor

```solidity
error LastAdminFloor();
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

