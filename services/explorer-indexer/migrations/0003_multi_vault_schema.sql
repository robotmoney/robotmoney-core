-- Canonical: docs/technical/explorer-schema-decisions.md §3.4 / §3.5
--            docs/implementation-plan.md §"Phase: Multi-vault explorer"
-- Implements: issue #315 — multi-vault schema migration
--
-- Two changes in this migration:
--
--   1. Add `vault_address` column to vault_snapshots and backfill
--      existing rows with the sentinel single-vault address
--      (0x0000…0000 placeholder — real vaults are non-zero). Pre-existing
--      rows that already carry the vault address via the `contract` FK
--      are left intact; callers must join on `contract` for the
--      canonical address. New rows from the multi-vault indexer path set
--      both `contract` (FK) and `vault_address` (queryable denorm).
--
--   2. Add account_positions — a non-materialised view that aggregates
--      vault receipt token balances per (chain_id, vault_address,
--      holder_address) from the wallet_positions table.
--
-- router_weight_snapshots and governance tables are created in migrations
-- 0004 and 0005 with the authoritative schemas from issues #316 and #317.
--
-- All uint256 values remain NUMERIC(78, 0) per ADR §3.1.

-- ── 1. vault_snapshots: add vault_address column ─────────────────────────────
--
-- The column is nullable for backwards-compatibility; existing rows are
-- backfilled with the zero-address sentinel below.  New rows written by
-- the multi-vault indexer path always have a non-zero vault_address.

ALTER TABLE vault_snapshots
    ADD COLUMN IF NOT EXISTS vault_address BYTEA;

-- Backfill: copy the existing `contract` column value into vault_address
-- for any row that still has NULL.  On a fresh database this is a no-op.
UPDATE vault_snapshots
   SET vault_address = contract
 WHERE vault_address IS NULL;

-- Create a supporting index so queries filtered by vault_address are fast.
CREATE INDEX IF NOT EXISTS vault_snapshots_vault_address_idx
    ON vault_snapshots(chain_id, vault_address, block_number DESC);

-- ── 2. account_positions view ────────────────────────────────────────────────
--
-- Non-materialised view that presents the most-recent wallet_positions
-- row per (chain_id, contract, owner) trio.  The view is called
-- account_positions and exposes vault_address as an alias for contract
-- so callers can join on vault_address without knowing the internal
-- column name.
--
-- Using a plain view (not MATERIALIZED) keeps migration idempotent across
-- fresh and migrated databases — REFRESH MATERIALIZED VIEW requires
-- additional orchestration that is out of scope for issue #315.

CREATE OR REPLACE VIEW account_positions AS
SELECT DISTINCT ON (chain_id, contract, owner)
    chain_id,
    contract        AS vault_address,
    owner           AS holder_address,
    block_number,
    shares,
    indexed_at
FROM wallet_positions
ORDER BY chain_id, contract, owner, block_number DESC;
