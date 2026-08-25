# ADR — OpenCode headless invocation contract for CI testing

> Scope: dev-scout decision record for Phase 4 (Agent-Harness Installation and
> Skill Loading) of `Plan tracking issue #109` §10. Documents the exact
> flags, environment variables, exit codes, and output format required to drive
> OpenCode non-interactively in CI pipelines. No CI workflow is added by this
> scout.
>
> Cross-linked from:
> [`docs/development/headless-opencode-tests.md`](../development/headless-opencode-tests.md) §G7.
> Related walkthrough:
> [`docs/development/opencode-readonly-fork.md`](../development/opencode-readonly-fork.md).

---

## 1. Status

**Accepted.** Authored 2026-05-08 against `Plan tracking issue #109` §10 on
branch `feat/135-document-opencode-headless-invocation-contract-f`. No prior
ADR exists for OpenCode headless operation in this repo.

---

## 2. OpenCode version

Verified on the local install:

```
opencode --version
# 1.14.29
```

Pin CI to `>=1.14.29`. The `opencode run` subcommand and `--format json` flag
used in §4 are present from at least this release. Update the pin when the
project upgrades.

Install path (bun global):

```
/home/lucas/.bun/bin/opencode
```

In CI, install with:

```bash
bun install -g opencode@1.14.29
```

or use the published npm package:

```bash
npm install -g opencode@1.14.29
```

---

## 3. Context

`Plan tracking issue #109` §10 specifies that OpenCode and OpenClaw run
`rmpc` as a process-per-call shell command. For automated testing we need to
invoke OpenCode itself non-interactively — driving it with a prompt, capturing
output, and asserting exit codes — without a human at a terminal. This ADR
records the invocation contract so CI scripts and future test harnesses have a
single source of truth.

---

## 4. Headless invocation flags

OpenCode exposes the `run` subcommand for non-interactive (headless) operation:

```
opencode run [message..]
```

**Key flags for CI:**

| Flag | Purpose |
|---|---|
| `run [message..]` | Positional: the prompt text. Quoted strings become a single message. |
| `--format json` | Emit raw JSON events to stdout instead of formatted terminal output. Required for machine parsing. |
| `--model provider/model` | Pin the model. Prevents fallback to an unexpected default. |
| `--print-logs` | Print server logs to stderr. Use in CI for debugging; omit in production to keep stderr clean. |
| `--log-level DEBUG\|INFO\|WARN\|ERROR` | Verbosity of `--print-logs` output. Default `INFO`. |
| `--dangerously-skip-permissions` | Auto-approve all tool-call permission prompts. Required in unattended CI; understand the implications before use. |
| `--title` | Human-readable session title for `opencode export` traceability. |
| `--pure` | Disable external plugins. Use in minimal smoke tests that do not need the Robot Money skill. |
| `--agent` | Specify a named agent (if the repo ships one). Omit to use the provider default. |
| `--continue` / `--session` | Continue an existing session by ID. Not needed for one-shot CI runs. |
| `--file` | Attach files to the message. Useful for providing context documents. |

**Minimal headless invocation (no model key required):**

```bash
opencode --version
# exits 0, prints version, no API key needed
```

```bash
opencode --help
# exits 0, prints usage, no API key needed
```

**Minimal end-to-end invocation (API key required):**

```bash
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  opencode run "echo hello from opencode" \
    --format json \
    --model anthropic/claude-sonnet-4-5 \
    --dangerously-skip-permissions
```

**Robot Money skill invocation (API key + `rmpc` binary required):**

```bash
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  opencode run \
    "Using the robotmoney-user skill, run: rmpc --help. Print the subcommand list and exit." \
    --format json \
    --model anthropic/claude-sonnet-4-5 \
    --dangerously-skip-permissions \
    --print-logs \
    --log-level INFO
```

---

## 5. Supplying a prompt non-interactively

There are two patterns:

**a. Inline positional (preferred for short prompts):**

```bash
opencode run "your prompt here" --format json ...
```

**b. Piped stdin (not supported):**

OpenCode `run` does not read from stdin. The prompt must be supplied via the
positional `[message..]` argument. For multi-line prompts, use shell quoting:

```bash
opencode run \
  "First, run rmpc get-vault --config ./rmpc-fork.toml --pretty. \
   Then run rmpc get-gateway --config ./rmpc-fork.toml --pretty. \
   Print both JSON outputs and nothing else." \
  --format json ...
```

