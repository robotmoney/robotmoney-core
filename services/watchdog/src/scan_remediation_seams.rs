//! Dev-scout seam map — Off-chain scan remediation phase (issue #994).
//!
//! Canonical: `docs/code-review/external-scan-verification-20260619.md`
//! (verified external scan), `docs/technical/security-model.md §9` (watchdog
//! breach requirement).
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. It documents the watchdog volume-source and cursor seam touched by
//! issue #990 and its coupling to the indexer fix in #989.
//!
//! # The seam: volume-source functions + the poll cursor
//!
//! Two surfaces in this crate carry the #990 work:
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
//! # Issue #990 — reliable volume accounting + breach actuation
//!
//! **Gap (scan + #990):** the loop is per-block and can skip blocks under
//! catch-up or RPC-timeout pressure, deposits/withdrawals can be
//! double-counted or missed, and breach actuation coverage is incomplete.
//! Reliable accounting must cover *all* blocks between cursor positions, be
//! resilient to RPC timeouts, dedup rows, and exercise the full mint+burn
//! breach path.
//!
//! **Burn-side coupling with #989 (hard ordering constraint):** the burn
//! volume functions read `vault_transfer_events(direction='withdrawal')`,
//! which has **zero rows** until #989 revives the dead `erc4626_withdraw`
//! branch in the indexer (`services/explorer-indexer/src/handle_log`). Until
//! #989 lands, every burn-side assertion in a #990 test is vacuously green and
//! the burn breaker cannot fire regardless of #990's loop changes.
//!
//! **Recommended landing order: #989 → #990.** #990 should add an end-to-end
//! regression that (a) drives a `Withdraw` log through the indexer, then
//! (b) asserts `burn_volume_per_block` / `burn_volume_per_hour` return the
//! expected non-zero value and that the breach loop actuates a pause when the
//! configured burn threshold is crossed.
//!
//! # Newly discovered integration points and risks
//!
//! 1. **The `'withdrawal'` direction literal is a cross-crate contract.** The
//!    burn queries here filter on the exact string the indexer writes in
//!    `insert_vault_transfer_event`. A rename on either side silently zeroes
//!    burn volume. Keep `volume.rs`, the indexer writer, and migration 0008 in
//!    lock-step.
//!
//! 2. **Block coverage vs. `blocks.timestamp` join.** The per-hour queries
//!    join `blocks` on `(chain_id, block_number)` for the timestamp window. If
//!    the cursor work in #990 changes which blocks the indexer persists rows
//!    for, the per-hour window can silently undercount any block whose header
//!    row is missing. #990's coverage test should assert the join is total for
//!    the evaluated window.
//!
//! 3. **No config or schema change is in scope for the scout.** Threshold and
//!    table shapes are owned by #990; this scout only records the seam.
