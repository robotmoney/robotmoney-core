# PortfolioRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/09526bad1d1fc83318c95c5e3ae875b62d6bb960/contracts/PortfolioRouter.sol)

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


### prototypeOverride
Per-vault override that allows a prototype vault (one that
returns `true` from `isPrototype()`) to be included in the
router weight vector and receive deposits. False by default —
a fresh deployment cannot accidentally route real USDC into a
slot0-priced prototype basket vault. Intended for devnet /
test deployments that intentionally exercise prototype
vaults, and for the eventual case where governance has
completed TWAP hardening but the contract still declares
itself a prototype. See issue #427 and
docs/code-reviews/review-codex-20260518-234945.md.


```solidity
mapping(address => bool) public prototypeOverride
```


### nonPrototypeAttested
Per-vault attestation that `vault` is intentionally
non-prototype despite NOT implementing the
`IPrototypeAware.isPrototype()` introspection view.
Without this attestation, a vault that omits the interface
would silently bypass the prototype gate because the
`isPrototype()` call would revert and be treated as
non-prototype. By requiring an explicit ADMIN_ROLE
attestation, governance opts a legacy or third-party vault
into router eligibility instead of relying on silent trust.
False by default for every address. See issue #447 and
the 2026-05-19 audit report (MEDIUM finding on silent
IPrototypeAware fall-through).


```solidity
mapping(address => bool) public nonPrototypeAttested
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

### setPrototypeOverride

Explicitly opt `vault` in (`allowed = true`) or out
(`allowed = false`) of router eligibility despite the vault
self-declaring as a prototype via `isPrototype() == true`.
The default is `false` for every address — a fresh
production deployment cannot accidentally weight a
slot0-priced basket vault. Intended for devnet / test
deployments, and for the post-TWAP-hardening transition
where governance has audited the prototype and accepts the
remaining risk. Restricted to `ADMIN_ROLE`.


```solidity
function setPrototypeOverride(address vault, bool allowed) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|  Vault address to mark as router-eligible despite prototype status.|
|`allowed`|`bool`|New override value. `true` lifts the prototype gate for this single vault; `false` re-engages it.|


### setNonPrototypeAttested

Attest (`attested = true`) or revoke (`attested = false`) the
non-prototype eligibility of `vault`. Required for any vault
that does NOT implement `IPrototypeAware.isPrototype()` —
without this attestation the router refuses to weight or
deposit into the vault, even though the (missing) interface
call would have silently returned false. This closes the
silent-trust fall-through reported as MEDIUM in the
2026-05-19 audit (see issue #447). Vaults that DO implement
`IPrototypeAware` do not need this attestation; their
self-declaration via `isPrototype()` is sufficient (subject
to the existing prototype-override gate). The default value
is `false` for every address — a fresh production deployment
cannot accidentally route USDC into a vault whose pricing
model the router cannot introspect. Restricted to
`ADMIN_ROLE`.


```solidity
function setNonPrototypeAttested(address vault, bool attested) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|   Vault address to attest as non-prototype.|
|`attested`|`bool`|New attestation value. `true` opts the vault into router eligibility; `false` revokes the attestation and re-engages the gate.|


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


### isRouterEligible

Return true if `vault` is router-eligible: it exposes an
ERC-4626 `asset()` view and that asset equals the router's USDC.
This is intentionally distinct from VaultRegistry status —
registry status describes lifecycle (Active/Paused/Retired)
while router eligibility describes asset compatibility with the
router's deposit flow. Clients (dapp, rmpc) read both to
present accurate state.


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
|`eligible`|`bool`|True if the vault's ERC-4626 asset equals the router's USDC; false if the asset differs or `asset()` reverts.|


### _requireRouterEligible

Revert unless `vault` exposes an ERC-4626 `asset()` view equal to
`usdc`. Used by `setWeights` and `_depositTo` to enforce
router-eligibility. See review-codex-20260518-234945.md §2.


```solidity
function _requireRouterEligible(address vault) internal view;
```

### _probePrototype

Probe the optional `IPrototypeAware.isPrototype()` view and
report both whether the interface is implemented and (if so)
the declared flag. Distinguishing "interface absent" from
"interface present and returns false" is what closes the
silent-trust fall-through from issue #447: callers can require
an explicit attestation for the absent case instead of
treating the revert as a non-prototype declaration.


```solidity
function _probePrototype(address vault)
    internal
    view
    returns (bool implementsInterface, bool prototypeFlag);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Vault address to probe.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`implementsInterface`|`bool`|True iff `isPrototype()` returned a bool without reverting.|
|`prototypeFlag`|`bool`|      The returned bool (only meaningful when `implementsInterface` is true).|


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

### PrototypeOverrideSet
Emitted when the prototype-eligibility override for `vault` is
toggled. `allowed = true` permits the prototype vault to be
weighted and to receive deposits; `false` (the default)
blocks router inclusion.


```solidity
event PrototypeOverrideSet(address indexed vault, bool oldValue, bool newValue);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|   Vault address whose override flag changed.|
|`oldValue`|`bool`|Previous override value.|
|`newValue`|`bool`|New override value.|

### NonPrototypeAttestedSet
Emitted when the non-prototype attestation flag for `vault`
is toggled. `attested = true` opts a vault that does not
implement `IPrototypeAware.isPrototype()` into router
eligibility; `false` (the default) blocks router inclusion
until governance explicitly attests the vault as non-prototype.


```solidity
event NonPrototypeAttestedSet(address indexed vault, bool oldValue, bool newValue);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|   Vault address whose attestation flag changed.|
|`oldValue`|`bool`|Previous attestation value.|
|`newValue`|`bool`|New attestation value.|

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

### VaultAssetMismatch
A vault's ERC-4626 `asset()` does not match the router's USDC.
Router refuses to weight or deposit into vaults whose underlying
asset is anything other than the configured router USDC. This is
the router-eligibility guard described in issue #426 / the
coin-theft path audit (review-codex-20260518-234945.md §2).


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

### VaultIsPrototype
A vault self-declares as a prototype (via `isPrototype()
returns true`) and has no explicit `prototypeOverride[vault]
= true`. Prototype basket vaults price NAV from Uniswap V3
`slot0`, which is manipulable inside a single block. They
MUST NOT receive router-routed USDC in production until TWAP
hardening is complete. Devnet / test deployments may opt in
by calling `setPrototypeOverride(vault, true)`. See issue
#427 and docs/code-reviews/review-codex-20260518-234945.md.


```solidity
error VaultIsPrototype(address vault);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|The prototype vault address that was rejected.|

### VaultEligibilityNotAttested
A vault does not implement the `IPrototypeAware.isPrototype()`
introspection view and has no explicit
`nonPrototypeAttested[vault] = true` attestation. Without the
interface, the prototype gate cannot self-verify the vault's
pricing model; without the attestation, governance has not
explicitly opted the vault into router eligibility. The
router refuses to weight or deposit into such vaults so that
omitting `IPrototypeAware` (intentionally or accidentally)
cannot silently bypass the prototype gate. ADMIN_ROLE can
attest the vault via `setNonPrototypeAttested(vault, true)`.
See issue #447 and audit-report.md (2026-05-19, MEDIUM).


```solidity
error VaultEligibilityNotAttested(address vault);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|The vault address that lacks IPrototypeAware and attestation.|

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

