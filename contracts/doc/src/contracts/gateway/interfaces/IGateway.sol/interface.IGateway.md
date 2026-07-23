# IGateway
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/gateway/interfaces/IGateway.sol)

**Title:**
IGateway

Minimal interface stub for the RobotMoney deposit gateway.

Per the MVP plan (`Plan tracking issue #109` §2.2), the gateway
exposes a single state-mutating entrypoint for agents (`deposit`),
a permissionless depositor-owned authorize/revoke/policy surface
(`authorizeAgent`, `revokeAgent`, `setPolicy`), and a protocol-wide
pause asymmetry (PAUSER pauses, ADMIN unpauses) retained as a
kill-switch by the contract upgrader.
Authority model (see issue #269). Each depositor is the sole authority
over her own agent. `authorizeAgent` is callable by any EOA;
`msg.sender` is recorded as the agent's owner. Only that recorded
owner can update policy or revoke. The Robot Money team has no
runtime authority over any agent's lifecycle — `ADMIN_ROLE` is
reserved for protocol-wide kill switches (e.g. `unpause`) retained
by the contract upgrader for incident response.


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
|`paymentId`|`bytes32`|      keccak256(abi.encode(OP_DEPOSIT=1, chainId, gateway, agent, orderId, amount, idempotencyKey)) — op-kind prefix ensures deposit ids are disjoint from depositTo and withdraw ids.|
|`sharesMinted`|`uint256`|   Vault shares minted to `shareReceiver`.|


### depositTo

Pull `amount` USDC from caller, route to `destination` (vault or
Portfolio Router), and deliver resulting shares to the agent's
configured `shareReceiver`. When `destination` is the router,
`minSharesPerLeg` provides per-leg slippage protection.

Restricted to `AGENT_ROLE`. Reverts when paused. Enforces all the
same caps, deadline, idempotency, and policy checks as `deposit`.
`destination` must appear in the agent's `allowedDestinations` list
(or the list must be empty, in which case only the pinned vault or
the pinned router is accepted — no registry lookup is performed).


```solidity
function depositTo(
    bytes32 orderId,
    uint256 amount,
    uint64 deadline,
    bytes32 idempotencyKey,
    address destination,
    uint256[] calldata minSharesPerLeg
) external returns (bytes32 paymentId);
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
|`paymentId`|`bytes32`|      keccak256(abi.encode(OP_DEPOSIT_TO=3, chainId, gateway, agent, orderId, amount, idempotencyKey)) — op-kind prefix ensures depositTo ids are disjoint from deposit and withdraw ids.|


### withdraw

Redeem `shares` from `sourceVault` on behalf of the agent's
configured depositor. USDC proceeds are sent only to the
policy-configured `assetRecipient` — the agent cannot redirect
funds. The gateway pulls shares from `msg.sender` via
`transferFrom` (agent must have approved the gateway).

Restricted to `AGENT_ROLE`. Reverts when paused. Enforces all the
same deadline, idempotency, and policy checks as `deposit`. The
agent must approve the gateway to spend its vault shares before
calling this function.


```solidity
function withdraw(
    bytes32 orderId,
    uint256 shares,
    address sourceVault,
    uint64 deadline,
    bytes32 idempotencyKey
) external returns (bytes32 paymentId, uint256 assetsOut);
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
|`paymentId`|`bytes32`|      keccak256(abi.encode(OP_WITHDRAW=2, chainId, gateway, agent, orderId, shares, idempotencyKey)) — op-kind prefix ensures withdraw ids are disjoint from deposit and depositTo ids.|
|`assetsOut`|`uint256`|      USDC transferred to `assetRecipient`.|


### withdrawFromRouter

Redeem vault shares proportionally across all Portfolio Router
legs. Enforces the same policy checks (valid-until, per-payment
cap, window cap, allowed-source-vaults, pause, idempotency,
recipient) as single-vault `withdraw`. Each leg's vault must
appear in `policy.allowedSourceVaults` (when non-empty). USDC
is forwarded exclusively to the policy-configured `assetRecipient`.
`policy.shareReceiver` (the share holder) must have approved the
gateway for each vault's share token prior to calling. The
gateway temporarily holds the shares during the call frame and
passes them through to the router — no outer share token is
minted and no intermediate custody persists beyond the call.

Restricted to `AGENT_ROLE`. Reverts when paused. `totalShares` is
the sum of `sharesPerLeg` and is checked against
`maxWithdrawPerPayment` and the rolling window cap.


```solidity
function withdrawFromRouter(
    bytes32 orderId,
    address[] calldata vaults,
    uint256[] calldata sharesPerLeg,
    uint256[] calldata minAssetsPerLeg,
    uint64 deadline,
    bytes32 idempotencyKey
) external returns (bytes32 paymentId, uint256[] memory assetsPerLeg);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`orderId`|`bytes32`|         Caller-supplied order identifier (echoed in event).|
|`vaults`|`address[]`|          Explicit list of vault addresses to redeem from (issue #967, F-03). Drives the redeem legs directly instead of the router's live weight vector, so a holder can exit a reweighted-out or Retired position. `sharesPerLeg[i]` binds to `vaults[i]` (NC-5) and the array is committed to `paymentId`.|
|`sharesPerLeg`|`uint256[]`|    Vault shares to redeem per leg (parallel to `vaults`).|
|`minAssetsPerLeg`|`uint256[]`| Per-leg minimum USDC out (slippage floor), parallel to `vaults`/`sharesPerLeg`. The gateway forwards this floor straight to `PortfolioRouter.redeemFor`, which reverts each leg whose realized proceeds fall below it (GW-5 / F-11). A floor of 0 disables the check for that leg, but the caller is expected to pass a real, off-chain-computed minimum — the gateway no longer hardcodes an all-zero vector. Length must equal `sharesPerLeg`. The floor vector is folded into `paymentId` so a replay cannot re-execute the same order under a weaker floor.|
|`deadline`|`uint64`|        Hard expiry; must be `<= block.timestamp + 600`. The gateway forwards this same deadline to the router (no longer `type(uint256).max`), so the router's own deadline guard also bites (F-11).|
|`idempotencyKey`|`bytes32`|  Caller-side dedup salt mixed into `paymentId`.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Hash committing chain/contract/agent/order/totalShares/ vaults/sharesPerLeg/minAssetsPerLeg/key.|
|`assetsPerLeg`|`uint256[]`|   USDC received per leg.|


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

First-time authorization for `agent`. Admin-only — only callable
by `ADMIN_ROLE` (so the TimelockController retains agent-onboarding
authority after the deploy handover revokes the deployer's
`DEFAULT_ADMIN_ROLE`; see F-01 / ACL-1). Regular users must use
`commitAuthorization` + `revealAuthorization` instead.
`msg.sender` is recorded as the agent's owner. Reverts if
`agent` already has a recorded owner; that owner must call
`setPolicy` to update or `revokeAgent` to release.


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


### pause

Stop-the-world pause. Restricted to `PAUSER_ROLE`.


```solidity
function pause() external;
```

### unpause

Resume operations. Restricted to `ADMIN_ROLE` (asymmetric).
`ADMIN_ROLE` is retained as a protocol-wide kill-switch
counterweight to `pause`; it has no authority over any
agent's lifecycle.


```solidity
function unpause() external;
```

### setICPolicy

Set or update the Investment Committee policy contract address.
Restricted to `ADMIN_ROLE`. Pass `address(0)` to clear.


```solidity
function setICPolicy(address policy_) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`policy_`|`address`|Address of the deployed `InvestmentCommitteePolicy` contract, or `address(0)` to disable committee routing.|


### committeeRegister

Forward a committee agent registration to the IC policy contract.
Restricted to `ADMIN_ROLE`. Reverts if `icPolicy` is not set.


```solidity
function committeeRegister(address agent, string calldata agentId_) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|   Address to register on the IC contract.|
|`agentId_`|`string`|Human-readable label (e.g. "athena-v1").|


### committeeVoteSubmit

Forward a signed committee vote to the IC policy contract.
Restricted to `AGENT_ROLE`. Reverts if `icPolicy` is not set.


```solidity
function committeeVoteSubmit(IInvestmentCommitteePolicy.VoteParams calldata p)
    external
    returns (uint256 voteId);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`p`|`IInvestmentCommitteePolicy.VoteParams`| All vote fields packed into a `VoteParams` struct.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`voteId`|`uint256`| Index of the newly appended vote in the IC contract.|


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

### icPolicy

Investment Committee policy contract, or `address(0)` if not configured.


```solidity
function icPolicy() external view returns (IInvestmentCommitteePolicy);
```

### agentOwner

Recorded owner (depositor EOA) for `agent`, or `address(0)`
if no policy is recorded.


```solidity
function agentOwner(address agent) external view returns (address);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|The agent address whose recorded owner to look up.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`address`|The depositor EOA that authorized `agent`, or zero if none.|


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


## Events
### CommitSubmitted
Emitted when a depositor submits a commitment hash for a
future `revealAuthorization` call.


```solidity
event CommitSubmitted(
    address indexed committer, bytes32 indexed commitHash, uint64 blockNumber
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`committer`|`address`|   EOA that submitted the commitment (`msg.sender`).|
|`commitHash`|`bytes32`|  `keccak256(abi.encode(agent, committer, salt))`.|
|`blockNumber`|`uint64`| Block number at which the commitment was recorded.|

### CommitRevealed
Emitted when a depositor successfully reveals a commitment and
the agent is authorized.


```solidity
event CommitRevealed(
    address indexed committer, bytes32 indexed commitHash, address indexed agent
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`committer`|`address`|  EOA that revealed (must equal the original committer).|
|`commitHash`|`bytes32`| The commitment hash that was revealed and cleared.|
|`agent`|`address`|      Agent address that was authorized.|

### AgentAuthorized
Emitted when an agent's policy is created or updated.


```solidity
event AgentAuthorized(
    address indexed agent,
    address indexed owner,
    uint64 validUntil,
    uint256 maxPerPayment,
    uint256 maxPerWindow,
    address shareReceiver
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|         Agent address whose policy was set.|
|`owner`|`address`|         Depositor EOA that authorized the agent (`msg.sender` at first `authorizeAgent` call).|
|`validUntil`|`uint64`|    Policy expiry timestamp (Unix seconds).|
|`maxPerPayment`|`uint256`| Maximum USDC per single deposit call.|
|`maxPerWindow`|`uint256`|  Maximum USDC per rolling window.|
|`shareReceiver`|`address`| Address receiving minted vault shares.|

### AgentRevoked
Emitted when an agent's policy and role are revoked.


```solidity
event AgentRevoked(address indexed agent, address indexed owner);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|Agent address whose policy was removed.|
|`owner`|`address`|Depositor EOA that revoked (must equal the recorded owner).|

### Paused
Emitted when the gateway is paused.


```solidity
event Paused(address indexed by);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`by`|`address`|Address that called `pause()`.|

### Unpaused
Emitted when the gateway is unpaused.


```solidity
event Unpaused(address indexed by);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`by`|`address`|Address that called `unpause()`.|

### AgentDeposit
Emitted on every successful agent deposit to a single vault.


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

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|    Replay-protection hash for this payment.|
|`orderId`|`bytes32`|      Caller-supplied order identifier.|
|`agent`|`address`|        Agent address that made the deposit.|
|`shareReceiver`|`address`|Address that received the minted vault shares.|
|`amount`|`uint256`|       Gross USDC deposited (6-decimal units).|
|`sharesMinted`|`uint256`| Vault shares minted to `shareReceiver`.|
|`windowId`|`uint64`|     Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).|

### AgentDepositRouted
Emitted on every successful agent deposit routed through the Portfolio Router.


```solidity
event AgentDepositRouted(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    address shareReceiver,
    address router,
    uint256 amount,
    uint256[] sharesPerLeg,
    uint64 windowId
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Replay-protection hash for this payment.|
|`orderId`|`bytes32`|        Caller-supplied order identifier.|
|`agent`|`address`|          Agent address that made the deposit.|
|`shareReceiver`|`address`|  Address that received the minted vault shares per leg.|
|`router`|`address`|         Portfolio Router address used for this deposit.|
|`amount`|`uint256`|         Gross USDC deposited (6-decimal units).|
|`sharesPerLeg`|`uint256[]`|   Vault shares minted per leg (parallel to router weight list).|
|`windowId`|`uint64`|       Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).|

### AgentWithdrawal
Emitted on every successful agent withdrawal (vault redemption).


```solidity
event AgentWithdrawal(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    address sourceVault,
    uint256 shares,
    uint256 assetsOut,
    address assetRecipient,
    uint64 windowId
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Replay-protection hash for this payment.|
|`orderId`|`bytes32`|        Caller-supplied order identifier.|
|`agent`|`address`|          Agent address that initiated the withdrawal.|
|`sourceVault`|`address`|    Vault address shares were redeemed from.|
|`shares`|`uint256`|         Vault shares burned.|
|`assetsOut`|`uint256`|      USDC transferred to `assetRecipient`.|
|`assetRecipient`|`address`| Address that received the redeemed USDC.|
|`windowId`|`uint64`|       Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).|

### AgentWithdrawalRouted
Emitted on every successful router withdrawal (multi-vault proportional redeem).


```solidity
event AgentWithdrawalRouted(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    address router,
    address shareHolder,
    uint256[] sharesPerLeg,
    uint256[] assetsPerLeg,
    address assetRecipient,
    uint64 windowId
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`paymentId`|`bytes32`|      Replay-protection hash for this payment.|
|`orderId`|`bytes32`|        Caller-supplied order identifier.|
|`agent`|`address`|          Agent address that initiated the withdrawal.|
|`router`|`address`|         Portfolio Router address used.|
|`shareHolder`|`address`|    Address whose vault shares were redeemed.|
|`sharesPerLeg`|`uint256[]`|   Vault shares redeemed per leg (parallel to router weight list).|
|`assetsPerLeg`|`uint256[]`|   USDC received per leg.|
|`assetRecipient`|`address`| Address that received all redeemed USDC.|
|`windowId`|`uint64`|       Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).|

## Structs
### AgentPolicy
Per-agent policy. Set by the agent's recorded owner via
`authorizeAgent` (first time) or `setPolicy` (subsequent
updates).


```solidity
struct AgentPolicy {
    bool active;
    uint64 validUntil;
    uint256 maxPerPayment;
    uint256 maxPerWindow;
    address shareReceiver;
    address[] allowedDestinations;
    address assetRecipient;
    uint256 maxWithdrawPerPayment;
    uint256 maxWithdrawPerWindow;
    address[] allowedSourceVaults;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`active`|`bool`|                 Policy is enabled.|
|`validUntil`|`uint64`|             Unix-seconds expiry; deposits revert at/after.|
|`maxPerPayment`|`uint256`|          Maximum gross USDC per single `deposit` call.|
|`maxPerWindow`|`uint256`|           Maximum gross USDC per `WINDOW_SECONDS` window.|
|`shareReceiver`|`address`|          Address that receives minted vault shares.|
|`allowedDestinations`|`address[]`|    Whitelist of deposit destinations (vault or router addresses). When non-empty, `depositTo` requires the supplied destination to appear in this list. An empty array disables the allowlist — only the pinned vault or the pinned router is permitted (no registry lookup).|
|`assetRecipient`|`address`|         Address that receives redeemed USDC on `withdraw`. Must be non-zero when `maxWithdrawPerPayment > 0`.|
|`maxWithdrawPerPayment`|`uint256`|  Maximum vault shares redeemable per single `withdraw` call. Set to zero to disable agent-initiated withdrawal.|
|`maxWithdrawPerWindow`|`uint256`|   Maximum vault shares redeemable per `WINDOW_SECONDS` window. Must be >= `maxWithdrawPerPayment` when non-zero.|
|`allowedSourceVaults`|`address[]`|    Whitelist of vaults the agent may redeem from via `withdraw`. When non-empty, the supplied `sourceVault` must appear in this list. An empty array permits only the pinned vault (no registry lookup; arbitrary vault addresses are never accepted).|

