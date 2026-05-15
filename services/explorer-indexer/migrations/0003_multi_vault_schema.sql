-- Canonical: docs/technical/explorer-schema-decisions.md §3.4 / §3.5
--            docs/implementation-plan.md §"Phase: Multi-vault explorer"
--            docs/technical/governance-decisions.md §3.5
-- Implements: issue #315 — multi-vault schema migration
--
-- Four changes in this migration:
--
--   1. Add `vault_address` column to vault_snapshots and backfill
--      existing rows with the sentinel single-vault address
--      (0x0000…0000 placeholder — real vaults are non-zero). Pre-existing
--      rows that already carry the vault address via the `contract` FK
--      are left intact; callers must join on `contract` for the
--      canonical address. New rows from the multi-vault indexer path set
--      both `contract` (FK) and `vault_address` (queryable denorm).
--
--   2. Add router_weight_snapshots — keyed (chain_id, block_number,
--      log_index) — sourced from PortfolioRouter.WeightsSet and (when
--      RouterGovernance ships) RouterGovernance.WeightsApplied events.
--
--   3. Add governance_proposals and governance_votes — sourced from
--      RouterGovernance.sol events once the contract is deployed.
--      Tables are created now so the indexer can start recording events
--      without a further schema migration when the contract is wired.
--
--   4. Add account_positions — a non-materialised view that aggregates
--      vault receipt token balances per (chain_id, vault_address,
--      holder_address) from the wallet_positions table.
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

-- ── 2. router_weight_snapshots ───────────────────────────────────────────────
--
-- One row per WeightsSet / WeightsApplied event.  A single event sets
-- weights for N vaults; we store one row per vault leg so queries can
-- filter by (chain_id, vault_address).
--
-- Keyed (chain_id, block_number, log_index, vault_address) — unique
-- because one event can cover many vaults, so (block, log_index) alone
-- is not enough to distinguish the per-vault rows.

CREATE TABLE IF NOT EXISTS router_weight_snapshots (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    -- log_index from the WeightsSet / WeightsApplied log entry.
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    -- Vault address this weight row describes.
    vault_address   BYTEA           NOT NULL,
    -- Weight in basis points (0–10 000).
    weight_bps      NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index, vault_address)
);

CREATE INDEX IF NOT EXISTS router_weight_snapshots_vault_idx
    ON router_weight_snapshots(chain_id, vault_address, block_number DESC);

-- ── 3a. governance_proposals ─────────────────────────────────────────────────
--
-- Sourced from RouterGovernance.ProposalCreated events.
-- lifecycle_state mirrors the on-chain enum:
--   0 = Draft, 1 = Open, 2 = Passed, 3 = Rejected, 4 = Executed, 5 = Expired.
-- Rows are upserted (ON CONFLICT DO NOTHING on the PK; status transitions
-- require separate UPDATE paths keyed on proposal_id).

CREATE TABLE IF NOT EXISTS governance_proposals (
    chain_id            BIGINT          NOT NULL REFERENCES chains(chain_id),
    -- On-chain proposal id (uint256 from the contract).
    proposal_id         NUMERIC(78, 0)  NOT NULL,
    -- RouterGovernance contract address.
    governance_addr     BYTEA           NOT NULL,
    proposer            BYTEA           NOT NULL,
    -- Block where ProposalCreated was emitted.
    created_block       BIGINT          NOT NULL,
    -- Block whose RM supply / balances are used for quorum math.
    snapshot_block      BIGINT          NOT NULL,
    -- RM totalSupply at snapshot_block.
    snapshot_supply     NUMERIC(78, 0)  NOT NULL,
    -- Block when voting period closes (createdBlock + votingPeriod).
    voting_closes_block BIGINT          NOT NULL,
    -- Accumulated yes / no vote power; updated on VoteCast events.
    yes_votes           NUMERIC(78, 0)  NOT NULL DEFAULT 0,
    no_votes            NUMERIC(78, 0)  NOT NULL DEFAULT 0,
    -- 0=Draft 1=Open 2=Passed 3=Rejected 4=Executed 5=Expired
    lifecycle_state     SMALLINT        NOT NULL DEFAULT 0,
    -- Block of execution (NULL until executed).
    executed_block      BIGINT,
    indexed_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS governance_proposals_state_idx
    ON governance_proposals(chain_id, lifecycle_state);

-- ── 3b. governance_votes ─────────────────────────────────────────────────────
--
-- Sourced from RouterGovernance.VoteCast events.
-- Keyed (chain_id, proposal_id, voter) — one row per voter per proposal.
-- `support = true` means "yes".

CREATE TABLE IF NOT EXISTS governance_votes (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    proposal_id     NUMERIC(78, 0)  NOT NULL,
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    voter           BYTEA           NOT NULL,
    -- true = yes, false = no.
    support         BOOLEAN         NOT NULL,
    -- RM balance at the voter's vote-time block (balanceOf snapshot).
    power           NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, proposal_id, voter),
    FOREIGN KEY (chain_id, proposal_id)
        REFERENCES governance_proposals(chain_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS governance_votes_block_idx
    ON governance_votes(chain_id, block_number DESC);

-- ── 4. account_positions view ────────────────────────────────────────────────
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
