# OpenCode walkthrough — read-only Robot Money inspection on a fork

> Canonical: [`docs/implementation-plan.md`](../implementation-plan.md) §10
> (Phase 4, Agent-Harness Installation and Skill Loading).
> ADR: [`docs/technical/mcp-decision.md`](../technical/mcp-decision.md) — MCP
> deferred; harnesses run `rmpc` as a process-per-call shell command.
> Skill package: [`plugins/robotmoney-cli/`](../../plugins/robotmoney-cli/).
> Implements: issue #53.
>
> Every command, flag, and config field referenced in this document is
> covered by an automated parity test in
> [`testing/opencode-walkthrough/`](../../testing/opencode-walkthrough/).
> If you change `rmpc` or this walkthrough, run
> `cargo test --manifest-path testing/opencode-walkthrough/Cargo.toml`
> before opening a PR — drift fails CI.

This walkthrough sets up [OpenCode](https://github.com/sst/opencode) with
the Robot Money skill (`plugins/robotmoney-cli/`) and runs a read-only
inspection against a forked Base mainnet anvil. It also exercises the
documented refusal envelope so you know what failure looks like before you
ever sign a write.

The walkthrough is intentionally read-first: no `deposit` is signed, no
`approve` is broadcast, no operator key is touched. It is the lowest-risk
possible end-to-end exercise of the skill package.

## Prerequisites

- Linux or macOS shell.
- Rust toolchain (stable). `cargo --version` should print 1.74 or later.
- [Foundry](https://getfoundry.sh) on `PATH` (`anvil --version`).
- A Base mainnet archive RPC URL (Alchemy, Infura, BlockPI, or any
  archive endpoint). Export it as `RMPC_FORK_RPC_URL`:

  ```bash
  export RMPC_FORK_RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>"
  ```

- Optional: an OpenCode install. The skill package is harness-portable;
  any agent runtime that can shell out to a binary will do. If you do not
  have OpenCode handy, the same commands run from your shell directly.

## Step 1 — Build `rmpc`

`rmpc` is the Robot Money Rust payment client. It is the only binary the
skill drives.

```bash
cargo build --release --bin rmpc --manifest-path clients/rust-payment-client/Cargo.toml
```

The release binary lands at
`clients/rust-payment-client/target/release/rmpc`. Add it to `PATH` for
this shell:

```bash
export PATH="$PWD/clients/rust-payment-client/target/release:$PATH"
rmpc --help
```

`rmpc --help` prints the full subcommand list (`deposit`, `status`,
`self-check`, `get-vault`, `get-gateway`, `get-agent`, `get-roles`,
`get-balance`, `get-allowance`, `get-deposit`, `get-tx`). The walkthrough
only uses the `get-*` reads.

## Step 2 — Boot an anvil fork of Base mainnet

```bash
anvil --fork-url "$RMPC_FORK_RPC_URL" --port 8545 --silent &
ANVIL_PID=$!
```

Leave anvil running in the background. The fork inherits Base mainnet
state at the latest block; reads against it return the same values an
explorer would surface. Tear it down with `kill $ANVIL_PID` when you are
done.

## Step 3 — Write a fork-default operator config

Save the following as `./rmpc-fork.toml` next to your shell. The
walkthrough test crate ships the same template at
[`testing/opencode-walkthrough/fixtures/rmpc-fork.toml.template`](../../testing/opencode-walkthrough/fixtures/rmpc-fork.toml.template)
and asserts it parses with the real `rmpc` config loader.

```toml
# Read-only fork inspection config for the OpenCode walkthrough.
# Canonical: docs/walkthroughs/opencode-readonly-fork.md
#
# This file is fork-only. Pointing it at mainnet would still refuse all
# writes (no signer key is loaded), but operators must never edit a
# mainnet config in a walkthrough shell — keep fork and prod configs in
# separate directories.

chain_id              = 8453                                                   # Base mainnet
rpc_url               = "http://127.0.0.1:8545"                                # local anvil fork
gateway_address       = "0x000000000000000000000000000000000000dEaD"           # gateway not deployed on Base; reads degrade to partial envelope
usdc_address          = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"           # Base mainnet USDC
vault_address         = "0xCd9BB6428180c89cC0E5b9F1Bf6Bb98155Cf9CFf"           # Robot Money vault
gateway_runtime_hash  = "0x0000000000000000000000000000000000000000000000000000000000000000"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path            = "./keystore.json"                                   # never read in read-only inspection
```

The `gateway_address` is intentionally a known EOA: the
`RobotMoneyGateway` contract is not deployed on Base mainnet, so any
gateway read degrades to the documented `partial: true` envelope rather
than crashing. This is the **expected** read-only fork shape.

## Step 4 — Register the skill with OpenCode

OpenCode loads skill packages from a configured plugins directory.
Register `plugins/robotmoney-cli/` and start an OpenCode session:

```bash
opencode --plugin "$PWD/plugins/robotmoney-cli"
```

If OpenCode is not installed, skip to step 5 and run the commands
directly. The skill package is just a `SKILL.md` + `references/*.md`
bundle; the parity test in
`testing/opencode-walkthrough/tests/walkthrough_parity.rs` proves every
command this walkthrough mentions is one OpenCode would dispatch through
shell-tool execution.

## Step 5 — Run the read-only-first inspection

Use this prompt with OpenCode (or paste the commands into your shell):

> **Prompt:** "Using the robotmoney-cli skill, inspect the Robot Money
> vault on the configured fork. Run `get-vault` and `get-gateway` with
> `--config ./rmpc-fork.toml --pretty`. Do not propose any writes; this
> is a read-only inspection."

Expected commands:

```bash
rmpc get-vault   --config ./rmpc-fork.toml --pretty
rmpc get-gateway --config ./rmpc-fork.toml --pretty
```

Expected envelope shape (per
[`docs/technical/rmpc-read-output-contract.md`](../technical/rmpc-read-output-contract.md)):

- Every response is a JSON object with `chain_id`, `block_number`, and
  `source: "json_rpc"`.
- `get-vault` returns the deployed vault's asset/share metadata,
  total assets, total supply, and per-field error markers
  (`unknown` or `not_onchain`) where the ABI does not expose a value.
- `get-gateway` returns `partial: true` with per-field error entries
  because the configured `gateway_address` is an EOA on Base — the
  documented degradation shape, not a bug.

## Step 6 — Trigger the documented refusal case

The skill's safety story (see
[`plugins/robotmoney-cli/skills/robotmoney-cli/references/safety.md`](../../plugins/robotmoney-cli/skills/robotmoney-cli/references/safety.md))
promises a structured refusal envelope when an unsupported subcommand is
invoked. Confirm it directly:

```bash
rmpc get-vault --config ./rmpc-fork.toml --pretty
rmpc not-a-real-subcommand --config ./rmpc-fork.toml
echo "exit: $?"
```

The second invocation prints a clap-style error to stderr and exits with
a non-zero status. OpenCode's shell tool surfaces both the non-zero exit
and the stderr text, so the agent can refuse cleanly without inventing a
recovery action.

## Step 7 — Tear down

```bash
kill $ANVIL_PID
unset RMPC_FORK_RPC_URL
```

Leave the release binary cached at
`clients/rust-payment-client/target/release/rmpc` for next time.

## What is asserted automatically

The walkthrough is backed by
[`testing/opencode-walkthrough/`](../../testing/opencode-walkthrough/),
a Rust test crate that runs in CI on every PR via
[`.github/workflows/opencode-walkthrough.yml`](../../.github/workflows/opencode-walkthrough.yml).

| Test | What it proves |
|---|---|
| `walkthrough_parity::every_documented_subcommand_exists` | Every `rmpc <sub>` token in this doc resolves against `rmpc --help`. |
| `walkthrough_parity::every_documented_flag_exists` | Every `--flag` in this doc resolves against some `rmpc` subcommand. |
| `walkthrough_parity::skill_package_referenced` | This doc points at `plugins/robotmoney-cli/` and the referenced files exist. |
| `config_template_parses::fixture_parses_with_rmpc_config_loader` | The `rmpc-fork.toml.template` shipped under `fixtures/` deserializes with `rust_payment_client::config::Config`. |
| `refusal_walkthrough::unknown_subcommand_refuses_with_nonzero_exit` | `rmpc not-a-real-subcommand` exits non-zero with stderr text — the structured refusal contract step 6 documents. |
| `read_only_walkthrough::get_vault_against_fork` *(skip-clean without `RMPC_FORK_RPC_URL`)* | Boots anvil against the same fork URL, runs `rmpc get-vault` against it, asserts the envelope contract (`chain_id`, `block_number`, `source`). |
| `get_gateway_against_fork_is_partial` *(skip-clean without `RMPC_FORK_RPC_URL`)* | Boots anvil against the fork URL, runs `rmpc get-gateway`, asserts `partial: true` with at least one named per-field error — the documented degradation shape. |

The two fork-driven tests skip cleanly when no archive RPC is
configured, mirroring [`testing/fork-e2e-rust`](../../testing/fork-e2e-rust)
— a contributor laptop without an RPC stays green.
