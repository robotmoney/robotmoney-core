//! Historical seam map — Off-chain scan remediation phase (issue #1009, landed).
//!
//! # Canonical docs
//! - `docs/code-review/20260619-code-review-internal-claude-scan-verification.md` — the verified
//!   external full-stack automated scan that motivated this phase. The
//!   indexer findings (duplicate `erc4626_withdraw` branch, watchdog burn
//!   blindness) are graded there.
//! - `docs/audits.md` — disposes FS-IDX-1 (and the watchdog/rmpc siblings) as
//!   `fixed`.
//! - `docs/technical/security-model.md §9` — the watchdog mint/burn breach
//!   requirement that the indexer's `vault_transfer_events` table feeds.
//! - `docs/architecture.md §5.4` — Explorer Indexer and API.
//!
//! # Purpose
//! This module is a **documentation-only** compilation unit. It contains no
//! runtime logic and changes no behaviour. It is retained as a historical
//! pointer to the indexer seam that the off-chain scan remediation phase
//! (#1009) touched; the bugs it describes have all been fixed and the prose
//! below is past-tense.
//!
//! # The shared seam: `indexer.rs::handle_log` topic dispatch
//!
//! [`crate::indexer`] `handle_log` (defined ~line 443) is a flat sequence of
//! `if topic0 == topics.<event> { … return Ok(r); }` branches. Every branch
//! that matches **returns early**, so branch *order* is load-bearing: a second
//! branch keyed on the same `topic0` as an earlier branch is dead code.
//!
//! ## Resolved (#989) — duplicate `erc4626_withdraw` branch (the headline finding)
//!
//! **What was wrong:** there used to be **two** `if topic0 ==
//! topics.erc4626_withdraw` branches:
//!
//! 1. The first decoded `IVaultEvents::Withdraw`, wrote an
//!    `account_history_events` row via `db.insert_history_event(…)`, then
//!    `return Ok(r)`.
//! 2. A later branch decoded the same event and wrote the
//!    `vault_transfer_events(direction='withdrawal')` row via
//!    `db.insert_vault_transfer_event(…)`.
//!
//! Because branch (1) returned, branch (2) was **unreachable**. That second
//! branch was the *only* writer of `vault_transfer_events` with
//! `direction = 'withdrawal'`. The watchdog burn-volume queries
//! (`watchdog::volume::burn_volume_per_block` /
//! `watchdog::volume::burn_volume_per_hour`, in the `watchdog` crate) read
//! exclusively from that table, so the burn/redemption circuit breaker could
//! never observe outflow and never fire. The scan re-graded this UP to
//! Critical (`20260619-code-review-internal-claude-scan-verification.md`, headline §2).
//!
//! **How it was fixed (#989):** the two `erc4626_withdraw` branches were merged
//! into one, so a single decode now writes *both* the history row and the
//! `vault_transfer_events` withdrawal row before returning. There is now a
//! single `erc4626_withdraw` branch in `indexer.rs` (~line 690). The
//! `insert_history_event` write was preserved because the account-history
//! endpoint (#654) still depends on it. The `erc4626_deposit` mirror was
//! already single-branch and served as the pattern.
//!
//! **Regression guard:** a `handle_log`-level test feeds one `Withdraw` log and
//! asserts both an `account_history_events` row and a
//! `vault_transfer_events(direction='withdrawal')` row exist, so the split
//! cannot be silently re-introduced.
//!
//! ## Resolved (#990) — reliable volume accounting + breach actuation
//!
//! **What was wrong:** breach detection in the `watchdog` crate was unreliable
//! (a per-block-only cursor that could skip blocks, missing RPC-timeout
//! handling, dedup, and incomplete event coverage). The indexer side of the
//! coupling is that the watchdog's volume numbers are only as complete as the
//! rows `handle_log` persists.
//!
//! **Coupling with #989:** #990's burn-side coverage was blocked on #989 —
//! before the duplicate-branch fix landed, `vault_transfer_events` had zero
//! withdrawal rows, so any burn-accounting assertion passed trivially. #989
//! landed first, then #990. #990 added a regression test that asserts a
//! non-zero `burn_volume_per_*` for a block containing a `Withdraw` event
//! end-to-end (indexer write → watchdog read). The watchdog volume/cursor
//! detail is recorded in
//! `services/watchdog/src/scan_remediation_seams.rs`.
//!
//! # Integration points and risks (still relevant)
//!
//! 1. **Branch-order fragility is a recurring class.** The early-return
//!    dispatch means *any* future duplicate-topic branch is silently dead.
//!    `erc4626_withdraw` must remain single-branch; #990's coverage test
//!    doubles as a guard against re-introducing the split.
//!
//! 2. **`vault_transfer_events` is the single coupling point between the
//!    indexer and the watchdog burn alarm.** Any schema or direction-string
//!    change here (`'withdrawal'` literal) silently breaks the watchdog query
//!    filter. Keep the literal and column names in lock-step across
//!    `indexer.rs`, `volume.rs`, and migration 0008.
