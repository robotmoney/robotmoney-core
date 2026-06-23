//! Historical seam map — Off-chain scan remediation **residual** phase (issue
//! #1027 scout; fix landed under #1024).
//!
//! Canonical: `docs/code-review/20260619-code-review-internal-claude-scan-verification.md` — the
//! verified external full-stack scan. The residual rmpc finding remediated by
//! this phase is **RPC-1** (`get-agent` used the deprecated calendar-window
//! gross), in the "rmpc payment client" subsystem table.
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. Like the sibling [`crate::scan_remediation_seams`] (which records
//! the already-landed #991/#993 fixes), the bug below has been **fixed**; the
//! prose is past tense and points at the landed fix site.
//!
//! # The seam: calendar `agentWindowGross` vs. the rolling-window gross
//!
//! `rmpc get-agent` ([`crate::commands::get_agent`]) reported the agent's
//! current deposit-window usage by:
//!
//! 1. computing a **calendar** bucket id `window_id = block_timestamp /
//!    WINDOW_SECONDS` ([`crate::policy::WINDOW_SECONDS`] = 86_400), then
//! 2. reading `agentWindowGross(agent, window_id)` on the gateway and surfacing
//!    it as `AgentData::window_gross`.
//!
//! **What was wrong:** the on-chain deposit cap is enforced on a **strict
//! rolling window** anchored to the agent's last deposit, but `get-agent`
//! reported a per-**calendar**-bucket mapping that resets to 0 at each
//! `WINDOW_SECONDS` boundary regardless of the agent's anchor. The reported
//! `window_gross` could therefore badly disagree with the value the gateway
//! would actually use to admit/deny the next deposit.
//!
//! # Resolved (#1024) — get-agent reads the rolling deposit-gross view
//!
//! The **withdraw** side already migrated to the rolling-window read under
//! issue #449 (`call_view_agent_withdraw_window_gross` in [`crate::policy`]),
//! reading the *rolling* gross instead of the per-calendar-window mapping.
//! #1024 mirrored that precedent for the **deposit** side: `get-agent` now
//! calls [`crate::commands::get_agent::call_effective_deposit_window_gross`]
//! (`get_agent.rs` ~line 326), the parameterless `effectiveDepositWindowGross`
//! gateway view that is the deposit analogue of the withdraw read, dropping the
//! calendar `window_id` mapping. The reported `window_gross` now matches the
//! exposure the gateway actually enforces the deposit cap on — the same view the
//! preflight in `policy/mod.rs` uses.
//!
//! **Disjointness (as landed):** RPC-1 stayed confined to
//! `clients/rust-payment-client/` (`commands/get_agent.rs`, the gateway view
//! binding). It did **not** touch the indexer (#1021/#1022), watchdog (#1023),
//! dapp (#1025) or harness (#1026) surfaces, so #1024 landed in parallel.
//!
//! # Out of scope
//! - RPC-3/4 (failover) and RPC-9/15/16 (block-pinned reads) — remediated in
//!   the **closed** #1009 phase; see [`crate::scan_remediation_seams`].
