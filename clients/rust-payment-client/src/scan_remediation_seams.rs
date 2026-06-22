//! Dev-scout seam map — Off-chain scan remediation phase (issue #994).
//!
//! Canonical: `docs/code-review/external-scan-verification-20260619.md` (the
//! verified external full-stack scan whose RPC-* findings drive #991 and #993).
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. It documents the shared `rpc/mod.rs` failover + read-tag seam that
//! issues #991 and #993 both edit, so they can be landed without clobbering
//! each other.
//!
//! # The shared seam: [`crate::rpc`] (`rpc/mod.rs`)
//!
//! Two distinct concerns live in the same file and the same per-method
//! failover loops:
//!
//! - **Failover control flow** — [`crate::rpc::FailoverRpcClient`] wraps an
//!   ordered `Vec<RpcClient>`. Each method (`call`, `chain_id`,
//!   `get_transaction_receipt`, `eth_call`, …) re-implements the same
//!   "try each endpoint, keep `last_err`, return first `Ok`" loop. What
//!   counts as a failure that *advances* to the next endpoint is the
//!   #991 surface, gated by the `rpc::is_indexing_transient` classifier.
//!
//! - **Read block-tag threading** — `get_code`, `get_balance`,
//!   `get_transaction_count`, and `eth_call` all take `tag: Option<&str>`.
//!   Callers in `commands/*` currently pass `None` (→ `"latest"`). Pinning
//!   reads to the envelope-sampled block is the #993 surface.
//!
//! ## Issue #991 — correctness footguns (failover retry; RPC-3 / RPC-4)
//!
//! **Gap:** the failover loops treat `Ok(None)` (e.g. a not-yet-indexed
//! `get_transaction_receipt`, or a malformed/missing `result`) as a *terminal
//! success*, so a transient indexing error or empty response on the first
//! endpoint never tries the next endpoint. The `rpc::is_indexing_transient`
//! classifier already matches Geth's `-32000 "indexing is in progress"` error but is
//! only consulted by receipt-wait callers, not the failover advance decision.
//!
//! **Seam to touch (#991):** in the receipt (and `call`) failover loops in
//! `rpc/mod.rs`, treat a transient-indexing `Err` **and** an `Ok(None)`
//! receipt as "try the next endpoint" rather than returning immediately.
//! #991 also lands non-rpc fixes (decimal proposal-id parsing in `cli`,
//! `ReplayCache` finalize-on-failure in `replay_cache`, router-withdraw
//! preflight share reads in `commands`/`policy`) that do **not** touch the
//! shared block-tag plumbing — those are #991-only and conflict-free with #993.
//!
//! ## Issue #993 — shared-root client hygiene (block-pinned reads; RPC-9/15/16)
//!
//! **Gap:** read commands advertise a sampled `block_number` in their output
//! envelope but resolve balances/allowances/receipts/logs against `"latest"`,
//! so the envelope tag and the data can disagree across a block boundary.
//! #993 also reconstructs timelock role membership chronologically and surfaces
//! read failures via `partial`/`errors` instead of fabricated zeros.
//!
//! **Seam to touch (#993):** thread the envelope-sampled block tag through the
//! `tag: Option<&str>` parameters of `get_balance` / `eth_call` /
//! `get_transaction_count` (replacing the `None`/`"latest"` call sites in
//! `commands/*`). The `FailoverRpcClient` read methods already accept `tag`;
//! #993 is mostly a *caller* change plus the timelock-reconstruction and
//! `partial/errors` surfacing in `commands`/`read_output`.
//!
//! # Coupling and recommended landing order
//!
//! #991 changes the **failover advance condition** inside the per-method loops;
//! #993 changes the **`tag` argument threaded into** those same read methods.
//! They edit adjacent lines of `rpc/mod.rs` and overlapping call sites in
//! `commands/*`, so a blind rebase will conflict.
//!
//! **Recommended order: land #991 first, then #993.** #991's failover-loop
//! edits are structural (control flow); #993's are additive (an extra argument
//! value at the call sites). Rebasing the additive change on top of the
//! structural one is cleaner than the reverse. If they must land in parallel,
//! split the work so #991 owns the loop bodies in `rpc/mod.rs` and #993 owns
//! the `commands/*` call sites, and have #993 only *read* (never reshape) the
//! failover loops.
//!
//! # Newly discovered integration points and risks
//!
//! 1. **`is_indexing_transient` is the shared classifier.** #991 should keep
//!    the match narrow (code `-32000` + the stable message substring) so #993's
//!    block-pinned receipt reads don't accidentally start failing over on a
//!    legitimate "no receipt at this pinned block yet" answer.
//!
//! 2. **`tag = "latest"` vs a pinned tag changes failover idempotency.** Once
//!    #993 pins reads to a fixed block, retrying the *same* pinned read across
//!    endpoints is safe and deterministic; today's `"latest"` retries can
//!    observe different chain tips per endpoint. #991's failover work should
//!    not assume `"latest"`.
//!
//! 3. **No config or schema change is in scope for the scout.** Command output
//!    envelope shape (`partial`/`errors` fields) is owned by #993; this scout
//!    only records the seam.
