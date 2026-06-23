//! Historical seam map — Off-chain scan remediation phase (issue #1009, landed).
//!
//! Canonical: `docs/code-review/20260619-code-review-internal-claude-scan-verification.md` (the
//! verified external full-stack scan whose RPC-* findings drove #991 and
//! #993), `docs/audits.md` (disposes FS-RPC-3/4/9/15/16 as `fixed`).
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. It is retained as a historical pointer to the shared `rpc/mod.rs`
//! failover + read-tag seam that issues #991 and #993 resolved. The bugs it
//! describes have been fixed; the prose below is past-tense.
//!
//! # The shared seam: [`crate::rpc`] (`rpc/mod.rs`)
//!
//! Two distinct concerns live in the same file and the same per-method
//! failover loops:
//!
//! - **Failover control flow** — [`crate::rpc::FailoverRpcClient`] wraps an
//!   ordered `Vec<RpcClient>`. Each method (`call`, `chain_id`,
//!   `get_transaction_receipt`, `eth_call`, …) implements the same
//!   "try each endpoint, keep `last_err`, return first `Ok`" loop. What
//!   counts as a failure that *advances* to the next endpoint was the
//!   #991 surface, gated by the `rpc::is_indexing_transient` classifier.
//!
//! - **Read block-tag threading** — `get_code`, `get_balance`,
//!   `get_transaction_count`, and `eth_call` all take `tag: Option<&str>`.
//!   Pinning reads to the envelope-sampled block was the #993 surface.
//!
//! ## Resolved (#991) — correctness footguns (failover retry; RPC-3 / RPC-4)
//!
//! **What was wrong:** the failover loops treated `Ok(None)` (e.g. a
//! not-yet-indexed `get_transaction_receipt`, or a malformed/missing `result`)
//! as a *terminal success*, so a transient indexing error or empty response on
//! the first endpoint never tried the next endpoint. The
//! `rpc::is_indexing_transient` classifier matched Geth's `-32000 "indexing is
//! in progress"` error but was only consulted by receipt-wait callers, not the
//! failover advance decision.
//!
//! **How it was fixed (#991):** the receipt (and `call`) failover loops in
//! `rpc/mod.rs` now treat a transient-indexing `Err` **and** an `Ok(None)`
//! receipt as "try the next endpoint" rather than returning immediately. #991
//! also landed non-rpc fixes (decimal proposal-id parsing in `cli`,
//! `ReplayCache` finalize-on-failure in `replay_cache`, router-withdraw
//! preflight share reads in `commands`/`policy`) that did not touch the shared
//! block-tag plumbing.
//!
//! ## Resolved (#993) — shared-root client hygiene (block-pinned reads; RPC-9/15/16)
//!
//! **What was wrong:** read commands advertised a sampled `block_number` in
//! their output envelope but resolved balances/allowances/receipts/logs against
//! `"latest"`, so the envelope tag and the data could disagree across a block
//! boundary.
//!
//! **How it was fixed (#993):** the envelope-sampled block tag is now threaded
//! through the `tag: Option<&str>` parameters of `get_balance` / `eth_call` /
//! `get_transaction_count` (replacing the prior `None`/`"latest"` call sites in
//! `commands/*`). #993 also reconstructs timelock role membership
//! chronologically and surfaces read failures via `partial`/`errors` instead of
//! fabricated zeros.
//!
//! # Landing order (honoured) and residual integration notes
//!
//! #991 changed the **failover advance condition** inside the per-method loops;
//! #993 changed the **`tag` argument threaded into** those same read methods.
//! They edit adjacent lines of `rpc/mod.rs` and overlapping call sites in
//! `commands/*`. #991 landed first (its failover-loop edits are structural
//! control flow); #993's additive `tag`-argument change rebased cleanly on top.
//!
//! 1. **`is_indexing_transient` is the shared classifier.** It is kept narrow
//!    (code `-32000` + the stable message substring) so #993's block-pinned
//!    receipt reads do not fail over on a legitimate "no receipt at this pinned
//!    block yet" answer.
//!
//! 2. **A pinned tag changes failover idempotency.** With #993's reads pinned
//!    to a fixed block, retrying the *same* pinned read across endpoints is safe
//!    and deterministic, unlike the old `"latest"` retries that could observe
//!    different chain tips per endpoint.
