# ADR — MCP server: build, defer, or not needed for `rmpc` in OpenCode and OpenClaw

> Scope: dev-scout decision record for Phase 4 (Agent-Harness Installation and Skill Loading) of `docs/implementation-plan.md` §10. Resolves the open question of whether Robot Money ships a Model Context Protocol (MCP) server that wraps `rmpc`, defers the question, or rules MCP out for the planned harness set. No MCP server, schema, or stub code is produced by this scout.
>
> Closes the open question gate in `docs/implementation-plan.md` §10 ("MCP decision"). Also retires the open item in `docs/architecture.md` §"Open questions" — "Whether MCP is needed for OpenClaw or can be deferred."

---

## 1. Status

**Decision:** **Defer.** No MCP server is built in Phase 4. Both OpenCode and OpenClaw execute `rmpc` as a process-per-call shell command, consuming the stable JSON output contract (`docs/technical/rmpc-read-output-contract.md`) and the Robot Money skill (`docs/implementation-plan.md` §10 "Skill loading").

Authored 2026-05-06 against `docs/implementation-plan.md` §10 on branch `feat/55-dev-scout-mcp-build-defer-decision`. No prior ADR exists for the harness layer.

## 2. Context

`docs/implementation-plan.md` §10 names three eligible decisions — **build now**, **defer**, **not needed** — and binds each to a concrete criterion:

- *Build now* — MCP is justified only if it makes OpenClaw integration "materially simpler or safer with long-lived tools than with process-per-call shell execution."
- *Defer* — both OpenCode and OpenClaw can already run `rmpc` directly with clean JSON and robust timeout handling.
- *Not needed* — neither harness ever benefits from a long-lived tool server.

The framing in §10 itself already leans toward defer ("not required for the first OpenCode manual tests if shell execution is available"). What was missing was a recorded answer with cited rationale, an explicit re-evaluation trigger, and a confirmation that the downstream Phase 4 work issues do not assume MCP.

Three external constraints anchor the decision:

1. **`rmpc` already owns the command surface.** Phases 1, 2, and 3 (`docs/implementation-plan.md` §§5, 8, 9) lock `rmpc` as the user-facing CLI, with a stable JSON envelope (`docs/technical/rmpc-read-output-contract.md`) and a Rust integration test crate that exercises the same CLI surface humans and agents use. An MCP server today would be a second tool surface wrapping a CLI surface that already exists.
2. **OpenCode and OpenClaw both support shell execution.** OpenCode's whole interaction model is shell tool calls; OpenClaw's long-running task model also supports shell invocations and per-call timeouts. Neither harness is in the failure mode that §10 names ("the harness cannot safely or ergonomically execute shell commands").
3. **No fast-feedback optimization** (binding user-memory constraint applied across the project). Building MCP now would add a moving part — server lifecycle, transport choice, schema duplication, version skew between MCP schema and `rmpc --help` output — purely to optimize per-call overhead. The constraint says we should not.

## 3. Decision

### 3.1 Defer MCP — both harnesses run `rmpc` as process-per-call shell commands

- **Driver.** §10's defer criterion is satisfied as written: OpenCode and OpenClaw both execute shell commands cleanly, `rmpc` already emits the §9 JSON envelope, and timeout handling is the harness's responsibility (both runtimes have native per-call timeouts). No part of the Phase 4 acceptance criteria (`§10` — read-only inspection on a fork; guarded deposit attempt; long-lived read/monitor task) requires a tool server with persistent state.
- **What ships in Phase 4 instead.** The harness work tracked under §10 produces installation docs (`rmpc` build/install for OpenCode and OpenClaw), the Robot Money skill package (`SKILL.md` + `references/`), a fork-default config, and a manual deposit-simulation checklist. The skill instructs agents to invoke `rmpc <subcommand>` directly via the host's shell-tool affordance and to parse the JSON envelope.
- **Cost paid by deferring.** Per-call process startup (~10–50 ms for `rmpc` with chain config loaded from disk). For a long-running OpenClaw task that issues a read every few seconds, this is in the noise. For tight read loops it would matter; §10 does not contemplate tight read loops.
- **Cost avoided by deferring.** No second command schema to maintain in lockstep with `rmpc` clap definitions. No MCP transport choice (stdio vs. localhost socket vs. UNIX socket). No server lifecycle to wire into OpenClaw's task supervisor. No risk of an MCP server silently shadowing `rmpc` subcommand updates because the schema fell behind.
- **Constraint cited.** §10 defer criterion ("both OpenCode and OpenClaw can run `rmpc` commands directly with clean JSON and robust timeout handling"); no-fast-feedback memo; `docs/technical/rmpc-read-output-contract.md` already pins the JSON envelope agents will parse.

