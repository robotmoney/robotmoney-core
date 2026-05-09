# IGateway
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/gateway/interfaces/IGateway.sol)

**Title:**
IGateway

Minimal interface stub for the RobotMoney deposit gateway.

This is the surface downstream issues (#9 RobotMoneyGateway, #10 deploy
script, #13 forge tests) compile against. Keep it stable. Per the MVP
plan (`docs/implementation-plan.md` §2.2), the gateway exposes a
single state-mutating entrypoint for agents (`deposit`), admin
lifecycle calls, and a pause asymmetry (PAUSER pauses, ADMIN unpauses).


## Functions
### deposit

Pull `amount` USDC from caller, deposit into the vault, route
resulting shares to the agent's configured `shareReceiver`.

Restricted to `AGENT_ROLE`. Reverts when paused. See MVP §2.2 for
the full preflight checklist (caps, window, deadline, idempotency).


```solidity
function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
    external
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


### authorizeAgent

Set or replace the policy for `agent`. Restricted to `ADMIN_ROLE`.


```solidity
function authorizeAgent(address agent, AgentPolicy calldata p) external;
```

### revokeAgent

Disable policy for `agent`. Restricted to `ADMIN_ROLE`.


```solidity
function revokeAgent(address agent) external;
```

### pause

Stop-the-world pause. Restricted to `PAUSER_ROLE`.


```solidity
function pause() external;
```

### unpause

Resume operations. Restricted to `ADMIN_ROLE` (asymmetric).


```solidity
function unpause() external;
```

### WINDOW_SECONDS

Window length in seconds for per-window gross caps.


```solidity
function WINDOW_SECONDS() external view returns (uint64);
```

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

## Events
### AgentAuthorized

```solidity
event AgentAuthorized(
    address indexed agent,
    uint64 validUntil,
    uint256 maxPerPayment,
    uint256 maxPerWindow,
    address shareReceiver
);
```

### AgentRevoked

```solidity
event AgentRevoked(address indexed agent);
```

### Paused

```solidity
event Paused(address indexed by);
```

### Unpaused

```solidity
event Unpaused(address indexed by);
```

### AgentDeposit

```solidity
event AgentDeposit(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    address shareReceiver,
    uint256 amount,
    uint256 sharesMinted,
    uint64 windowId
);
```

## Structs
### AgentPolicy
Per-agent policy. Set by ADMIN via `authorizeAgent`.


```solidity
struct AgentPolicy {
    bool active;
    uint64 validUntil;
    uint256 maxPerPayment;
    uint256 maxPerWindow;
    address shareReceiver;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`active`|`bool`|        Policy is enabled.|
|`validUntil`|`uint64`|    Unix-seconds expiry; deposits revert at/after.|
|`maxPerPayment`|`uint256`| Maximum gross USDC per single `deposit` call.|
|`maxPerWindow`|`uint256`|  Maximum gross USDC per `WINDOW_SECONDS` window.|
|`shareReceiver`|`address`| Address that receives minted vault shares.|

