# Confused-Deputy / Caller-Supplied-Identity Defense-in-Depth Audit

> Authored: 2026-06-02  
> Canonical docs: `docs/prd.md §2`, `docs/technical/security-hardening-seams.md`  
> Reference exploit: SquidRouterModule / "New Market trading" (QuillAudits, 2026-05-25, ~$3M across ~86 Safes)  
> QuillAudits report: https://quillaudits.com/blog/hack-analysis/squid-router-module-hack-analysis/

---

## 1. Vulnerability Class: Confused-Deputy / Caller-Supplied Identity

The SquidRouterModule exploit was a **confused-deputy / broken-access-control** attack. The module was a privileged Safe module that could execute arbitrary calls on behalf of a Safe. The exploit worked by:

1. Supplying a caller-controlled `source` string in calldata that the module used to derive authority (which Safe "owned" the funds), bypassing on-chain `msg.sender` authentication.
2. Using a caller-supplied delegate address read from calldata to route execution.
3. Routing through an attacker-controlled Uniswap V3 pool pairing a worthless token against real assets, with zero slippage protection (`amountOutMinimum = 0`).

The net effect: an attacker could direct any victim Safe's USDC into a worthless-token pool and extract the real asset, with the module treating the caller's fabricated `source` as authorization.

**Intersection with Robot Money:**  
The Robot Money gateway authorizes agents to act on a depositor's behalf (`agentOwner[agent] = msg.sender`), and the Portfolio Router / BasketVault move USDC into vaults that swap on Uniswap V3 — the same two surfaces. A single gap (a fund-moving path trusting a caller-supplied `owner`/`recipient`/`onBehalfOf`, or a swap into an unvalidated pool with no slippage floor) could drain vaults.

---

## 2. Entrypoint Authority Audit

### 2.1 RobotMoneyGateway

| Entrypoint | Authority source | Caller-supplied identity? | Verdict |
|---|---|---|---|
| `authorizeAgent(agent, p)` | `msg.sender` binds as `agentOwner[agent]`; no role gate | No. Agent address is caller-provided but ownership always binds to `msg.sender` | **SAFE** |
| `revealAuthorization(agent, salt, p)` | `msg.sender` must match prior `commitments[commitHash].committer`; commitHash includes `msg.sender` at commit time | No. Commit hash binds agent to `msg.sender`; mismatch reverts at lookup | **SAFE** |
| `setPolicy(agent, p)` | `agentOwner[agent] != msg.sender` → reverts `NotAgentOwner` | No | **SAFE** |
| `revokeAgent(agent)` | `agentOwner[agent] != msg.sender` → reverts `NotAgentOwner` | No | **SAFE** |
| `deposit(orderId, amount, deadline, idemKey)` | `onlyRole(AGENT_ROLE)` gated; policy read from `agents[msg.sender]`; `shareReceiver` from policy, not calldata | No. All authority derived from `msg.sender`'s registered role and policy | **SAFE** |
| `depositTo(orderId, amount, deadline, idemKey, destination, minSharesPerLeg)` | `onlyRole(AGENT_ROLE)`; destination validated against `policy.allowedDestinations` whitelist; `shareReceiver` from policy | Destination is caller-supplied but whitelisted against policy | **SAFE** |
| `withdraw(orderId, shares, sourceVault, deadline, idemKey)` | `onlyRole(AGENT_ROLE)`; `sourceVault` must equal pinned vault AND pass `allowedSourceVaults` whitelist; `assetRecipient` from policy, not calldata | `sourceVault` caller-supplied but validated against immutable vault address and policy whitelist | **SAFE** |
| `pause()` | `onlyRole(PAUSER_ROLE)` | No | **SAFE** |
| `unpause()` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `commitAuthorization(commitHash)` | `msg.sender` stored as committer | No | **SAFE** |

