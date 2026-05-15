# Gateway Withdrawal: Architecture Decisions

> Canonical: `docs/architecture.md` §5.2 — Agent Permissions Gateway
> Issue: #310 — dev-scout: map gateway withdrawal seams, receipt-allowance model, and rmpc signing path
> Status: **Accepted**

This ADR resolves the design questions that must be settled before any
implementation issue for gateway agent withdrawal begins. It covers four
topics: the receipt-allowance model, the new `AgentPolicy` fields, the
`gateway.withdraw()` function signature and policy checks, and the
router-position withdrawal scope decision.

---

## 1. Receipt-Allowance Model

### Decision

The depositor (or the configured receipt owner) grants the gateway a
standard ERC-20 allowance on the vault's receipt token (rmUSDC). The
gateway holds no special protocol role on the vault; it calls
`vault.redeem(shares, assetRecipient, receiptOwner)` using the allowance
granted to it by the receipt owner.

### Rationale

The vault is ERC-4626. Its `redeem(shares, receiver, owner)` surface
already supports operator-style redemption when `owner` has approved a
`spender` via `IERC20.approve`. The gateway becomes that spender. This
requires no vault changes, no new vault role, and no gateway custody of
receipts.

### Granting the allowance

The depositor calls `rmUSDC.approve(gateway, shares)` before or alongside
agent authorization. This is a one-time or rolling approval on the vault
receipt token, not on USDC. The dapp and `rmpc` must surface this step
clearly:

- the dapp policy-management action must prompt the depositor to approve
  the gateway as a spender of their vault receipts;
- `rmpc` preflight for `withdraw` must read
  `rmUSDC.allowance(receiptOwner, gateway)` and refuse if insufficient.

### What "receipt owner" means

The receipt owner is whoever holds the vault shares. After a gateway
deposit, shares are minted to `policy.shareReceiver`. That address is
therefore the receipt owner and the one that must grant the gateway
allowance. In the simple single-wallet case, `shareReceiver == depositor
EOA` and the depositor grants the allowance directly.

### Custody invariant (mirrors deposit)

The gateway must never hold vault receipts after a `withdraw` call. The
implementation must apply the same pre/post-call balance invariant as the
existing deposit path.

---

## 2. New AgentPolicy Fields

### Decision

Extend the `AgentPolicy` struct with four fields:

| Field | Type | Description |
|---|---|---|
| `assetRecipient` | `address` | Where withdrawn USDC is sent. Must be non-zero. The agent cannot redirect proceeds to itself. |
| `maxWithdrawPerPayment` | `uint256` | Maximum vault shares redeemable per single `withdraw` call. Zero means withdrawal is disabled for this policy. |
| `maxWithdrawPerWindow` | `uint256` | Maximum vault shares redeemable across all `withdraw` calls within one `WINDOW_SECONDS` window. |
| `allowedSourceVaults` | `address[]` | Explicit whitelist of vault addresses the agent may withdraw from. Empty list means withdrawal is disabled. |

### Migration path

The existing `AgentPolicy` struct in `IGateway.sol` and
`RobotMoneyGateway.sol` must be extended. Because the gateway is a
non-proxy direct deployment, a new contract deployment is required when
the withdrawal fields are added. The `authorizeAgent` / `setPolicy`
surfaces must accept and validate the new fields simultaneously with the
existing deposit-related fields.

### Validation rules for new fields

- `assetRecipient != address(0)` — always required once withdrawal is
  enabled.
- If `maxWithdrawPerPayment == 0` or `maxWithdrawPerWindow == 0` or
  `allowedSourceVaults.length == 0`, withdrawal capability is considered
  disabled for that policy. The gateway must not revert on a policy with
  no withdrawal capability; it must revert only if `withdraw` is actually
  called against such a policy.
- `maxWithdrawPerPayment <= maxWithdrawPerWindow` — mirrors the deposit
  cap invariant.

### Window counter

Withdrawal window gross is tracked separately from deposit window gross.
The implementation uses a new mapping:
`agentWithdrawWindowGross[agent][windowId]`. This prevents a depositing
agent from inadvertently consuming withdrawal headroom and vice versa.

---

