# RobotMoneyGateway
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/gateway/RobotMoneyGateway.sol)

**Inherits:**
[AccessRoles](/contracts/gateway/AccessRoles.sol/abstract.AccessRoles.md), ReentrancyGuard, [IGateway](/contracts/gateway/interfaces/IGateway.sol/interface.IGateway.md)

**Title:**
RobotMoneyGateway

Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
the agent, enforces per-agent caps and a per-window gross cap,
calls the vault, and routes the resulting `rmUSDC` shares to a
per-agent configured receiver.

Implements `Plan tracking issue #109` §2.2. Custom errors only;
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


### OP_DEPOSIT
Op-kind discriminators prepended to every `paymentId` hash to
prevent cross-operation replay (deposit id ≠ depositTo id ≠
withdrawal id ≠ router-withdrawal id even when all other inputs
are identical).


```solidity
uint8 internal constant OP_DEPOSIT = 1
```


### OP_WITHDRAW

```solidity
uint8 internal constant OP_WITHDRAW = 2
```


### OP_DEPOSIT_TO

```solidity
uint8 internal constant OP_DEPOSIT_TO = 3
```


### OP_WITHDRAW_ROUTER

```solidity
uint8 internal constant OP_WITHDRAW_ROUTER = 4
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


### MAX_WINDOW_ENTRIES
Hard cap on the number of distinct live ring-buffer entries per
agent per side. Because same-second operations coalesce, the live
count can never exceed the number of distinct seconds in the
rolling window; this constant pins the storage footprint regardless
and makes the bound explicit. `WINDOW_SECONDS` distinct seconds is
the theoretical ceiling, but no real agent approaches it — the cap
exists purely so the worst case is provably O(1) in storage.


```solidity
uint256 public constant MAX_WINDOW_ENTRIES = WINDOW_SECONDS
```


## State Variables
### commitments
Pending commitments keyed by
`keccak256(abi.encode(commitHash, committer))`. Caller scoping
prevents another account from overwriting a commitment observed
in the mempool or on-chain.


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


### _depositWindow

```solidity
mapping(address => RollingWindow) private _depositWindow
```


### _withdrawWindow

```solidity
mapping(address => RollingWindow) private _withdrawWindow
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


### icPolicy
Investment Committee Policy contract. When set, `committeeRegister`
and `committeeVoteSubmit` forward calls here. Settable by
`ADMIN_ROLE` via `setICPolicy`. `address(0)` means not configured.


```solidity
IInvestmentCommitteePolicy public icPolicy
```


### _adminCount
Number of accounts currently holding `ADMIN_ROLE`.


```solidity
uint256 private _adminCount
```


### _defaultAdminCount
Number of accounts currently holding `DEFAULT_ADMIN_ROLE`.


```solidity
uint256 private _defaultAdminCount
```


## Functions
### _grantRole

Maintain the admin-tier counters and enforce the floor. `AccessRoles`
keeps its role-separation override; we route through `super` so both
invariants compose (separation on grant, last-admin floor on revoke).


```solidity
function _grantRole(bytes32 role, address account) internal override returns (bool granted);
```

### _revokeRole

ACL-3 / F-06: block dropping the final `ADMIN_ROLE` or
`DEFAULT_ADMIN_ROLE` holder. Both `revokeRole` and `renounceRole`
route through this hook.


```solidity
function _revokeRole(bytes32 role, address account) internal override returns (bool revoked);
```

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

### _pruneWindow

Drop every live entry whose timestamp has aged past the rolling
window `(t-WINDOW_SECONDS, t]`, reclaiming its ring slot and
decrementing `total`. Strictly bounded: it scans at most `count`
entries, which can never exceed `MAX_WINDOW_ENTRIES` (NC-7).


```solidity
function _pruneWindow(RollingWindow storage w) internal;
```

### _appendWindowEntry

Record `amount` at the current `block.timestamp` in the ring buffer.
Operations within the same second COALESCE into the newest live entry
(no new slot), which is what bounds the live entry count. Otherwise a
freed slot is reused (ring wrap) or, only while the buffer has not yet
reached its high-water mark, a new slot is `push`ed — capped at
`MAX_WINDOW_ENTRIES`. `total` always tracks the live sum.


```solidity
function _appendWindowEntry(RollingWindow storage w, uint256 amount) internal;
```

### _relinearize

Rotate the full ring buffer so the oldest live entry sits at index 0.
Precondition: the buffer is completely full (`count == slots.length`),
so every slot is live and a simple rotation by `head` re-linearizes
the live region. Used only on the rare grow path. Implemented as a
sequence of in-place reversals (reverse[0,head), reverse[head,len),
reverse[0,len)) so it needs no scratch array.


```solidity
function _relinearize(RollingWindow storage w) internal;
```

### _reverseRange

Reverse `slots[lo:hi)` in place.


```solidity
function _reverseRange(RollingWindow storage w, uint256 lo, uint256 hi) internal;
```

### _oldestTimestamp

Timestamp of the oldest live entry, or 0 when the window is empty.