**c. File-based context (for long prompts or attached documents):**

```bash
opencode run "Summarize the attached file." \
  --file ./context.md \
  --format json ...
```

---

## 6. Capturing the tool-call transcript

When `--format json` is passed, OpenCode writes a newline-delimited stream of
JSON event objects to **stdout**. Each line is one event. The event stream
includes:

- Session lifecycle events (session created, model selected).
- Assistant message chunks (streaming text).
- Tool call events (name, arguments, result, exit code for shell tools).
- Final assistant message.

**Capturing stdout for later assertion:**

```bash
TRANSCRIPT=$(opencode run "rmpc --help" --format json --dangerously-skip-permissions)
echo "$TRANSCRIPT" | jq 'select(.type == "tool.result")'
```

**Filtering tool-call events with `jq`:**

```bash
echo "$TRANSCRIPT" | jq 'select(.type == "tool.call") | {name: .name, args: .args}'
```

**Session export (after the run, for archiving):**

```bash
# opencode run prints the session ID in the JSON stream; capture it first.
SESSION_ID=$(echo "$TRANSCRIPT" | jq -r 'select(.type == "session.created") | .id' | head -1)
opencode export "$SESSION_ID" > transcript.json
# --sanitize redacts file content and sensitive data:
opencode export "$SESSION_ID" --sanitize > transcript-sanitized.json
```

The JSON event schema is not formally versioned by OpenCode as of v1.14.29.
Use `jq` `select(.type == ...)` filters rather than positional indexing to
guard against schema additions.

---

## 7. Exit codes

| Exit code | Meaning |
|---|---|
| `0` | Run completed. The model produced a final message. Does **not** guarantee the task succeeded — inspect the transcript for errors. |
| `1` | Invocation error (bad flags, missing required args) or the OpenCode server failed to start. |
| Non-zero (other) | Unexpected process failure or signal. |

Shell tool calls made by the agent (e.g. `rmpc`) return their own exit codes
inside the JSON transcript as the `exit_code` field of `tool.result` events.
A non-zero tool exit code does not cause `opencode run` itself to exit
non-zero; the model receives the error text and may recover or report failure
in its final message.

**CI recommendation:** assert both the process exit code of `opencode run` and
the presence/absence of expected content in the JSON transcript. Do not rely
on exit code 0 alone to confirm task success.

---

## 8. Required secrets and environment variables

| Variable | Required? | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (for live runs) | Anthropic API key. OpenCode uses this to call Claude. Without it, model calls fail. |
| `OPENCODE_SERVER_PASSWORD` | No | Basic-auth password when attaching to a remote OpenCode server (`opencode attach`). Not needed for `opencode run`. |
| `RMPC_FORK_RPC_URL` | Local-only, optional | Overrides the RPC endpoint for optional local live-fork reads by the Robot Money skill; defaults to a public Base RPC and is never a CI secret. Not consumed by OpenCode itself. See [`docs/development/environments.md`](../development/environments.md) §2. |
| `RMPC_BIN` | Conditional | Override path to the `rmpc` binary. Defaults to `rmpc` on `$PATH`. Not consumed by OpenCode itself. |

**CI secret wiring (GitHub Actions example):**

```yaml
- name: Run opencode headless test
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    opencode run "rmpc --help" \
      --format json \
      --model anthropic/claude-sonnet-4-5 \
      --dangerously-skip-permissions
```

For smoke tests that do not call the model (e.g. `opencode --version`,
`opencode --help`), no API key is required.

---

## 9. Minimal working example (no model key)

The following invocations work without `ANTHROPIC_API_KEY` and are suitable as
a CI smoke test to confirm OpenCode is installed and on `$PATH`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Smoke test: OpenCode is installed and responds to --version.
opencode --version
echo "opencode smoke: version check passed (exit $?)"

# Smoke test: help text is parseable.
opencode --help | grep -q "opencode run"
echo "opencode smoke: 'run' subcommand present in help (exit $?)"

