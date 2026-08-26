# rmpc command reference

Complete flag reference for all `rmpc` subcommands. Every command requires
`--config <CONFIG>` unless noted.

## Read commands

### `rmpc self-check`

Print the signer-backend self-check report.

```
rmpc self-check --config <CONFIG> [--pretty]
```

### `rmpc get-vault`

Read vault state directly from chain.

```
rmpc get-vault --config <CONFIG> [--address <ADDR>] [--pretty]
```

### `rmpc get-vaults`

List all vaults registered in the VaultRegistry.

```
rmpc get-vaults --config <CONFIG> [--pretty]
```

### `rmpc get-router`

Read PortfolioRouter state: vault addresses, weight bps, and router cap.

```
rmpc get-router --config <CONFIG> [--pretty]
```

### `rmpc get-governance`

Read RouterGovernance state: active proposal, cadence params, and weights.
Requires `governance_address` in config.

```
rmpc get-governance --config <CONFIG> [--pretty]
```

Output includes: `proposal_id`, `voting_deadline`, `proposed_vaults`,
`proposed_bps`, `votes_for`, `votes_against`, `votes_abstain`.

### `rmpc get-timelock`

Read TimelockController state.

```
rmpc get-timelock --config <CONFIG> [--pretty]
```

### `rmpc get-gateway`

Read gateway state directly from chain.

```
rmpc get-gateway --config <CONFIG> [--pretty]
```

### `rmpc get-agent`

Read an agent's authorization + window usage.

```
rmpc get-agent --config <CONFIG> --agent <ADDR> [--pretty]
```

### `rmpc get-roles`

Read role membership on the gateway for a target address.

```
rmpc get-roles --config <CONFIG> --address <ADDR> [--pretty]
```

### `rmpc get-balance`

Read an ERC-20 token balance for an address (USDC by default).

```
rmpc get-balance --config <CONFIG> --address <ADDR> [--pretty]
```

### `rmpc get-allowance`

Read an ERC-20 allowance(owner, spender) on the configured USDC.

```
rmpc get-allowance --config <CONFIG> --owner <ADDR> --spender <ADDR> [--pretty]
```

### `rmpc get-deposit`

Look up a gateway deposit by its on-chain id.

```
rmpc get-deposit --config <CONFIG> --deposit-id <ID> [--pretty]
```

### `rmpc get-tx`

Look up a transaction's receipt status by hash.

```
rmpc get-tx --config <CONFIG> --tx-hash <HASH> [--pretty]
```

## Write commands

### `rmpc deposit`

Sign and broadcast a USDC deposit through the gateway.

```
rmpc deposit --config <CONFIG> --amount <UNITS> --order-id <HEX>
  [--idempotency-key <HEX>] [--deadline-secs <N>]
  [--receipt-timeout-secs <N>] [--gas-limit <N>] [--fee-cap <WEI>]
  [--pretty]
```

### `rmpc withdraw`

Redeem vault shares through the gateway (agent-initiated redemption).

```
rmpc withdraw --config <CONFIG> --shares <N> --source-vault <ADDR>
  --order-id <HEX> [--idempotency-key <HEX>] [--deadline-secs <N>]
  [--receipt-timeout-secs <N>] [--gas-limit <N>] [--fee-cap <WEI>]
  [--pretty]
```

### `rmpc withdraw-router`

Redeem vault shares via the Portfolio Router (multi-vault proportional
redemption, agent-initiated). Calls
`gateway.withdrawFromRouter(orderId, sharesPerLeg, deadline, idempotencyKey)`.
USDC lands at the policy-configured `assetRecipient`; no shares pass through
the gateway. Requires `--confirm` to proceed past the preview.

Run `rmpc get-router` first to inspect the router's current vault order and
decide per-leg share amounts.

```
rmpc withdraw-router --config <CONFIG>
  --shares-per-leg <N,N,...> --order-id <HEX>
  [--idempotency-key <HEX>] [--deadline-secs <N>]
  [--receipt-timeout-secs <N>] [--gas-limit <N>] [--fee-cap <WEI>]
  --confirm [--pretty]
```

### `rmpc status`

Look up a previously submitted payment by its on-chain `paymentId`.

```
rmpc status --config <CONFIG> --payment-id <HEX> [--pretty]
```

## Governance write commands

### `rmpc propose`

Submit a new weight-reallocation proposal to `RouterGovernance.propose()`.
Requires `governance_address` in config and a configured signer.

```
rmpc propose --config <CONFIG> --vaults <ADDR,...> --weights-bps <BPS,...>
  [--gas-limit <N>] [--fee-cap <WEI>] [--receipt-timeout-secs <N>]
  [--pretty]
```

### `rmpc vote`

Cast a vote on an active `RouterGovernance` proposal.
Requires `governance_address` in config and a configured signer.

```
rmpc vote --config <CONFIG> --proposal-id <ID> --choice yes|no|abstain
  [--gas-limit <N>] [--fee-cap <WEI>] [--receipt-timeout-secs <N>]
  [--pretty]
```

