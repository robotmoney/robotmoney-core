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

## Adding new gaps

Add rows above this line following the `G<N>` numbering. Each gap entry must
include: status, description, and either a closure reference or an open issue
link.
