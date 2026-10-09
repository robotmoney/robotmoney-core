---
name: robotmoney-cli
description: >
  Complete rmpc CLI reference. Use this skill when you need the full command
  surface for the Robot Money Rust payment client, including read commands
  (get-vault, get-gateway, get-agent, get-roles, get-balance, get-allowance,
  get-deposit, get-tx, get-vaults, get-router, get-governance, get-timelock),
  write commands (deposit, withdraw, status, self-check), Investment Committee commands (committee
  vote-submit), consensus recommendation receipt commands
  (receipt verify, receipt submit), and the Investment Swarm signing
  identity commands (committee-identity create, show-public-key, sign).
  Covers all flags, output shapes and preflight rules. rmpc is not a governance
  signer: it has no vote, propose or committee register command, and router
  weights change only through the Safe and the timelock.
---

# robotmoney-cli (`rmpc`)

> **Experimental — pre-v1.0.** Command syntax, flags, and output shapes can
> change. Verify every transaction. Default to fork/devnet; mainnet must be an
> explicit operator action.

`rmpc` is the Robot Money Rust payment client. It is the only path to signed
writes on the Robot Money policy gateway. The binary also exposes direct
on-chain read commands. It has no governance write command.

All commands require `--config <path-to-config.toml>` and write JSON to stdout.
Exit code 0 means success; non-zero means a named, structured error. Add
`--pretty` for indented JSON.

## Reference docs

- **[Commands](references/commands.md)** — complete flag reference for every
  subcommand: `deposit`, `withdraw`, `status`, `self-check`, `build-info`,
  `get-vault`,
  `get-vaults`, `get-router`, `get-governance`, `get-timelock`, `get-gateway`,
  `get-agent`, `get-roles`, `get-balance`, `get-allowance`, `get-deposit`,
  `get-tx`, `committee`, `receipt`, `committee-identity`.

## Command surface

The complete surface (mirrors `rmpc --help`):

```text
rmpc deposit         Sign and broadcast a USDC deposit through the gateway
rmpc withdraw        Redeem vault shares through the gateway (agent-initiated)
rmpc status          Look up a previously submitted payment by its on-chain paymentId
rmpc self-check      Print the signer-backend self-check report (v0 §9.2 JSON)
rmpc build-info      Print the git commit this binary was compiled from (JSON)
rmpc get-vault       Read vault state directly from chain
rmpc get-vaults      List all vaults registered in the VaultRegistry
rmpc get-router      Read PortfolioRouter state: vault addresses, weight bps, and router cap
rmpc get-governance  Read RouterGovernance state: constructor params and weights
rmpc get-timelock    Read TimelockController state
rmpc get-gateway     Read gateway state directly from chain
rmpc get-agent       Read an agent's authorization + window usage
rmpc get-roles       Read role membership on the gateway for a target address
rmpc get-balance     Read an ERC-20 token balance for an address (USDC by default)
rmpc get-allowance   Read an ERC-20 allowance(owner, spender) on the configured USDC
rmpc get-deposit     Look up a gateway deposit by its on-chain id
rmpc get-tx          Look up a transaction's receipt status by hash
rmpc committee       Investment Committee: submit signed allocation tilts
rmpc receipt         Consensus recommendation receipt: verify a receipt off-chain and anchor its digest on chain
rmpc committee-identity  Investment Swarm signing identity: local Ed25519 identity, public-key export, and canonical-payload signing
```

## Router-weight governance

`rmpc` has no governance write command. The Safe multisig, through the
`TimelockController`, is the only body that changes any Robot Money contract
configuration, router weights included. `WEIGHT_SETTER_ROLE` is the only
authority over router weights. It submits the Investment Committee's consensus
receipt, and that submission is the rebalance: one timelock operation releases
the receipt and applies its weights (publish-contracts govern row
`apply-receipt`, core 1696). There is no voting by token holders or anyone else:
no voter set, no voting power, no quorum, no voting period, no execution delay,
no propose, vote or execute. `rmpc get-governance` only reads the
`RouterGovernance` state, and `rmpc governance draft-proposal` prints an unsigned
review draft only. Today's test bytecode still carries the old voting functions.
They are unused: the test deploys it with voter addresses nobody holds keys for.
A later contract change (issue 1698) will delete them and add a weight-setter
`applyReceipt` call.

## Example trace: read governance state