# Smoke test: run --help shows expected flags.
opencode run --help | grep -q -- "--format"
echo "opencode smoke: '--format' flag present in run --help (exit $?)"
```

Save as `testing/opencode-headless-smoke.sh` and run in CI before any
model-dependent step.

---

## 10. Consequences

- CI pipelines can assert `opencode run` headless behavior against a pinned
  `1.14.29` install without a terminal.
- The `--format json` + `jq` pattern makes tool-call transcripts
  machine-readable, enabling per-event assertions.
- `--dangerously-skip-permissions` is required for unattended runs; this is
  acceptable in ephemeral CI environments where the agent's tool surface is
  already constrained by the skill package and not arbitrary shell access.
- Stdin piping is not supported; prompts must be provided as positional
  arguments or via `--file`.
- A non-zero exit from `opencode run` is not the only failure mode — always
  inspect the transcript JSON for `tool.result` `exit_code` fields.
- This ADR does not add CI workflows. Those belong in a future implementation
  issue that references this ADR.

---

## 11. Re-evaluation trigger

Re-evaluate when:

- OpenCode publishes a major version with a breaking `--format json` schema
  change.
- A stable `opencode run --stdin` or equivalent flag is added.
- The project pins a different AI provider (non-Anthropic) requiring a
  different key variable.

---

## 12. Reconciled CI contract (issues #908/#909 — authoritative)

§4–§10 above were written against OpenCode 1.14.x and an assumed event schema.
The `suite-11b-opencode-headless.yml` read and deposit jobs are now reconciled
against the **actual** OpenCode 1.16.x CLI and transcript reality. This section
supersedes the relevant details above where they conflict.

### 12.1 No `--plugin` flag; the SKILL bundle is not an OpenCode plugin

- `opencode run` has **no** `--plugin` flag. Plugins are installed with
  `opencode plugin <module>`, which records the path in `.opencode/opencode.json`.
- `plugins/robotmoney-user/` is a Claude/Anthropic-style **SKILL bundle**
  (`plugin.json` manifest + `skills/.../SKILL.md`), **not** an OpenCode JS-module
  plugin. OpenCode's loader logs `Plugin export is not a function failed to load
  plugin` and never registers the rmpc skill as a tool. The agent therefore has
  only OpenCode's built-in tools (`bash`, `read`, `task`, …).
- Consequently, the resolved in-repo plugin path appears (if at all) only in
  `--print-logs` **stderr**, never in the `--format json` **stdout** that the
  assert scripts scan. The previous assertion requiring an in-repo plugin-path
  event in the JSON transcript was structurally unsatisfiable and has been
  removed.

### 12.2 Drive rmpc deterministically through the bash tool

Because the skill is not registered, a vague prompt makes the agent improvise
with `task`/`read` (and even suggest explorer URLs). The disabled live jobs
retain explicit prompts naming the exact rmpc commands and instructing the
agent to use the `bash` tool only. They currently provide no CI coverage: see
§12.6 for the unavailable live-model dependency.

- Read job commands: `get-vault`, `get-gateway`, `get-balance`.
- Deposit job commands (read prefix in the asserter's required order, then the
  write): `get-vault`, `get-agent`, `get-balance`, `get-allowance`,
  `self-check`, `deposit`.

### 12.3 Real `--format json` transcript schema (1.16.x)

The stream is NDJSON with event `type`s including `step_start`, `step_finish`,
`text`, and `tool_use`. A shell tool call is a `tool_use` event:

```json
{"type": "tool_use",
 "part": {"tool": "bash",
          "state": {"status": "completed",
                    "input": {"command": "rmpc get-vault --config ... --pretty"},
                    "output": "<rmpc stdout>",
                    "metadata": {"exit": 0, "output": "<rmpc stdout>"}}}}