```solidity
function _oldestTimestamp(RollingWindow storage w) internal view returns (uint64);
```

### _effectiveWindowTotal

View-only effective live total after notionally pruning expired
entries. Mirrors `_pruneWindow`'s arithmetic without mutating storage.


```solidity
function _effectiveWindowTotal(RollingWindow storage w) internal view returns (uint256 total);
```

### _commitmentKey


```solidity
function _commitmentKey(bytes32 commitHash, address committer) internal pure returns (bytes32);
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

First-time authorization for `agent`. Admin-only — only callable
by `ADMIN_ROLE` (so the TimelockController retains agent-onboarding
authority after the deploy handover revokes the deployer's
`DEFAULT_ADMIN_ROLE`; see F-01 / ACL-1). Regular users must use
`commitAuthorization` + `revealAuthorization` instead.
`msg.sender` is recorded as the agent's owner. Reverts if
`agent` already has a recorded owner; that owner must call
`setPolicy` to update or `revokeAgent` to release.


```solidity
function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE);
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
|`paymentId`|`bytes32`|      keccak256(abi.encode(OP_DEPOSIT=1, chainId, gateway, agent, orderId, amount, idempotencyKey)) — op-kind prefix ensures deposit ids are disjoint from depositTo and withdraw ids.|
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
|`paymentId`|`bytes32`|      keccak256(abi.encode(OP_DEPOSIT_TO=3, chainId, gateway, agent, orderId, amount, idempotencyKey)) — op-kind prefix ensures depositTo ids are disjoint from deposit and withdraw ids.|


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
Share custody requirement (audit 2026-06-09, L-13 — intentional):
this single-vault path pulls shares from the AGENT (`msg.sender`),
while `deposit` mints shares to `policy.shareReceiver` and the
router path (`withdrawFromRouter`) pulls from `policy.shareReceiver`.
Single-vault withdrawal therefore requires `agent == shareReceiver`,
or the share holder to have transferred shares to the agent first.
This matches the production client contract: rmpc preflights
`vault.allowance(agent, gateway)` and `vault.balanceOf(agent)`
(clients/rust-payment-client/src/commands/withdraw.rs) before
submitting, so changing the pull source here would break the only
production caller. No funds are at risk either way: USDC always
settles to `policy.assetRecipient`.


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

Proportional multi-vault redemption through the Portfolio Router.
All legs must succeed (all-or-revert). No outer share token is
minted; the gateway temporarily holds each vault's shares during the
call frame and passes them to the router's `redeemFor`, which calls
`vault.redeem` per leg and delivers USDC directly to `assetRecipient`.
CEI pattern: all state effects written before external calls.
`nonReentrant` provides defense-in-depth.


```solidity
function withdrawFromRouter(
    bytes32 orderId,
    address[] calldata vaults,
    uint256[] calldata sharesPerLeg,
    uint256[] calldata minAssetsPerLeg,
    uint64 deadline,
    bytes32 idempotencyKey
)
    external
    nonReentrant
    onlyRole(AGENT_ROLE)
    returns (bytes32 paymentId, uint256[] memory assetsPerLeg);
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


### _routerWithdrawPaymentId

Compute the router-withdrawal paymentId. DEADLINE INTENTIONALLY
EXCLUDED (a deadline is liveness, not intent). `OP_WITHDRAW_ROUTER`
prefix namespaces these ids from the three sibling op kinds (L-12).
The explicit `vaults`/`sharesPerLeg` are committed so two withdrawals
that name different vaults or per-leg shares can never collide (#967,
NC-5), and `minAssetsPerLeg` is bound so a replay can never re-execute
the same order under a weaker (e.g. zeroed) slippage floor (GW-5 /
F-11). Extracted to a helper to keep `withdrawFromRouter` under the
EVM stack-depth limit.


```solidity
function _routerWithdrawPaymentId(
    bytes32 orderId,
    uint256 totalShares,
    address[] calldata vaults,
    uint256[] calldata sharesPerLeg,
    uint256[] calldata minAssetsPerLeg,
    bytes32 idempotencyKey
) internal view returns (bytes32);
```

### setICPolicy

Set or update the Investment Committee policy contract address.
Restricted to `ADMIN_ROLE`. Pass `address(0)` to clear (disable).


```solidity
function setICPolicy(address policy_) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`policy_`|`address`|Address of the deployed `InvestmentCommitteePolicy` contract, or `address(0)` to disable committee routing.|


### committeeRegister

Forward a committee agent registration to the IC policy contract.
Restricted to `ADMIN_ROLE` (mirrors IC contract's own `ADMIN_ROLE`
requirement on `registerAgent`). Reverts if `icPolicy` is not set.
All committee writes pass through the gateway so that the IC
contract's `onlyGateway` modifier enforcement is the single
choke point — no committee side channel exists.