## 3. `gateway.withdraw()` Signature and Policy Checks

### Decided signature

```solidity
function withdraw(
    bytes32 orderId,
    uint256 shares,
    address sourceVault,
    uint64  deadline,
    bytes32 idempotencyKey,
    uint256 minAssetsOut
)
    external
    nonReentrant
    onlyRole(AGENT_ROLE)
    returns (bytes32 paymentId, uint256 assetsReceived);
```

Parameter notes:

- `orderId` — caller-supplied order identifier; echoed in `AgentWithdrawal` event.
- `shares` — vault shares to redeem (in receipt token decimals).
- `sourceVault` — must be in `policy.allowedSourceVaults`.
- `deadline` — same `MAX_DEADLINE_SKEW = 600` rule as `deposit`.
- `idempotencyKey` — mixed into `paymentId` for replay protection.
- `minAssetsOut` — floor on USDC received; protects against exit-fee
  changes between preflight and execution. Zero is accepted but
  discouraged for production use.

### Policy check order (CEI-compatible)

The checks run in this order before any state mutation or external call:

1. `!_paused` — gateway not paused.
2. `shares > 0` — non-zero amount.
3. `shares <= policy.maxWithdrawPerPayment` — per-payment cap.
4. `block.timestamp <= deadline` — deadline not expired.
5. `deadline <= block.timestamp + MAX_DEADLINE_SKEW` — deadline not too far.
6. `policy.active` — policy is active (defensive, mirrors deposit).
7. `policy.validUntil >= block.timestamp` — policy not expired.
8. `allowedSourceVaults contains sourceVault` — destination is allowed.
9. `agentWithdrawWindowGross[msg.sender][windowId] + shares <= policy.maxWithdrawPerWindow` — window cap.
10. `paymentId` not already used — replay protection.
11. `IERC20(sourceVault).allowance(receiptOwner, address(this)) >= shares` — receipt allowance sufficient; `receiptOwner` derived from `policy.shareReceiver`.
12. `IERC20(sourceVault).balanceOf(receiptOwner) >= shares` — receipt balance sufficient.

After checks pass:

- Write state effects (window gross, usedPaymentIds) before external calls (CEI pattern).
- Call `IERC4626(sourceVault).redeem(shares, policy.assetRecipient, policy.shareReceiver)`.
- Verify `assetsReceived >= minAssetsOut`.
- Emit `AgentWithdrawal`.

### `AgentWithdrawal` event

```solidity
event AgentWithdrawal(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    address         sourceVault,
    address         assetRecipient,
    uint256         shares,
    uint256         assetsReceived,
    uint64          windowId
);
```

### New error variants

```solidity
error WithdrawalDisabledForPolicy();   // policy.maxWithdrawPerPayment == 0 or allowedSourceVaults empty
error SourceVaultNotAllowed();         // sourceVault not in allowedSourceVaults
error SharesExceedPerPaymentCap();     // shares > maxWithdrawPerPayment
error WithdrawWindowCapExceeded();     // withdraw window gross would exceed maxWithdrawPerWindow
error InsufficientReceiptAllowance();  // receipt allowance < shares
error InsufficientReceiptBalance();    // receipt balance < shares
error InsufficientAssetsOut();         // assetsReceived < minAssetsOut
```

---

## 4. rmpc `withdraw` Command: Preflight and Signing Path

### Preflight reads (in order, fail-fast)

1. `eth_chainId` — matches `config.chain_id`.
2. `keccak256(eth_getCode(gateway))` — matches `config.gateway_runtime_hash`.
3. `gateway.paused()` — must be false.
4. `gateway.agents(self)` — `active`, `validUntil >= now`, `allowedSourceVaults contains sourceVault`.
5. `shares <= agents(self).maxWithdrawPerPayment`.
6. `agentWithdrawWindowGross(self, currentWindow) + shares <= maxWithdrawPerWindow`.
7. `IERC20(sourceVault).allowance(policy.shareReceiver, gateway) >= shares`.
8. `IERC20(sourceVault).balanceOf(policy.shareReceiver) >= shares`.
9. `IERC4626(sourceVault).previewRedeem(shares)` — used to populate `minAssetsOut` with a configurable slippage floor.