```

The asserters key off this shape: command at `part.state.input.command`, exit
code at `part.state.metadata.exit`, rmpc stdout at `part.state.output`. There is
no top-level `exit_code` and no `tool.result` event type.

### 12.4 Two real on-chain preconditions the deposit job must satisfy

These are independent of OpenCode and were missing from the original workflow:

1. **USDC allowance.** `rmpc deposit` preflight (§4.4) hard-refuses unless
   `allowance(agent, gateway) >= amount`, and `rmpc` has no `approve` command
   (approvals flow through the human dapp). The job adds an explicit
   `cast send USDC approve(gateway, …)` **signed by the generated agent key**
   after deploy.
2. **`state_dir`.** `rmpc deposit` resolves a per-agent nonce-lock / replay-cache
   directory via `RMPC_STATE_DIR` → config `state_dir` → **fail-fast** (no silent
   `/tmp` fallback). The job pins `state_dir` in `config.toml` (and exports
   `RMPC_STATE_DIR`). Without it the deposit exits non-zero with no stdout.

### 12.5 What the reconciled asserters prove

- **Read** (`assert_headless_read_transcript.py`): `rmpc get-vault`,
  `get-gateway`, `get-balance` each ran as a completed `bash` tool call (exit 0)
  whose stdout is a §9 `source: "json_rpc"` envelope; no forbidden explorer/dapp
  host appears. The old `partial: true` gateway requirement was wrong — a
  deployed-gateway snapshot returns `partial: false` — and is replaced by a
  `source == "json_rpc"` check.
- **Deposit** (`assert_headless_deposit_transcript.py`): the read prefix ran in
  the required order before `rmpc deposit`; `rmpc deposit` completed exit 0 with
  a `status: "success"` + `tx_hash` result; no forbidden hosts.
- The on-chain checks are unchanged in intent:
  `assert_headless_deposit_delta.py` ties the transcript-reported amount to the
  vault `total_assets` delta, and `assert_headless_deposit_sender.py` confirms
  the deposit tx `from` equals the generated agent key — both updated only to
  read `tx_hash`/`amount` out of the real `part.state.output` JSON.

### 12.6 Live-transcript loud-fail guard and unavailable model coverage (issues #1151/#1210)

**The failure.** From 2026-07-01 the nightly was red every day: the pinned free
zen model `opencode/big-pickle` on `opencode-ai@1.14.29` began 400ing. First the
provider (DeepSeek) rejected opencode 1.14.29's tool-schema serialization
(`tools[0].function: missing field \`name\``); later the provider 400ed outright
(`Upstream request failed`). The `opencode run` transcript was then a **single
`{"type":"error", ...}` APIError event with zero tool calls** — the agent died
before issuing any `rmpc` command. Everything upstream of the agent (rmpc build,
fork-state Anvil, deploy, on-chain authorization asserts) still passed.

**Loud-fail guard.** `opencode run` **exits 0** even on that dead session, and the
error-only transcript is non-empty, so the previous `test -s <transcript>` guard
green-lit it and the outage only surfaced three steps later at the transcript
asserter — reading as an assertion failure rather than a model outage. The read
and deposit "Headless … run" steps now run
[`assert_headless_live_transcript.py`](../../.github/scripts/assert_headless_live_transcript.py)
immediately after `opencode run`. It reds **that step** when the transcript is
empty, contains any `error` event, or contains **zero `rmpc …` bash tool
invocations** — a broken model path fails loudly at the agent step
(loud-skip policy), never silent-green. It deliberately does **not** re-check
command order / exit codes / envelopes; those remain the transcript asserters'
job, unchanged (the order and exit-code checks were not weakened).

**Unavailable model coverage (issue #1210, option B).** The anonymous zen tier
no longer executes any model, so selecting a different free model cannot restore
the live runs. This repository intentionally does not provision or require
`OPENCODE_API_KEY`; the `deposit` and `read` live-agent jobs are therefore
disabled. They are not replayed from fixtures, and the offline tests below do
not prove live model behaviour, tool-schema compatibility, or prompt adherence.
On schedule and manual dispatch, `live-model-coverage-unavailable` fails with
this limitation explicitly. That deliberate red result satisfies loud-skip:
missing model access cannot be mistaken for executed coverage or a green suite.

The disabled jobs are retained in the workflow rather than deleted, so option A
(provision the key) is a one-line `if:` flip. The workflow keeps an `env:` block
defining `OPENCODE_VERSION` / `OPENCODE_MODEL` for that reason alone — the
retained steps run under `set -u` and would die on unbound variables without it.
Those defaults are **not** a working no-credential path; #1210 disproved that.

**Who owns the deliberate red.** Suite 11b now fails on every nightly by design.
Issue #1233 is the open tracking issue for restoring coverage and stays open for
as long as the red does; it is what stops "permanently red nightly" from decaying
back into the eight-week unowned red that #1210 was filed about. The
`live-model-coverage-unavailable` step prints that issue URL in its failure
output so the run log names its own owner.

**Executed-in-CI proof.** The guard and the (previously CI-orphaned) transcript
asserters are pinned by offline unit tests
(`.github/scripts/tests/test_live_guard.py`,
`test_transcript_asserter_provenance.py`) run by the keyless
`opencode-headless-asserter-tests` job on every trigger — including
`pull_request`, so a change to the guard or asserters is proven to execute rather
than silent-skipped. The offline `refusal` job stays schedule/dispatch-only;
the live `deposit` and `read` jobs are disabled and have no current replacement.