```solidity
function committeeRegister(address agent, string calldata agentId_)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|   Address to grant `COMMITTEE_AGENT_ROLE` on the IC contract.|
|`agentId_`|`string`|Human-readable label (e.g. "athena-v1").|


### committeeVoteSubmit

Forward a signed committee vote to the IC policy contract.
Restricted to `AGENT_ROLE`. Reverts if `icPolicy` is not set or
if the IC contract's own guards fail (agent not allowlisted,
invalid vote fields, etc.).
The gateway is the sole permitted caller of `IC.submitVote`
(enforced by the IC contract's `onlyGateway` modifier). This
function is the only path through which an agent may reach the
IC contract.


```solidity
function committeeVoteSubmit(IInvestmentCommitteePolicy.VoteParams calldata p)
    external
    onlyRole(AGENT_ROLE)
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


### _executeRouterWithdraw

Execute the multi-leg router withdrawal: pull shares from shareHolder,
approve router, call redeemFor, clear allowances, verify custody.
Separated to avoid stack-too-deep in `withdrawFromRouter`.


```solidity
function _executeRouterWithdraw(
    RouterWithdrawArgs memory args,
    uint256[] calldata sharesPerLeg,
    uint256[] calldata minAssetsPerLeg
) internal returns (uint256[] memory assetsPerLeg);
```

## Events
### ICPolicySet
Emitted when the IC policy contract address is set or updated.


```solidity
event ICPolicySet(address indexed by, address indexed policy);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`by`|`address`|    Address that called `setICPolicy` (must hold `ADMIN_ROLE`).|
|`policy`|`address`|New IC policy contract address (`address(0)` clears it).|

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

### ShareReceiverNotAuthorized
`revealAuthorization` called with a policy whose `shareReceiver`
is not `msg.sender`. In the permissionless commit/reveal path the
caller must be the intended share receiver so that vault-share
allowances from the receiver cannot be spent by an unauthorized
third party (AZ-GW-1 — critical / access-control).


```solidity
error ShareReceiverNotAuthorized();
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

### ICPolicyNotSet
`committeeRegister()` or `committeeVoteSubmit()` called but no IC
policy contract is configured (`icPolicy == address(0)`).


```solidity
error ICPolicyNotSet();
```

### WindowBufferFull
Raised when an agent's live window-entry count would exceed
`MAX_WINDOW_ENTRIES`. Unreachable in practice (same-second
coalescing keeps the live count far below the cap) but guarantees
the ring buffer can never silently overflow its bound.


```solidity
error WindowBufferFull();
```

### LastAdminFloor
Revoking/renouncing the sole holder of an admin tier is forbidden.


```solidity
error LastAdminFloor();
```

### RouterNotConfigured
Error: `withdrawFromRouter()` called but no router is configured
(`routerContract == address(0)`).


```solidity
error RouterNotConfigured();
```

### RouterLegLengthMismatch
Error: `sharesPerLeg` length does not match the router's current
effective weight vector length.


```solidity
error RouterLegLengthMismatch();
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

### WindowEntry

```solidity
struct WindowEntry {
    uint64 timestamp;
    uint256 amount;
}
```

### RollingWindow
Bounded ring buffer backing one agent's rolling-window accounting
(NC-7 / GW-4). The previous design `.push`ed a fresh `WindowEntry`
for every operation and only advanced a `head` cursor on prune, so
the underlying dynamic array grew without bound for the life of the
agent — eventually making every windowed op (and the linear prune
scan) cost so much gas that the agent gas-bricks itself out of the
gateway permanently.
The ring buffer fixes this in two ways:
1. SAME-SECOND COALESCING — operations sharing a `block.timestamp`
merge into the single newest entry instead of appending. The
count of distinct live entries can therefore never exceed the
number of distinct seconds in the rolling window, which is
hard-capped at `MAX_WINDOW_ENTRIES`.
2. SLOT REUSE — pruned (expired) slots are reclaimed by wrapping
`head`/`count` around the fixed-capacity `slots` array, so the
array's storage footprint plateaus at the high-water mark of
concurrently-live entries and never grows monotonically.
Exact rolling-window semantics (strict `(t-WINDOW_SECONDS, t]`
expiry) are preserved per-entry; only the storage shape changed.


```solidity
struct RollingWindow {
    WindowEntry[] slots; // ring storage; length == live capacity (≤ MAX_WINDOW_ENTRIES)
    uint256 head; // index of the oldest live entry
    uint256 count; // number of live entries
    uint256 total; // cumulative amount across the live entries
}
```

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
    /// @dev Captured from the in-memory policy snapshot so the rolling-window
    ///      cap check never performs a second cold SLOAD on `agents[msg.sender]`.
    uint256 maxPerWindow;
}
```

### RouterWithdrawArgs
Internal args struct to avoid stack-too-deep in `withdrawFromRouter`.


```solidity
struct RouterWithdrawArgs {
    bytes32 paymentId;
    bytes32 orderId;
    address shareHolder;
    address assetRecipient;
    uint256 totalShares;
    uint64 windowId;
    uint64 deadline;
    address[] vaultList;
    uint256[] shareBalancesBefore;
}
```

