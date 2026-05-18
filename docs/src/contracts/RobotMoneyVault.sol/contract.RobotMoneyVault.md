# RobotMoneyVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/31a8dcee8651b68de6fb5481acf7c895437acde1/contracts/RobotMoneyVault.sol)

**Inherits:**
ERC4626, AccessControl, ReentrancyGuard

**Title:**
RobotMoneyVault

Multi-adapter ERC-4626 USDC vault on Base. Dynamic equal-weight target across active
adapters. On-chain trustless pricing. Atomic deposit-to-yield AND withdraw — both
single-transaction, standard ERC-4626. Exit fee applied on withdrawal.
Yearn V3-inspired security: 2 roles + hardcoded floors.
Deployed: 0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun


## Constants
### ADMIN_ROLE
Role that can manage adapters, set parameters, and rebalance.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE
Role that can pause and perform emergency withdrawals.
Asymmetric with unpause by design: a compromised emergency key can
only halt the vault (DoS), not restart it. Unpause is restricted to
`ADMIN_ROLE` so that resuming operations is deliberate and requires
the higher-trust role — mirroring the gateway's `PAUSER_ROLE` /
`ADMIN_ROLE` asymmetry documented in `AccessRoles.sol`.


```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### KEEPER_ROLE
Role for automated keeper rebalancing (not granted at launch).


```solidity
bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE")
```


### MAX_EXIT_FEE_BPS
Absolute ceiling on exit fee (100 bps = 1%).


```solidity
uint256 public constant MAX_EXIT_FEE_BPS = 100
```


### MAX_ADAPTERS
Maximum number of strategy adapters the vault can hold.


```solidity
uint256 public constant MAX_ADAPTERS = 20
```


### MAX_BPS
Basis-points denominator (10 000 = 100%).


```solidity
uint16 public constant MAX_BPS = 10000
```


### MAX_REBALANCE_BPS_CEILING
Keeper can never move more than 50% of TVL in a single rebalance call.


```solidity
uint16 public constant MAX_REBALANCE_BPS_CEILING = 5000
```


### MIN_REBALANCE_INTERVAL_FLOOR
Minimum enforced interval between rebalance calls (1 hour).


```solidity
uint256 public constant MIN_REBALANCE_INTERVAL_FLOOR = 1 hours
```


## State Variables
### adapters
Ordered registry of all strategy adapters (active and inactive).


```solidity
AdapterInfo[] public adapters
```


### tvlCap
Maximum total assets under management; deposits revert above this.


```solidity
uint256 public tvlCap
```


### perDepositCap
Maximum USDC that a single deposit may contribute.


```solidity
uint256 public perDepositCap
```


### exitFeeBps
Exit fee in basis points charged on withdrawals.


```solidity
uint256 public exitFeeBps
```


### feeRecipient
Recipient of collected exit fees.


```solidity
address public feeRecipient
```


### shutdown
Whether the vault has been permanently shut down. Irreversible.


```solidity
bool public shutdown
```


### depositsPaused
When true, new deposits and mints are blocked.


```solidity
bool public depositsPaused
```


### withdrawalsPaused
When true, withdrawals and redeems are blocked.


```solidity
bool public withdrawalsPaused
```


### maxRebalanceBpsPerCall
Maximum fraction of TVL a keeper may move in one rebalance call (bps).


```solidity
uint16 public maxRebalanceBpsPerCall
```


### minRebalanceInterval
Minimum time between consecutive rebalance calls (seconds).


```solidity
uint256 public minRebalanceInterval
```


### lastRebalanceAt
Timestamp of the most recent completed rebalance.


```solidity
uint256 public lastRebalanceAt
```


## Functions
### constructor


```solidity
constructor(
    IERC20 _asset,
    uint256 _tvlCap,
    uint256 _perDepositCap,
    uint256 _exitFeeBps,
    address _feeRecipient,
    address _admin
) ERC4626(_asset) ERC20("Robot Money USDC", "rmUSDC");
```

### decimals

Returns the decimal precision used by this vault's share token (6, matching USDC).

Share token precision is fixed at 6 so that external tools (wallets, explorers,
integrators) always see a consistent denomination regardless of the internal
virtual-share scale chosen for inflation protection.
Raw-share scale note (for integrators):
The ERC-4626 virtual-share offset is 18 (see `_decimalsOffset`).  OpenZeppelin's
`_convertToShares` formula is:
shares = assets × (totalSupply + 10^18) / (totalAssets + 1)
For a fresh vault this yields `1e6 USDC → 1e24 raw shares`.  Because `decimals()`
returns 6, a user interface rendering `balanceOf(user) / 1e6` would display
`1e18` rmUSDC for a 1 USDC seed deposit.  This is intentional: the inflated share
count is what makes donation-based price manipulation economically infeasible.
Once the vault accumulates real TVL the share price converges to 1 rmUSDC ≈ 1 USDC
(in 6-decimal terms) and the raw count no longer dominates the display.


```solidity
function decimals() public pure override(ERC4626) returns (uint8);
```

### _decimalsOffset

Returns the ERC-4626 virtual-share decimal offset used to resist first-depositor
share-price inflation attacks.

Returning 18 configures OpenZeppelin's ERC-4626 virtual shares to `10^18` and
virtual assets to `1`.  With this setting the economic cost of a donation-based
inflation attack scales as `10^18` — orders of magnitude beyond any realistic
attacker budget — while legitimate depositors receive economically fair shares at
all TVL levels.
Raw-share scale (fresh vault, decimals() == 6, _decimalsOffset() == 18):
previewDeposit(1e6)  → 1e24 raw shares  (= 1e18 rmUSDC in 6-decimal display)
previewMint(1e24)    → 1e6 USDC
previewRedeem(1e24)  → ~1e6 USDC (minus exit fee if any)
previewWithdraw(1e6) → ~1e24 raw shares
Integrators MUST NOT assume raw shares equal asset amounts.  Always use
`convertToShares` / `convertToAssets` for on-chain math, or read `decimals()` and
divide accordingly in off-chain display logic.
See: docs/security-model.md — ERC-4626 Inflation Attack Mitigation


```solidity
function _decimalsOffset() internal pure override returns (uint8);
```

### totalAssets

Sum of USDC held directly in the vault (idle) plus all active adapter balances.

Idle USDC can accumulate via direct transfers or when `_routeDeposit` cannot place
all assets (e.g. all adapter caps are exhausted). Including it here prevents NAV
understatement and the associated TVL-cap bypass / share-price dilution described
in docs/code-reviews/code-review-codex-20260508-1522.md — Finding 2.


```solidity
function totalAssets() public view override returns (uint256);
```

### _deposit


```solidity
function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
    internal
    override
    nonReentrant;
