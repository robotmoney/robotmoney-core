---
name: robotmoney-cli
description: >
  Use the `rmpc` Rust client to interact with the Robot Money vault and policy
  gateway from an agent runtime. Use this skill when the user asks to:
  inspect vault, gateway, agent-policy, or role state on-chain
  ("Is the vault healthy?", "What's my agent's deposit cap?", "Who has ADMIN_ROLE?");
  read an ERC-20 balance, allowance, deposit record, or transaction receipt
  ("What's my USDC balance?", "Did this deposit go through?");
  run the signer self-check before any write
  ("Is my signing backend ready?");
  submit a guarded USDC deposit through the gateway
  ("Deposit 100 USDC for order 0x...").
  Always run reads first, run `self-check` before any write, and refuse to
  proceed when preflight (caps, allowance, code-hash, fee cap, role,
  pause) does not pass.
---

# robotmoney-cli (`rmpc`)

> **Experimental — pre-v1.0.** Command syntax, flags, and output shapes can
> change. Verify every transaction. Default to fork/devnet; mainnet must be an
> explicit operator action.

`rmpc` is the Robot Money Rust payment client. It is the only path to a signed
deposit on the Robot Money policy gateway. The same binary also exposes
direct on-chain read commands so an agent can inspect vault, gateway, and
agent-policy state without an explorer API.

All commands take `--config <path-to-config.toml>` and write JSON to stdout;
exit code 0 means success, non-zero means a named, structured error on stderr.
Add `--pretty` for indented JSON.

## Target users

This skill is for **AI agents and autonomous machines** that have been issued
an `AGENT_ROLE` key on the Robot Money gateway. It is not a retail wallet UX:
output is JSON, errors are named, and writes are gated by on-chain policy
(per-deposit cap, per-window cap, pause, role, share-receiver, code-hash).

## Reference docs

- **[Read commands](references/read.md)** — `self-check`, `get-vault`,
  `get-gateway`, `get-agent`, `get-roles`, `get-balance`, `get-allowance`,
  `get-deposit`, `get-tx`. Output envelope, error fields, and call-order
  recommendations.
- **[Write commands](references/write.md)** — `deposit`, `status`. Required
  preflight, idempotency model, deadline semantics, gas/fee cap behavior, and
  the single-flight nonce lock.
- **[Safety and refusal cases](references/safety.md)** — every refusal the
  client emits before broadcast, mapped to implementation-plan §4.4 (preflight),
  §4.6 (nonce lock), and §4.7 (fee cap), plus the fork-vs-mainnet warning.
- **[Examples](references/examples.md)** — minimal prompts and expected
  command traces for read-first inspection, guarded deposit, and refusal
  handling.

## Command surface

The complete surface (mirrors `rmpc --help`):

```text
rmpc deposit        Sign and broadcast a USDC deposit through the gateway
rmpc status         Look up a previously submitted payment by its on-chain `paymentId`
rmpc self-check     Print the signer-backend self-check report (v0 §9.2 JSON)
rmpc get-vault      Read vault state directly from chain
rmpc get-gateway    Read gateway state directly from chain
rmpc get-agent      Read an agent's authorization + window usage
rmpc get-roles      Read role membership on the gateway for a target address
rmpc get-balance    Read an ERC-20 token balance for an address (USDC by default)
rmpc get-allowance  Read an ERC-20 allowance(owner, spender) on the configured USDC
rmpc get-deposit    Look up a gateway deposit by its on-chain id (`AgentDeposit.paymentId`)
rmpc get-tx         Look up a transaction's receipt status by hash
```

Every command requires `--config <CONFIG>` (a TOML file pinning chain id,
gateway address, USDC address, vault address, gateway runtime code hash, fee
cap, signer backend, and state directory). The config is operator-managed; the
agent does not edit it at runtime.

## Operating model

1. **Read first.** Before any write, the agent runs `get-vault`, `get-gateway`,
   `get-agent --agent <self>`, `get-balance --address <self>`, and
   `get-allowance --owner <self> --spender <gateway>`. These answer "is the
   vault healthy?", "am I authorized?", "do I have funds and approval?".
2. **Self-check.** Before any deposit, run `rmpc self-check`. The signer
   backend, encrypted-keystore status, and `allow_software_fallback` flag must
   all be acceptable per the operator's policy.
3. **Guarded write.** Run `rmpc deposit` with the operator-issued
   `--order-id` (and optional `--idempotency-key`). The client mirrors every
   contract precondition in `preflight` and refuses to sign if any check
   fails. Hard refusal is intentional and not advisory.
4. **Confirm.** Use `rmpc status --payment-id <id>` (or `rmpc get-deposit`) to
   confirm the on-chain record. The returned `paymentId` is the canonical
   identity for retry/idempotency.

## Refusal cases

The agent must surface — not suppress — these refusals:

- **Preflight (§4.4):** paused gateway, agent inactive or expired, allowance
  or balance below `--amount`, chain id mismatch, gateway runtime code-hash
  mismatch.
- **Caps (gateway):** `--amount > maxPerPayment` or
  `windowGross + amount > maxPerWindow`.
- **Nonce lock (§4.6):** another `rmpc deposit` is in flight for the same
  agent address (`ErrConcurrentInvocation`).
- **Fee cap (§4.7):** computed `maxFeePerGas` exceeds `max_fee_per_gas_cap`
  in config (`ErrFeeCapExceeded`).
- **Signer backend:** software signer selected but
  `[signer].allow_software_fallback = false` — the binary exits before any
  RPC.

See [`references/safety.md`](references/safety.md) for the full table.

## Network environment label

Every `rmpc` command result includes a stable `network_env` field that
identifies the active chain. Agents MUST report this label in every summarized
response — do not omit it or substitute the raw `chain_id` integer.

Stable label values:

| `network_env` value  | Meaning                                    |
|----------------------|--------------------------------------------|
| `local_devnet`       | Anvil / local devnet (chain id 31337)      |
| `rm_testnet`         | Robot Money testnet — Base Sepolia (84532) |
| `production_base`    | Production Base mainnet (8453)             |
| `unknown`            | Unrecognised chain id                      |

When `network_env == "production_base"`, agents MUST surface the following
warning before recommending or describing any write action:

> **WARNING: connected to production Base mainnet — real assets are at risk.**

The warning must appear in every agent response that summarizes a deposit,
status, or self-check result issued against production Base.

For read-only commands (`get-vault`, `get-gateway`, `get-agent`, `get-balance`,
`get-allowance`, `get-deposit`, `get-tx`), the agent should note the
`network_env` label in its response summary but does not need to gate on it.

Unknown chain ids (`network_env == "unknown"`) must be surfaced verbatim; the
agent must not bypass existing chain-id or code-hash refusals and must not
assume such a chain is safe.

## Fork-vs-mainnet

Default to fork or local devnet. Mainnet operation requires an explicit,
operator-supplied config and is loud by design: a high-severity log line on
startup notes any mainnet chain id and any software-signer fallback. The
agent must not silently switch chains.

## Harness portability

This skill makes no assumptions about a specific harness. `rmpc` is a plain
binary that reads JSON config and writes JSON to stdout. Any harness that can
run a subprocess and parse JSON can use it. Harness-specific install steps
(OpenCode, OpenClaw) are documented separately under
`docs/implementation-plan.md` §10.
