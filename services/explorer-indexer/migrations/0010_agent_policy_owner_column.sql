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

ALTER TABLE agent_policies
    ADD COLUMN IF NOT EXISTS owner                BYTEA,
    ADD COLUMN IF NOT EXISTS window_usage_to_date NUMERIC(78, 0);

CREATE INDEX IF NOT EXISTS agent_policies_owner_idx
    ON agent_policies(chain_id, owner, block_number DESC);