```

### _routeDeposit


```solidity
function _routeDeposit(uint256 amount) internal;
```

### _allocateTo


```solidity
function _allocateTo(uint256 i, uint256 amount) internal;
```

### previewRedeem

Estimate net USDC returned when redeeming `shares` (after exit fee).


```solidity
function previewRedeem(uint256 shares) public view override returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`shares`|`uint256`|Number of rmUSDC shares to simulate redeeming.|


### previewWithdraw

Estimate shares required to receive exactly `assets` USDC net (after exit fee).


```solidity
function previewWithdraw(uint256 assets) public view override returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`assets`|`uint256`|Target net USDC to receive.|


### _grossToNet


```solidity
function _grossToNet(uint256 gross) internal view returns (uint256);
```

### _netToGross


```solidity
function _netToGross(uint256 net) internal view returns (uint256);
```

### _withdraw


```solidity
function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
) internal override nonReentrant;
```

### _pullProportional


```solidity
function _pullProportional(uint256 assetsNeeded) internal;
```

### addAdapter

Register a new strategy adapter. Restricted to `ADMIN_ROLE`.


```solidity
function addAdapter(address adapter_, uint16 capBps_) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`adapter_`|`address`|Address of the `IStrategyAdapter`-compatible contract.|
|`capBps_`|`uint16`| Maximum allocation cap in basis points (1–10 000).|


### removeAdapter

Deactivate an adapter. The adapter must hold zero assets. Restricted to `ADMIN_ROLE`.


```solidity
function removeAdapter(uint256 index) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|Registry index of the adapter to remove.|


### setAdapterCap

Update the allocation cap for an existing adapter. Restricted to `ADMIN_ROLE`.


```solidity
function setAdapterCap(uint256 index, uint16 newCapBps) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|    Registry index of the adapter.|
|`newCapBps`|`uint16`|New maximum allocation cap in basis points (1–10 000).|


### rebalance

Keeper-triggered equal-weight rebalance. Callable by `ADMIN_ROLE` or `KEEPER_ROLE`.
Pulls excess from over-weight adapters and re-routes into under-weight adapters.
Subject to `minRebalanceInterval` and `maxRebalanceBpsPerCall` throttles.


```solidity
function rebalance() external nonReentrant;
```

### adminRebalance

