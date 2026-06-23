# IC Gateway Seam — RobotMoneyGateway Routing Extension Point

> Phase: Agentic Investment Committee
> Scout issue: #1047
> Canonical docs: `docs/architecture.md §5.2`, `contracts/gateway/RobotMoneyGateway.sol`

## 1. Purpose

This report defines the exact routing extension point in `RobotMoneyGateway.sol` that
Investment Committee (IC) committee actions must pass through, documents whether gateway
code changes are required or only registration, records the coupling with #835, and
specifies the interface the IC policy contract must expose for the gateway to forward
calls to it.

## 2. Entry Points in RobotMoneyGateway that Committee Actions Route Through

The gateway exposes four public, agent-callable state-changing functions, all guarded by
`onlyRole(AGENT_ROLE)`:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `deposit` | `deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)` | Single-vault USDC deposit |
| `depositTo` | `depositTo(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey, address destination, uint256[] calldata minSharesPerLeg)` | Deposit to named vault or Portfolio Router |
| `withdraw` | `withdraw(bytes32 orderId, uint256 shares, address sourceVault, uint64 deadline, bytes32 idempotencyKey)` | Single-vault share redemption |
| `withdrawFromRouter` | `withdrawFromRouter(bytes32 orderId, address[] calldata vaults, uint256[] calldata sharesPerLeg, uint256[] calldata minAssetsPerLeg, uint64 deadline, bytes32 idempotencyKey)` | Multi-vault proportional redemption through the Portfolio Router |

None of these functions are suitable as-is for committee actions (register and voteSubmit).
Committee verbs — submitting a per-vault overweight/underweight vote JSON — do not involve
USDC deposits or vault redemptions. There is no generic "forward arbitrary calldata to an
allowlisted target" path in the current gateway.

### The AGENT_ROLE gate is the routing extension point

The structural pattern the gateway enforces is:

1. Caller must hold `AGENT_ROLE` (granted at registration time via `authorizeAgent` or
   `revealAuthorization` commit/reveal).
2. Caller must have a valid, non-expired `AgentPolicy` in `agents[msg.sender]`.
3. Per-call checks (caps, deadline, idempotency, pause state) execute on the in-memory
   policy snapshot.
4. If all checks pass, the gateway executes the permitted action (deposit into vault or
   router, redeem shares from vault or router) and emits an event.

For committee actions to "route through the gateway" in the same sense as deposit/withdraw,
two options exist:

**Option A — No gateway code changes: separate on-chain committee contract.**
Committee register and voteSubmit are not financial operations; they do not need the
gateway's amount/cap/deadline machinery. Committee agents authorize against a separate
on-chain committee registry contract (not RobotMoneyGateway). The gateway's AGENT_ROLE
and policy system remain scoped to deposit/withdraw; the IC policy contract enforces its
own access model. This is the lower-risk path and keeps the gateway's invariants intact.

**Option B — Gateway code change: add a `forwardTarget` calldata routing verb.**
Add a new `forwardTarget(address target, bytes calldata data)` function gated on
`AGENT_ROLE`, backed by an `allowedTargets` allowlist in `AgentPolicy`, that forwards
arbitrary calldata to an approved address (the IC policy contract). This generalizes the
gateway into a multi-purpose agent router. It requires a new storage slot in
`AgentPolicy`, a new routing code path, new cap semantics (or none), and new event types.

