//! Dev-scout seam map — Off-chain scan remediation **residual** phase (issue
//! #1027).
//!
//! Canonical: `docs/code-review/external-scan-verification-20260619.md` — the
//! verified external full-stack scan. The residual watchdog finding remediated
//! by this phase is **WD-4** (per-vault thresholds parsed but never enforced),
//! in the "watchdog" subsystem table.
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. Unlike the sibling [`crate::scan_remediation_seams`] (which records
//! the already-landed #990 fixes in past tense), the bug below is **still
//! present at HEAD**; the prose is present/future tense and hands off to:
//!
//! - **#1023** — `fix(watchdog): enforce per-vault burn/mint thresholds`
//!   (WD-4).
//!
//! # The seam: per-vault threshold resolution vs. the global-only breach loop
//!
//! [`crate::config::Config`] already carries a
//! `vault: HashMap<String, VaultThresholds>` of per-vault overrides
//! (`config.rs` ~line 61), validates them on load (~line 190), and exposes
//! per-vault resolver methods that fall back to the global limit:
//! `Config::per_block_mint_limit(vault_hex)`,
//! `per_hour_mint_limit`, `per_block_burn_limit`, `per_hour_burn_limit`
//! (`config.rs` ~lines 244–283).
//!
//! **What is wrong:** the breach loop in [`crate::watchdog`] (the
//! "Compare against thresholds" block, ~line 101) only ever calls the
//! **global** accessors — `config.global_per_block_mint_limit()` and siblings —
//! and emits every `BreachEvent` (from [`crate::alert`]) with `vault: None`.
//! The per-vault resolver
//! methods and the `vault` override map therefore have **no caller in the live
//! path**, so a tighter per-vault limit is silently ignored: a vault configured
//! with a stricter cap is only ever measured against the looser global cap.
//!
//! # Seam for #1023
//!
//! The integration point is the comparison block in `watchdog.rs` and the
//! already-present per-vault accessors in `config.rs`. #1023 will need a
//! **per-vault** volume source: the current `mint_volume_per_block` /
//! `burn_volume_per_*` functions in [`crate::volume`] aggregate across all
//! vaults. The seam therefore has two halves:
//!
//! 1. **volume**: add (or parameterise) per-vault variants of the four volume
//!    functions so a vault address can be threaded through to the SQL filter
//!    (the rows already carry the vault `contract` column the global query sums
//!    over).
//! 2. **watchdog**: for each configured/active vault, resolve the effective
//!    limit via the existing `Config::per_*_limit(vault_hex)` accessors, compare
//!    against that vault's volume, and emit `BreachEvent { vault: Some(addr), .. }`
//!    (the `BreachEvent.vault: Option<..>` field already exists for exactly this).
//!
//! **Disjointness:** WD-4 is confined to `services/watchdog/` (`watchdog.rs`,
//! `volume.rs`, `config.rs`). It does **not** touch `explorer-indexer`'s
//! `indexer.rs`/`db.rs` (Seams A/B in
//! `services/explorer-indexer/src/scan_residual_seams.rs`), so #1023 runs in
//! parallel with the indexer issues #1021/#1022. It also does not touch the
//! rmpc/dapp/harness residual issues (#1024/#1025/#1026).
//!
//! # Out of scope
//! - WD-1 / WD-6 (RPC-timeout SLA, latest-block-only cursor) — already remediated
//!   in the **closed** #1009 phase; see [`crate::scan_remediation_seams`].
//! - Reorg detection and the indexer cursor (owned by #1021).