Admin-specified precision rebalance: sets each adapter to an explicit target balance.
Restricted to `ADMIN_ROLE`.


```solidity
function adminRebalance(uint256[] calldata targetBalances)
    external
    onlyRole(ADMIN_ROLE)
    nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`targetBalances`|`uint256[]`|Target USDC balance for each adapter (must match `adapters.length`).|


### setMaxRebalanceBpsPerCall

Update the per-call rebalance cap. Restricted to `ADMIN_ROLE`.


```solidity
function setMaxRebalanceBpsPerCall(uint16 newBps) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newBps`|`uint16`|New cap in basis points (1–5 000; must not exceed `MAX_REBALANCE_BPS_CEILING`).|


### setMinRebalanceInterval

Update the minimum interval between rebalance calls. Restricted to `ADMIN_ROLE`.


```solidity
function setMinRebalanceInterval(uint256 newInterval) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newInterval`|`uint256`|New minimum interval in seconds (must be ≥ `MIN_REBALANCE_INTERVAL_FLOOR`).|


### pause

Pause all deposits and withdrawals. Restricted to `EMERGENCY_ROLE`.


```solidity
function pause() external onlyRole(EMERGENCY_ROLE);
```

### unpause

Resume deposits and withdrawals. Restricted to `ADMIN_ROLE`.
Intentionally asymmetric: pausing is fast and unilateral (`EMERGENCY_ROLE`);
unpausing is deliberate and requires the higher-trust admin role.


```solidity
function unpause() external onlyRole(ADMIN_ROLE);
```

### emergencyWithdraw

Pause the vault and attempt to withdraw all assets from every active adapter.
Uses `try/catch` so a failed adapter does not block others. Restricted to `EMERGENCY_ROLE`.
After this call, deposits are blocked but withdrawals remain open so users can exit.


```solidity
function emergencyWithdraw() external onlyRole(EMERGENCY_ROLE) nonReentrant;
```

### emergencyWithdrawAdapter

Pause deposits and withdraw all assets from a single adapter. Restricted to `EMERGENCY_ROLE`.
Withdrawals remain open so users can redeem assets pulled into idle USDC.


```solidity
function emergencyWithdrawAdapter(uint256 index)
    external
    onlyRole(EMERGENCY_ROLE)
    nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|Registry index of the adapter to drain.|


### forceRemoveAdapter

Force-remove an adapter without withdrawing its assets (last-resort action).
Assets in the adapter are treated as lost. Restricted to `EMERGENCY_ROLE`.


```solidity
function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|Registry index of the adapter to force-remove.|


### shutdownVault

Permanently shut down the vault: set `shutdown = true` and zero the TVL cap.
Irreversible. Restricted to `EMERGENCY_ROLE`.


```solidity
function shutdownVault() external onlyRole(EMERGENCY_ROLE);
```

### setTvlCap

Update the TVL cap. Restricted to `ADMIN_ROLE`.


```solidity
function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newCap`|`uint256`|New maximum total assets in 6-decimal USDC units.|


### setPerDepositCap

Update the per-deposit cap. Restricted to `ADMIN_ROLE`.


```solidity
function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newCap`|`uint256`|New maximum single-deposit amount in 6-decimal USDC units.|


### setExitFeeBps

Update the exit fee. Restricted to `ADMIN_ROLE`.


```solidity
function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newBps`|`uint256`|New exit fee in basis points (0–`MAX_EXIT_FEE_BPS`).|


### setFeeRecipient

Update the fee recipient address. Restricted to `ADMIN_ROLE`.


```solidity
function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newRecipient`|`address`|New address to receive collected exit fees.|


### rescueTokens

Rescue accidentally-sent ERC-20 tokens (cannot rescue USDC or vault shares).
Restricted to `ADMIN_ROLE`.


```solidity
function rescueTokens(address token, address to) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|ERC-20 token to rescue (must not be the vault asset or vault share token).|
|`to`|`address`|   Recipient address for the rescued tokens.|


### _setDepositsPaused

Set `depositsPaused` and emit an event if the state changes.


```solidity
function _setDepositsPaused(bool paused_) internal;
```

### _setWithdrawalsPaused

Set `withdrawalsPaused` and emit an event if the state changes.


```solidity
function _setWithdrawalsPaused(bool paused_) internal;
```

### _targetBpsFor


```solidity
function _targetBpsFor() internal view returns (uint256);
```

### _activeAdapterCount


```solidity
function _activeAdapterCount() internal view returns (uint256);
```

### paused

Returns true when both deposits and withdrawals are blocked (full pause).
Provided for compatibility with tooling that queries `paused()`.