`--choice yes` submits `vote(proposalId)` on-chain. `no` and `abstain` are
client-side no-ops (the contract only records FOR votes). Re-calling with the
same choice after a `yes` vote exits 0 (idempotent). A different choice after
an on-chain `yes` exits 2 with `ErrVoteAlreadyCast`.

## Investment Committee write commands

### `rmpc committee register`

Register a committee agent in `InvestmentCommitteePolicy`.
Requires `ADMIN_ROLE`. Routes through `RobotMoneyGateway`.

```
rmpc committee --config <CONFIG> register ...
```

Pass `rmpc committee register --help` for the full flag list.
Required args: agent address, agent-id string.
Common options: `--gas-limit`, `--fee-cap`, `--receipt-timeout-secs`, `--pretty`.

### `rmpc committee vote-submit`

Submit a signed allocation vote from an allowlisted committee agent.
Routes through `RobotMoneyGateway`. Votes are signalling-only.

```
rmpc committee --config <CONFIG> vote-submit ...
```

Pass `rmpc committee vote-submit --help` for the full flag list.
Required args: vault address, stance (overweight/neutral/underweight),
weight-bps, confidence, rationale-uri, vote-json-hash, prompt-hash,
inputs-digest, timestamp.
Common options: schema-version, gas-limit, fee-cap,
receipt-timeout-secs, pretty.

## Investment Swarm signing identity commands

`rmpc committee-identity` manages the local Ed25519 signing identity every
Investment Swarm member signs with. The flow is plain REST end to end
(`POST /api/swarm/apply` -> approval -> token claim ->
`POST /api/swarm/signing-payload` -> `POST /api/swarm/submit`); there is no
MCP transport. It is a distinct identity type from the on-chain EVM signer
used by `rmpc committee register` / `vote-submit` above — no on-chain write,
no RPC, no operator config TOML. The private key never leaves the local
keystore file.

All three subcommands take a shared `--path <FILE>` (the keystore file) at
the `rmpc committee-identity` level, e.g.
`rmpc committee-identity --path identity.json create`.

### Supplying the keystore passphrase

The passphrase is **never** accepted on argv and **never** read from stdin,
so it must never be typed into an agent's chat. `create` and `sign` take it
from the first of these that applies:

1. `RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE` — a path to a file holding the
   passphrase. The file must be a regular file owned by the current user
   with mode `0600` or stricter, or the command refuses. Trailing newlines
   are trimmed. This is the channel to use when an agent runs the command:
   the operator writes the file, the agent only ever passes its path.

   ```bash
   umask 077 && printf '%s' 'your passphrase' > ~/.rmpc-committee-pass
   export RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE=~/.rmpc-committee-pass
   ```

2. `RMPC_COMMITTEE_IDENTITY_PASSPHRASE` — the legacy variable, still
   supported. The operator exports it themselves; never ask them to paste
   its value into a chat.

3. An interactive `/dev/tty` prompt with echo suppressed, used only when
   neither variable is set **and** the command is attached to a terminal.
   Because it reads the controlling terminal rather than stdin, a piped or
   agent-driven stdin cannot answer it.

With no variable set and no terminal attached, the command exits `2` with
`ErrPassphrase` and names the two safe channels. It never hangs and never
silently continues.

### `rmpc committee-identity create`

Generate a fresh Ed25519 identity and write an encrypted keystore
(Argon2id + AES-256-GCM) at `--path`. Refuses to overwrite an existing
file. Needs a passphrase — see "Supplying the keystore passphrase" above.

```
rmpc committee-identity --path <FILE> create
```

Prints `{"ok":true,"path":"...","public_key":"<base64>"}` on success.

### `rmpc committee-identity show-public-key`

Print the identity's base64 (standard, padded) raw 32-byte Ed25519 public
key — the exact value `POST /api/swarm/apply`'s `publicKey` field
expects. Reads the keystore's cleartext `public_key` field; no passphrase
required.

```
rmpc committee-identity --path <FILE> show-public-key
```

### `rmpc committee-identity sign`

Sign the exact canonical payload string returned by `POST
/api/swarm/signing-payload` and print the base64 (standard, padded) raw
64-byte Ed25519 signature that `POST /api/swarm/submit` expects alongside
the member bearer token. Deterministic: signing the same payload twice
yields the same signature. Needs a passphrase — see "Supplying the keystore
passphrase" above.

```
rmpc committee-identity --path <FILE> sign ...
```

Pass `rmpc committee-identity --path <FILE> sign --help` for the full flag
list. Exactly one of two mutually exclusive flags is required: an inline
payload flag taking the canonical JSON string directly, or a payload-file
flag taking a path whose exact bytes (no trimming) are signed — prefer the
file form for payloads with shell-sensitive characters. Prints
`{"ok":true,"public_key":"<base64>","signature":"<base64>"}` on success.