### 3.2 Rejected alternatives

- ***Build now.*** Rejected. The §10 build-now criterion is "materially simpler or safer with long-lived tools than process-per-call shell execution." Neither materially-simpler nor materially-safer holds for the Phase 4 acceptance scenarios:
  - *Simpler* fails because MCP would replicate the `rmpc` clap-derived command surface (subcommand names, flags, JSON output) in a second schema language. The simpler surface is the one that already exists.
  - *Safer* fails because `rmpc`'s own preflight checks, refusal cases, fork-vs-mainnet warnings, and cap enforcement run identically whether `rmpc` is invoked from a shell or from an MCP tool dispatcher — the safety boundary lives inside `rmpc`, not at the harness/tool boundary.
- ***Not needed (permanent).*** Rejected. Closing the door entirely would require asserting MCP can never offer value for any future harness, including ones the project does not yet ship to. That assertion is too strong; see §3.3 re-evaluation triggers.
- ***Build a thin MCP shim that just shells out to `rmpc`.*** Rejected. It buys nothing over direct shell execution while adding a process to supervise. If MCP is ever justified, it is justified by features MCP brings *beyond* shell execution (schema discoverability, tool-listing for agents that cannot enumerate shell tools, transport-level auth) — not by being a shell wrapper.

### 3.3 Conditions that re-open this question

A future dev-scout must re-author this ADR if **any** of the following hold:

1. **A target harness lacks shell execution** — Robot Money is asked to integrate with an agent runtime where shell tool calls are unavailable, sandboxed away, or unsafe (no per-call resource limits, no exit-code propagation, no stderr capture). MCP becomes the integration mechanism by default.
2. **Per-call startup cost becomes load-bearing** — a real workload (typically a tight monitor loop in OpenClaw or a phase-7 demo) measures `rmpc` startup as the dominant latency and the workload cannot be restructured around batch read commands. Threshold: per-call overhead exceeds ~100 ms *and* the workload issues more than ~10 calls/sec sustained.
3. **The skill needs structured tool discovery** — an agent runtime requires a typed tool list (name + JSON schema for inputs/outputs) at session start and cannot synthesize one from `rmpc --help`. MCP's `tools/list` is the standard answer.
4. **Long-lived chain/config state becomes a correctness requirement** — the harness must guarantee that every call in a session targets the same `chain_id` and config snapshot (no operator mid-session reconfig), and `rmpc`'s startup-pinning per call is judged insufficient. MCP's startup-pinned server semantics solve this.
5. **Multi-process secret custody is required** — secret material must live in a single process across many tool calls (e.g. an unlocked signer cached in memory, never re-prompted, never written to disk). `rmpc`'s process-per-call model cannot hold in-memory secrets across calls. *Note:* this trigger interacts with the §10 constraint that any MCP build "must … exclude interactive secret prompts" — see §4 below.
6. **An external auditor or operator requires a single auditable boundary** — every agent action must pass through one process whose logs are the audit record. `rmpc`'s per-call logs satisfy this today; if that ever becomes false, MCP's persistent process is the natural single boundary.

If exactly one trigger fires, the new ADR may scope MCP narrowly (one harness, one transport). If two or more fire, the new ADR should reconsider the "build a full MCP server" path with the §4 design constraints as the starting point.

## 4. Constraints any future MCP build must inherit

If §3.3 ever fires and the next ADR chooses *build*, that ADR is bound by the §10 design constraints, repeated here so they survive the deferral:

