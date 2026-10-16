-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 task X7 (review finding DI-8) — reorg-safe committee
--             membership.
--
-- ─── Why ─────────────────────────────────────────────────────────────────────
--
-- `committee_agents` (0014) keeps one row per member and rewrites it in place:
-- `AgentRegistered` sets `active`, `agent_id` and `registered_at`, and
-- `AgentRevoked` sets `active = FALSE` and `revoked_at`. The table has no
-- `block_number` column, so the schema-derived reorg rollback (issue #1283)
-- never touched it. A reorg that orphaned an `AgentRevoked` left the member
-- revoked for good, and the tilt and the regime feed dropped a member the
-- canonical chain still has. An orphaned re-registration kept its
-- `registered_at`, so the member's earlier signals stayed uncounted.
--
-- The row cannot be rolled back by itself: a re-registration overwrote the
-- earlier `registered_at`, and nothing kept it. This table is the append-only
-- history the row is derived from. It is block-numbered and chain-scoped, so
-- `delete_above_block` clears it with its block like every other event table,
-- and then re-derives the row of every member whose history lost an event
-- (`services/explorer-indexer/src/db.rs`, `derive_committee_agents`).
--
-- `kind`:
--   0 = AgentRegistered (`agent_id` is the event's label)
--   1 = AgentRevoked
--   2 = placeholder: the first vote from a member with no row (DI-4). The row
--       it creates is inactive with an empty label.
--
-- A member's row is: the newest kind 0 or 2 entry gives `registered_at` and
-- `agent_id`; a kind 1 entry after it makes the row inactive with that
-- `revoked_at`; only a kind 0 entry with no revoke after it is active.
CREATE TABLE IF NOT EXISTS committee_agent_events (
    chain_id        BIGINT      NOT NULL,
    agent_address   BYTEA       NOT NULL,   -- 20-byte address
    block_number    BIGINT      NOT NULL,
    log_index       INT         NOT NULL,
    kind            SMALLINT    NOT NULL,
    agent_id        TEXT        NOT NULL DEFAULT '',
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (chain_id, agent_address, block_number, log_index),
    CONSTRAINT committee_agent_events_kind_check CHECK (kind IN (0, 1, 2))
);

CREATE INDEX IF NOT EXISTS committee_agent_events_block_idx
    ON committee_agent_events (chain_id, block_number);

-- ─── Backfill ────────────────────────────────────────────────────────────────
--
-- Every existing row gets the history that reproduces it exactly, from its own
-- columns. `registered_at` and `revoked_at` are the blocks of the events that
-- wrote them, so no provenance is invented. The position inside the block was
-- never stored, so backfilled entries carry a NEGATIVE log index, which no real
-- log has: -2 for the registration and -1 for the revoke, which keeps a revoke
-- in the registration's own block after it. `revoked_at` is only ever set by
-- the newest event (a re-registration clears it), so a revoke entry always
-- follows the registration entry.
--
-- A row that is inactive with no `revoked_at` was written by the DI-4
-- placeholder path, so it backfills as kind 2. Every other row backfills as a
-- registration.
INSERT INTO committee_agent_events
    (chain_id, agent_address, block_number, log_index, kind, agent_id)
SELECT chain_id,
       agent_address,
       registered_at,
       -2,
       CASE WHEN active = FALSE AND revoked_at IS NULL THEN 2 ELSE 0 END,
       agent_id
FROM committee_agents
ON CONFLICT DO NOTHING;

INSERT INTO committee_agent_events
    (chain_id, agent_address, block_number, log_index, kind, agent_id)
SELECT chain_id, agent_address, revoked_at, -1, 1, ''
FROM committee_agents
WHERE revoked_at IS NOT NULL
ON CONFLICT DO NOTHING;