**Finding:** The current gateway source (post-#835) contains **no forwardTarget path and
no allowedTargets field in AgentPolicy**. Option A requires zero gateway code changes.
Option B requires gateway contract changes and a corresponding policy struct extension.

The architecture principle stated in `docs/architecture.md §5.2` is:

> The gateway is not an allocation layer. It is the on-chain permission and agent-safety
> layer in front of agent-initiated writes. It answers whether the agent may act, for how
> much, until when, on behalf of which depositor, to which share receiver, and into which
> allowed destination.

Committee vote submission does not fit the "how much, until when, to which share receiver"
model. Option A (separate contract, no gateway changes) is the cleanest architectural fit.

## 3. Gateway Code Changes: Required or Registration-Only?

For IC committee actions routed through the existing gateway (deposit/withdraw verbs):
- **No code changes required.** An IC committee agent that holds `AGENT_ROLE` and has a
  valid `AgentPolicy` can call `deposit`, `depositTo`, `withdraw`, and `withdrawFromRouter`
  today. If the committee agent needs to make a deposit action as part of its mandate, it
  registers via the standard commit/reveal path and the existing functions apply.

For IC committee register and voteSubmit verbs routed through the gateway:
- **Option A (separate contract):** No gateway changes required. IC policy contract
  enforces its own access. Gateway is not involved.
- **Option B (forwardTarget in gateway):** Gateway code change required. A new verb,
  storage slot in `AgentPolicy`, and allowlist enforcement would need to be added.

**Conclusion:** If the committee agent also needs deposit authority (dual mandate), a
single registration granting AGENT_ROLE with a correctly scoped `AgentPolicy` (restricted
`allowedDestinations`, withdrawal disabled via `maxWithdrawPerPayment == 0`) is sufficient
today and requires no code changes. If the committee agent must remain deposit-scope-free
(per sprint spec: "committee plugin gets no treasury-spend scope"), it must NOT hold
AGENT_ROLE — it routes through a separate committee contract.

## 4. Coupling with Issue #835 and Sequencing Constraint

Issue #835 (`fix(contracts): complete 2026-06-12 security remediation findings atomically`)
is **CLOSED** and merged. Its gateway-relevant changes are:

- **SR-M7 (commit/reveal):** `authorizeAgent` is now admin-only (`onlyRole(ADMIN_ROLE)`);
  permissionless first-time registration goes only through the `commitAuthorization` →
  `revealAuthorization` commit/reveal path. The IC committee agent's owner must either use
  commit/reveal (permissionless depositor path) or be granted registration by an account
  holding `ADMIN_ROLE`.
- **SR-M3 (rolling window accounting):** Both deposit and withdraw caps are enforced on a
  strict rolling window (ring buffer, `_accrueRollingDeposit`, `_accrueRollingWithdraw`).
  If the IC committee agent is scoped to deposit/withdraw, its `AgentPolicy` caps govern
  rolling window usage.
- **Role-separation invariant (L-14):** `AGENT_ROLE`, `ADMIN_ROLE`/`DEFAULT_ADMIN_ROLE`,
  and `PAUSER_ROLE` are pairwise disjoint. The IC committee agent address may not hold any
  two of these roles simultaneously.

**Sequencing constraint:** Because #835 is closed and its gateway changes are present at
HEAD, IC committee workstream issues may be authored against the current gateway source
without any dependency on further security remediation. There is no pending gateway merge
that would invalidate the interface documented here.

If Option B (forwardTarget) is chosen by a downstream IC implementation issue, that
implementation must serialize after any further gateway changes in the plan (edit the
same files: `RobotMoneyGateway.sol`, `IGateway.sol`, `AgentPolicy` struct).

## 5. Interface the IC Policy Contract Must Expose

**Option A (separate contract, no gateway involvement):**
The IC policy contract defines its own interface. The gateway does not call the IC policy
contract. No calldata forwarding interface is required on the IC side. The committee
contract exposes whatever functions it needs (e.g., `register(address agent, ...)`,
`voteSubmit(bytes calldata voteJson, ...)`).

**Option B (forwardTarget in gateway):**
For the gateway to forward calldata to the IC policy contract, the IC policy contract does
not need to expose a specific interface — the gateway would forward arbitrary `bytes
calldata data` to the `allowlisted` target address. The gateway simply executes
`target.call(data)` (or `target.functionCall(data)` via SafeERC20-style helper) and
checks the return value. The IC policy contract only needs to expose callable functions
reachable by the committee agent's desired verbs.

**Current finding:** The gateway forwards calldata to exactly two targets today: the
pinned `vaultContract` (via `vaultContract.deposit`) and the `routerContract` (via
`routerContract.depositFor` / `routerContract.redeemFor`). Both targets are typed
interfaces (`IERC4626`, `IPortfolioRouter`). There is no generic calldata forward path.

## 6. Summary

| Question | Answer |
|----------|--------|
| Gateway functions committee actions route through | None today for vote verbs; `deposit`/`depositTo`/`withdraw`/`withdrawFromRouter` exist for financial verbs |
| Gateway code changes required for vote verbs? | No (Option A: separate contract) / Yes (Option B: add `forwardTarget` + allowlist) |
| Recommended path for committee register/voteSubmit | Option A — separate on-chain committee contract; gateway not involved |
| Recommended path if committee agent also deposits | Single AGENT_ROLE registration with restricted `AgentPolicy` (`allowedDestinations`, withdrawal disabled); no gateway changes |
| Coupling with #835 | #835 is closed; post-remediation gateway is the stable base. SR-M7 commit/reveal, SR-M3 rolling window, L-14 role separation all apply to any IC agent registration. No pending predecessor merge. |
| IC policy contract interface required? | None for Option A. For Option B: the gateway forwards arbitrary calldata; no specific interface needed on the IC contract side. |
| `allowlist`/`forwardTarget`/`calldata` in current gateway? | Not present. `allowedDestinations` and `allowedSourceVaults` exist in `AgentPolicy` but scope vault/router addresses only. No generic calldata forwarding. |