### Calldata construction

`rmpc withdraw` builds the exact ABI-encoded calldata for
`gateway.withdraw(orderId, shares, sourceVault, deadline, idempotencyKey, minAssetsOut)`.
No dynamic dispatch; the ABI is compiled in from the `sol!` macro binding
for `IGateway`, same pattern as `deposit`.

### Signing path

Same constrained signing path as `deposit`: sign with the configured
backend (local key, hardware wallet, or future MPC backend), broadcast
via `eth_sendRawTransaction`, wait for receipt, emit stable JSON
envelope.

### Output JSON (stable contract)

```json
{
  "chain_id": 8453,
  "block_number": "...",
  "source": "on-chain",
  "partial": false,
  "errors": [],
  "data": {
    "payment_id": "0x...",
    "order_id": "0x...",
    "source_vault": "0x...",
    "shares_redeemed": "...",
    "assets_received": "...",
    "asset_recipient": "0x...",
    "window_id": "...",
    "tx_hash": "0x..."
  }
}
```

Large integers serialized as decimal strings per the existing `rmpc`
output contract (`docs/technical/rmpc-read-output-contract.md`).

---

## 5. Router-Position Withdrawal Scope

### Decision

Router-position withdrawal (proportional multi-vault redeem coordinated
by a router withdrawal helper) is **deferred past MVP**.

### Rationale

The Portfolio Router does not yet exist as a deployed contract. A router
withdrawal helper would require the router to be deployed first, the
multi-vault proportional math to be specified, and additional gateway
check surfaces for multi-vault operation. These dependencies push the
scope well beyond the current phase.

For MVP, `gateway.withdraw()` operates against a single named vault
(`sourceVault` parameter). An agent holding receipts across multiple
vaults calls `withdraw` once per vault. This is sufficient for the
initial agent-withdrawal use case and avoids coupling gateway withdrawal
to the undeployed Portfolio Router.

The router withdrawal helper remains an open implementation issue for
the Portfolio Router phase. When it is implemented it must preserve the
same gateway permission checks and must not create hidden custody or an
unobservable outer claim, per `docs/architecture.md` §5.2.

---

## 6. Integration Points and Open Risks for Downstream Issues

The following items are surfaced for the benefit of the gateway
withdrawal implementation issue and the rmpc withdraw command issue:

### Gateway contract

- `AgentPolicy` struct change requires re-deployment (non-proxy).
- `authorizeAgent` and `setPolicy` calldata changes; downstream rmpc
  and dapp config-export code must be updated simultaneously.
- `allowedSourceVaults` is a dynamic array in the struct. Solidity
  encodes dynamic arrays in calldata; `agentsReturn` mapping may need
  to expose it as a getter differently than a plain storage var — check
  how OpenZeppelin's `AccessControl.getRoleMember` handles arrays vs.
  what the Solidity mapping auto-getter produces. A view function
  `allowedSourceVaults(agent)` may be needed.
- Window tracking is per-verb (deposit vs. withdraw). Two mappings,
  two window caps, two window gross reads in preflight.

### rmpc

- The config TOML will need `withdrawal_enabled = true` / `source_vaults`
  fields. The config parser and the TOML schema must be updated.
- `get-agent` output must surface the new withdrawal policy fields so
  operators can verify configuration without triggering a live withdrawal.

### Dapp

- The dapp's `authorizeAgent` / `setPolicy` flow must include the new
  fields in its signing prompt and config-export format.
- The depositor must be prompted to approve the gateway as a spender of
  their vault receipts (separate transaction from policy authorization).

### Fork e2e tests

- Happy path: agent redeems shares, USDC goes to `assetRecipient`, not
  to agent.
- Recipient-redirect blocked: agent cannot pass an `assetRecipient` that
  differs from the policy-configured one (the value is read from storage,
  not passed by the caller).
- Receipt-allowance check: withdraw fails if depositor has not approved
  gateway.
- Window cap: second withdrawal within the same window that would exceed
  `maxWithdrawPerWindow` reverts.
- Source vault check: withdraw to a vault not in `allowedSourceVaults`
  reverts.
