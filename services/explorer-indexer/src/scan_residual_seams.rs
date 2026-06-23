//! Dev-scout seam map — Off-chain scan remediation **residual** phase (issue
//! #1027, the scout for the phase that follows the closed #1009 phase).
//!
//! # Canonical docs
//! - `docs/code-review/external-scan-verification-20260619.md` — the verified
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
//! runtime logic and changes no behaviour — it exists so the shared indexer
//! reorg/cursor + writers seam compiles and is documented *before* the two
//! downstream indexer issues edit it, so they do not collide.
//!
//! It is **not** a historical record (unlike the sibling
//! [`crate::scan_remediation_seams`], which describes already-landed fixes in
//! past tense). The bugs below are **still present at HEAD**; the prose is in
//! present/future tense and is a hand-off to the feature issues that own the
//! fixes:
//!
//! - **#1021** — `fix(indexer): reorg-safe run cursor + vault status rollback`
//!   (IDX-2 / IDX-8).
//! - **#1022** — `fix(indexer): account-position + vote-power accounting`
//!   (IDX-3 / IDX-5).
//!
//! Both edit `services/explorer-indexer/src/indexer.rs` and
//! `services/explorer-indexer/src/db.rs`. The scout's job (#1027) is to
//! establish the shared seam so #1021 and #1022 land in either order without
//! rebasing each other. **Neither this module nor #1027 implements the real
//! fixes.**
//!
//! ---
//!
//! # Seam A — the reorg/cursor path (owned by #1021)
//!
//! ## A1. IDX-2 — failed run after a reorg records a stale cursor (High)
//!
//! The reorg rollback lives in [`crate::indexer`] `run_inner` (~line 196). When
//! the stored hash for `last_indexed` diverges from chain, it calls
//! `walk_back_to_match` → `db.delete_above_block(chain_id, root)` and **mutates
//! the local `last_indexed`** to `root` (or `None` if `root < 0`). That
//! corrected cursor is only returned inside the `Ok(..)` outcome.
//!
//! The coupling is in `run_once` (~line 155): on the **error** arm of
//! `run_inner`, it calls
//! `db.finish_run(run_id, None, last_indexed, 0, 0, Some(&msg))` using the
//! **outer** `last_indexed` it captured from `db.last_indexed_block(..)` *before*
//! `run_inner` ran. If `run_inner` rolled blocks back via `delete_above_block`
//! and *then* errored (e.g. an RPC failure fetching the new range), the run is
//! recorded as still sitting at the **pre-reorg** cursor — above the blocks that
//! were just deleted. The next tick resumes from `pre_reorg_cursor + 1`, never
//! re-indexing the rolled-back range, leaving a permanent gap.
//!
//! **Seam for #1021:** the corrected cursor computed inside `run_inner`'s reorg
//! branch must survive into the error path of `run_once`. The
//! [`crate::indexer::IndexerError`] / outcome plumbing already carries
//! `last_indexed_block` on the success arm; #1021 threads the post-rollback
//! cursor out of `run_inner` even on `Err`. Do **not** change
//! `walk_back_to_match` / reorg-detection *semantics* — that is explicitly out
//! of scope per #1027. The fix is purely about which cursor value `finish_run`
//! persists on failure.
//!
//! ## A2. IDX-8 — reorg rollback does not revert in-place `vaults` status (Med, strengthened)
//!
//! `db.delete_above_block` (`db.rs` ~line 244) deletes block-numbered rows
//! `WHERE block_number > root` from a fixed table list:
//! `wallet_positions, vault_snapshots, agent_deposits, agent_policies,
//! governance_votes, governance_proposals, router_weight_snapshots,
//! router_deposit_legs, adapter_allocations, vault_fee_events,
//! vault_transfer_events, account_history_events, transactions, blocks`.
//!
//! The **`vaults` table is not in that list at all.** Vault status is mutated
//! *in place* by `db.update_vault_status` (the only call site is `indexer.rs`
//! ~line 864, handling a `VaultStatusChanged`-class event). Because `vaults`
//! rows are updated, not block-versioned, a reorg that removes the block which
//! carried a status transition (Active→Paused→Retired) leaves the **post-reorg
//! status stuck** at the orphaned value: `delete_above_block` never touches the
//! row, and there is no per-block history to roll back to.
//!
//! **Seam for #1021:** the chosen remediation shape is a #1021 decision, but the
//! seam is the `delete_above_block` table list + the `vaults`/`update_vault_status`
//! writer pair. The two candidate directions are (a) make vault-status writes
//! block-versioned (an append-only `vault_status_events` history that the live
//! `vaults.status` is derived from, so rollback re-derives) or (b) on rollback,
//! recompute `vaults.status` from the surviving status events `<= root`. Either
//! way #1021 owns the table-list edit and the writer; this scout only documents
//! the gap so #1022's writers (Seam B) do not also try to touch the rollback
//! cascade.
//!
//! ---
//!
//! # Seam B — the writers (owned by #1022)
//!
//! ## B1. IDX-3 — account-positions endpoint never populated (Med)
//!
//! [`crate::db::Db::insert_wallet_position`] (`db.rs` ~line 461) is a complete,
//! correct writer for the `wallet_positions` table (the table that backs the
//! per-account positions API read). It has **zero call sites** in
//! `services/explorer-indexer/src/` — confirm with
//! `grep -rn insert_wallet_position services/explorer-indexer/src/`, which
//! returns only the `pub async fn` definition. No `handle_log` branch ever calls
//! it, so the positions endpoint returns empty for every owner.
//!
//! **Seam for #1022:** the writer signature is stable
//! (`chain_id, contract, owner, block_number, shares: U256`) and is the
//! integration point. #1022 wires it into the ERC-4626 `Deposit`/`Withdraw`
//! (and ERC-20 `Transfer`, if in scope) branches of `handle_log` in
//! `indexer.rs`, computing the owner's resulting share balance per event. The
//! row is already block-numbered and **already in `delete_above_block`'s list**
//! (line 248), so reorg rollback of these rows is handled by Seam A's existing
//! cascade — #1022 does **not** need to touch `delete_above_block`. This is the
//! disjointness guarantee that lets #1021 and #1022 run in parallel.
//!
//! ## B2. IDX-5 — vote tally counts voters, not voting power (Med)
//!
//! [`crate::db::Db::insert_vote`] (`db.rs` ~line 595) inserts the
//! `governance_votes` row (which already stores the per-vote `weight: U256`) and
//! then updates the running tally on `governance_proposals` with
//! `SET {votes_for|votes_against} = {col} + 1` (~line 632) — a **+1 per voter**,
//! ignoring the `weight` argument it was just handed. A whale and a dust holder
//! each move the tally by 1, so `votes_for` / `votes_against` count *voters* not
//! *power* and disagree with on-chain quorum/threshold math.
//!
//! **Seam for #1022:** the tally `UPDATE` inside `insert_vote` is the single
//! edit point — change `{col} + 1` to `{col} + <weight>`. Note the columns are
//! integer counters today; #1022 owns the decision on the column type / decimal
//! representation needed to hold a `U256` power sum (the row already persists
//! `weight` via `u256_to_decimal`, which is the precedent to follow). The
//! `governance_proposals` rows are already in `delete_above_block`'s list
//! (line 253), so a reorg that removes a vote block rolls the proposal row back
//! via Seam A — again, no `delete_above_block` edit needed here.
//!
//! ---
//!
//! # Why #1021 and #1022 are collision-free on this seam
//!
//! - #1021 edits: `run_once`/`run_inner` cursor plumbing (`indexer.rs` ~155/196),
//!   the `delete_above_block` **table list** + `vaults`/`update_vault_status`
//!   writer pair (`db.rs` ~244, ~529; `indexer.rs` ~864).
//! - #1022 edits: `handle_log` event branches to **call** `insert_wallet_position`
//!   (`indexer.rs`), and the `insert_vote` **tally UPDATE** (`db.rs` ~632).
//!
//! The only shared file regions are *adjacent, not overlapping* (`db.rs` line
//! ~244 vs ~461/~632; `indexer.rs` cursor/reorg lines ~155–210 vs `handle_log`
//! branch bodies ~459+). Crucially, **all four writer/rolled-back tables
//! #1022 touches (`wallet_positions`, `governance_proposals`) are already in
//! #1021's `delete_above_block` cascade**, so #1022 never edits the rollback
//! list and #1021 never edits the writers. Land in either order.
//!
//! # Out of scope for this scout and for the whole residual phase
//! - Reorg *detection* / `walk_back_to_match` semantics (#1027 scope bar).
//! - The IDX-1 duplicate-`Withdraw` branch — already fixed in the **closed**
//!   #1009 phase; see [`crate::scan_remediation_seams`].
//! - Watchdog (WD-4 → #1023), rmpc (RPC-1 → #1024), dapp (DAPP-1/2 → #1025),
//!   harness (HARN-2/5/6 → #1026): touch-point-disjoint from indexer.rs/db.rs,
//!   run in parallel after this scout.
