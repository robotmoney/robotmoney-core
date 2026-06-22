//! Dev-scout seam map — Off-chain scan remediation phase (issue #994).
//!
//! # Canonical docs
//! - `docs/code-review/external-scan-verification-20260619.md` — the verified
//!   external full-stack automated scan that motivates this phase. The
//!   indexer findings (duplicate `erc4626_withdraw` branch, watchdog burn
//!   blindness) are graded there.
//! - `docs/technical/security-model.md §9` — the watchdog mint/burn breach
//!   requirement that the indexer's `vault_transfer_events` table feeds.
//! - `docs/architecture.md §5.4` — Explorer Indexer and API.
//!
//! # Purpose
//! This module is a **documentation-only** compilation unit. It contains no
//! runtime logic and changes no behaviour. Its sole job is to give each
//! downstream wave-1 feature issue a precise pointer to the indexer seam it
//! must touch, and to surface the coupling between issues that edit the same
//! `handle_log` dispatch so they can be landed in a safe order.
//!
//! # The shared seam: `indexer.rs::handle_log` topic dispatch
//!
//! [`crate::indexer`] `handle_log` (defined ~line 443) is a flat sequence of
//! `if topic0 == topics.<event> { … return Ok(r); }` branches. Every branch
//! that matches **returns early**, so branch *order* is load-bearing: a second
//! branch keyed on the same `topic0` as an earlier branch is dead code.
//!
//! ## Issue #989 — duplicate `erc4626_withdraw` branch (the headline finding)
//!
//! **Gap:** There are **two** `if topic0 == topics.erc4626_withdraw` branches:
//!
//! 1. ~line 667 — decodes `IVaultEvents::Withdraw`, writes an
//!    `account_history_events` row via `db.insert_history_event(…)`, then
//!    `return Ok(r)` (~line 683).
//! 2. ~line 1024 — decodes the same event and writes the
//!    `vault_transfer_events(direction='withdrawal')` row via
//!    `db.insert_vault_transfer_event(…)`.
//!
//! Because branch (1) returns, branch (2) is **unreachable**. That second
//! branch is the *only* writer of `vault_transfer_events` with
//! `direction = 'withdrawal'`. The watchdog burn-volume queries
//! (`watchdog::volume::burn_volume_per_block` /
//! `watchdog::volume::burn_volume_per_hour`, in the `watchdog` crate) read
//! exclusively from that table, so the burn/redemption circuit breaker can
//! never observe outflow and never fire. The scan re-graded this UP to
//! Critical (`external-scan-verification-20260619.md`, headline §2).
//!
//! **Seam to touch (#989):** merge the two `erc4626_withdraw` branches into
//! one so a single decode writes *both* the history row and the
//! `vault_transfer_events` withdrawal row before returning. Do **not** simply
//! delete the first branch — its `insert_history_event` write is still
//! required for the account-history endpoint (#654). The mirror pair for
//! `erc4626_deposit` is already single-branch (~line 1001) and is the pattern
//! to follow; consider extracting a shared decode + dual-insert helper.
//!
//! **Test seam:** a `handle_log`-level test that feeds one `Withdraw` log and
//! asserts both an `account_history_events` row and a
//! `vault_transfer_events(direction='withdrawal')` row exist. Today the second
//! assertion fails by construction.
//!
//! ## Issue #990 — reliable volume accounting + breach actuation
//!
//! **Gap:** breach detection in the `watchdog` crate is unreliable (per-block-only
//! cursor that can skip blocks, RPC-timeout handling, dedup, and full event
//! coverage). The indexer side of the coupling is that the watchdog's volume
//! numbers are only as complete as the rows `handle_log` persists.
//!
//! **Coupling with #989:** #990's burn-side coverage is *blocked* on #989 —
//! until the duplicate-branch fix lands, `vault_transfer_events` has zero
//! withdrawal rows and any #990 burn-accounting test is vacuously green.
//! **Recommended order: land #989 first, then #990.** #990 should add a
//! regression test that asserts a non-zero `burn_volume_per_*` for a block
//! containing a `Withdraw` event end-to-end (indexer write → watchdog read).
//!
//! **Seam to touch (#990, indexer side):** none beyond #989 for the data
//! rows; the watchdog volume/cursor seam is documented in
//! `services/watchdog/src/scan_remediation_seams.rs`.
//!
//! # Newly discovered integration points and risks
//!
//! 1. **Branch-order fragility is a recurring class.** The early-return
//!    dispatch means *any* future duplicate-topic branch is silently dead.
//!    #989 should leave a comment at the merged branch noting that
//!    `erc4626_withdraw` must remain single-branch, and #990's coverage test
//!    doubles as a guard against re-introducing the split.
//!
//! 2. **`vault_transfer_events` is the single coupling point between the
//!    indexer and the watchdog burn alarm.** Any schema or direction-string
//!    change here (`'withdrawal'` literal) silently breaks the watchdog query
//!    filter. Keep the literal and column names in lock-step across
//!    `indexer.rs`, `volume.rs`, and migration 0008.
//!
//! 3. **No schema change is required for #989.** The table and writer already
//!    exist; only the dead branch needs reviving. This keeps #989 a small,
//!    low-risk landing that unblocks #990.
