# OpenClaw — install + long-running task config

> Canonical: `docs/implementation-plan.md` §10 (Phase 4 — Agent-Harness
> Installation and Skill Loading). Issue: #114.

This walkthrough documents how to install `rmpc`, register the Robot
Money skill, configure environment variables and secrets, persist
state across long-running runs, and enforce the fork-default /
mainnet-toggle policy when running Robot Money tasks under OpenClaw.

OpenClaw is the long-running task harness in §10. The same `rmpc`
binary and skill package serve OpenCode (manual) and OpenClaw
(unattended). This doc only covers the OpenClaw side; OpenCode is in
its own walkthrough.

## 1. Obtain the rmpc binary

`rmpc` is built from `clients/rust-payment-client` in this repo. There
is no published binary yet; the install path is "build from source"
until a release pipeline lands.

```bash
cargo build --manifest-path clients/rust-payment-client/Cargo.toml --bin rmpc
# Resulting binary: clients/rust-payment-client/target/debug/rmpc
```

The OpenClaw harness wrapper (`testing/openclaw-config/openclaw_harness.sh`)
defaults to that path. Override via `RMPC_BIN=/abs/path/to/rmpc` when
you install rmpc system-wide.

Verify the binary:

```bash
./clients/rust-payment-client/target/debug/rmpc --help
```

The full `rmpc` subcommand surface (mirrored from `--help`):

- `rmpc deposit` — guarded write, not used by the bounded read
  monitor.
- `rmpc status` — look up a previously submitted payment.
- `rmpc self-check` — signer backend self-check; required before any
  write.
- `rmpc get-vault`, `rmpc get-gateway`, `rmpc get-agent`,
  `rmpc get-roles`, `rmpc get-balance`, `rmpc get-allowance`,
  `rmpc get-deposit`, `rmpc get-tx` — direct on-chain reads.

The default OpenClaw monitor task uses `rmpc get-vault`. Any
read-only `rmpc get-*` subcommand is a valid `RMPC_MONITOR_COMMAND`.

## 2. Operator config

`rmpc` is configured by a TOML file. Field set is locked by
`clients/rust-payment-client/src/config.rs` and rejects unknown fields
(typos fail loudly).

Minimal fork-mode config:

```toml
chain_id              = 8453                  # Base mainnet (the fork target)
rpc_url               = "http://127.0.0.1:8545"
gateway_address       = "0x000000000000000000000000000000000000dEaD"
usdc_address          = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
vault_address         = "0x4F83837cC2BB7E5b7DA89cf36c52A7D3F6b49DDD"
gateway_runtime_hash  = "0x0000000000000000000000000000000000000000000000000000000000000000"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "/var/lib/openclaw/rmpc/keystore.json"

# Optional — see §4 (state persistence).
state_dir = "/var/lib/openclaw/rmpc/state"
```

For the bounded long-running test, see the config written by
`testing/openclaw-config/test_long_running.sh`.

## 3. Environment variables

The harness wrapper consumes the following env vars. The exhaustive
list lives in `testing/openclaw-config/openclaw_harness.sh`; this
table is the operator-facing summary.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RMPC_CONFIG` | yes | — | Path to the `rmpc` TOML config. |
| `RMPC_NETWORK` | no | `fork` | One of `fork`, `devnet`, `mainnet`. Mainnet is gated (see §5). |
| `RMPC_MONITOR_COMMAND` | no | `get-vault` | The `rmpc` read subcommand to loop. |
| `RMPC_MONITOR_ITERATIONS` | no | `3` | Successful reads before the harness exits 0. |
| `RMPC_MONITOR_INTERVAL_SECS` | no | `1` | Sleep between reads. |
| `RMPC_BIN` | no | repo target dir | Override the rmpc binary path. |
| `RMPC_ALLOW_MAINNET` | only on mainnet | — | Must be the literal string `yes` to allow `RMPC_NETWORK=mainnet`. |
| `RMPC_SIGNER_PASSPHRASE` | only for writes | — | Passphrase for the encrypted keystore. Read commands never need it; the harness strips it before exec'ing rmpc for read-only subcommands (see §6). |

`rmpc` itself also honors `RMPC_LOG_LEVEL`, `RMPC_LOG_DIR`, and
`RMPC_STATE_DIR` per `clients/rust-payment-client/src/config.rs`. The
harness leaves those untouched and forwards them to rmpc.

## 4. State persistence

Two distinct state surfaces:

- **rmpc state dir** — set by `state_dir` in the TOML or `RMPC_STATE_DIR`
  env var. Holds the per-agent nonce lock, replay cache, and any other
  rmpc-internal state. Must be a writable directory the OpenClaw service
  user owns. There is no silent fallback: if neither source provides a
  path, rmpc errors at startup.
- **OpenClaw task state** — handled by OpenClaw itself, outside of rmpc.
  Long-running goal-driven tasks should treat each `rmpc` invocation as
  stateless and persist agent goals/checkpoints in OpenClaw's own state
  store.

Optional: a phase 5 explorer API will expose deposit/vault history for
read-back into long-running tasks. This is documented as a future hook;
it is not required for the bounded monitor.

## 5. Mainnet gate

The harness refuses to run with `RMPC_NETWORK=mainnet` unless
`RMPC_ALLOW_MAINNET=yes` (literal string) is also set. The refusal is a
hard, non-zero exit (code 10), printed to stderr verbatim:

```text
openclaw-harness: refusing to run on mainnet without RMPC_ALLOW_MAINNET=yes
```

Asserted by `testing/openclaw-config/test_mainnet_gate.sh`. The toggle
must be a deliberate operator action — a typo (`true`, `1`, `YES`)
does not bypass it.

`fork` is the default. `devnet` is treated identically to `fork` for the
mainnet gate (both pass).

## 6. Secret handling

The encrypted keystore passphrase is read **only** from the
`RMPC_SIGNER_PASSPHRASE` environment variable. The harness:

- Never prints the passphrase value.
- Never passes the passphrase as a command-line argument (so it cannot
  appear in `ps`, `/proc/<pid>/cmdline`, shell history, or process
  accounting).
- Explicitly **unsets** `RMPC_SIGNER_PASSPHRASE` from the environment
  passed to the rmpc child process for read-only subcommands. Read
  commands do not need the signer; stripping the var prevents an
  accidental future read-command bug from logging it.

Asserted by `testing/openclaw-config/test_secret_handling.sh`, which
runs the harness with a sentinel passphrase and greps captured
stdout/stderr, the harness/rmpc `/proc/<pid>/cmdline`, and the rmpc
child `/proc/<pid>/environ` for the sentinel. Any match fails the test.

For writes (`rmpc deposit`), the passphrase must be present in the
environment at exec time. That codepath is out of scope for this
walkthrough — see the deposit/write reference in the skill package.

## 7. Long-running task

The bounded monitor loop is the OpenClaw entry point exercised in CI:

```bash
RMPC_CONFIG=/etc/openclaw/rmpc.toml \
RMPC_NETWORK=fork \
RMPC_MONITOR_COMMAND=get-vault \
RMPC_MONITOR_ITERATIONS=60 \
RMPC_MONITOR_INTERVAL_SECS=30 \
    bash testing/openclaw-config/openclaw_harness.sh