- **Schema parity with `rmpc`.** The MCP server exposes the same command names, flags, and JSON output envelope (`docs/technical/rmpc-read-output-contract.md`) as the `rmpc` CLI. Schema generation should be derived from `rmpc`'s clap definitions, not hand-maintained. Any divergence is a release-blocking bug.
- **Startup-pinned chain/config by default.** `chain_id`, RPC endpoint, and config file are read once at server startup and cannot be changed per-call. A new chain or new config requires a server restart. This matches the §3.1 simpler-surface argument: the per-call `rmpc` model already pins per-call; MCP's per-server pin is the equivalent at the persistent-process layer.
- **Localhost-only network binding by default.** Default transport is stdio or a UNIX socket. If a TCP socket is configured, it binds to `127.0.0.1` only. Binding to `0.0.0.0` requires an explicit operator flag and a refusal-style log line at startup.
- **No interactive secret prompts.** The MCP server never prompts for a passphrase, never opens a TTY, never reads from stdin for secrets. Secret material arrives via env var, file path, or external signer reference — the same surfaces `rmpc` uses today. This rule is independent of §3.3 trigger 5: even if MCP exists to hold a cached signer, the *acquisition* of that secret happens before the server starts.
- **Mirror `rmpc`'s refusal and cap behavior exactly.** Any MCP tool call that would map to a `rmpc` subcommand must produce the same refusal, cap, and fork-vs-mainnet behavior. The MCP layer cannot relax safety; it can only re-shape the call.

## 5. Impact on `docs/implementation-plan.md` §10

§10's prose stands as written; this ADR records the answer to its open question without changing acceptance criteria. The §10 acceptance criterion "The MCP decision is recorded as `build now`, `defer`, or `not needed`, with rationale" is satisfied by §1 + §3 of this document.

A one-line cross-link is added to §10 ("MCP decision" subsection): `See docs/technical/mcp-decision.md for the recorded ADR (issue #55).`

## 6. Impact on downstream Phase 4 issues

- **Skill package (§10 "Skill loading").** The `SKILL.md` + `references/` set assumes shell-tool execution of `rmpc`. No MCP tool-listing prelude, no MCP server boot step, no MCP-specific examples. Per `docs/implementation-plan.md` §10 the skill must remain harness-portable; the deferral keeps that portability — the skill works in any runtime that can shell out.
- **OpenCode installation issue.** Documents `rmpc` build/install + skill registration only. No MCP install step.
- **OpenClaw installation issue.** Documents how OpenClaw obtains the `rmpc` binary, env vars, and state directories. No MCP server install or supervisor wiring.
- **Phase 7 OpenClaw e2e demo (§13).** Inherits the same shell-execution model. If the demo workload itself triggers §3.3 condition 2 (per-call startup becomes load-bearing), the re-evaluation happens then, not now.

## 7. Open follow-ups (not in scope of this scout)

- **Phase 4 portability check.** When the OpenCode and OpenClaw installation issues land, the reviewer must confirm neither set of docs assumes MCP (per the §10 "test plan" in issue #55).
- **Re-evaluation cadence.** No calendar cadence. Re-open only when a §3.3 trigger fires; do not re-litigate this ADR on a schedule.
- **`rmpc` startup-cost baseline.** Capture a one-line `rmpc get-vault` cold-start latency number when Phase 3 lands, so future §3.3 trigger 2 evaluations have a baseline to compare against. Tracked separately, not part of this scout.

## 8. References

- `docs/implementation-plan.md` §10 — Phase 4, MCP decision criteria (the question this ADR closes).
- `docs/architecture.md` §"Open questions" — "Whether MCP is needed for OpenClaw or can be deferred" (this ADR is the answer).
- `docs/architecture.md` §"Agent harnesses" — `rmpc` + skill targeting OpenCode + OpenClaw.
- `docs/technical/rmpc-read-output-contract.md` — the JSON envelope agents parse from `rmpc` (issue #51).
- `docs/technical/fork-e2e-decisions.md` — ADR template followed here (issue #47).
- `docs/implementation-plan.md` §§5, 8, 9 — `rmpc` ownership of the command surface (precondition for §3.1).
- Issue #55 — this scout.
- User memory: "No fast-feedback optimization in test harness" — applied to §3.1's defer rationale.
