# Write commands

`rmpc` ships exactly one write command: `deposit`. There is no withdraw,
redeem, role-grant, pause, or unpause path in the MVP — those flow through
the human dapp (implementation plan §12), not the agent client. `status` is
listed here because it is the canonical follow-up to a write.

Every write goes through:

1. Load and validate the operator config TOML (chain id, addresses, code hash,
   fee cap, signer backend, state directory).
2. Run preflight (mirrors gateway invariants — see `safety.md` §4.4).
3. Acquire a single-flight nonce file lock (§4.6) before signing.
4. Compute EIP-1559 fees against `eth_feeHistory` and the configured fee cap
   (§4.7).
5. Build a typed `GatewayTxRequest`, sign the EIP-1559 envelope hash, and
   broadcast.
6. Wait up to `--receipt-timeout-secs` for the receipt; emit the structured
   result (or a named error) to stdout.

The Rust binary is the only path to a signed deposit — no provider is exposed
externally.

---

## `deposit`

```bash
rmpc deposit --config <CONFIG> \
  --amount <AMOUNT> \
  --order-id <0x...> \
  [--idempotency-key <0x...>] \
  [--deadline-secs <N>] \
  [--receipt-timeout-secs <N>] \
  [--gas-limit <N>] \
  [--pretty]
```

Required flags:

- `--config <CONFIG>` — operator config TOML.
- `--amount <AMOUNT>` — deposit amount in USDC's smallest unit (6 decimals).
  Decimal integer string; `100000000` = 100 USDC. **Never** a floating-point
  value.
- `--order-id <0x...>` — 32-byte order id, 0x-prefixed hex. Operator-supplied;
  identifies the off-chain payment intent.

Optional flags:

- `--idempotency-key <0x...>` — 32-byte key, 0x-prefixed hex. Defaults to
  `--order-id` when omitted. The on-chain `paymentId` is
  `keccak256(chain_id, gateway, agent, orderId, amount, idempotencyKey)`.
  **`deadline` is intentionally excluded from the hash.** Re-running with the
  same `(orderId, idempotencyKey, amount)` produces the same `paymentId`,
  and the second call is rejected by `usedPaymentIds`. This makes deadline a
  *liveness* parameter, not an *identity* parameter.
- `--deadline-secs <N>` — deadline horizon in seconds from now. Capped at 600
  (the gateway's `MAX_DEADLINE_SKEW`). Default 300.
- `--receipt-timeout-secs <N>` — maximum seconds to wait for the receipt.
  Default 60.
- `--gas-limit <N>` — gas limit for the deposit envelope. Default 350_000;
  the happy-path deposit is ~150k. The cushion covers cold-storage vault
  writes on first interaction.

### Output (success)

JSON on stdout including:

- `paymentId` — 32-byte hex; canonical identity for retry/lookup.
- `txHash` — 32-byte hex of the broadcast transaction.
- `blockNumber` — receipt block.
- `sharesMinted` — vault shares minted to the agent's pre-registered
  `shareReceiver` (the agent never receives `rmUSDC` directly).
- `windowId` — `uint64(block.timestamp / 86400)`.
- Standard envelope: `chain_id`, `block_number`, `source: "json_rpc"`.

### Output (refusal / error)

Non-zero exit, structured JSON on stderr, with a stable error `code` field.
See `safety.md` for the full list. The client never broadcasts a transaction
it has not first proven to satisfy every preflight check.

### Single-flight invariant

`rmpc deposit` is intentionally single-flight per agent address. Concurrent
invocations against the same agent fail fast with `ErrConcurrentInvocation`
on the loser side. A full nonce manager (with pending-tx queue, replacement,
and gap recovery) is v1 work.

---

## `status`

```bash
rmpc status --config <CONFIG> --payment-id <0x...> [--pretty]
```

Looks up a previously submitted payment by its on-chain `paymentId`. Output
follows the Phase 3 shared envelope (`chain_id`, `block_number`,
`source: "json_rpc"`, `partial`, `errors`, `data`) — the same envelope used by
`get-deposit` and all other read commands. No explorer API is involved.

On success, `data` contains:

- `payment_id` — 32-byte hex, echoed from the query.
- `order_id` — 32-byte hex.
- `agent` — agent address (0x-prefixed).
- `share_receiver` — address that received vault shares (0x-prefixed).
- `amount` — deposit amount as a **decimal string** (never a lossy JSON number).
- `shares_minted` — shares minted as a **decimal string**.
- `block_number` — block number of the `AgentDeposit` log.
- `tx_hash` — transaction hash (0x-prefixed hex).

When no matching `AgentDeposit` log is found, `data` contains:

- `payment_id` — echoed from the query.
- `status: "not_found"` — typed absence result; exit code is still 0.

Use `rmpc status` for retry, follow-up, and cross-checking after a `deposit`
invocation.

---

## Idempotency model

The agent's safe replay strategy:

- Pick a stable `--idempotency-key` per business intent. If the operator
  supplies an order id that itself encodes intent, omit the flag and accept
  the default (`idempotencyKey = orderId`).
- On any error before broadcast, re-run with the same flags. Preflight will
  re-check on-chain state.
- On any error after broadcast (network blip, receipt timeout), call
  `rmpc status --payment-id <id>` rather than re-running `deposit`. Re-running
  with the same `(orderId, idempotencyKey, amount)` is safe — the contract
  rejects duplicates — but it consumes nonce/gas pointlessly.

---

## What `rmpc` will not do

- Withdraw, redeem, or transfer vault shares.
- Grant or revoke roles. Authorize, revoke, or modify agent policy.
- Pause or unpause the gateway.
- Sign anything other than an EIP-1559 envelope hash for a typed
  `GatewayTxRequest`. The `AgentSigner` trait deliberately does not expose
  `sign_hash`, `sign_message`, or `sign_typed_data`.
- Run interactive secret prompts inside a long-lived agent harness without
  explicit operator setup.

If a user asks for any of the above, refuse and direct them to the human
dapp (implementation plan §12).
