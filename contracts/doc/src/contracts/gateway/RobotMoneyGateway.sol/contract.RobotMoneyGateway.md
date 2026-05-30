# RobotMoneyGateway
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/64169d1d4c5fd64418418d518fe4d696b2319b88/contracts/gateway/RobotMoneyGateway.sol)

**Inherits:**
[AccessRoles](/contracts/gateway/AccessRoles.sol/abstract.AccessRoles.md), ReentrancyGuard, [IGateway](/contracts/gateway/interfaces/IGateway.sol/interface.IGateway.md)

**Title:**
RobotMoneyGateway

Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
the agent, enforces per-agent caps and a per-window gross cap,
calls the vault, and routes the resulting `rmUSDC` shares to a
per-agent configured receiver.

Implements `docs/implementation-plan.md` §2.2. Custom errors only;
OZ v5 SafeERC20; the gateway must never custody `rmUSDC`. Idempotency
hash deliberately excludes `deadline`.


## Constants
### WINDOW_SECONDS
Window length in seconds for per-window gross caps. Unix-epoch
aligned: `windowId = block.timestamp / WINDOW_SECONDS`.


```solidity
uint64 public constant WINDOW_SECONDS = 86400
```


### MAX_DEADLINE_SKEW
Maximum future skew permitted on `deadline` arguments.


```solidity
uint256 public constant MAX_DEADLINE_SKEW = 600
```


### COMMIT_EXPIRY_BLOCKS
Number of blocks after which an unrevealed commitment expires.
After `commitBlock + COMMIT_EXPIRY_BLOCKS` the commitment can
no longer be revealed and the depositor must re-commit.


```solidity
uint256 public constant COMMIT_EXPIRY_BLOCKS = 256
```


### usdcToken
Pinned USDC token.


```solidity
IERC20 public immutable usdcToken
```


### vaultContract
Pinned ERC-4626 vault.


```solidity
IERC4626 public immutable vaultContract
```


### routerContract
Portfolio Router for multi-vault agent deposits. May be `address(0)`
if the gateway was deployed without router support.


```solidity
IPortfolioRouter public immutable routerContract
```


## State Variables
### commitments
Pending commitments keyed by `commitHash =
keccak256(abi.encode(agent, depositor, salt))`. Cleared on reveal.


```solidity
mapping(bytes32 => Commitment) public commitments
```


### agents
Per-agent policy. Keyed on the agent's signing address.


```solidity
mapping(address => AgentPolicy) public agents
```


