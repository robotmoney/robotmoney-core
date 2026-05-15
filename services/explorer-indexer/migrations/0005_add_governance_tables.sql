-- Canonical: docs/architecture.md §5.4 — router state and governance history.
--            docs/technical/explorer-schema-decisions.md §3.6 (governance defer trigger: issue #307).
--
-- Adds three tables:
--
--   governance_proposals    — one row per ProposalCreated event; status is
--                             derived and stored as a small int:
--                             0 = open, 1 = passed, 2 = executed, 3 = expired.
--
--   governance_votes        — one row per VoteCast event, keyed by
--                             (chain_id, proposal_id, voter).  The (proposal_id,
--                             voter) composite is the natural dedup key: a voter
--                             casts exactly one vote per proposal.
--
--   router_weight_snapshots — one row per WeightsSet / WeightsApplied event,
--                             recording the full ordered vault+bps vector at
--                             each block.  The `vaults` and `bps_values` arrays
--                             are stored as BYTEA[] / BIGINT[] respectively so
--                             JOIN-free reads are possible.
--
-- All PKs start with chain_id per ADR §3.4.  ON CONFLICT DO NOTHING semantics
-- are enforced at write time; re-indexing the same range is a no-op.

-- ─── governance_proposals ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance_proposals (
    chain_id            BIGINT      NOT NULL REFERENCES chains(chain_id),
    -- On-chain proposal identifier emitted by RouterGovernance.ProposalCreated.
    proposal_id         BIGINT      NOT NULL,
    block_number        BIGINT      NOT NULL,
    log_index           INTEGER     NOT NULL,
    tx_hash             BYTEA       NOT NULL,
    -- Proposer address.
    proposer            BYTEA       NOT NULL,
    -- Free-text description carried in the event.
    description         TEXT        NOT NULL DEFAULT '',
    -- UNIX timestamp from ProposalCreated event.
    created_at          BIGINT      NOT NULL,
    -- Block at which the voting period ends (0 if unknown).
    deadline_block      BIGINT      NOT NULL DEFAULT 0,
    -- 0=open, 1=passed, 2=executed, 3=expired.
    status              SMALLINT    NOT NULL DEFAULT 0,
    -- Set when a ProposalExecuted event is ingested.
    executed_block      BIGINT,
    -- Running vote totals (updated on each VoteCast event and on execution).
    votes_for           BIGINT      NOT NULL DEFAULT 0,
    votes_against       BIGINT      NOT NULL DEFAULT 0,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS governance_proposals_block_idx
    ON governance_proposals(chain_id, block_number DESC);

CREATE INDEX IF NOT EXISTS governance_proposals_status_idx
    ON governance_proposals(chain_id, status);

-- ─── governance_votes ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance_votes (
    chain_id            BIGINT      NOT NULL REFERENCES chains(chain_id),
    proposal_id         BIGINT      NOT NULL,
    voter               BYTEA       NOT NULL,
    block_number        BIGINT      NOT NULL,
    log_index           INTEGER     NOT NULL,
    tx_hash             BYTEA       NOT NULL,
    -- true = voted For, false = voted Against.
    support             BOOLEAN     NOT NULL,
    -- Voting weight (token balance or similar), stored as exact decimal.
    weight              NUMERIC(78, 0) NOT NULL DEFAULT 1,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, proposal_id, voter),
    FOREIGN KEY (chain_id, proposal_id)
        REFERENCES governance_proposals(chain_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS governance_votes_proposal_idx
    ON governance_votes(chain_id, proposal_id);

-- ─── router_weight_snapshots ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS router_weight_snapshots (
    chain_id            BIGINT      NOT NULL REFERENCES chains(chain_id),
    -- PortfolioRouter contract address that emitted the event.
    router_address      BYTEA       NOT NULL,
    block_number        BIGINT      NOT NULL,
    log_index           INTEGER     NOT NULL,
    tx_hash             BYTEA       NOT NULL,
    -- Ordered vault addresses parallel to bps_values.
    -- Postgres BYTEA[] stores each 20-byte address as a separate element.
    vault_addresses     BYTEA[]     NOT NULL,
    -- Basis-points weight per vault (parallel to vault_addresses).
    bps_values          BIGINT[]    NOT NULL,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, router_address, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS router_weight_snapshots_block_idx
    ON router_weight_snapshots(chain_id, router_address, block_number DESC);
