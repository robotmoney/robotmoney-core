# Examples

Minimal prompts and the command traces an agent should run in response. JSON
shapes are illustrative; consult `read.md` and `write.md` for the canonical
field sets and `safety.md` for the refusal vocabulary.

All commands assume an operator-supplied config at `./config.toml` and a
preconfigured `RMPC_STATE_DIR`.

---

## Example 1 — read-only health inspection

**User prompt:** "Is the Robot Money vault healthy and is my agent allowed
to deposit right now?"

```bash
rmpc get-vault   --config ./config.toml --pretty
rmpc get-gateway --config ./config.toml --pretty
rmpc get-agent   --config ./config.toml --agent 0xAGENT --pretty
```

**Expected agent behavior:**

- Confirm `paused == false` on both vault (if exposed) and gateway.
- Confirm `agents[self].active == true` and `validUntil > now`.
- Report remaining `maxPerWindow - agentWindowGross[self][windowId]` so the
  user knows the available capacity.
- Do not propose a deposit yet — this is read-only.

---

## Example 2 — guarded deposit (happy path)

**User prompt:** "Deposit 100 USDC for order
`0x11...1f` through Robot Money."

```bash
rmpc self-check    --config ./config.toml
rmpc get-agent     --config ./config.toml --agent 0xAGENT
rmpc get-balance   --config ./config.toml --address 0xAGENT
rmpc get-allowance --config ./config.toml --owner 0xAGENT --spender 0xGATEWAY

rmpc deposit \
  --config ./config.toml \
  --amount 100000000 \
  --order-id 0x1111111111111111111111111111111111111111111111111111111111111111
```

**Expected agent behavior:**

- Compute `100 USDC = 100000000` (6 decimals); never use a floating-point
  amount.
- Confirm balance and allowance both `>= 100000000` before invoking
  `deposit`. If allowance is short, do not silently issue an approval — that
  is an operator/dapp action.
- On success, capture `paymentId`, `txHash`, `sharesMinted`, and report
  them.
- Follow up with `rmpc status --payment-id <id>` if the receipt times out.

---

## Example 3 — refusal: insufficient allowance

**User prompt:** "Deposit 500 USDC."

```bash
rmpc get-allowance --config ./config.toml \
  --owner 0xAGENT --spender 0xGATEWAY --pretty
```

Reports `allowance == 100000000` (100 USDC).

```bash
rmpc deposit --config ./config.toml \
  --amount 500000000 \
  --order-id 0x2222...2222
```

Returns non-zero exit and JSON error `{"code": "ErrInsufficientAllowance",
...}`.

**Expected agent behavior:**

- Surface the refusal verbatim. Do **not** retry with a smaller amount
  unless the user explicitly approves the smaller intent.
- Do **not** issue an approval transaction. Direct the user to the human
  dapp (implementation-plan §12).

---

## Example 4 — refusal: paused gateway

**User prompt:** "Deposit 50 USDC."

```bash
rmpc get-gateway --config ./config.toml --pretty
```

Reports `paused == true`.

```bash
rmpc deposit --config ./config.toml \
  --amount 50000000 \
  --order-id 0x3333...3333
```

Returns non-zero exit and JSON error `{"code": "ErrGatewayPaused", ...}`.

**Expected agent behavior:**

- Surface the refusal. Do not retry on a timer.
- Note that pause is asymmetric: `PAUSER_ROLE` may have triggered it
  unilaterally as a stop-the-world tool, and only `ADMIN_ROLE` can unpause.

---

## Example 5 — refusal: code-hash mismatch

**User prompt:** "Deposit 10 USDC."

```bash
rmpc deposit --config ./config.toml \
  --amount 10000000 \
  --order-id 0x4444...4444
```

Returns non-zero exit and JSON error `{"code": "ErrCodeHashMismatch", ...}`.

**Expected agent behavior:**

- Stop. Do not advise disabling the check; there is no flag for that.
- Surface the operator action: redeploy + config bump per
  implementation-plan §4.4.

---

## Example 6 — confirming a prior deposit

**User prompt:** "Did my deposit for order `0x11...1f` go through?"

```bash
# Recompute paymentId from (chain_id, gateway, agent, orderId, amount,
# idempotencyKey) — the value rmpc deposit printed on success — then:
rmpc status      --config ./config.toml --payment-id 0xPAYMENTID --pretty
rmpc get-deposit --config ./config.toml --deposit-id 0xPAYMENTID --pretty
rmpc get-tx      --config ./config.toml --tx-hash    0xTXHASH    --pretty
```

**Expected agent behavior:**

- Prefer `status` for the rolled-up view, `get-deposit` for the on-chain
  record, and `get-tx` for the underlying receipt.
- If the prior `rmpc deposit` failed mid-flight, re-running with the same
  `--order-id` and `--idempotency-key` (and the same `--amount`) is safe:
  the contract rejects duplicates by `paymentId`. Prefer `status` over a
  re-run when the previous attempt may already have been mined.
