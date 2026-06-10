-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Issue #661: add owner and window_usage_to_date to agent_policies so that
-- GET /v1/accounts/:address/policies can look up all policies by depositor.
--
-- owner: the depositor address that called gateway.authorizeAgent. BYTEA NOT
-- NULL so the new API endpoint can filter by owner = $address without scanning
-- the full table.
--
-- window_usage_to_date: running total of amount consumed within the current
-- window, stored as NUMERIC(78,0) to match the uint256 wire type.  NULL for
-- rows indexed before this migration (AgentRevoked tombstones) or when the
-- indexer does not have the value (forward-compat).
--
-- The composite index (chain_id, owner, block_number DESC) supports the
-- DISTINCT ON query pattern used by GET /v1/accounts/:address/policies.
--
-- RENUMBERED 0007 -> 0010: this file originally shipped as version 0007,
-- colliding with 0007_account_history_and_vault_detail_stubs.sql (dev-scout
-- PR #708). sqlx requires unique migration versions; the duplicate made
-- MIGRATOR.run() fail with a _sqlx_migrations_pkey violation on every fresh
-- database. The scout stubs migration already adds both columns and a partial
-- agent_policies_owner_idx, so on databases where 0007 applied this migration
-- is an idempotent no-op (IF NOT EXISTS throughout).

ALTER TABLE agent_policies
    ADD COLUMN IF NOT EXISTS owner                BYTEA,
    ADD COLUMN IF NOT EXISTS window_usage_to_date NUMERIC(78, 0);

CREATE INDEX IF NOT EXISTS agent_policies_owner_idx
    ON agent_policies(chain_id, owner, block_number DESC);
