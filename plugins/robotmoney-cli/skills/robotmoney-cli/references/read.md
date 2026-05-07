# Read commands

`rmpc` exposes direct JSON-RPC reads for vault, gateway, agent, and ERC-20
state. No explorer API is used or required for safety-critical reads. Output
is stable JSON suitable for agents and shell scripts.

Common flags (every read command):

- `-c, --config <CONFIG>` — path to the operator config TOML (required).
- `--pretty` — pretty-print JSON output.

Per the implementation plan §9 read-output contract:

- All large integers are emitted as **decimal strings** (never JSON numbers).
- Every read response includes `chain_id`, `block_number`, and
  `source: "json_rpc"`.
- Commands that combine multiple reads include a `partial` flag and a
  per-field error list when some reads fail.

Exit code is 0 on success. Failures emit a structured JSON error on stderr
and a non-zero exit.

---

## `self-check`

```bash
rmpc self-check --config ./config.toml [--pretty]
```

Prints the signer-backend self-check report (v0 §9.2 JSON shape). Use this
**before any write** to confirm the encrypted-keystore is reachable, the
backend kind matches operator policy, and `allow_software_fallback` is set
correctly. No RPC reads are required for this command beyond chain-id checks
performed by the signer module on startup.

---

## `get-vault`

```bash
rmpc get-vault --config ./config.toml [--pretty]
```

Reads the configured `RobotMoneyVault` (ERC-4626) directly. Returns vault
address, asset and share metadata, total assets and supply, share price,
deposit caps, pause/shutdown flags, adapter addresses and balances where the
ABI exposes them. Fields not exposed on-chain are returned as `unknown` or
`not_onchain` rather than guessed.

Use it to answer "is the vault healthy?" before any deposit.

---

## `get-gateway`

```bash
rmpc get-gateway --config ./config.toml [--pretty]
```

Reads the configured `RobotMoneyGateway`. Returns gateway address, chain id,
configured USDC and vault addresses, the runtime code hash (compared against
`gateway_runtime_hash` in config), and the pause flag. A code-hash mismatch is
a hard refusal at write time (see `references/safety.md`).

---

## `get-agent`

```bash
rmpc get-agent --config ./config.toml --agent <0x...> [--pretty]
```

Reads `agents[address]` policy: `active`, `validUntil`, `maxPerPayment`,
`maxPerWindow`, `shareReceiver`, plus the current
`agentWindowGross[address][windowId]` for the live window. Use it before any
deposit to confirm the agent is authorized and has remaining cap.

---

## `get-roles`

```bash
rmpc get-roles --config ./config.toml --address <0x...> [--pretty]
```

Reports membership of `ADMIN_ROLE`, `PAUSER_ROLE`, and `AGENT_ROLE` on the
gateway for the supplied address. The gateway enforces an invariant that an
`AGENT_ROLE` holder must not also hold `ADMIN_ROLE` or `PAUSER_ROLE`; this
command is the agent-side check.

---

## `get-balance`

```bash
rmpc get-balance --config ./config.toml --address <0x...> [--pretty]
```

Reads an ERC-20 balance for `address` on the configured USDC. Output includes
the raw smallest-unit string, the token address, and decimals so callers can
format without re-deriving constants.

---

## `get-allowance`

```bash
rmpc get-allowance --config ./config.toml \
  --owner <0x...> --spender <0x...> [--pretty]
```

Reads `allowance(owner, spender)` on the configured USDC. The agent must
ensure `allowance(self, gateway) >= amount` before `rmpc deposit` — the
client mirrors this in preflight (§4.4) and refuses with a structured error
otherwise.

---

## `get-deposit`

```bash
rmpc get-deposit --config ./config.toml --deposit-id <0x...> [--pretty]
```

Looks up a gateway deposit by its `paymentId`. `paymentId` is the keccak hash
of `(chain_id, gateway, agent, orderId, amount, idempotencyKey)` and is
returned by `rmpc deposit` and `rmpc status`. Use this to confirm an
on-chain record after a successful broadcast.

---

## `get-tx`

```bash
rmpc get-tx --config ./config.toml --tx-hash <0x...> [--pretty]
```

Returns the transaction receipt status (success/reverted), block number,
gas used, and any decoded `AgentDeposit` event from the gateway log set.
Useful to confirm that a broadcast tx was actually mined and not just
accepted into the mempool.

---

## Recommended call order before a write

```text
rmpc self-check         --config ./config.toml
rmpc get-gateway        --config ./config.toml
rmpc get-vault          --config ./config.toml
rmpc get-agent          --config ./config.toml --agent <self>
rmpc get-balance        --config ./config.toml --address <self>
rmpc get-allowance      --config ./config.toml --owner <self> --spender <gateway>
```

Only proceed to `rmpc deposit` if every read returns a healthy state and the
agent has remaining `maxPerPayment` and `maxPerWindow` capacity for the
intended amount.