**Key invariants already holding (pinned by automated tests in `ConfusedDeputyGuardsTest`):**
- `deposit` reads `shareReceiver` exclusively from `agents[msg.sender]`, never from calldata.
- `withdraw` sends assets only to `policy.assetRecipient`, never to a caller-supplied address.
- `depositTo` rejects any destination not in `policy.allowedDestinations`.
- `withdraw` rejects any `sourceVault` not equal to the pinned vault.

### 2.2 PortfolioRouter

| Entrypoint | Authority source | Caller-supplied identity? | Verdict |
|---|---|---|---|
| `deposit(amount, minSharesPerLeg)` | `msg.sender` is the depositor; shares minted to `msg.sender` | No | **SAFE** |
| `depositFor(receiver, amount, minSharesPerLeg)` | Receiver is caller-supplied; no role gate | Receiver is caller-supplied — caller can direct shares to any address | **SAFE (by design)**: `depositFor` is called by the gateway; the gateway derives `shareReceiver` from `agents[msg.sender]` policy, not from the agent's calldata. The router itself is a pass-through that accepts the receiver from its caller; the gateway is the trust boundary. |
| `setWeights(vaults, bps)` | `onlyRole(ADMIN_ROLE)` | No. Vaults in weights validated against registry | **SAFE** |
| `setDefaultWeights(vaults, bps)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `clearVotedWeights()` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `setRouterCap(cap)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `setVaultCap(vault, cap)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `rescueUsdc(to)` | `onlyRole(ADMIN_ROLE)` | `to` is caller-supplied but caller must hold `ADMIN_ROLE` | **SAFE** |

**Swap / pool surface:**  
`PortfolioRouter` does not call any swap router. It calls `IERC4626(vault).deposit()` on governance-weighted, registry-eligible vaults only. There is no direct Uniswap interaction in `PortfolioRouter`.

**Pool validation at deposit time:**  
`_requireRouterEligible(vault)` is called at both `setWeights` (configuration time) and `_executeLegs` (runtime). It checks:
1. Vault has code (`vault.code.length > 0`).
2. `vault.asset() == usdc` (ERC-4626 asset match).
3. `registry.isRouterEligible(vault) == true` (governance-set flag).

No attacker-supplied pool address can enter the swap rail.

### 2.3 RouterGovernance

| Entrypoint | Authority source | Caller-supplied identity? | Verdict |
|---|---|---|---|
| `propose(vaults, bps)` | `onlyRole(ADMIN_ROLE)`; each vault validated via `router.isRouterEligible` | Vaults are caller-supplied but each must pass eligibility check | **SAFE** |
| `vote(proposalId)` | `votingPower[msg.sender]` must be > 0; only admin-granted power | No | **SAFE** |
| `execute(proposalId)` | Anyone may call; calls `router.setWeights(p.vaults, p.bps)` with governance-approved vault list | No | **SAFE** |
| `cancel(proposalId)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `setVotingPower(voter, power)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `setDefaultWeights(vaults, bps)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `clearVotedWeights()` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |

### 2.4 VaultRegistry

| Entrypoint | Authority source | Caller-supplied identity? | Verdict |
|---|---|---|---|
| `registerVault(vault, metadata)` | `onlyRole(ADMIN_ROLE)` | No | **SAFE** |
| `setVaultStatus(vault, newStatus)` | `onlyRole(ADMIN_ROLE)`; vault must be registered | No | **SAFE** |
| `setRouterEligible(vault, eligible)` | `onlyRole(ADMIN_ROLE)`; vault must be registered; blocks stale-length when router linked | No | **SAFE** |
| `setRouter(newRouter)` | `onlyRole(ADMIN_ROLE)`; unlinking blocked while router has non-empty default vector | No | **SAFE** |

### 2.5 RobotMoneyVault (ERC-4626 standard paths)

