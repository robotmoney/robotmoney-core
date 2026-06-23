//! Historical seam map — Off-chain scan remediation **residual** phase (issue
//! #1027 scout; fix landed under #1023).
//!
//! Canonical: `docs/code-review/20260619-code-review-internal-claude-scan-verification.md` — the
//! verified external full-stack scan. The residual watchdog finding remediated
//! by this phase is **WD-4** (per-vault thresholds parsed but never enforced),
//! in the "watchdog" subsystem table.
//!
//! This module is **documentation-only**: no runtime logic, no behaviour
//! change. Like the sibling [`crate::scan_remediation_seams`] (which records
//! the already-landed #990 fixes), the bug below has been **fixed**; the prose
//! is past tense and points at the landed fix site.
//!
//! # The seam: per-vault threshold resolution vs. the global-only breach loop
//!
//! [`crate::config::Config`] already carried a
//! `vault: HashMap<String, VaultThresholds>` of per-vault overrides
//! (`config.rs` ~line 61), validated them on load (~line 190), and exposed
//! per-vault resolver methods that fall back to the global limit:
//! `Config::per_block_mint_limit(vault_hex)`,
//! `per_hour_mint_limit`, `per_block_burn_limit`, `per_hour_burn_limit`
//! (`config.rs` ~lines 244–283).
//!
//! **What was wrong:** the breach loop in [`crate::watchdog`] (the
//! "Compare against thresholds" block) only ever called the **global**
//! accessors — `config.global_per_block_mint_limit()` and siblings — and
//! emitted every `BreachEvent` (from [`crate::alert`]) with `vault: None`. The
//! per-vault resolver methods and the `vault` override map therefore had **no
//! caller in the live path**, so a tighter per-vault limit was silently
//! ignored: a vault configured with a stricter cap was only ever measured
//! against the looser global cap.
//!
//! # Resolved (#1023) — per-vault breach enforcement wired into the live path
//!
//! The breach loop now drives a dedicated per-vault evaluator,
//! [`crate::watchdog::evaluate_vault_breaches`], for each configured/active
//! vault. It has two halves:
//!
//! 1. **volume**: per-vault variants of the four volume functions
//!    (`mint_volume_per_block_for_vault`, `mint_volume_per_hour_for_vault`,
//!    `burn_volume_per_block_for_vault`, `burn_volume_per_hour_for_vault` in
//!    [`crate::volume`]) thread a vault address through to the SQL filter (the
//!    rows already carried the vault `contract` column the global query summed
//!    over).
//! 2. **watchdog**: for each vault, `evaluate_vault_breaches` resolves the
//!    effective limit via the existing `Config::per_*_limit(vault_hex)`
//!    accessors, compares against that vault's scoped volume, and emits
//!    `BreachEvent { vault: Some(addr), .. }` (the `BreachEvent.vault:
//!    Option<..>` field existed for exactly this).
//!
//! **Disjointness (as landed):** WD-4 stayed confined to
//! `services/watchdog/` (`watchdog.rs`, `volume.rs`, `config.rs`). It did
//! **not** touch `explorer-indexer`'s `indexer.rs`/`db.rs` (Seams A/B in
//! `services/explorer-indexer/src/scan_residual_seams.rs`), nor the
//! rmpc/dapp/harness residual surfaces, so #1023 landed in parallel with the
//! indexer issues #1021/#1022.
//!
//! # Out of scope
//! - WD-1 / WD-6 (RPC-timeout SLA, latest-block-only cursor) — remediated in
//!   the **closed** #1009 phase; see [`crate::scan_remediation_seams`].
//! - Reorg detection and the indexer cursor — landed under #1021.
