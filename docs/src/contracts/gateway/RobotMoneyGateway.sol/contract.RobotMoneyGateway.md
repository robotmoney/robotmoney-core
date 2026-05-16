# RobotMoneyGateway
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/gateway/RobotMoneyGateway.sol)

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
Per-agent windowed gross deposit. NOT shared across agents — each
agent has an independent allowance per window.


```solidity
mapping(address => mapping(uint64 => uint256)) public agentWindowGross
```


### agentWithdrawWindowGross
Per-agent windowed withdrawal gross (shares redeemed). Independent per agent per window.


```solidity
mapping(address => mapping(uint64 => uint256)) public agentWithdrawWindowGross
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

Implements §2.2 steps 1–12. Effects (`usedPaymentIds`, `agentWindowGross`) are
written before external calls (CEI pattern). `nonReentrant` provides defense-in-depth.


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

