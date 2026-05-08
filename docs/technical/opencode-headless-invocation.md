# ADR — OpenCode headless invocation contract for CI testing

> Scope: dev-scout decision record for Phase 4 (Agent-Harness Installation and
> Skill Loading) of `docs/implementation-plan.md` §10. Documents the exact
> flags, environment variables, exit codes, and output format required to drive
> OpenCode non-interactively in CI pipelines. No CI workflow is added by this
> scout.
>
> Cross-linked from:
> [`docs/testing/headless-opencode-tests.md`](../testing/headless-opencode-tests.md) §G7.
> Related walkthrough:
> [`docs/walkthroughs/opencode-readonly-fork.md`](../walkthroughs/opencode-readonly-fork.md).

---

## 1. Status

**Accepted.** Authored 2026-05-08 against `docs/implementation-plan.md` §10 on
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

`docs/implementation-plan.md` §10 specifies that OpenCode and OpenClaw run
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
    "Using the robotmoney-cli skill, run: rmpc --help. Print the subcommand list and exit." \
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
| `RMPC_FORK_RPC_URL` | Conditional | Required when the Robot Money skill runs fork-mode reads. Not consumed by OpenCode itself. |
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
