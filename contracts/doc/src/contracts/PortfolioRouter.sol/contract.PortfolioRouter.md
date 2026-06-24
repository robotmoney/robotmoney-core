# PortfolioRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c509d0100d3df416d312069339974e56f8ecce75/contracts/PortfolioRouter.sol)

**Inherits:**
[AdminFloorAccessControl](/contracts/lib/AdminFloorAccessControl.sol/abstract.AdminFloorAccessControl.md), ReentrancyGuard

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
Basis-points denominator (10 000 = 100%). Sourced from the
shared `BpsMath.BPS_DENOMINATOR` so fee/weight math cannot drift.


```solidity
uint256 public constant BPS_DENOMINATOR = BpsMath.BPS_DENOMINATOR
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

RTR-6 / F-12 — SEMANTICS DECISION: `routerCap` is a PER-TRANSACTION sanity
bound, NOT a cumulative/windowed exposure limit. It bounds the size of any one
`deposit()` call (fat-finger / single-tx blast-radius protection); it does NOT
track or limit aggregate inflow across multiple calls, so a depositor can exceed
it over several transactions by design. Cumulative inflow throttling is the
gateway's responsibility via its rolling-window accounting (GW-4); the router cap
deliberately does not duplicate that state. Treat this value as a per-call upper
bound only when configuring it.


```solidity
uint256 public routerCap
```


### quarantineAddress
Destination for permissionless foreign-token sweeps (INV-1/INV-2).
Defaults to `ForeignTokenQuarantine.QUARANTINE`; settable only via
the TimelockController (ADMIN_ROLE, INV-3).


```solidity
address public quarantineAddress
```


### vaultCap
Per-vault USDC ceiling for a single `deposit()` leg.
0 means no cap enforced for that vault.

RTR-6 / F-12 — like `routerCap`, this is a PER-TRANSACTION per-leg sanity bound,
not a cumulative per-vault exposure limit (see `routerCap`). It bounds a single
deposit leg's size; aggregate per-vault exposure across calls is not tracked here.


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

### setQuarantineAddress

Update the quarantine address for foreign-token sweeps. Restricted
to `ADMIN_ROLE` (held by TimelockController in production — INV-3).


```solidity
function setQuarantineAddress(address newAddr) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newAddr`|`address`|New quarantine address. Must not be address(0).|


### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token held by the
router to the governed quarantine address (custody invariants
INV-1/INV-2).
The router moves zero USDC out via any admin path: under the
all-or-revert deposit/redeem semantics it never holds USDC across
transactions, and the old arbitrary-recipient `rescueUsdc` —
which forwarded USDC to a caller-supplied address — is DELETED
(INV-1). The only asset movement that remains is this permissionless
sweep of foreign (non-USDC) tokens to the timelock-gated
`quarantineAddress`; the destination is never caller-supplied.
Reverts when `token` is USDC.


```solidity
function sweepForeignToken(address token) external nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to quarantine. Must not be the router's USDC.|


### previewDeposit

Return per-vault estimated receipts for `amount` USDC without
executing any state changes. Non-depositable legs (paused/retired,
unregistered, router-ineligible, or over their per-vault cap) are
marked `unavailable = true` and return `estShares = 0`; the deposit
path skips exactly these legs and renormalises `amount` across the
remaining available legs. `legAmount` therefore reflects the
**renormalised** amount the leg would actually receive on execute,
so `previewDeposit` and the executed deposit never disagree on which
legs are available (RTR-5; findings F-13/NC-4).


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


### _availabilityAndAmounts

Compute, for the given weight vector and total `amount`, which legs
are depositable and the renormalised USDC each available leg receives.
A leg is available iff its registry status is `Active` and it is
router-eligible (asset == USDC + eligibility flag) — exactly the
availability dimension `previewDeposit` reports. The amount is split
across ONLY the available legs in proportion to their bps, with the
rounding remainder assigned to the last available leg so the router
holds zero USDC after a successful deposit. Unavailable legs get
amount 0. This single predicate is shared by `previewDeposit` and
`_executeLegs` so the two can never diverge on availability (RTR-5).
Per-vault caps are intentionally NOT an availability factor: a cap is a
hard per-tx operator bound (see F-12), not a "this vault is down"
signal, and silently redistributing a capped leg's allocation onto
other vaults would breach operator intent. A renormalised leg over its
cap therefore still reverts `VaultCapExceeded` at execute time rather
than being skipped.


```solidity
function _availabilityAndAmounts(
    address[] memory vaultList,
    uint256[] memory bpsList,
    uint256 amount
) internal view returns (bool[] memory available, uint256[] memory legAmounts);
```

### _isDepositable

Non-reverting predicate: is `vault` depositable right now (registry
status Active AND router-eligible)? Mirrors the reverting checks in
`_executeLeg`/`_requireRouterEligible` without reverting, so it can be
used to compute the shared availability set.


```solidity
function _isDepositable(address vault) internal view returns (bool);
```

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


### redeemFor

