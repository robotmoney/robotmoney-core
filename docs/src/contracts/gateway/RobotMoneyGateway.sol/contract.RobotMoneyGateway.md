# RobotMoneyGateway
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/gateway/RobotMoneyGateway.sol)

**Inherits:**
[AccessRoles](/contracts/gateway/AccessRoles.sol/abstract.AccessRoles.md), [IGateway](/contracts/gateway/interfaces/IGateway.sol/interface.IGateway.md)

**Title:**
RobotMoneyGateway

Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
the agent, enforces per-agent caps and a per-window gross cap,
calls the vault, and routes the resulting `rmUSDC` shares to a
per-agent configured receiver.

Implements `docs/implementation-plan.md` §2.2. Custom errors only;
OZ v5 SafeERC20; the gateway must never custody `rmUSDC`. Idempotency
hash deliberately excludes `deadline`.


## State Variables
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


### agents
Per-agent policy. Keyed on the agent's signing address.


```solidity
mapping(address => AgentPolicy) public agents
```


### agentWindowGross
Per-agent windowed gross. NOT shared across agents — each
agent has an independent allowance per window.


```solidity
mapping(address => mapping(uint64 => uint256)) public agentWindowGross
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
constructor(IERC20 usdc_, IERC4626 vault_, address admin_, address pauser_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdc_`|`IERC20`|  USDC (or 6-decimal stand-in) token address.|
|`vault_`|`IERC4626`| ERC-4626 vault whose `asset()` MUST equal `usdc_`.|
|`admin_`|`address`| Holder of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.|
|`pauser_`|`address`|Holder of `PAUSER_ROLE`. Must be distinct from agents.|


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

### paused

Whether the gateway is currently paused.


```solidity
function paused() external view returns (bool);
```

### authorizeAgent

Set or replace the policy for `agent`. Restricted to `ADMIN_ROLE`.


```solidity
function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE);
```

### revokeAgent

Disable policy for `agent`. Restricted to `ADMIN_ROLE`.


```solidity
function revokeAgent(address agent) external onlyRole(ADMIN_ROLE);
```

### pause

Stop-the-world pause. Restricted to `PAUSER_ROLE`.


```solidity
function pause() external onlyRole(PAUSER_ROLE);
```

### unpause

Resume operations. Restricted to `ADMIN_ROLE` (asymmetric).


```solidity
function unpause() external onlyRole(ADMIN_ROLE);
```

### deposit

Pull `amount` USDC from caller, deposit into the vault, route
resulting shares to the agent's configured `shareReceiver`.

Implements §2.2 steps 1–12 verbatim.


```solidity
function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
    external
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

