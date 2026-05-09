# RobotMoneyVault
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/RobotMoneyVault.sol)

**Inherits:**
ERC4626, AccessControl, Pausable, ReentrancyGuard

**Title:**
RobotMoneyVault

Multi-adapter ERC-4626 USDC vault on Base. Dynamic equal-weight target across active
adapters. On-chain trustless pricing. Atomic deposit-to-yield AND withdraw — both
single-transaction, standard ERC-4626. Exit fee applied on withdrawal.
Yearn V3-inspired security: 2 roles + hardcoded floors.
Deployed: 0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun


## State Variables
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE

```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### KEEPER_ROLE

```solidity
bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE")
```


### MAX_EXIT_FEE_BPS

```solidity
uint256 public constant MAX_EXIT_FEE_BPS = 100
```


### MAX_ADAPTERS

```solidity
uint256 public constant MAX_ADAPTERS = 20
```


### MAX_BPS

```solidity
uint16 public constant MAX_BPS = 10000
```


### MAX_REBALANCE_BPS_CEILING

```solidity
uint16 public constant MAX_REBALANCE_BPS_CEILING = 5000
```


### MIN_REBALANCE_INTERVAL_FLOOR

```solidity
uint256 public constant MIN_REBALANCE_INTERVAL_FLOOR = 1 hours
```


### adapters

```solidity
AdapterInfo[] public adapters
```


### tvlCap

```solidity
uint256 public tvlCap
```


### perDepositCap

```solidity
uint256 public perDepositCap
```


### exitFeeBps

```solidity
uint256 public exitFeeBps
```


### feeRecipient

```solidity
address public feeRecipient
```


### shutdown

```solidity
bool public shutdown
```


### maxRebalanceBpsPerCall

```solidity
uint16 public maxRebalanceBpsPerCall
```


### minRebalanceInterval

```solidity
uint256 public minRebalanceInterval
```


### lastRebalanceAt

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


```solidity
function decimals() public pure override(ERC4626) returns (uint8);
```

### _decimalsOffset


```solidity
function _decimalsOffset() internal pure override returns (uint8);
```

### totalAssets


```solidity
function totalAssets() public view override returns (uint256);
```

### _deposit


```solidity
function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
    internal
    override
    whenNotPaused
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


```solidity
function previewRedeem(uint256 shares) public view override returns (uint256);
```

### previewWithdraw


```solidity
function previewWithdraw(uint256 assets) public view override returns (uint256);
```

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
) internal override whenNotPaused nonReentrant;
```

### _pullProportional


```solidity
function _pullProportional(uint256 assetsNeeded) internal;
```

### addAdapter


```solidity
function addAdapter(address adapter_, uint16 capBps_) external onlyRole(ADMIN_ROLE);
```

### removeAdapter


```solidity
function removeAdapter(uint256 index) external onlyRole(ADMIN_ROLE);
```

### setAdapterCap


```solidity
function setAdapterCap(uint256 index, uint16 newCapBps) external onlyRole(ADMIN_ROLE);
```

### rebalance


```solidity
function rebalance() external nonReentrant;
```

### adminRebalance


```solidity
function adminRebalance(uint256[] calldata targetBalances)
    external
    onlyRole(ADMIN_ROLE)
    nonReentrant;
```

### setMaxRebalanceBpsPerCall


```solidity
function setMaxRebalanceBpsPerCall(uint16 newBps) external onlyRole(ADMIN_ROLE);
```

### setMinRebalanceInterval


```solidity
function setMinRebalanceInterval(uint256 newInterval) external onlyRole(ADMIN_ROLE);
```

### pause


```solidity
function pause() external onlyRole(EMERGENCY_ROLE);
```

### unpause


```solidity
function unpause() external onlyRole(EMERGENCY_ROLE);
```

### emergencyWithdraw


```solidity
function emergencyWithdraw() external onlyRole(EMERGENCY_ROLE) nonReentrant;
```

### emergencyWithdrawAdapter


```solidity
function emergencyWithdrawAdapter(uint256 index)
    external
    onlyRole(EMERGENCY_ROLE)
    nonReentrant;
```

### forceRemoveAdapter


```solidity
function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE);
```

### shutdownVault


```solidity
function shutdownVault() external onlyRole(EMERGENCY_ROLE);
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

### setFeeRecipient


```solidity
function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE);
```

### rescueTokens


```solidity
function rescueTokens(address token, address to) external onlyRole(ADMIN_ROLE);
```

### _targetBpsFor


```solidity
function _targetBpsFor() internal view returns (uint256);
```

### _activeAdapterCount


```solidity
function _activeAdapterCount() internal view returns (uint256);
```

### adapterCount


```solidity
function adapterCount() external view returns (uint256);
```

### isShutdown


```solidity
function isShutdown() external view returns (bool);
```

### getAdapterInfo


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

### getAdapterDrift


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

### isRebalanceAvailable


```solidity
function isRebalanceAvailable() external view returns (bool);
```

### nextRebalanceAt


```solidity
function nextRebalanceAt() external view returns (uint256);
```

### activeAdapterCount


```solidity
function activeAdapterCount() external view returns (uint256);
```

### currentTargetBps


```solidity
function currentTargetBps() external view returns (uint256);
```

## Events
### AdapterAdded

```solidity
event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps);
```

### AdapterRemoved

```solidity
event AdapterRemoved(uint256 indexed index, address indexed adapter);
```

### AdapterCapUpdated

```solidity
event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
```

### AdapterForceRemoved

```solidity
event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
```

### Allocated

```solidity
event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
```

### Pulled

```solidity
event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
```

### Rebalanced

```solidity
event Rebalanced(uint256 totalMoved);
```

### MaxRebalanceBpsUpdated

```solidity
event MaxRebalanceBpsUpdated(uint16 oldBps, uint16 newBps);
```

### MinRebalanceIntervalUpdated

```solidity
event MinRebalanceIntervalUpdated(uint256 oldInterval, uint256 newInterval);
```

### ExitFeeCharged

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

```solidity
event TvlCapUpdated(uint256 oldCap, uint256 newCap);
```

### PerDepositCapUpdated

```solidity
event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
```

### ExitFeeUpdated

```solidity
event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
```

### FeeRecipientUpdated

```solidity
event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
```

### EmergencyWithdrawCalled

```solidity
event EmergencyWithdrawCalled();
```

### EmergencyWithdrawAdapterCalled

```solidity
event EmergencyWithdrawAdapterCalled(
    uint256 indexed index, address indexed adapter, uint256 amount, bool success
);
```

### Shutdown

```solidity
event Shutdown();
```

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

## Structs
### AdapterInfo

```solidity
struct AdapterInfo {
    IStrategyAdapter adapter;
    uint16 capBps; // max allocation % out of MAX_BPS — also acts as ramp control
    bool active;
}
```