```

The harness exits 0 after `RMPC_MONITOR_ITERATIONS` successful reads
and exits 20 on the first failure. There is no manual
intervention path — every condition the loop encounters is
either a structured success or a hard exit.

Automated coverage:

- `testing/openclaw-config/test_long_running.sh` — runs the harness
  against `RMPC_FORK_RPC_URL` (or skips loud-clean if the secret is
  missing) for N iterations and asserts each captured stdout block is
  a JSON envelope with a sane `chain_id`.
- `testing/openclaw-config/test_mainnet_gate.sh` — asserts the
  refusal sentinel.
- `testing/openclaw-config/test_secret_handling.sh` — asserts the
  passphrase never leaks.
- `testing/openclaw-config/test_doc_parity.sh` — structural validator
  that this doc's CLI flags, env vars, script paths, and refusal
  sentinel match the implementation.

CI workflow: `.github/workflows/openclaw-config.yml`.

## 8. Skill registration

The Robot Money skill package lives at
`plugins/robotmoney-cli/skills/robotmoney-cli/`. Loading it into
OpenClaw is harness-specific configuration — point OpenClaw at the
skill directory and at the `rmpc` binary path. The skill's
`SKILL.md`, `references/read.md`, `references/write.md`,
`references/safety.md`, and `references/examples.md` are deliberately
harness-portable (no Claude-specific assumptions, no hidden prompt
state).

## 10. CI secret: `RMPC_FORK_RPC_URL`

The long-running test (`testing/openclaw-config/test_long_running.sh`)
needs a Base-mainnet JSON-RPC URL to actually exercise the monitor
loop against a fork. CI consumes the URL from the repo secret
`RMPC_FORK_RPC_URL`.

Behaviour matrix (enforced by `.github/workflows/openclaw-config.yml`):

| `RMPC_FORK_RPC_URL` | Workflow step result | Artifact `outcome=` | Job exit |
|---|---|---|---|
| set, test passes | runs the harness for N iterations | `pass` | 0 |
| set, test fails | runs and fails loud | `fail` | non-zero |
| unset | emits `::warning::`, skips-clean | `skipped` | 0 |

Every run uploads `openclaw-long-running-outcome` (containing
`outcome.txt` + `test_long_running.log`) so the run page shows pass
versus skipped without digging through logs. A subsequent assertion
step fails the job if the artifact is missing or malformed.

### Setting the secret

Operator (repo admin) action — one-time per repo:

```bash
# Public Base mainnet RPC — free, read-only, fine for fork-based
# read-only test traffic. No API key required.
gh secret set RMPC_FORK_RPC_URL \
  --repo lucky-tensor/robotmoney-skills \
  --body "https://mainnet.base.org"
```

Or via the GitHub web UI: **Settings → Secrets and variables →
Actions → New repository secret**. Name `RMPC_FORK_RPC_URL`, value the
RPC URL.

### RPC URL choices

- **`https://mainnet.base.org`** — Base Foundation public RPC.
  Free, no key. Rate-limited; fine for the bounded N=3 monitor test.
  Recommended default.
- **Alchemy / Infura / QuickNode Base mainnet endpoint** — paid /
  keyed. Use this if the public RPC starts rate-limiting CI runs.
- **A private archive node** — for forks deeper than the latest few
  hundred blocks. Not required for the monitor test.

The test only issues read calls (`rmpc get-vault`) so any Base mainnet
JSON-RPC endpoint that supports `eth_call` and `eth_chainId` works.

### Verifying after the secret is set

After setting the secret, re-run the `openclaw-config` workflow. The
`Long-running monitor test (fork or skip-clean)` step should print
`PASS: bounded long-running monitor completed N clean iterations.`
and the uploaded `openclaw-long-running-outcome` artifact should
contain `outcome=pass`.

## 11. What is intentionally not here

- **MCP server.** Decision: defer. See `docs/technical/mcp-decision.md`.
- **The demo runbook.** Phase 7 deliverable; out of scope for this
  walkthrough.
- **Production secrets management** (HSM/KMS/TPM). MVP only ships the
  encrypted software signer. Operators must set
  `[signer].allow_software_fallback = true` explicitly.