```bash
rmpc get-governance --config rmpc.toml --pretty
```

The `get-governance` output includes `active_proposal` (always `null`, because
nobody holds a voter key), the `cadence_params` block (constructor arguments of
today's bytecode, not a governance model) and the router weight vector.


## Investment Committee commands

### committee vote-submit

Submit a signed allocation tilt from an allowlisted committee agent.
Routes through `RobotMoneyGateway`. The name `vote-submit` is the command's
name only: a tilt is not a vote on anything. It has no treasury-spend or
router-weight authority. The committee's consensus receipt is applied by
`WEIGHT_SETTER_ROLE` through the timelock.

```bash
rmpc committee --config <CONFIG> vote-submit ...
```

See `rmpc committee vote-submit --help` for the full flag list (vault,
stance, weight-bps, confidence, rationale-uri, vote-json-hash,
prompt-hash, inputs-digest, timestamp, schema-version, gas-limit,
fee-cap, receipt-timeout-secs, pretty).

## Consensus receipt commands

`rmpc receipt` handles a **consensus recommendation receipt** — the signed
off-chain artifact a Project Fusion swarm session produces. The chain stores
only the `keccak256` of the receipt's canonical bytes, beside the public URI
serving those exact bytes.

**The chain cannot verify the analyst signatures.** The EVM has no Ed25519
precompile, so the per-analyst signatures ride inside the payload as data. A
recorded receipt proves that one submitter attested to it — not that each
named analyst signed. Say so on every surface: render the count as
*off-chain analyst signatures*, never as on-chain approvals.

### receipt verify

Canonicalize a receipt, print the derived `payload_digest` and `receipt_id`,
and report per-analyst Ed25519 verification. Read-only — no signer, no
chain. Exits non-zero on any failure.

```bash
rmpc receipt --config <CONFIG> verify --receipt-url <URL>
```

### receipt submit

Anchor a verified receipt's digest on chain via
`RobotMoneyGateway.consensusRecordReceipt`. The call goes to the **gateway**
address; the receipt contract is `onlyGateway`.

```bash
rmpc receipt --config <CONFIG> submit --receipt-url <URL> --expected-digest <0x...64hex>
```

`submit` re-derives the digest and verifies EVERY embedded analyst signature
first, and **refuses to broadcast** if either check fails — before it loads
the signer, takes the nonce lock, or makes any RPC call. That refusal is the
only thing standing between a compromised submitter and a receipt the
analysts never agreed to, so never work around it by anchoring a digest by
hand.

See `references/commands.md` for the full flag list (`--receipt-url`,
`--receipt-file`, `--expected-digest`, `--gas-limit`, `--fee-cap`,
`--receipt-timeout-secs`, `--pretty`) and the named error codes.

## Investment Swarm signing identity commands

`rmpc committee-identity` is the local Ed25519 signing identity every
Investment Swarm member signs with — the production signing path, not a
demo. The flow is plain REST end to end (`POST /api/swarm/apply` →
approval → token claim → `POST /api/swarm/signing-payload` →
`POST /api/swarm/submit`); there is no MCP transport. It is a separate
identity type from the `rmpc committee` on-chain EVM signer above: no RPC,
no operator config TOML, no on-chain write. Use it so a prospective member
never has to hand-roll Ed25519 code.

**Never ask the owner for their keystore passphrase, and never accept it in
chat.** Have them write it to a file only they can read and hand you the
path:

```bash
umask 077 && printf '%s' '<passphrase>' > ~/.rmpc-committee-pass
export RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE=~/.rmpc-committee-pass
```

An owner working at their own terminal can skip the file: with neither
`RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE` nor
`RMPC_COMMITTEE_IDENTITY_PASSPHRASE` set, `rmpc` prompts on `/dev/tty` with
echo off. That prompt cannot be answered through a pipe, so run it yourself
rather than through an agent.

```bash
# 1. Generate the identity (needs RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE
#    or the /dev/tty prompt — never the passphrase itself on the command line)
rmpc committee-identity --path identity.json create

# 2. Export the base64 public key for POST /api/swarm/apply
rmpc committee-identity --path identity.json show-public-key

# 3. Sign the canonical payload from POST /api/swarm/signing-payload
rmpc committee-identity --path identity.json sign ...
```

See `references/commands.md` for the full flag list (`--path`, `create`,
`show-public-key`, `sign`, `--pretty`).
