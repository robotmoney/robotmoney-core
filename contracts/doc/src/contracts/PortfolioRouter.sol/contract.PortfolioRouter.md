# PortfolioRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e725858583e4c0e5819bd858f896d04ded40bdb7/contracts/PortfolioRouter.sol)

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
Router eligibility (whether a vault may be weighted at all) is **registry
state**, not a contract variant: `VaultRegistry.isRouterEligible(vault)`
is the single signal an operator sets. This keeps the same production
contract path live across test, demo, and mainnet — environments differ
only by which vaults the operator has opted in. See
`docs/development/single-production-codebase.md` for the principle.
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
VaultRegistry from which vault addresses, lifecycle status, and
router-eligibility state are read.


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
Ordered list of vaults included in the voted (active) weight
vector. Set by governance on a successful proposal execution
via `setWeights`. Empty until the first vote passes.


```solidity
address[] private _weightVaultList
```


### _weightBps
Weight in basis points for each vault in `_weightVaultList`.
Parallel array — must always sum to BPS_DENOMINATOR.


```solidity
uint256[] private _weightBps
```


### votedWeightsActive
True when the voted weight vector is in effect. False means the
router falls back to `defaultWeights` (the on-chain below-quorum
fallback). Set true by `setWeights`, set false by
`clearVotedWeights`. See ADR-0002.


```solidity
bool public votedWeightsActive
```


### _defaultWeightVaultList
Ordered list of vaults included in the default (fallback) weight
vector. Used by `previewDeposit`/`deposit` whenever the voted
vector is not active — i.e. no proposal has ever passed or
governance has reverted to the default after a failed quorum.
Admin-settable; survives proposal execution unchanged. ADR-0002.


```solidity
address[] private _defaultWeightVaultList
```


### _defaultWeightBps
Weight in basis points for each vault in `_defaultWeightVaultList`.
Parallel array — must always sum to BPS_DENOMINATOR.


```solidity
uint256[] private _defaultWeightBps
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
VaultRegistry and must be marked router-eligible there. The bps
values must sum to exactly BPS_DENOMINATOR.
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


### setDefaultWeights

Set the default (below-quorum fallback) weight vector. Used by
`previewDeposit`/`deposit` whenever the voted vector is not
active — when no proposal has ever passed, or governance has
reverted to the default after a proposal failed quorum. This
vector survives proposal execution unchanged. ADR-0002.
All vaults must be registered AND router-eligible, the bps must
sum to BPS_DENOMINATOR, and the length must equal the registry's
router-eligible vault count so the default can never go stale
relative to eligibility. Restricted to `ADMIN_ROLE` (reached via
the Safe -> Timelock -> ADMIN_ROLE path).


```solidity
function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered list of vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array in basis points (must sum to 10 000).|


### clearVotedWeights

Clear the voted weight vector and revert routing to
`defaultWeights`. Intended for governance to fall back to the
default after the most recent proposal failed quorum. Restricted
to `ADMIN_ROLE`. ADR-0002.


```solidity
function clearVotedWeights() external onlyRole(ADMIN_ROLE);
```

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

### _executeLegs

Execute one vault leg per entry: enforce Active status, per-vault
cap, runtime router-eligibility, approve and deposit, then check
the slippage floor. All-or-revert. Writes minted shares into
`sharesPerLeg`.


```solidity
function _executeLegs(
    address receiver,
    address[] memory vaultList,
    uint256[] memory bpsList,
    uint256[] memory legAmounts,
    uint256[] calldata minSharesPerLeg,
    uint256[] memory sharesPerLeg
) internal;
```

### getWeights

Return the voted (active) weight vector (vault list and bps).
This is the raw voted vector and is empty until a proposal has
passed; use `getEffectiveWeights` for the vector the router
actually routes by.


```solidity
function getWeights() external view returns (address[] memory vaults, uint256[] memory bps);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array in basis points.|


### getDefaultWeights

Return the default (below-quorum fallback) weight vector.


```solidity
function getDefaultWeights()
    external
    view
    returns (address[] memory vaults, uint256[] memory bps);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array in basis points.|


### getEffectiveWeights

