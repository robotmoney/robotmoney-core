---
name: robotmoney-user
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
  ("Deposit 100 USDC for order 0x..."). The deposit is the only write.
  Always run reads first, run `self-check` before any write, and refuse to
  proceed when preflight (caps, allowance, code-hash, fee cap, role,
  deposit pause) does not pass.
---

# robotmoney-user (`rmpc`)

> **Owner decisions 2026-10-19 and 2026-10-20 (noted 2026-10-20).** The tables below
> document today's binary. These parts of it are deprecated: `withdraw`, `withdraw-router`, router deposits, `receipt submit`, `committee vote-submit`, `committee check-agent` and the Investment Committee policy.
> The only on-chain write `rmpc` keeps is `rmpc deposit` into an allowed vault.
> Consensus receipts go on-chain only through the submitter Safe (the
> publish-contracts `record-receipt` row), never through `rmpc`. Details: `docs/code-review/20261019-code-review-internal-claude-opus-5-5-rmpc-scope.md` and `docs/code-review/20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md`.

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
(per-deposit cap, per-window cap, deposit pause, role, share-receiver, code-hash).

## Reference docs

- **[Read commands](references/read.md)** — `self-check`, `get-vault`,
  `get-gateway`, `get-agent`, `get-roles`, `get-balance`, `get-allowance`,
  `get-deposit`, `get-tx`. Output envelope, error fields, and call-order
  recommendations.
- **[Write commands](references/write.md)** — `deposit`, `withdraw`, `status`.
  Required preflight, idempotency model, deadline semantics, gas/fee cap
  behavior, and the single-flight nonce lock.
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
rmpc withdraw       Redeem vault shares through the gateway (agent-initiated redemption)
rmpc withdraw-router Redeem shares from several vaults in one call (preview without --confirm)
rmpc status         Look up a previously submitted payment by its on-chain `paymentId`
rmpc self-check     Print the signer-backend self-check report (v0 §9.2 JSON)
rmpc get-vault      Read vault state directly from chain
rmpc get-vaults     List all vaults registered in the VaultRegistry
rmpc get-router     Read PortfolioRouter state: vault addresses, weight bps, and router cap
rmpc get-governance Read RouterGovernance state: last applied weights and receipt register
rmpc get-gateway    Read gateway state directly from chain
rmpc get-agent      Read an agent's authorization + window usage
rmpc get-roles      Read role membership on the gateway for a target address
rmpc get-balance    Read an ERC-20 token balance for an address (USDC by default)
rmpc get-allowance  Read an ERC-20 allowance(owner, spender) on the configured USDC
rmpc get-deposit    Look up a gateway deposit by its on-chain id (`AgentDeposit.paymentId`)
rmpc get-vaults     List all vaults registered in the VaultRegistry
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

- **Preflight (§4.4):** gateway deposits paused (`ErrDepositsPaused`, deposit
  only), agent inactive (`ErrAgentNotAuthorized`) or expired
  (`ErrPolicyExpired`), agent bound to another owner or share receiver
  (`ErrAgentBindingMismatch`), allowance or balance below `--amount`
  (`ErrAllowanceInsufficient`, `ErrBalanceInsufficient`), chain id mismatch,
  gateway runtime code-hash mismatch.
- **Caps (gateway):** `--amount > maxPerPayment` or
  `windowGross + amount > maxPerWindow` (`ErrDepositCapExceeded`); the
  withdraw caps (`ErrWithdrawCapExceeded`).
- **Router legs:** a router deposit reads `router.previewDeposit` first. A
  leg with weight above 0 that the router would skip is refused as
  `ErrLegUnavailable` unless the user approves `--allow-unavailable-legs`.
  Without `--min-shares-per-leg`, each funded leg gets a floor of its
  quoted shares less 0.50%.
- **Simulation:** the exact call is simulated before signing; a router leg
  that is disabled, unavailable (including `LegSkippedWithFloor`) or below
  its slippage floor is refused as `ErrVaultDisabled`, `ErrLegUnavailable`
  or `ErrSlippageBoundExceeded`.
- **withdraw-router:** `--min-assets-per-leg` is required
  (`ErrMinAssetsPerLegRequired`; `0` sends no floor), and without
  `--confirm` the command only prints its preview (`ErrConfirmNotProvided`).
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
the retired `Plan tracking issue #109` §10 (git history).