```solidity
function paused() external view returns (bool);
```

### adapterCount

Total number of adapters in the registry (active and inactive).


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
        uint256 currentBalance,
        uint256 targetBps
    );
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|        Registry index of the adapter.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`adapterAddr`|`address`| Address of the adapter contract.|
|`capBps`|`uint16`|      Maximum allocation cap in basis points.|
|`active`|`bool`|      Whether the adapter is currently active.|
|`currentBalance`|`uint256`|Live USDC value held by the adapter.|
|`targetBps`|`uint256`|   Current equal-weight target in basis points.|


### getAdapterDrift

Compute current vs. target balances and signed drift for every adapter.


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
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`currentBalances`|`uint256[]`|Live USDC values for each adapter (6-decimal units).|
|`targetBalances`|`uint256[]`| Equal-weight target USDC values for each adapter.|
|`drifts`|`int256[]`|         Signed difference (current − target) per adapter.|


### isRebalanceAvailable

Whether `minRebalanceInterval` has elapsed since the last rebalance.


```solidity
function isRebalanceAvailable() external view returns (bool);
```

### nextRebalanceAt

Timestamp at which the next rebalance call will be permitted.


```solidity
function nextRebalanceAt() external view returns (uint256);
```

### activeAdapterCount

Number of currently active strategy adapters.


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
Emitted when a new strategy adapter is registered.


```solidity
event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|  Registry index of the new adapter.|
|`adapter`|`address`|Address of the registered adapter contract.|
|`capBps`|`uint16`| Maximum allocation cap in basis points.|

### AdapterRemoved
Emitted when an adapter is deactivated (normal removal).


```solidity
event AdapterRemoved(uint256 indexed index, address indexed adapter);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|  Registry index of the removed adapter.|
|`adapter`|`address`|Address of the deactivated adapter contract.|

### AdapterCapUpdated
Emitted when an adapter's allocation cap is updated.


```solidity
event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`| Registry index of the adapter.|
|`oldBps`|`uint16`|Previous cap in basis points.|
|`newBps`|`uint16`|New cap in basis points.|

### AdapterForceRemoved
Emitted when an adapter is force-removed without withdrawing assets (emergency).


```solidity
event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|     Registry index of the force-removed adapter.|
|`adapter`|`address`|   Address of the adapter contract.|
|`lossAmount`|`uint256`|Estimated assets lost due to force removal.|

### Allocated
Emitted when USDC is allocated from the vault into an adapter.


```solidity
event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|  Registry index of the target adapter.|
|`adapter`|`address`|Address of the target adapter contract.|
|`amount`|`uint256`| Amount of USDC allocated (6-decimal units).|

### Pulled
Emitted when USDC is pulled from an adapter back to the vault.


```solidity
event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|  Registry index of the source adapter.|
|`adapter`|`address`|Address of the source adapter contract.|
|`amount`|`uint256`| Amount of USDC pulled (6-decimal units).|

### Rebalanced
Emitted at the end of a successful rebalance call.


```solidity
event Rebalanced(uint256 totalMoved);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`totalMoved`|`uint256`|Total USDC redistributed across adapters (6-decimal units).|

### MaxRebalanceBpsUpdated
Emitted when the per-call rebalance cap is updated.


```solidity
event MaxRebalanceBpsUpdated(uint16 oldBps, uint16 newBps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldBps`|`uint16`|Previous cap in basis points.|
|`newBps`|`uint16`|New cap in basis points.|

### MinRebalanceIntervalUpdated
Emitted when the minimum rebalance interval is updated.


```solidity
event MinRebalanceIntervalUpdated(uint256 oldInterval, uint256 newInterval);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldInterval`|`uint256`|Previous minimum interval in seconds.|
|`newInterval`|`uint256`|New minimum interval in seconds.|

### ExitFeeCharged
Emitted when an exit fee is charged on a withdrawal.