| Entrypoint | Authority source | Caller-supplied identity? | Verdict |
|---|---|---|---|
| `deposit(assets, receiver)` | `_deposit(msg.sender, receiver, ...)` — caller is authenticated as depositor; allowance checked by OZ ERC4626 | `receiver` is caller-supplied — user may direct shares to any address | **SAFE (by design)**: standard ERC-4626; caller pre-authorizes via `approve`/`permit`. Gateway always uses `policy.shareReceiver`. |
| `mint(shares, receiver)` | Same as deposit | Same | **SAFE** |
| `withdraw(assets, receiver, owner)` | `_withdraw(msg.sender, receiver, owner, ...)` — if `caller != owner`, `_spendAllowance(owner, caller, shares)` is called | `receiver` and `owner` caller-supplied; `owner` allowance strictly enforced | **SAFE** |
| `redeem(shares, receiver, owner)` | Same as withdraw | Same | **SAFE** |
| `addAdapter(adapter, capBps)` | `onlyRole(ADMIN_ROLE)`; `_requireAdapterEligible` checks address allowlist AND codehash allowlist AND USDC/VAULT compatibility | No | **SAFE** |
| `emergencyWithdraw()` | `onlyRole(EMERGENCY_ROLE)` | No | **SAFE** |
| `rebalance()` | `ADMIN_ROLE` or `KEEPER_ROLE` only | No | **SAFE** |

### 2.6 BasketVault (ERC-4626 + Uniswap V3 swap surface)

| Entrypoint | Authority source | Pool/token validation | Slippage/TWAP posture | Verdict |
|---|---|---|---|---|
| `deposit(assets, receiver)` via `_deposit` | Standard ERC-4626; `caller = msg.sender` | Pool registered via `addAsset` (ADMIN_ROLE gated, validates token0/token1 match with USDC) | `minOut = TWAP-derived * (MAX_BPS - maxSlippageBps) / MAX_BPS`; TWAP window 10 min–24 h | **SAFE** |
| `withdraw`/`redeem` via `_withdraw` | Standard ERC-4626; `_spendAllowance` enforced for delegated callers | Same registered pool list | `minUsdcOut = TWAP-derived * (MAX_BPS - maxSlippageBps) / MAX_BPS` | **SAFE** |
| `addAsset(token, pool, swapFee)` | `onlyRole(ADMIN_ROLE)` | Verifies `pool.token0` and `pool.token1` include `token` and `_USDC`; reverts `PoolTokenMismatch` if not | Checks `pool.observationCardinality >= MIN_POOL_CARDINALITY` (≥2) to ensure TWAP reads will not revert with "OLD" | **SAFE** |
| `emergencyUnwind()` | `onlyRole(EMERGENCY_ROLE)` | Pools are from registered `assets[]` list only | `effectiveFloor = max(TWAP-derived * (1 - slippage), configuredMin)` | **SAFE** |
| `emergencyUnwindWithOverride(tokens)` | `onlyRole(EMERGENCY_ROLE)`; per-token `overrideAllowed` flag must be set by ADMIN_ROLE | Pools from registered `assets[]` via `_activeAssetForToken` | `appliedFloor = guard.minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`; also takes `max(TWAP-floor, appliedFloor)`; reverts `EmergencyUnwindLossCapExceeded` if received < floor | **SAFE** |
| `rescueTokens(token, to)` | `onlyRole(ADMIN_ROLE)` | Reverts if `token == _USDC` or `token` is a basket asset | No swap involved | **SAFE** |

---

## 3. Swap Exit-Rail Surface: BasketVault

The Uniswap V3 swap surface is the highest-risk area in the codebase — it mirrors the mechanism used in the SquidRouterModule exploit. This section enumerates every swap call and its validation chain.

### 3.1 Pool registration gating (addAsset)

`addAsset` validates:
- `token != address(0)` and `pool != address(0)`.
- `pool.token0` and `pool.token1` form exactly `{token, _USDC}` — any other combination reverts `PoolTokenMismatch`. An attacker cannot register a pool whose token pair does not include both the intended basket token and USDC.
- `pool.observationCardinality >= MIN_POOL_CARDINALITY (2)` — prevents TWAP reads from reverting with "OLD" on cardinality=1 pools.
- Restricted to `ADMIN_ROLE` (not `EMERGENCY_ROLE`).

