-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: issue #1053 — IC event indexing and committee/regime-feed API endpoints
--
-- Three new tables for the Investment Committee (IC) subsystem:
--
--   committee_agents     — registry of on-chain committee agents.
--   committee_votes      — one row per VoteSubmitted event; memo keccak256
--                          verification result is stored as `verified`.
--   regime_snapshots     — aggregated per-vault tilt snapshots derived from
--                          verified votes (written off-chain; read by the
--                          regime-feed API endpoint).
--
-- PK convention (ADR §3.4): every PK starts with chain_id so rows from
-- different chains never collide, and re-indexing the same range is a
-- no-op via ON CONFLICT DO NOTHING.

-- ─── committee_agents ────────────────────────────────────────────────────────
-- One row per registered committee agent. Upserted on AgentRegistered;
-- set active=false on AgentRevoked.
CREATE TABLE IF NOT EXISTS committee_agents (
    chain_id        BIGINT      NOT NULL,
    agent_address   BYTEA       NOT NULL,   -- 20-byte address
    agent_id        TEXT        NOT NULL,   -- human-readable label from AgentRegistered.agentId
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    registered_at   BIGINT      NOT NULL,   -- block_number of AgentRegistered event
    revoked_at      BIGINT,                 -- block_number of AgentRevoked event (NULL if still active)
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (chain_id, agent_address)
);

-- ─── committee_votes ─────────────────────────────────────────────────────────
-- One row per VoteSubmitted event. The `verified` flag is set by the
-- indexer after it fetches rationaleUri and computes keccak256 of the
-- memo JSON; if the hash matches voteJsonHash, verified=true and tilt
-- columns are populated. If the fetch fails or hashes don't match,
-- verified=false and tilt columns are NULL.
CREATE TABLE IF NOT EXISTS committee_votes (
    chain_id            BIGINT      NOT NULL,
    vote_id             BIGINT      NOT NULL,   -- uint256 voteId from VoteSubmitted (capped at i64::MAX)
    block_number        BIGINT      NOT NULL,
    log_index           INT         NOT NULL,
    tx_hash             BYTEA       NOT NULL,   -- 32-byte hash
    agent_address       BYTEA       NOT NULL,   -- 20-byte address
    vault_address       BYTEA       NOT NULL,   -- 20-byte address
    stance              SMALLINT    NOT NULL,   -- 0=Overweight, 1=Neutral, 2=Underweight
    target_weight_bps   SMALLINT    NOT NULL,   -- 0..10000
    confidence          SMALLINT    NOT NULL,   -- 0..100
    rationale_uri       TEXT        NOT NULL,
    vote_json_hash      BYTEA       NOT NULL,   -- bytes32 voteJsonHash from event
    timestamp_secs      BIGINT      NOT NULL,   -- uint64 timestamp from event
    verified            BOOLEAN     NOT NULL DEFAULT FALSE,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (chain_id, vote_id),
    FOREIGN KEY (chain_id, agent_address) REFERENCES committee_agents (chain_id, agent_address)
);

CREATE INDEX IF NOT EXISTS committee_votes_agent_idx
    ON committee_votes (chain_id, agent_address);
CREATE INDEX IF NOT EXISTS committee_votes_vault_idx
    ON committee_votes (chain_id, vault_address);

-- ─── regime_snapshots ────────────────────────────────────────────────────────
-- Aggregated per-vault tilt snapshot written by the indexer after every
-- VoteSubmitted tick (verified votes only). The regime-feed API returns
-- the latest snapshot for each (chain_id, vault_address).
CREATE TABLE IF NOT EXISTS regime_snapshots (
    chain_id            BIGINT      NOT NULL,
    vault_address       BYTEA       NOT NULL,   -- 20-byte address
    block_number        BIGINT      NOT NULL,   -- block of the triggering vote
    avg_weight_bps      NUMERIC(7,2)    NOT NULL,   -- mean of verified target_weight_bps
    vote_count          INT         NOT NULL,   -- number of verified votes in this snapshot
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (chain_id, vault_address, block_number)
);