Redeem vault shares from an explicit, caller-supplied set of
vaults. For each leg the router calls
`vaults[i].redeem(sharesPerLeg[i], assetRecipient, shareHolder)`,
routing USDC directly to `assetRecipient`. The caller (typically
the gateway) must either be `shareHolder` itself — the gateway
pulls the user's shares into its own custody for the call frame
and passes itself as `shareHolder` — or hold an ERC-20 allowance
from `shareHolder` on each vault's share token covering that leg's
share count; otherwise the call reverts with `UnauthorizedRedeemer`
(confused-deputy guard, audit finding M-5).
EXIT SEMANTICS (issue #967, F-02/F-03/NC-5):
- Legs are driven by the explicit `vaults[]` argument, NOT the
live weight vector. A holder can therefore always redeem a
position the router has since reweighted away from (F-03);
the router never silently skips or reorders a named vault.
- `sharesPerLeg[i]` is identity-bound to `vaults[i]`: the redeem
targets exactly the address the caller named, so a reweight
between sign and execution can never redirect a leg to a vault
the caller did not name (NC-5).
- Redemption succeeds when a leg's registry status is Active OR
Retired; only Paused blocks the exit (F-02). Retired vaults are
withdraw-only, never deposit targets — see ADR-0009.
SECURITY: users must NEVER grant a share-token approval directly to
this router. The router calls `vault.redeem` with itself as the
vault-level spender, so a standing user→router approval would let
any holder-authorized caller burn the user's shares to an arbitrary
`assetRecipient`. Only the gateway's transient self-custody flow
(approve inside its own `nonReentrant` frame, clear afterwards) may
approve the router.
All legs must succeed (all-or-revert). No intermediate USDC custody
is created in the router — each vault sends USDC directly to
`assetRecipient`.


```solidity
function redeemFor(
    address shareHolder,
    address assetRecipient,
    address[] calldata vaults,
    uint256[] calldata sharesPerLeg,
    uint256[] calldata minAssetsPerLeg,
    uint256 deadline
) external nonReentrant returns (uint256[] memory assetsPerLeg);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`shareHolder`|`address`|      Address whose vault shares are redeemed (the `owner` passed to `vault.redeem`). Either equals the caller (gateway self-custody flow: shares pulled from the user and held only during the call frame), or must have approved the caller on each vault's share token for at least that leg's share count. Direct user approvals to this router are forbidden (see SECURITY note above).|
|`assetRecipient`|`address`|   Address that receives redeemed USDC. The router forwards each leg's USDC here; it never custodies USDC.|
|`vaults`|`address[]`|           Explicit, caller-supplied list of vault addresses to redeem from. Each must be registered in the VaultRegistry. Drives the redeem legs directly, so a reweighted-out or retired position remains reachable (F-03). `sharesPerLeg[i]`/`minAssetsPerLeg[i]` bind to `vaults[i]` (identity binding, NC-5).|
|`sharesPerLeg`|`uint256[]`|     Shares to redeem per leg (parallel to `vaults`). Length must match `vaults`. Zero-share legs are accepted (and skipped) so the caller can specify partial positions.|
|`minAssetsPerLeg`|`uint256[]`|  Per-leg minimum USDC out (slippage floor), parallel to `vaults`. Mirrors the deposit path's `minSharesPerLeg`: each non-zero leg reverts with `SlippageExceeded` if realized proceeds fall below the floor. Length must match `vaults`. A floor of 0 disables the check for that leg.|
|`deadline`|`uint256`|         Unix timestamp after which the call reverts with `DeadlineExpired`. Pass `type(uint256).max` to disable.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`assetsPerLeg`|`uint256[]`|    USDC received per leg (parallel to `vaults`).|


### _redeemLeg

Redeem a single leg: validate registry status and the confused-deputy
guard, call `vault.redeem`, then enforce the per-leg slippage floor
(finding L-8). Extracted from `redeemFor` to bound stack depth.


```solidity
function _redeemLeg(
    address vault,
    address shareHolder,
    address assetRecipient,
    uint256 shares,
    uint256 minAssets
) private returns (uint256 assetsOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|      Vault whose shares are redeemed.|
|`shareHolder`|`address`|Owner of the shares (the `owner` passed to `vault.redeem`).|
|`assetRecipient`|`address`|Address that receives the leg's USDC.|
|`shares`|`uint256`|     Shares to redeem on this leg (caller guarantees > 0).|
|`minAssets`|`uint256`|  Per-leg minimum USDC out; reverts `SlippageExceeded` below it.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`assetsOut`|`uint256`| Realized USDC for this leg.|


### _depositTo

Internal allocation logic shared by `deposit` and `depositFor`.


```solidity
function _depositTo(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
    internal
    returns (uint256[] memory sharesPerLeg);
```

### _executeLegs

Execute one available vault leg per entry: approve and deposit, then
check the slippage floor. Unavailable legs (per the shared
`_availabilityAndAmounts` pass) are skipped — matching
`previewDeposit` (RTR-5). Available legs are guaranteed depositable by
that pass; `_executeLeg` re-asserts eligibility as defence in depth.
All available legs must succeed (all-or-revert across the surviving
set). Writes minted shares into `sharesPerLeg`.


```solidity
function _executeLegs(
    address receiver,
    address[] memory vaultList,
    uint256[] memory bpsList,
    uint256[] memory legAmounts,
    bool[] memory available,
    uint256[] calldata minSharesPerLeg,
    uint256[] memory sharesPerLeg
) internal;
```

### _executeLeg

Execute a single available leg: re-assert Active status + per-vault
cap + runtime router-eligibility (defence in depth — the leg was
already vetted by `_availabilityAndAmounts`, but a vault could change
state between the read and here), approve, deposit, and emit. Extracted
from `_executeLegs` to bound stack depth.


```solidity
function _executeLeg(address receiver, address vault, uint256 legAmount, uint256 weightBps)
    private
    returns (uint256 sharesReceived);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`receiver`|`address`| Address that receives the minted shares.|
|`vault`|`address`|    Vault to deposit into (guaranteed available by the caller).|
|`legAmount`|`uint256`|Renormalised USDC for this leg.|
|`weightBps`|`uint256`|This leg's weight (event field only).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`sharesReceived`|`uint256`|Shares minted to `receiver`.|


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


### isRouterEligibleAndActive

Return true iff `vault` is router-eligible AND its registry
lifecycle status is `Active` — i.e. it can be written into a
weight vector and accept a routed deposit right now. This is the
exact predicate `setWeights`/`setDefaultWeights` enforce; governance
(`RouterGovernance.propose`) reads it so a proposal that would
render router deposits non-executable can never enter the voting
pipeline (GOV-4, no self-DoS). Never reverts: returns false for a
zero address, an EOA, an asset mismatch, an unregistered vault, or
any non-Active status.


```solidity
function isRouterEligibleAndActive(address vault) external view returns (bool ok);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of the vault to check.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`ok`|`bool`|True iff the vault is eligible AND Active.|


### _requireActiveAndEligible

Revert unless `vault` is registered, its registry status is `Active`,
AND it is router-eligible (asset == USDC + eligibility flag). This is
the single guard that a weight vector is only ever written when every
leg is simultaneously eligible AND depositable (F-05/RTR-4/GOV-4):
eligibility and lifecycle status are independent signals, so checking
eligibility alone would let an eligible-but-Paused/Retired vault enter
the vector and brick `deposit()` later. Used by `setWeights` and
`setDefaultWeights` at configuration time.


```solidity
function _requireActiveAndEligible(address vault) internal view;
```

### _requireRouterEligible

Revert unless `vault` exposes an ERC-4626 `asset()` view equal to
`usdc` AND the VaultRegistry has marked the vault as
router-eligible. Used by `_executeLegs` to enforce
router-eligibility at runtime.


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

### QuarantineAddressUpdated
Emitted when the quarantine address for foreign-token sweeps is updated.


```solidity
event QuarantineAddressUpdated(address indexed oldAddr, address indexed newAddr);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldAddr`|`address`|Previous quarantine address.|
|`newAddr`|`address`|New quarantine address.|

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

### MinAssetsLengthMismatch
`minAssetsPerLeg` length does not match the number of active legs.


```solidity
error MinAssetsLengthMismatch();
```

### SlippageExceeded
A vault returned fewer shares (deposit) or assets (redeem) than the
caller-supplied per-leg minimum.


```solidity
error SlippageExceeded();
```

### DeadlineExpired
The supplied `deadline` has passed (`block.timestamp > deadline`).


```solidity
error DeadlineExpired();
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

### VaultPausedForRedeem
A redeem leg targets a Paused vault. Redemption permits Active OR
Retired status (withdraw-only after retirement, F-02); only Paused
blocks the exit path.


```solidity
error VaultPausedForRedeem(address vault);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`| The vault address whose status is Paused.|

### RedeemVaultsLengthMismatch
The explicit `vaults[]` array supplied to `redeemFor` does not
match the length of `sharesPerLeg` (or `minAssetsPerLeg`). Each
redeem leg names exactly one vault address (NC-5 identity binding),
so the three arrays are strictly parallel.


```solidity
error RedeemVaultsLengthMismatch();
```

### RedeemVaultNotRegistered
A vault named in `redeemFor`'s explicit `vaults[]` is not
registered in the VaultRegistry. The redeem path drives legs from
the caller-supplied vault set (F-03), so each named vault must be
a registered vault whose lifecycle status the router can read.


```solidity
error RedeemVaultNotRegistered(address vault);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|The unregistered vault address named in a redeem leg.|

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

### UsdcCustodyInvariantViolated
After `_executeLegs` completes the router's USDC balance is
non-zero, meaning one or more vaults accepted less than their
allocated `legAmount`. The entire deposit is reverted so no
USDC is permanently stranded in the router.


```solidity
error UsdcCustodyInvariantViolated();
```

### UnauthorizedRedeemer
Caller is not the shareHolder and has insufficient ERC-20
allowance on the vault share token to redeem on its behalf.


```solidity
error UnauthorizedRedeemer(address shareHolder, address caller);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`shareHolder`|`address`| The owner of the vault shares.|
|`caller`|`address`|      The address that attempted the unauthorized redeem.|

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

