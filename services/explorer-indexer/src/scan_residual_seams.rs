//! Historical seam map — Off-chain scan remediation **residual** phase (issue
//! #1027 scout; fixes landed under #1021 and #1022).
//!
//! # Canonical docs
//! - `docs/code-review/20260619-code-review-internal-claude-scan-verification.md` — the verified
//!   external full-stack automated scan. The residual indexer findings
//!   remediated by this phase (IDX-2, IDX-3, IDX-5, IDX-8) are graded in the
//!   "explorer-indexer + explorer-api" subsystem table and the severity
//!   re-grade summary there. These are the indexer findings that the **closed**
//!   off-chain-scan phase (#988–#993, see [`crate::scan_remediation_seams`])
//!   did **not** cover.
//! - `docs/architecture.md §5.4` — Explorer Indexer and API.
//!
//! # Purpose
//! This module is a **documentation-only** compilation unit. It contains no
//! runtime logic and changes no behaviour — it established the shared indexer
//! reorg/cursor + writers seam so the two downstream indexer issues could edit
//! it without colliding.
//!
//! Like the sibling [`crate::scan_remediation_seams`] (which describes the
//! already-landed #1009-phase fixes), the bugs below have been **fixed**; the
//! prose is past tense and points at the landed fix sites:
//!
//! - **#1021** — `fix(indexer): reorg-safe run cursor + vault status rollback`
//!   (IDX-2 / IDX-8).
//! - **#1022** — `fix(indexer): account-position + vote-power accounting`
//!   (IDX-3 / IDX-5).
//!
//! Both edited `services/explorer-indexer/src/indexer.rs` and
//! `services/explorer-indexer/src/db.rs`. The scout (#1027) established the
//! shared seam so #1021 and #1022 landed in either order without rebasing each
//! other.
//!
//! ---
//!
//! # Seam A — the reorg/cursor path (fixed by #1021)
//!
//! ## A1. IDX-2 — failed run after a reorg recorded a stale cursor (High)
//!
//! The reorg rollback lives in [`crate::indexer`] `run_inner`. When the stored
//! hash for `last_indexed` diverged from chain, it called `walk_back_to_match`
//! → `db.delete_above_block(chain_id, root)` and **mutated** the local cursor
//! to `root` (or `None` if `root < 0`).
//!
//! **What was wrong:** `run_once` recorded the run on the **error** arm of
//! `run_inner` using the **outer** `last_indexed` it captured from
//! `db.last_indexed_block(..)` *before* `run_inner` ran. If `run_inner` rolled
//! blocks back via `delete_above_block` and *then* errored (e.g. an RPC failure
//! fetching the new range), the run was recorded as still sitting at the
//! **pre-reorg** cursor — above the blocks that were just deleted — leaving a
//! permanent gap.
//!
//! **Resolved (#1021):** `run_inner` now threads its post-rollback cursor out
//! through a shared `rollback_cursor: &mut Option<i64>` that is updated *before*
//! any fallible step following a rollback. The error arm of `run_once` records
//! `db.finish_run(run_id, None, rollback_cursor, 0, 0, Some(&msg))` (see
//! `indexer.rs` ~line 188), so a failure after a rollback persists the
//! **corrected** cursor and the rolled-back range is re-indexed on the next
//! tick. `walk_back_to_match` / reorg-detection *semantics* were left unchanged,
//! per the #1027 scope bar — the fix was purely about which cursor value
//! `finish_run` persists on failure.
//!
//! ## A2. IDX-8 — reorg rollback did not revert in-place `vaults` status (Med)
//!
//! `db.delete_above_block` deletes block-numbered rows `WHERE block_number >
//! root` from a fixed table list. Originally the **`vaults` table was not in
//! that list**: vault status was mutated *in place* by `db.update_vault_status`,
//! so a reorg that removed the block carrying a status transition
//! (Active→Paused→Retired) left the **post-reorg status stuck** at the orphaned
//! value with no per-block history to roll back to.
//!
//! **Resolved (#1021):** vault-status writes are now block-versioned via an
//! append-only `vault_status_events` history (migration
//! `0012_vault_status_events.sql`). `db.update_vault_status` appends an event
//! row and the live `vaults.status` is derived from it; `delete_above_block`
//! now deletes `vault_status_events` rows above `root` and re-derives
//! `vaults.status` from the surviving events `<= root`, so a reorg correctly
//! rolls the status back.
//!
//! ---
//!
//! # Seam B — the writers (fixed by #1022)
//!
//! ## B1. IDX-3 — account-positions endpoint never populated (Med)
//!
//! [`crate::db::Db::insert_wallet_position`] is a complete, correct writer for
//! the `wallet_positions` table (the table that backs the per-account positions
//! API read).
//!
//! **What was wrong:** it had **zero call sites** in
//! `services/explorer-indexer/src/`, so no `handle_log` branch ever called it
//! and the positions endpoint returned empty for every owner.
//!
//! **Resolved (#1022):** `handle_log` now calls
//! `db.insert_wallet_position(cfg.chain_id, contract, owner, block,
//! new_balance)` (see `indexer.rs` ~line 1137) on the ERC-4626
//! `Deposit`/`Withdraw` (and ERC-20 `Transfer`) branches, computing the owner's
//! resulting share balance per event. The row is block-numbered and already in
//! `delete_above_block`'s list, so Seam A's existing cascade handles reorg
//! rollback — #1022 did **not** touch `delete_above_block`, which is the
//! disjointness guarantee that let #1021 and #1022 land in parallel.
//!
//! ## B2. IDX-5 — vote tally counted voters, not voting power (Med)
//!
//! [`crate::db::Db::insert_vote`] inserts the `governance_votes` row (which
//! stores the per-vote `weight: U256`) and updates the running tally on
//! `governance_proposals`.
//!
//! **What was wrong:** the tally `UPDATE` set `{votes_for|votes_against} = {col}
//! + 1` — a **+1 per voter**, ignoring the `weight` argument — so a whale and a
//! dust holder each moved the tally by 1 and the counters disagreed with
//! on-chain quorum/threshold math.
//!
//! **Resolved (#1022):** the tally `UPDATE` inside `insert_vote` now adds the
//! vote's `weight` (voting power) to `votes_for` / `votes_against` instead of
//! `+1`, persisted via `u256_to_decimal` to hold a `U256` power sum. The
//! `governance_proposals` rows are in `delete_above_block`'s list, so a reorg
//! that removes a vote block rolls the proposal row back via Seam A.
//!
//! ---
//!
//! # Why #1021 and #1022 were collision-free on this seam
//!
//! - #1021 edited: `run_once`/`run_inner` cursor plumbing, the
//!   `delete_above_block` **table list** + the `vaults`/`update_vault_status`
//!   writer pair (now backed by `vault_status_events`).
//! - #1022 edited: `handle_log` event branches to **call**
//!   `insert_wallet_position`, and the `insert_vote` **tally UPDATE**.
//!
//! The only shared file regions were *adjacent, not overlapping*. All
//! writer/rolled-back tables #1022 touched (`wallet_positions`,
//! `governance_proposals`) were already in #1021's `delete_above_block`
//! cascade, so #1022 never edited the rollback list and #1021 never edited the
//! writers. They landed in either order.
//!
//! # Out of scope for this scout and for the whole residual phase
//! - Reorg *detection* / `walk_back_to_match` semantics (#1027 scope bar).
//! - The IDX-1 duplicate-`Withdraw` branch — fixed in the **closed** #1009
//!   phase; see [`crate::scan_remediation_seams`].
//! - Watchdog (WD-4 → #1023), rmpc (RPC-1 → #1024), dapp (DAPP-1/2 → #1025),
//!   harness (HARN-2/5/6 → #1026): touch-point-disjoint from indexer.rs/db.rs.