### agentOwner
Recorded owner (depositor EOA) for each agent. Set on the
first `authorizeAgent` call; cleared on `revokeAgent`. Used to
gate `setPolicy` and `revokeAgent` so each depositor is the
sole authority over her own agent (issue #269).


```solidity
mapping(address => address) public agentOwner
```


### agentWindowGross
Per-agent calendar-window gross deposit. Deprecated in issue #497
— the gateway stopped writing new values when rolling-window
deposit accounting was introduced. Retained only for ABI
compatibility with off-chain indexers that may still read it.
Use `agentDepositWindow` and `effectiveDepositWindowGross` instead.


```solidity
mapping(address => mapping(uint64 => uint256)) public agentWindowGross
```


### agentDepositWindow
Per-agent rolling deposit window state. See `DepositWindow`.


```solidity
mapping(address => DepositWindow) public agentDepositWindow
```


### agentWithdrawWindow
Per-agent rolling withdrawal window state. See `WithdrawWindow`.


```solidity
mapping(address => WithdrawWindow) public agentWithdrawWindow
```


### usedPaymentIds
Replay protection. `paymentId => used`.


```solidity
mapping(bytes32 => bool) public usedPaymentIds
```


### _paused
Stop-the-world flag.


```solidity
bool private _paused
```


## Functions
### constructor


```solidity
constructor(IERC20 usdc_, IERC4626 vault_, address admin_, address pauser_, address router_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdc_`|`IERC20`|   USDC (or 6-decimal stand-in) token address.|
|`vault_`|`IERC4626`|  ERC-4626 vault whose `asset()` MUST equal `usdc_`.|
|`admin_`|`address`|  Holder of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.|
|`pauser_`|`address`| Holder of `PAUSER_ROLE`. Must be distinct from agents.|
|`router_`|`address`| Portfolio Router address, or `address(0)` to deploy without router support (single-vault mode).|


### usdc

Pinned USDC token address.


```solidity
function usdc() external view returns (address);
```

### vault

Pinned ERC-4626 vault address.


```solidity
function vault() external view returns (address);
```

### router

Portfolio Router address, or `address(0)` if not configured.


```solidity
function router() external view returns (address);
```

### paused

Whether the gateway is currently paused.


```solidity
function paused() external view returns (bool);
```

### effectiveWithdrawWindowGross

Cumulative vault shares the agent has redeemed in the current
rolling withdrawal window. Returns zero when the agent has
either never withdrawn or the last anchor lies more than
`WINDOW_SECONDS` in the past. Use this — not the raw
`agentWithdrawWindow` storage tuple — to project whether the
next withdrawal would breach `maxWithdrawPerWindow` (issue
#449).


```solidity
function effectiveWithdrawWindowGross(address agent) external view returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|The agent address to look up.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`|The agent's cumulative rolling-window withdrawal gross.|


### effectiveDepositWindowGross

Cumulative USDC the agent has deposited in the current rolling
deposit window. Returns zero when the agent has either never
deposited or the last anchor lies more than `WINDOW_SECONDS` in
the past. Use this — not the deprecated `agentWindowGross`
mapping — to project whether the next deposit would breach
`maxPerWindow` (issue #497).


```solidity
function effectiveDepositWindowGross(address agent) external view returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|The agent address to look up.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`uint256`|The agent's cumulative rolling-window deposit gross.|


### _accrueRollingWithdraw

Apply a `shares` redemption against the agent's rolling-window
withdrawal budget (#449). Reverts with `WithdrawWindowCapExceeded`
when the projected cumulative draw would breach `cap`. On success
writes the updated `WithdrawWindow` to storage. Extracted from
`withdraw` to keep the entrypoint within EVM stack-depth limits.


```solidity
function _accrueRollingWithdraw(address agent, uint256 shares, uint256 cap) internal;
```

### _accrueRollingDeposit

Apply an `amount` deposit against the agent's rolling-window deposit
budget (#497). Reverts with `WindowCapExceeded` when the projected
cumulative deposit would breach `cap`. On success writes the updated
`DepositWindow` to storage. Mirrors `_accrueRollingWithdraw` so
the deposit side is equally hardened against calendar-boundary bursts.


```solidity
function _accrueRollingDeposit(address agent, uint256 amount, uint256 cap) internal;
```

### commitAuthorization

Phase-1 of the two-phase commit/reveal agent authorization.
Submit `commitHash = keccak256(abi.encode(agent, msg.sender, salt))`
to reserve the agent address. Must wait at least one block
before revealing. The commitment expires after
`COMMIT_EXPIRY_BLOCKS` blocks.

Permissionless. Any EOA may commit. The hash binds the agent
address, the caller identity, and a caller-chosen salt so that
a mempool observer cannot front-run the reveal with a different
depositor address.


```solidity
function commitAuthorization(bytes32 commitHash) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`commitHash`|`bytes32`|`keccak256(abi.encode(agent, msg.sender, salt))`.|


### revealAuthorization

Phase-2 of the two-phase commit/reveal agent authorization.
Reveal `agent` and `salt` to validate the prior commitment and
authorize the agent with the supplied policy. Reverts if no
prior commitment matches, if the commitment has expired, if
`msg.sender` is not the original committer, or if the hash
does not match.

Must be called at least one block after `commitAuthorization`.


```solidity
function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`| The agent address to authorize (must not already be owned).|
|`salt`|`bytes32`|  The caller-chosen salt used when building `commitHash`.|
|`p`|`AgentPolicy`|     Initial policy parameters.|


### authorizeAgent

First-time authorization for `agent`. Permissionless — any EOA
may call to register their own agent. `msg.sender` is recorded
as the agent's owner. Reverts if `agent` already has a
recorded owner; that owner must call `setPolicy` to update or
`revokeAgent` to release.


```solidity
function authorizeAgent(address agent, AgentPolicy calldata p) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|The agent address to authorize (must not already be owned).|
|`p`|`AgentPolicy`|    Initial policy parameters.|


### _authorizeAgentInternal

Shared authorization logic for both `authorizeAgent` (direct) and
`revealAuthorization` (commit/reveal path). Extracted to avoid code
duplication and to keep each entrypoint concise.


```solidity
function _authorizeAgentInternal(address agent, AgentPolicy calldata p) internal;
```

### setPolicy

Update the policy for an agent the caller already owns.
Reverts if `msg.sender` is not the recorded owner of `agent`.


```solidity
function setPolicy(address agent, AgentPolicy calldata p) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|The agent address whose policy to update.|
|`p`|`AgentPolicy`|    New policy parameters.|


### revokeAgent

Revoke an agent. Reverts if `msg.sender` is not the recorded
owner. Clears policy, role, and owner record.


```solidity
function revokeAgent(address agent) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|The agent address whose policy and role are revoked.|


### _validatePolicy

Internal policy-shape validator shared by `authorizeAgent` and
`setPolicy`. Custom errors match the previous public surface
so downstream clients (rmpc, dapp) keep the same revert
vocabulary across the depositor-owned redesign.


```solidity
function _validatePolicy(AgentPolicy calldata p) internal view;
```

### pause

Stop-the-world pause. Restricted to `PAUSER_ROLE`.


```solidity
function pause() external onlyRole(PAUSER_ROLE);
```

### unpause

Resume operations. Restricted to `ADMIN_ROLE` (asymmetric).
`ADMIN_ROLE` is retained as a protocol-wide kill-switch
counterweight to `pause`; it has no authority over any
agent's lifecycle.


```solidity
function unpause() external onlyRole(ADMIN_ROLE);
```

### deposit

Pull `amount` USDC from caller, deposit into the vault, route
resulting shares to the agent's configured `shareReceiver`.

Implements §2.2 steps 1–12. Effects (`usedPaymentIds`, rolling
deposit window) are written before external calls (CEI pattern).
`nonReentrant` provides defense-in-depth.


```solidity
function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
    external
    nonReentrant
    onlyRole(AGENT_ROLE)
    returns (bytes32 paymentId, uint256 sharesMinted);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`orderId`|`bytes32`|         Caller-supplied order identifier (echoed in event).|
|`amount`|`uint256`|          Gross USDC amount, in 6-decimal base units.|
|`deadline`|`uint64`|        Hard expiry; must be `<= block.timestamp + 600`.|
|`idempotencyKey`|`bytes32`|  Caller-side dedup salt mixed into `paymentId`.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Hash committing chain/contract/agent/order/amount/key.|
|`sharesMinted`|`uint256`|   Vault shares minted to `shareReceiver`.|


### depositTo

Pull `amount` USDC from caller, route to `destination` (vault or
Portfolio Router), and deliver resulting shares to the agent's
configured `shareReceiver`. When `destination` is the router,
`minSharesPerLeg` provides per-leg slippage protection.

Routes to a specific `destination` (vault or Portfolio Router). All the
same caps, deadline, idempotency, and policy checks as `deposit` apply.
When `destination` is the router, `minSharesPerLeg` is forwarded to
`router.depositFor(shareReceiver, amount, minSharesPerLeg)` and shares
are minted directly to `shareReceiver`. When `destination` is a vault,
it behaves identically to `deposit` except the vault is user-specified
and must pass the allowedDestinations check.


```solidity
function depositTo(
    bytes32 orderId,
    uint256 amount,
    uint64 deadline,
    bytes32 idempotencyKey,
    address destination,
    uint256[] calldata minSharesPerLeg
) external nonReentrant onlyRole(AGENT_ROLE) returns (bytes32 paymentId);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`orderId`|`bytes32`|         Caller-supplied order identifier (echoed in event).|
|`amount`|`uint256`|          Gross USDC amount, in 6-decimal base units.|
|`deadline`|`uint64`|        Hard expiry; must be `<= block.timestamp + 600`.|
|`idempotencyKey`|`bytes32`|  Caller-side dedup salt mixed into `paymentId`.|
|`destination`|`address`|     Vault address or Portfolio Router address.|
|`minSharesPerLeg`|`uint256[]`| Per-leg slippage floor (router path only). Pass empty array when routing to a single vault.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Hash committing chain/contract/agent/order/amount/key.|


### _validateDestination

Validates `destination` against the pinned vault and router, and
enforces the policy allowedDestinations whitelist when non-empty.
Returns `true` when destination is the router, `false` for a vault.


```solidity
function _validateDestination(address destination, address[] memory allowedDestinations)
    internal
    view
    returns (bool isRouter);
```

### _executeDeposit

Dispatches to router or vault deposit execution based on `args.isRouter`.
Separated into two internal calls to give viaIR coverage instrumentation
a reliable source-map anchor for each path.


```solidity
function _executeDeposit(DepositArgs memory args, uint256[] calldata minSharesPerLeg) internal;
```

### _executeRouterDeposit

Router-path deposit: approve router, call `depositFor`, clear allowance,
check USDC custody invariant, emit event.


```solidity
function _executeRouterDeposit(DepositArgs memory args, uint256[] calldata minSharesPerLeg)
    internal;
```

### _executeVaultDeposit

Vault-path deposit: pre-call share custody check, approve vault, deposit,
clear allowance, post-call custody invariants, emit event.


```solidity
function _executeVaultDeposit(DepositArgs memory args) internal;
```

### withdraw

Redeem `shares` from `sourceVault` on behalf of the agent's
configured depositor. USDC proceeds are sent only to the
policy-configured `assetRecipient` — the agent cannot redirect
funds. The gateway pulls shares from `msg.sender` via
`transferFrom` (agent must have approved the gateway).

The agent must have approved the gateway to spend its vault shares
before calling this function. The gateway pulls shares via
`transferFrom(agent, gateway, shares)`, calls `vault.redeem`, and
forwards USDC only to `policy.assetRecipient`. CEI pattern: state
effects written before external calls. `nonReentrant` provides
defense-in-depth.


```solidity
function withdraw(
    bytes32 orderId,
    uint256 shares,
    address sourceVault,
    uint64 deadline,
    bytes32 idempotencyKey
) external nonReentrant onlyRole(AGENT_ROLE) returns (bytes32 paymentId, uint256 assetsOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`orderId`|`bytes32`|         Caller-supplied order identifier (echoed in event).|
|`shares`|`uint256`|          Vault shares to redeem.|
|`sourceVault`|`address`|     Vault address to redeem from.|
|`deadline`|`uint64`|        Hard expiry; must be `<= block.timestamp + 600`.|
|`idempotencyKey`|`bytes32`|  Caller-side dedup salt mixed into `paymentId`.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Hash committing chain/contract/agent/order/shares/key.|
|`assetsOut`|`uint256`|      USDC transferred to `assetRecipient`.|


## Errors
### ZeroAddress
Constructor or admin call passed `address(0)` where a real address is required.


```solidity
error ZeroAddress();
```

### AssetMismatch
Constructor-time check: vault.asset() does not match the configured USDC token.


```solidity
error AssetMismatch();
```

### PausedError
Operation rejected because the gateway is paused (also re-thrown by `pause()` if already paused).


```solidity
error PausedError();
```

### NotPaused
`unpause()` called while the gateway was not paused.


```solidity
error NotPaused();
```

### InvalidAmount
Deposit amount is zero, or `authorizeAgent` policy has zero/inverted per-payment vs per-window caps.


```solidity
error InvalidAmount();
```

### AmountExceedsPerPaymentCap
Deposit amount exceeds the agent's `maxPerPayment` cap.


```solidity
error AmountExceedsPerPaymentCap();
```

### DeadlineExpired
`block.timestamp > deadline` — the signed transaction's deadline has already passed.


```solidity
error DeadlineExpired();
```

### DeadlineTooFar
`deadline` is more than `MAX_DEADLINE_SKEW` seconds in the future.


```solidity
error DeadlineTooFar();
```

### AgentNotAuthorized
Agent has no active policy (defensive — unreachable through current public API).


```solidity
error AgentNotAuthorized();
```

### AgentPolicyExpired
Agent's policy `validUntil` is in the past.


```solidity
error AgentPolicyExpired();
```

### WindowCapExceeded
Cumulative deposits in the current window would exceed `maxPerWindow`.


```solidity
error WindowCapExceeded();
```

### PaymentIdAlreadyUsed
Idempotency: this `paymentId` has already been consumed by a prior deposit.


```solidity
error PaymentIdAlreadyUsed();
```

### FeeOnTransferDetected
USDC `safeTransferFrom` delivered fewer tokens than requested (fee-on-transfer or rebasing token).


```solidity
error FeeOnTransferDetected();
```

### ShareCustodyInvariantViolated
Pre/post-call invariant: gateway must never custody vault shares or leftover USDC across the call frame.


```solidity
error ShareCustodyInvariantViolated();
```

### InvalidShareReceiver
`authorizeAgent` policy specifies `shareReceiver == address(0)`.


```solidity
error InvalidShareReceiver();
```

### InvalidValidUntil
`authorizeAgent` policy is inactive or `validUntil` is already in the past.


```solidity
error InvalidValidUntil();
```

### NotAgentOwner
Caller is not the recorded owner of the target agent. Raised by
`setPolicy` and `revokeAgent` when `msg.sender != agentOwner[agent]`.


```solidity
error NotAgentOwner();
```

### AgentAlreadyOwned
`authorizeAgent` called on an agent that already has a recorded
owner. The existing owner must call `setPolicy` to update or
`revokeAgent` to release the address before a new authorization.


```solidity
error AgentAlreadyOwned();
```

### CommitmentNotFound
`revealAuthorization` called but no prior commitment exists for
this commit hash. The depositor must call `commitAuthorization`
first and wait at least one block.


```solidity
error CommitmentNotFound();
```

### CommitmentExpired
`revealAuthorization` called after the commitment has expired
(block.number > commitBlock + COMMIT_EXPIRY_BLOCKS).


```solidity
error CommitmentExpired();
```

### CommitmentOwnerMismatch
`revealAuthorization` called from a different address than the
one that submitted the commitment.


```solidity
error CommitmentOwnerMismatch();
```

### CommitmentHashMismatch
`revealAuthorization` called but `keccak256(agent, msg.sender, salt)`
does not match the stored commitment hash.


```solidity
error CommitmentHashMismatch();
```

### CommitmentTooRecent
`revealAuthorization` called in the same block as the commitment.
Must wait at least one block before revealing.


```solidity
error CommitmentTooRecent();
```

### InvalidDestination
`depositTo` was called with a destination not in the agent's
`allowedDestinations` list (when the list is non-empty), or the
destination is neither the pinned vault nor the router.


```solidity
error InvalidDestination();
```

### WithdrawalNotEnabled
`withdraw()` called but the agent's policy has withdrawal disabled
(`maxWithdrawPerPayment == 0`).


```solidity
error WithdrawalNotEnabled();
```

### SharesExceedWithdrawPerPaymentCap
`withdraw()` shares argument exceeds `maxWithdrawPerPayment` cap.


```solidity
error SharesExceedWithdrawPerPaymentCap();
```

### WithdrawWindowCapExceeded
`withdraw()` cumulative shares in the current window would exceed `maxWithdrawPerWindow`.


```solidity
error WithdrawWindowCapExceeded();
```

### InvalidSourceVault
`withdraw()` called with a `sourceVault` not in the agent's
`allowedSourceVaults` list (when the list is non-empty), or the
vault is not the pinned vault.


```solidity
error InvalidSourceVault();
```

### InvalidAssetRecipient
`withdraw()` policy has `assetRecipient == address(0)`.


```solidity
error InvalidAssetRecipient();
```

### UnexpectedAssetsReceived
`withdraw()` USDC balance did not increase by the expected amount,
indicating a malicious or fee-on-transfer vault.


```solidity
error UnexpectedAssetsReceived();
```

## Structs
### Commitment
Pending authorization commitment. Stored by commitHash to allow
the depositor to reveal in a subsequent block, defeating
mempool front-running of `authorizeAgent`.


```solidity
struct Commitment {
    address committer;
    uint64 blockNumber;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`committer`|`address`|  EOA that submitted the commitment (`msg.sender` at commit time).|
|`blockNumber`|`uint64`|Block number at which the commitment was submitted.|

### DepositWindow
Per-agent rolling-window deposit accounting (issue #497).
Mirrors the withdrawal rolling-window pattern (`agentWithdrawWindow`)
to eliminate the fixed-window boundary burst on the deposit side.
An agent cannot deposit more than `maxPerWindow` in any contiguous
`WINDOW_SECONDS`-wide interval regardless of calendar boundary.


```solidity
struct DepositWindow {
    uint64 windowStart;
    uint256 gross;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`windowStart`|`uint64`|Unix-seconds anchor of the agent's current rolling window. Zero when the agent has never deposited.|
|`gross`|`uint256`|      Cumulative USDC deposited since `windowStart`.|

### WithdrawWindow
Per-agent rolling-window withdrawal accounting (issue #449).
The withdrawal cap is enforced as a strict rolling window of
length `WINDOW_SECONDS`: at any time `t`, the cumulative shares
redeemed in the half-open interval `(windowStart, t]` may not
exceed `policy.maxWithdrawPerWindow`. `windowStart` is anchored
to the agent's first withdrawal in each rolling window and
advances to `block.timestamp` only after a full `WINDOW_SECONDS`
has elapsed with no further withdrawal — eliminating the
fixed-window boundary burst that allowed ~2× per-window draw
at calendar-aligned window edges.


```solidity
struct WithdrawWindow {
    uint64 windowStart;
    uint256 gross;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`windowStart`|`uint64`|Unix-seconds anchor of the agent's current rolling window. Zero when the agent has never withdrawn.|
|`gross`|`uint256`|      Cumulative shares redeemed since `windowStart`.|

### DepositArgs
Internal args struct to avoid stack-too-deep in `depositTo`.


```solidity
struct DepositArgs {
    bytes32 paymentId;
    bytes32 orderId;
    address shareReceiver;
    uint256 amount;
    address destination;
    uint64 windowId;
    uint256 balBefore;
    bool isRouter;
}
```