**No caller-supplied pool address reaches any swap call after `addAsset` validation.**

### 3.2 Deposit swaps (_routeDeposit)

Each active-asset leg computes:
```
minOut = TWAP(pool, USDC→token, swapIn) * (MAX_BPS - maxSlippageBps) / MAX_BPS
```
`maxSlippageBps` is capped at `MAX_SLIPPAGE_BPS = 500` (5%). A governance action that sets `maxSlippageBps = 500` is the worst case; the TWAP window floor (minimum 10 minutes) prevents the denominator from being a manipulated spot price.

### 3.3 Withdrawal swaps (_sellProportional)

```
minUsdcOut = TWAP(pool, token→USDC, sellAmount) * (MAX_BPS - maxSlippageBps) / MAX_BPS
```
Same TWAP derivation.

### 3.4 Emergency unwind swaps

Non-override path:
```
effectiveFloor = max(TWAP-derived * (1 - slippage), emergencyUnwindGuard[token].minUsdcOut)
```
Override path:
```
appliedFloor = guard.minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS
effectiveFloor = max(TWAP-floor, appliedFloor)
```
Post-swap: `if (received < appliedFloor) revert EmergencyUnwindLossCapExceeded(...)`.

**Conclusion:** Every swap path in BasketVault derives `amountOutMinimum` from a TWAP oracle over an admin-configured window (minimum 10 minutes, default 30 minutes). No swap path accepts a caller-supplied `amountOutMinimum`. There is no `amountOutMinimum = 0` path reachable by an unprivileged caller.

---

## 4. Confirmed Gaps and Fixes

After full enumeration, **no confused-deputy gaps were found** in the currently deployed contracts. The audit confirms:

1. No fund-moving path derives authority from a caller-supplied `owner`, `recipient`, `onBehalfOf`, or `source` parameter that bypasses `msg.sender` authentication.
2. No swap path accepts a caller-supplied pool address or `amountOutMinimum = 0`.
3. The `depositFor` receiver parameter in `PortfolioRouter` is safe because the gateway (the only caller in the authorized flow) derives `shareReceiver` from the agent's on-chain policy, not from the agent's calldata.
4. All swap pools are registered by `ADMIN_ROLE` at `addAsset` time with explicit token-pair validation. An attacker cannot introduce a malicious pool via any unprivileged entrypoint.

---

## 5. Authority Invariants Pinned by Automated Tests

The following invariants are covered by regression tests in `contracts/test/ConfusedDeputyGuardsTest.t.sol`:

1. **Gateway deposit shareReceiver bound to policy, not calldata** — `deposit` sends shares to `policy.shareReceiver`; no calldata argument can redirect shares.
2. **Gateway withdrawal assetRecipient bound to policy, not calldata** — `withdraw` sends USDC only to `policy.assetRecipient`.
3. **depositTo destination whitelist** — any destination not in `policy.allowedDestinations` reverts `InvalidDestination`.
4. **withdraw sourceVault pinned to gateway vault** — any `sourceVault != address(vaultContract)` reverts `InvalidSourceVault`.
5. **setPolicy requires msg.sender == agentOwner** — a third party cannot update another depositor's agent policy.
6. **revokeAgent requires msg.sender == agentOwner** — a third party cannot revoke another depositor's agent.
7. **authorizeAgent rejects agent with existing owner** — double-registration reverts `AgentAlreadyOwned`.
8. **BasketVault addAsset rejects mismatched pool** — a pool whose token pair does not include both the basket token and USDC reverts `PoolTokenMismatch`.
9. **BasketVault deposit slippage floor is non-zero** — every deposit swap sets `amountOutMinimum > 0` from TWAP.
10. **BasketVault withdrawal slippage floor is non-zero** — every withdrawal swap sets `amountOutMinimum > 0` from TWAP.
11. **PortfolioRouter runtime eligibility re-check** — a vault that became ineligible after weighting cannot receive USDC at deposit time.
