# PortfolioRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/b447b3c942571522a243df98942e1c4f5c32d4e3/contracts/PortfolioRouter.sol)

**Inherits:**
AccessControl, ReentrancyGuard

**Title:**
PortfolioRouter

Outer allocation contract that accepts USDC and splits deposits
across active vaults by RM-governed weight bps.
A depositor calls `deposit(amount, minSharesPerLeg[])`. The router reads
active vault addresses and weights from the governance-set weight vector,
splits `amount` proportionally, calls `vault.deposit` on each leg, and
delivers vault receipts directly to the depositor. If any leg reverts the
whole transaction reverts (all-or-revert semantics).
`previewDeposit(amount)` returns per-vault estimated receipts, weights,
fees, net amounts, and an unavailable flag per leg without executing.
Canonical: docs/architecture.md §4.2


## Constants
### ADMIN_ROLE
Grants/revokes roles, sets weights, caps, and registry address.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### BPS_DENOMINATOR
Basis-points denominator (10 000 = 100%).


```solidity
uint256 public constant BPS_DENOMINATOR = 10_000
```


### usdc
USDC token used as the deposit asset across all vaults.


```solidity
IERC20 public immutable usdc
```


### registry
VaultRegistry from which vault addresses and status are read.


```solidity
VaultRegistry public immutable registry
```


## State Variables
### routerCap
Global ceiling on the total USDC that may flow through a single
`deposit()` call. 0 means no cap enforced.


```solidity
uint256 public routerCap
```


### vaultCap
Per-vault USDC ceiling for a single `deposit()` leg.
0 means no cap enforced for that vault.


```solidity
mapping(address => uint256) public vaultCap
```


### _weightVaultList
Ordered list of vaults included in the weight vector.


```solidity
address[] private _weightVaultList
```


### _weightBps
Weight in basis points for each vault in `_weightVaultList`.
Parallel array — must always sum to BPS_DENOMINATOR.


```solidity
uint256[] private _weightBps
```


## Functions
### constructor


```solidity
constructor(address _usdc, address _registry, address _admin) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`_usdc`|`address`|     USDC token address.|
|`_registry`|`address`| VaultRegistry contract address.|
|`_admin`|`address`|    Address that receives `ADMIN_ROLE` at deploy time.|


### setWeights

Set the vault weight vector. All vaults must be registered in the
VaultRegistry. The bps values must sum to exactly BPS_DENOMINATOR.
Restricted to `ADMIN_ROLE`.


```solidity
function setWeights(address[] calldata vaults, uint256[] calldata bps)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered list of vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array in basis points (must sum to 10 000).|


### setRouterCap

Update the global router cap. 0 means uncapped.
Restricted to `ADMIN_ROLE`.


```solidity
function setRouterCap(uint256 cap) external onlyRole(ADMIN_ROLE);
```

### setVaultCap

Update the per-vault cap for `vault`. 0 means uncapped.
Restricted to `ADMIN_ROLE`.


```solidity
function setVaultCap(address vault, uint256 cap) external onlyRole(ADMIN_ROLE);
```

### previewDeposit

Return per-vault estimated receipts for `amount` USDC without
executing any state changes. Paused or retired vaults are marked
`unavailable = true` and return `estShares = 0`.


```solidity
function previewDeposit(uint256 amount) external view returns (LegPreview[] memory legs);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`| Total USDC to preview.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`legs`|`LegPreview[]`|  One entry per vault in the current weight vector.|


### deposit

Split `amount` USDC across active vaults by the current weight
vector. All legs must succeed (all-or-revert). Shares are minted
directly to `msg.sender`.


