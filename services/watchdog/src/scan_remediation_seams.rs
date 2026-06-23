//! Historical seam map — Off-chain scan remediation phase (issue #1009, landed).
//!
//! Canonical: `docs/code-review/20260619-code-review-internal-claude-scan-verification.md`
//! (verified external scan), `docs/audits.md` (disposes FS-WD-1/FS-WD-6 as
//! `fixed`), `docs/technical/security-model.md §9` (watchdog breach
//! requirement).
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. It is retained as a historical pointer to the watchdog
//! volume-source and cursor seam that issue #990 resolved, and to its coupling
//! with the indexer fix in #989. The bugs it describes have been fixed; the
//! prose below is past-tense.
//!
//! # The seam: volume-source functions + the poll cursor
//!
//! Two surfaces in this crate carried the #990 work:
//!
//! 1. **Volume-source functions** in [`crate::volume`]:
//!    [`crate::volume::mint_volume_per_block`],
//!    [`crate::volume::mint_volume_per_hour`],
//!    [`crate::volume::burn_volume_per_block`], and
//!    [`crate::volume::burn_volume_per_hour`]. The mint side reads
//!    `agent_deposits` + `router_deposit_legs`; the burn side reads
//!    `vault_transfer_events WHERE direction = 'withdrawal'`.
//!
//! 2. **The poll cursor / breach loop** in [`crate::watchdog`], which selects
//!    the block(s) to evaluate, calls the four volume functions, and actuates
//!    a pause/alert on breach.
//!
//! # Resolved (#990) — reliable volume accounting + breach actuation
//!
//! **What was wrong (scan FS-WD-6):** the loop was per-block and could skip
//! blocks under catch-up or RPC-timeout pressure, deposits/withdrawals could be
//! double-counted or missed, and breach actuation coverage was incomplete.
//!
//! **How it was fixed (#990):** the breach loop now iterates *every* block
//! newly indexed since the cursor rather than inspecting only the latest
//! indexed block (see [`crate::watchdog::run_cycles_since_cursor`], which
//! advances the cursor block-by-block so a mid-range error retries the
//! remaining blocks rather than skipping them). The path is resilient to RPC
//! timeouts and dedups rows, and exercises the full mint+burn breach path.
//!
//! **Burn-side coupling with #989 (ordering constraint that was honoured):** the
//! burn volume functions read `vault_transfer_events(direction='withdrawal')`,
//! which had **zero rows** until #989 revived the dead `erc4626_withdraw`
//! branch in the indexer (`services/explorer-indexer/src/handle_log`). #989
//! landed first; #990 then added an end-to-end regression that (a) drives a
//! `Withdraw` log through the indexer, then (b) asserts `burn_volume_per_block`
//! / `burn_volume_per_hour` return the expected non-zero value and that the
//! breach loop actuates a pause when the configured burn threshold is crossed.
//!
//! # Integration points and risks (still relevant)
//!
//! 1. **The `'withdrawal'` direction literal is a cross-crate contract.** The
//!    burn queries here filter on the exact string the indexer writes in
//!    `insert_vault_transfer_event`. A rename on either side silently zeroes
//!    burn volume. Keep `volume.rs`, the indexer writer, and migration 0008 in
//!    lock-step.
//!
//! 2. **Block coverage vs. `blocks.timestamp` join.** The per-hour queries
//!    join `blocks` on `(chain_id, block_number)` for the timestamp window. If
//!    the set of blocks the indexer persists rows for changes, the per-hour
//!    window can silently undercount any block whose header row is missing; the
//!    #990 coverage test asserts the join is total for the evaluated window.
