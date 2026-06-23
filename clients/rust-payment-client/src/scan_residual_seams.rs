//! Dev-scout seam map — Off-chain scan remediation **residual** phase (issue
//! #1027).
//!
//! Canonical: `docs/code-review/external-scan-verification-20260619.md` — the
//! verified external full-stack scan. The residual rmpc finding remediated by
//! this phase is **RPC-1** (`get-agent` uses the deprecated calendar-window
//! gross), in the "rmpc payment client" subsystem table.
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. Unlike the sibling [`crate::scan_remediation_seams`] (which records
//! the already-landed #991/#993 fixes in past tense), the bug below is **still
//! present at HEAD**; the prose is present/future tense and hands off to:
//!
//! - **#1024** — `fix(rmpc): get-agent rolling-window gross not calendar window`
//!   (RPC-1).
//!
//! # The seam: calendar `agentWindowGross` vs. the rolling-window gross
//!
//! `rmpc get-agent` ([`crate::commands::get_agent`]) reports the agent's
//! current deposit-window usage by:
//!
//! 1. computing a **calendar** bucket id `window_id = block_timestamp /
//!    WINDOW_SECONDS` ([`crate::policy::WINDOW_SECONDS`] = 86_400; `get_agent.rs`
//!    ~line 210), then
//! 2. reading `agentWindowGross(agent, window_id)` on the gateway
//!    (`get_agent.rs` ~lines 224/305 `call_window_gross`) and surfacing it as
//!    `AgentData::window_gross`.
//!
//! **What is wrong:** the on-chain deposit cap is enforced on a **strict rolling
//! window** anchored to the agent's last deposit, but `get-agent` reports a
//! per-**calendar**-bucket mapping that resets to 0 at each `WINDOW_SECONDS`
//! boundary regardless of the agent's anchor. The reported `window_gross` can
//! therefore badly disagree with the value the gateway will actually use to
//! admit/deny the next deposit (over- or under-stating remaining headroom).
//!
//! # Seam for #1024 — the established precedent already exists in this crate
//!
//! The **withdraw** side already migrated to the rolling-window read under
//! issue #449. See [`crate::policy`] `mod.rs` ~line 196 ("8w."), which calls
//! `call_view_agent_withdraw_window_gross(gateway, signer)` to read the *rolling*
//! gross (zero once the anchor ages past `WINDOW_SECONDS`) instead of the
//! per-calendar-window mapping. That method is the pattern #1024 mirrors for the
//! **deposit** side:
//!
//! - swap `get-agent`'s `call_window_gross(.., window_id)` calendar read for the
//!   gateway's rolling deposit-gross view (the deposit analogue of
//!   `call_view_agent_withdraw_window_gross`), and
//! - drop the now-unused `window_id` envelope field (or keep it documented as
//!   the calendar bucket while `window_gross` becomes the rolling value — a
//!   #1024 output-contract decision; coordinate with
//!   `docs/technical/rmpc-read-output-contract.md`).
//!
//! **Disjointness:** RPC-1 is confined to `clients/rust-payment-client/`
//! (`commands/get_agent.rs`, the gateway view binding, possibly `policy/`). It
//! does **not** touch the indexer (#1021/#1022), watchdog (#1023), dapp (#1025)
//! or harness (#1026) surfaces, so #1024 runs in parallel after this scout.
//!
//! # Out of scope
//! - RPC-3/4 (failover) and RPC-9/15/16 (block-pinned reads) — already
//!   remediated in the **closed** #1009 phase; see
//!   [`crate::scan_remediation_seams`].
