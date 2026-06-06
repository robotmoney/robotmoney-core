---
name: robotmoney-cli
description: >
  Complete rmpc CLI reference. Use this skill when you need the full command
  surface for the Robot Money Rust payment client, including read commands
  (get-vault, get-gateway, get-agent, get-roles, get-balance, get-allowance,
  get-deposit, get-tx, get-vaults, get-router, get-governance, get-timelock),
  write commands (deposit, withdraw, status, self-check), and governance write
  commands (propose, vote). Covers all flags, output shapes, preflight rules,
  and the get-governance → propose → vote example trace.
---

# robotmoney-cli (`rmpc`)

> **Experimental — pre-v1.0.** Command syntax, flags, and output shapes can
> change. Verify every transaction. Default to fork/devnet; mainnet must be an
> explicit operator action.

`rmpc` is the Robot Money Rust payment client. It is the only path to signed
writes on the Robot Money policy gateway. The binary also exposes direct
on-chain read commands and governance write commands.

All commands require `--config <path-to-config.toml>` and write JSON to stdout.
Exit code 0 means success; non-zero means a named, structured error. Add
`--pretty` for indented JSON.

## Reference docs

- **[Commands](references/commands.md)** — complete flag reference for every
  subcommand: `deposit`, `withdraw`, `status`, `self-check`, `get-vault`,
  `get-vaults`, `get-router`, `get-governance`, `get-timelock`, `get-gateway`,
  `get-agent`, `get-roles`, `get-balance`, `get-allowance`, `get-deposit`,
  `get-tx`, `propose`, `vote`.

## Command surface

The complete surface (mirrors `rmpc --help`):

```text
rmpc deposit         Sign and broadcast a USDC deposit through the gateway
rmpc withdraw        Redeem vault shares through the gateway (agent-initiated)
rmpc status          Look up a previously submitted payment by its on-chain paymentId
rmpc self-check      Print the signer-backend self-check report (v0 §9.2 JSON)
rmpc get-vault       Read vault state directly from chain
rmpc get-vaults      List all vaults registered in the VaultRegistry
rmpc get-router      Read PortfolioRouter state: vault addresses, weight bps, and router cap
rmpc get-governance  Read RouterGovernance state: active proposal, cadence params, and weights
rmpc get-timelock    Read TimelockController state
rmpc get-gateway     Read gateway state directly from chain
rmpc get-agent       Read an agent's authorization + window usage
rmpc get-roles       Read role membership on the gateway for a target address
rmpc get-balance     Read an ERC-20 token balance for an address (USDC by default)
rmpc get-allowance   Read an ERC-20 allowance(owner, spender) on the configured USDC
rmpc get-deposit     Look up a gateway deposit by its on-chain id
rmpc get-tx          Look up a transaction's receipt status by hash
rmpc propose         Submit a new weight-reallocation proposal to RouterGovernance
rmpc vote            Cast a vote on an active RouterGovernance proposal
```

## Governance write commands

### propose

Submit a new weight-reallocation proposal to `RouterGovernance.propose()`.

```bash
rmpc propose --config <CONFIG> \
  --vaults <ADDR1>,<ADDR2> \
  --weights-bps <BPS1>,<BPS2> \
  [--gas-limit <GAS>] \
  [--fee-cap <WEI>] \
  [--receipt-timeout-secs <SECS>] \
  [--pretty]
```

Flags:
- `--config` / `-c` — path to operator config TOML (required)
- `--vaults` — comma-separated vault addresses, 0x-prefixed hex (required)
- `--weights-bps` — comma-separated weight bps values summing to 10 000 (required)
- `--gas-limit` — gas limit for the propose tx (default 500 000)
- `--fee-cap` — override `max_fee_per_gas_cap` in wei
- `--receipt-timeout-secs` — seconds to wait for the receipt (default 60)
- `--pretty` — indented JSON output

Output on success (`exit 0`):
```json
{
  "ok": true,
  "result": {
    "proposal_id": "1",
    "tx_hash": "0x...",
    "block_number": 12345
  }
}
```

Exit codes:
- `0` — proposal submitted and mined.
- `2` — preflight refusal or broadcast failure.
- `3` — startup failure: missing `governance_address` in config, uninitialized
  signer, or runtime error.

### vote

Cast a vote on an active `RouterGovernance` proposal.

```bash
rmpc vote --config <CONFIG> \
  --proposal-id <ID> \
  --choice yes|no|abstain \
  [--gas-limit <GAS>] \
  [--fee-cap <WEI>] \
  [--receipt-timeout-secs <SECS>] \
  [--pretty]
```

Flags:
- `--config` / `-c` — path to operator config TOML (required)
- `--proposal-id` — proposal id to vote on, decimal integer (required)
- `--choice` — vote direction: `yes`, `no`, or `abstain` (required)
- `--gas-limit` — gas limit for the vote tx (default 200 000)
- `--fee-cap` — override `max_fee_per_gas_cap` in wei
- `--receipt-timeout-secs` — seconds to wait for the receipt (default 60)
- `--pretty` — indented JSON output

The contract supports only FOR votes (`vote(proposalId)`). Calling with
`--choice yes` submits the on-chain vote. `--choice no` and `--choice abstain`
are client-side no-ops (the contract has no mechanism to record them).

Idempotency: re-calling `--choice yes` when already voted exits 0 (no-op).
Calling with a different direction after a previous `yes` exits 2 with
`ErrVoteAlreadyCast`.

Output on success (`exit 0`):
```json
{
  "ok": true,
  "status": "cast",
  "receipt": {
    "proposal_id": "1",
    "choice": "yes",
    "tx_hash": "0x...",
    "block_number": 12345
  }
}
```

Idempotent no-op output:
```json
{
  "ok": true,
  "status": "noop"
}
```

Exit codes:
- `0` — vote cast or idempotent no-op.
- `2` — `ErrVoteAlreadyCast` (different direction after an on-chain yes).
- `3` — startup failure: missing `governance_address`, uninitialized signer, etc.

## Example trace: get-governance → propose → vote

```bash
# 1. Read current governance state
rmpc get-governance --config rmpc.toml --pretty

# 2. Submit a weight-reallocation proposal
rmpc propose --config rmpc.toml \
  --vaults 0xVaultA...,0xVaultB... \
  --weights-bps 6000,4000 \
  --pretty

# 3. Vote in favour of the proposal
rmpc vote --config rmpc.toml \
  --proposal-id 1 \
  --choice yes \
  --pretty

# 4. Confirm the vote was recorded
rmpc get-governance --config rmpc.toml --pretty
```

The `get-governance` output includes the active proposal's `proposal_id`,
`voting_deadline`, `proposed_vaults`, `proposed_bps`, `votes_for`,
`votes_against`, and `votes_abstain`.