```solidity
event ExitFeeCharged(
    address indexed owner,
    address indexed receiver,
    uint256 grossAssets,
    uint256 fee,
    uint256 netAssets
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`owner`|`address`|     Share owner who initiated the withdrawal.|
|`receiver`|`address`|  Address that received the net USDC.|
|`grossAssets`|`uint256`|Gross USDC value of redeemed shares.|
|`fee`|`uint256`|       Exit fee charged (grossAssets × exitFeeBps / MAX_BPS).|
|`netAssets`|`uint256`| Net USDC transferred to receiver (grossAssets − fee).|

### TvlCapUpdated
Emitted when the TVL cap is updated.


```solidity
event TvlCapUpdated(uint256 oldCap, uint256 newCap);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldCap`|`uint256`|Previous TVL cap (6-decimal USDC units).|
|`newCap`|`uint256`|New TVL cap (6-decimal USDC units).|

### PerDepositCapUpdated
Emitted when the per-deposit cap is updated.


```solidity
event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldCap`|`uint256`|Previous per-deposit cap (6-decimal USDC units).|
|`newCap`|`uint256`|New per-deposit cap (6-decimal USDC units).|

### ExitFeeUpdated
Emitted when the exit fee is updated.


```solidity
event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldBps`|`uint256`|Previous exit fee in basis points.|
|`newBps`|`uint256`|New exit fee in basis points.|

### FeeRecipientUpdated
Emitted when the fee recipient address is updated.


```solidity
event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldRecipient`|`address`|Previous fee recipient address.|
|`newRecipient`|`address`|New fee recipient address.|

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

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|  Registry index of the adapter.|
|`adapter`|`address`|Address of the adapter contract.|
|`amount`|`uint256`| Amount withdrawn (0 on failure or empty balance).|
|`success`|`bool`|Whether the adapter's withdraw call succeeded.|

### Shutdown
Emitted when the vault is permanently shut down.


```solidity
event Shutdown();
```

### DepositsPausedChanged
Emitted when deposit pause state changes.


```solidity
event DepositsPausedChanged(bool paused);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`paused`|`bool`|True when deposits are blocked, false when unblocked.|

### WithdrawalsPausedChanged
Emitted when withdrawal pause state changes.


```solidity
event WithdrawalsPausedChanged(bool paused);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`paused`|`bool`|True when withdrawals are blocked, false when unblocked.|

### UnroutedDeposit
Emitted when a deposit cannot be fully routed into adapters (e.g. all caps are full).


```solidity
event UnroutedDeposit(uint256 amount);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|USDC that remains idle in the vault after both routing passes.|

## Errors
### TVLCapExceeded
Deposit would push total managed assets above `tvlCap`.


```solidity
error TVLCapExceeded();
```

### PerDepositCapExceeded
A single deposit exceeds the per-deposit cap.


```solidity
error PerDepositCapExceeded();
```

### CannotRescueAsset
`rescueToken` refused because the token is the vault's own asset (USDC).


```solidity
error CannotRescueAsset();
```

### ZeroAddress
Constructor or admin call passed `address(0)` where a real address is required.


```solidity
error ZeroAddress();
```

### VaultShutdown
Operation rejected because the vault has been permanently shut down.


```solidity
error VaultShutdown();
```

### InvalidFee
Exit-fee bps argument exceeds `MAX_EXIT_FEE_BPS` (1%).


```solidity
error InvalidFee();
```

### InvalidParam
Generic admin parameter validation failure (zero/out-of-range value).


```solidity
error InvalidParam();
```

### InvalidCap
Adapter cap bps is zero or above `MAX_BPS`.


```solidity
error InvalidCap();
```

### ExceedsAdapterCap
Allocation to a single adapter would exceed its configured `capBps`.


```solidity
error ExceedsAdapterCap();
```

### MaxAdaptersReached
Adapter registry already holds `MAX_ADAPTERS`; cannot add another.


```solidity
error MaxAdaptersReached();
```

### AdapterNotFound
Provided adapter index is out of range or refers to an inactive entry.


```solidity
error AdapterNotFound();
```

### AdapterNotEmpty
Cannot remove an adapter while it still custodies assets — withdraw first.


```solidity
error AdapterNotEmpty();
```

### NoActiveAdapters
Deposit/rebalance attempted while no adapter is active.


```solidity
error NoActiveAdapters();
```

### RebalanceTooSoon
Keeper called `rebalance()` before `minRebalanceInterval` elapsed since `lastRebalanceAt`.


```solidity
error RebalanceTooSoon();
```

### UnauthorizedRebalancer
Caller lacks `KEEPER_ROLE` (or `ADMIN_ROLE` where the rebalancer path also accepts it).


```solidity
error UnauthorizedRebalancer();
```

### DepositsPaused
Deposit attempted while deposits are paused.


```solidity
error DepositsPaused();
```

### WithdrawalsPaused
Withdrawal attempted while withdrawals are paused.


```solidity
error WithdrawalsPaused();
```

## Structs
### AdapterInfo

```solidity
struct AdapterInfo {
    IStrategyAdapter adapter;
    uint16 capBps; // max allocation % out of MAX_BPS — also acts as ramp control
    bool active;
}
```

