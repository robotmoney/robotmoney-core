//! Dev-scout seam map for Phase 5 data-layer issues — issue #703.
//!
//! # Canonical docs
//! - `docs/technical/explorer-schema-decisions.md` — ADR for schema, cadence, reorg, idempotency
//! - `docs/architecture.md §5.4` — Explorer Indexer and API
//! - `services/explorer-indexer/migrations/` — migration files (source of truth for DDL)
//!
//! # Purpose
//! This module is a **documentation-only** compilation unit.  It contains no
//! runtime logic.  Its sole function is to give each downstream feature issue
//! a pointer to the exact seam it must touch, so implementors do not have to
//! re-derive the integration surface from scratch.
//!
//! # Seam catalogue
//!
//! ## Issue #654 — account history endpoint
//!
//! **Gap:** `GET /v1/accounts/:address/history` returns only `agent_deposits`
//! rows (kind = "deposit").  Architecture §5.4 requires: deposits, withdrawals,
//! fee events, policy changes, and governance votes.
//!
//! **Seams to touch:**
//! 1. `services/explorer-indexer/src/abi.rs` — add `AgentWithdrawal` to
//!    `IGatewayEvents` sol! block (currently marked MISSING).
//! 2. `services/explorer-indexer/src/indexer.rs` — add `handle_log` branches
//!    for `AgentWithdrawal`, `ExitFeeCharged` (as history row), `AgentRevoked`
//!    (policy_change), `VoteCast` (governance_vote); call
//!    `db.insert_account_history_event(...)` from each branch.
//! 3. `services/explorer-indexer/src/db.rs` — implement
//!    `insert_account_history_event` and `list_account_history` (stubs in
//!    `db.rs`, table in migration 0007).
//! 4. `clients/explorer-api/src/routes.rs` ~line 1031 — rewrite
//!    `get_account_history` to call `db::list_account_history` instead of the
//!    deposits-only query.
//! 5. `clients/explorer-api/src/model.rs` — extend `EventKind` enum with
//!    `Withdrawal`, `FeeCharged`, `PolicyChange`, `GovernanceVote` variants.
//!
//! **Migration target:** `0007_account_history_and_vault_detail_stubs.sql`
//!   table `account_history_events (chain_id, block_number, log_index)`.
//!
//! **Risk:** The ABI drift in `AgentAuthorized` / `AgentRevoked` (abi.rs
//! drift map — fix in issue #366) means policy-change events are currently
//! silently dropped.  Issue #654 should depend on issue #366, or stub the
//! policy_change path until #366 lands.
//!
//! ## Issue #675 — vault detail endpoint
//!
//! **Gap:** `GET /v1/vaults/:address` returns only TVL history (vault_snapshots).
//! Architecture §5.4 requires: adapter allocation history, deposit/withdrawal
//! event log, fee collection history.
//!
//! **Seams to touch:**
//! 1. `services/explorer-indexer/src/indexer.rs` ~line 595 — replace three
//!    `Ok(0)` stubs (`vault_allocated`, `vault_pulled`, `vault_rebalanced`)
//!    with calls to `db.insert_adapter_allocation(...)`.
//! 2. `services/explorer-indexer/src/indexer.rs` — add fee-event storage
//!    alongside the existing vault snapshot for `ExitFeeCharged`; call
//!    `db.insert_vault_fee_event(...)`.
//! 3. `services/explorer-indexer/src/indexer.rs` — when processing ERC-4626
//!    `Deposit`/`Withdraw` events (currently snapshot-only), also call
//!    `db.insert_vault_transfer_event(...)`.
//! 4. `services/explorer-indexer/src/db.rs` — implement
//!    `insert_adapter_allocation`, `insert_vault_fee_event`,
//!    `insert_vault_transfer_event` (stubs in `db.rs`, tables in migration 0007).
//! 5. `clients/explorer-api/src/routes.rs` ~line 532 — extend `get_vault`
//!    handler to query and return `adapter_allocation_history`,
//!    `deposit_withdrawal_log`, `fee_history` arrays.
//! 6. `clients/explorer-api/src/model.rs` — extend `VaultDetail` struct with
//!    the three new arrays.
//!
//! **Migration target:** `0007_account_history_and_vault_detail_stubs.sql`
//!   tables `adapter_allocations`, `vault_fee_events`, `vault_transfer_events`.
//!
//! ## Issue #661 — GET /v1/accounts/:address/policies endpoint
//!
//! **Gap:** No `GET /v1/accounts/:address/policies` route exists.  The
//! `agent_policies` table lacks `owner` and `window_usage_to_date` columns,
//! so owner-based lookups are not possible.
//!
//! **Seams to touch:**
//! 1. `services/explorer-indexer/migrations/` — migration adding `owner BYTEA`
//!    and `window_usage_to_date NUMERIC(78,0)` columns (scaffold in 0007;
//!    issue #661 should harden with NOT NULL constraint + backfill).
//! 2. `services/explorer-indexer/src/db.rs` — update or replace
//!    `insert_agent_policy` to accept and persist `owner` and
//!    `window_usage_to_date`; implement `list_policies_by_owner` (stubs in
//!    `db.rs`).
//! 3. `services/explorer-indexer/src/indexer.rs` — update `handle_log` branch
//!    for `AgentAuthorized` to decode the `owner` field (requires issue #366
//!    ABI fix) and pass it to the updated DB function.
//! 4. `clients/explorer-api/src/routes.rs` — add new route:
//!    `.route("/v1/accounts/:address/policies", get(get_account_policies))`
//! 5. `clients/explorer-api/src/routes.rs` (or new handler module) — implement
//!    `get_account_policies` handler querying `list_policies_by_owner`.
//! 6. `clients/explorer-api/tests/router_introspection.rs` — must pass
//!    automatically once the route is registered (no code change needed if
//!    the test is already open-ended).
//!
//! **Prerequisite:** Issue #366 (ABI drift fix for `AgentAuthorized` — adds
//!   `address indexed owner` field).  The `owner` column will be NULL for all
//!   rows indexed before #366 lands; #661 must decide whether to backfill.
//!
//! **Migration target:** `0007_account_history_and_vault_detail_stubs.sql`
//!   `ALTER TABLE agent_policies ADD COLUMN IF NOT EXISTS owner BYTEA` etc.
//!
//! ## Issue #695 — db::count() type-guard
//!
//! **Gap:** `db::count()` uses a `format!()` with a `CountTable` enum but the
//! enum variants do not yet cover the new tables added by migration 0007.
//! `docs/implementation-plan.md` line 134 carries an unchecked item:
//! "Indexer: restrict or type-guard db::count() to prevent dynamic SQL expansion."
//!
//! **Seams to touch:**
//! 1. `services/explorer-indexer/src/db.rs` — add `CountTable` variants for
//!    `account_history_events`, `adapter_allocations`, `vault_fee_events`,
//!    `vault_transfer_events` once those tables exist.
//! 2. `services/explorer-indexer/src/db.rs` — add a unit test asserting that
//!    an out-of-band string cannot reach the `format!()` call.  Because
//!    `CountTable` is an enum, this is satisfied by construction at the type
//!    level; the test can assert `CountTable::from_str("unknown_table")` returns
//!    `Err(...)` after a `FromStr` impl is added.
//! 3. `docs/implementation-plan.md` — tick the unchecked item once the above lands.
//!
//! **No migration required.** This is a code-only change.
//!
//! # Newly discovered integration points and risks (issue #703)
//!
//! 1. **Issue #366 is a hard prerequisite for #654 and #661.**  The ABI drift
//!    for `AgentAuthorized` (missing `address indexed owner`) means every
//!    policy-change and owner-lookup row will have a NULL `owner` until #366
//!    lands.  Both downstream issues should document this dependency.
//!
//! 2. **`ExitFeeCharged` is consumed by both #654 and #675.**  The indexer
//!    currently uses this event only to trigger a vault snapshot.  The two
//!    issues must coordinate so the single `handle_log` branch calls both
//!    `insert_account_history_event` and `insert_vault_fee_event` without
//!    duplicating the log-decode logic.  A shared helper function in `indexer.rs`
//!    is the recommended approach.
//!
//! 3. **JSONB payload in `account_history_events`.**  The scout chose JSONB for
//!    flexibility, but issue #654 may find it awkward for ordering/filtering by
//!    payload fields.  If the API needs to `ORDER BY payload->>'amount'`, typed
//!    columns are strongly preferred.  The migration 0007 scaffold uses JSONB;
//!    issue #654 can replace it with typed columns in its own migration.
//!
//! 4. **`CountTable` enum coverage.**  Any new table added by issues #654, #675,
//!    or #661 should immediately get a `CountTable` variant.  Leaving a table
//!    out of `CountTable` makes it invisible to the `db::count()` helper used
//!    by integration tests and ops tooling.
//!
//! 5. **`delete_above_block` reorg cascade.**  The reorg recovery function
//!    (`db.rs`) hard-codes the table list.  Issues #654 and #675 must add their
//!    new tables to that list, or reorg recovery will leave orphaned history rows
//!    after a chain re-org.  See `db::delete_above_block` for the current list.

// This module intentionally contains no runtime code.