```solidity
function deposit(uint256 amount, uint256[] calldata minSharesPerLeg)
    external
    nonReentrant
    returns (uint256[] memory sharesPerLeg);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|           Total USDC to deposit. Must be pre-approved.|
|`minSharesPerLeg`|`uint256[]`|  Minimum shares the caller accepts per leg. Length must equal the number of active legs (non- paused, non-retired). Pass an empty array to skip slippage protection.|


### depositFor

Split `amount` USDC across active vaults by the current weight
vector. All legs must succeed (all-or-revert). Shares are minted
to `receiver` instead of `msg.sender`. Intended for gateway
integration where the gateway is the caller but shares belong to
the depositor's configured share receiver.


```solidity
function depositFor(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
    external
    nonReentrant
    returns (uint256[] memory sharesPerLeg);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`receiver`|`address`|         Address that receives minted vault shares.|
|`amount`|`uint256`|           Total USDC to deposit. Must be pre-approved.|
|`minSharesPerLeg`|`uint256[]`|  Minimum shares the caller accepts per leg. Length must equal the number of active legs (non- paused, non-retired). Pass an empty array to skip slippage protection.|


### _depositTo

Internal allocation logic shared by `deposit` and `depositFor`.


```solidity
function _depositTo(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
    internal
    returns (uint256[] memory sharesPerLeg);
```

### getWeights

Return the current weight vector (vault list and bps).


```solidity
function getWeights() external view returns (address[] memory vaults, uint256[] memory bps);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array in basis points.|


## Events
### RouterDeposit
Emitted once per successful `deposit()` call, per vault leg.


```solidity
event RouterDeposit(
    address indexed depositor,
    address indexed vault,
    uint256 amount,
    uint256 shares,
    uint256 weightBps
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`depositor`|`address`| Address that initiated the deposit.|
|`vault`|`address`|     Vault address that received the USDC leg.|
|`amount`|`uint256`|    USDC forwarded to this vault.|
|`shares`|`uint256`|    Vault shares minted to the depositor.|
|`weightBps`|`uint256`| Weight of this vault in the current weight vector.|

### WeightsSet
Emitted when the weight vector is updated.


```solidity
event WeightsSet(address[] vaults, uint256[] bps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| New ordered list of vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array (must sum to BPS_DENOMINATOR).|

### RouterCapSet
Emitted when the global router cap is updated.


```solidity
event RouterCapSet(uint256 oldCap, uint256 newCap);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldCap`|`uint256`|Previous value (0 = uncapped).|
|`newCap`|`uint256`|New value (0 = uncapped).|

### VaultCapSet
Emitted when a per-vault cap is updated.


```solidity
event VaultCapSet(address indexed vault, uint256 oldCap, uint256 newCap);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`| Vault address.|
|`oldCap`|`uint256`|Previous cap (0 = uncapped).|
|`newCap`|`uint256`|New cap (0 = uncapped).|

## Errors
### ZeroAddress
Address argument is `address(0)`.


```solidity
error ZeroAddress();
```

### InvalidWeightSum
Weight bps array does not sum to BPS_DENOMINATOR (10 000).


```solidity
error InvalidWeightSum();
```

### LengthMismatch
Vaults and bps arrays have mismatched lengths.


```solidity
error LengthMismatch();
```

### VaultNotRegistered
A vault in the weight list is not registered in the VaultRegistry.


```solidity
error VaultNotRegistered();
```

### MinSharesLengthMismatch
`minSharesPerLeg` length does not match the number of active legs.


```solidity
error MinSharesLengthMismatch();
```

### SlippageExceeded
A vault returned fewer shares than the depositor's minimum.


```solidity
error SlippageExceeded();
```

### RouterCapExceeded
Total deposit amount exceeds the global router cap.


```solidity
error RouterCapExceeded();
```

### VaultCapExceeded
Single-vault leg amount exceeds that vault's per-vault cap.


```solidity
error VaultCapExceeded();
```

### NoWeightsSet
No weight vector has been set; cannot deposit.


```solidity
error NoWeightsSet();
```

### VaultNotActive
A vault's registry status is not Active; deposit is blocked.


```solidity
error VaultNotActive(address vault, VaultRegistry.VaultStatus status);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`| The vault address that is not Active.|
|`status`|`VaultRegistry.VaultStatus`|The current non-Active status of the vault.|

## Structs
### LegPreview
Per-leg preview result.


```solidity
struct LegPreview {
    address vault;
    uint256 weightBps;
    uint256 legAmount;
    uint256 estShares;
    bool unavailable;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|      Vault address.|
|`weightBps`|`uint256`|  Weight assigned to this leg.|
|`legAmount`|`uint256`|  USDC that would be sent to this vault.|
|`estShares`|`uint256`|  Estimated shares the depositor would receive (0 if unavailable).|
|`unavailable`|`bool`|True if the vault is paused/retired or the call reverted.|

