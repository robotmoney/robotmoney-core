# Headless OpenCode test gaps

> Canonical: `docs/implementation-plan.md` §10 (Phase 4 — Agent-Harness
> Installation and Skill Loading).

This document tracks known gaps in automated test coverage for OpenCode
headless invocation. Each gap (G-prefixed) is a discrete unit of missing
automation. When a gap is closed by an implementation issue, the row is
updated with the closing PR or ADR reference.

---

## G7 — Headless invocation contract not documented

**Status:** Closed by ADR (research only; no CI workflow added yet).

**Gap description:** No single document described the flags, environment
variables, exit codes, JSON output format, and secrets required to drive
`opencode run` non-interactively from a CI script. Without this contract,
CI authors had to reverse-engineer behavior from `opencode run --help`.

**Closure:**

ADR: [docs/technical/opencode-headless-invocation.md](../technical/opencode-headless-invocation.md)

The ADR records:
- OpenCode version to pin (1.14.29).
- The `opencode run` subcommand and `--format json` flag as the headless entry
  point.
- How to supply a prompt non-interactively (positional argument; stdin not
  supported).
- How to capture and parse the tool-call transcript (newline-delimited JSON
  events on stdout, queryable with `jq`).
- Exit code semantics (exit 0 does not imply task success; inspect transcript).
- Required secrets (`ANTHROPIC_API_KEY`; no key needed for smoke-only checks).
- A minimal working example that exercises `opencode --version` and
  `opencode run --help` without a model key.

**Remaining work:** Implementing a CI workflow that calls `opencode run` with a
live model key is out of scope for this scout and belongs in a follow-on
implementation issue.

---

## G8 — No CI exercises OpenCode headless vault read via skill

**Status:** Closed by issue #136.

**Gap description:** All prior CI called `rmpc` directly from Rust or shell.
No workflow routed through `opencode run`. A broken skill description,
misconfigured plugin path, or mismatched `--format json` schema would pass all
existing CI.

**Closure:**

Workflow: `.github/workflows/opencode-headless-read.yml`
Assertion script: `.github/scripts/assert_headless_read_transcript.py`

The nightly job:
- Installs OpenCode 1.14.29 and `rmpc` from source.
- Boots an Anvil fork at the pinned block.
- Invokes `opencode run` with the step-5 read-only prompt from the
  [walkthrough](../walkthroughs/opencode-readonly-fork.md).
- Captures the NDJSON transcript and runs the assertion script.
- Asserts `rmpc get-vault` exit 0 with valid JSON envelope
  (`chain_id`, `block_number`, `source`).
- Asserts `rmpc get-gateway` exit 0 with `partial: true`.
- Asserts no explorer/dapp HTTP references in the transcript.
- Skip-cleans when `ANTHROPIC_API_KEY` or `RMPC_FORK_RPC_URL` is absent.

---

## Adding new gaps

Add rows above this line following the `G<N>` numbering. Each gap entry must
include: status, description, and either a closure reference or an open issue
link.
