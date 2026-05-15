-- Canonical: docs/architecture.md §5.4 — router state history.
--            docs/implementation-plan.md §"Phase: Multi-vault explorer" (issue #316).
--
-- Adds the router_weight_snapshots table, one row per WeightsApplied event
-- emitted by PortfolioRouter.  Stores the full ordered vault+bps vector at
-- each block so GET /v1/router/state can reconstruct both the current
-- weight allocation and the full weight-change history without secondary
-- lookups.
--
-- PK: (chain_id, router_address, block_number, log_index) per ADR §3.4.
-- ON CONFLICT DO NOTHING is enforced at write time; re-indexing is a no-op.

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