Return the effective weight vector the router actually routes
by: the voted vector when active, otherwise the default vector.
This is the single source of truth the public allocation surface
(robotmoney.net/allocation) renders. ADR-0002.


```solidity
function getEffectiveWeights()
    external
    view
    returns (address[] memory vaults, uint256[] memory bps);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array in basis points.|


### defaultWeightsLength

Number of legs in the default weight vector. Read by
`VaultRegistry.setRouterEligible` to block eligibility changes
that would leave the default with a stale length. ADR-0002.


```solidity
function defaultWeightsLength() external view returns (uint256);
```

### _effectiveWeights

Return the storage vectors the router routes by: the voted vector
when `votedWeightsActive`, otherwise the default vector.


```solidity
function _effectiveWeights()
    internal
    view
    returns (address[] storage vaults, uint256[] storage bps);
```

### _effectiveWeightsMemory

Memory copy of `_effectiveWeights`, used on the deposit path so the
storage pointers do not stay live across the whole function body.


```solidity
function _effectiveWeightsMemory()
    internal
    view
    returns (address[] memory vaults, uint256[] memory bps);
```

### isRouterEligible

Return true if `vault` is router-eligible: it exposes an
ERC-4626 `asset()` view equal to the router's USDC AND the
VaultRegistry has marked the vault as router-eligible.
This view is intentionally distinct from VaultRegistry
lifecycle status (Active/Paused/Retired); clients (dapp,
rmpc) read both signals to compose accurate UI state.


```solidity
function isRouterEligible(address vault) external view returns (bool eligible);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of the vault to check.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`eligible`|`bool`|True iff the vault's ERC-4626 asset equals the router's USDC and the registry eligibility flag is set.|


### _requireRouterEligible

Revert unless `vault` exposes an ERC-4626 `asset()` view equal to
`usdc` AND the VaultRegistry has marked the vault as
router-eligible. Used by `setWeights` and `_depositTo` to enforce
router-eligibility at both configuration and runtime.


```solidity
function _requireRouterEligible(address vault) internal view;
```

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
Emitted when the voted weight vector is updated.


```solidity
event WeightsSet(address[] vaults, uint256[] bps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| New ordered list of vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array (must sum to BPS_DENOMINATOR).|

### DefaultWeightsSet
Emitted when the default (below-quorum fallback) weight vector
is updated by ADMIN_ROLE.


```solidity
event DefaultWeightsSet(address[] vaults, uint256[] bps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| New ordered list of vault addresses.|
|`bps`|`uint256[]`|    Parallel weight array (must sum to BPS_DENOMINATOR).|

### VotedWeightsCleared
Emitted when the voted weight vector is cleared and the router
reverts to the default weight vector.


```solidity
event VotedWeightsCleared();
```

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
No weight vector has been set; cannot deposit. Raised when the
voted vector is inactive AND no default weight vector has been
configured, so there is no effective allocation to route by.


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

### VaultAssetMismatch
A vault's ERC-4626 `asset()` does not match the router's USDC.
Router refuses to weight or deposit into vaults whose underlying
asset is anything other than the configured router USDC.


```solidity
error VaultAssetMismatch(address vault, address vaultAsset);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|      The router-ineligible vault address.|
|`vaultAsset`|`address`| The vault's reported `asset()` address.|

### VaultAssetUnreadable
A vault did not expose a callable ERC-4626 `asset()` view, so
router eligibility cannot be verified. The router refuses to
interact with such vaults.


```solidity
error VaultAssetUnreadable(address vault);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|The vault address whose `asset()` call reverted.|

### VaultNotRouterEligible
A vault has not been marked router-eligible in the
VaultRegistry (`isRouterEligible(vault) == false`).
Production-readiness is registry state set by ADMIN_ROLE on
the registry — environments differ only by which vaults the
operator has opted in. A fresh registration is gated by
default until governance audits the vault and calls
`VaultRegistry.setRouterEligible(vault, true)`.
See `docs/development/single-production-codebase.md`.


```solidity
error VaultNotRouterEligible(address vault);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|The vault address that lacks the eligibility flag.|

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

