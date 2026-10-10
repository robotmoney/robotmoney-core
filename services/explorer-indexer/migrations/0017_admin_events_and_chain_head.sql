-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: core issue 1731 (read-only Base 8453 dapp hardening).
--
-- 1. `indexer_runs.chain_head_block`: the chain head (`eth_blockNumber`) a tick saw. The explorer reports
--    it beside the last indexed block so the dapp can say "indexer N blocks behind".
-- 2. `admin_events`: the Timelock (CallScheduled, CallExecuted, Cancelled, MinDelayChange) and Safe
--    (ExecutionSuccess, ExecutionFailure, AddedOwner, RemovedOwner, ChangedThreshold) events of the
--    governed-change path. The table has `chain_id` and `block_number`, so the reorg rollback clears it
--    with every other event table. `detail` is the decoded event as JSON text.

ALTER TABLE indexer_runs ADD COLUMN IF NOT EXISTS chain_head_block BIGINT;

CREATE TABLE IF NOT EXISTS admin_events (
    chain_id       BIGINT      NOT NULL REFERENCES chains(chain_id),
    block_number   BIGINT      NOT NULL,
    log_index      INTEGER     NOT NULL,
    tx_hash        BYTEA       NOT NULL,
    contract       BYTEA       NOT NULL,
    contract_kind  TEXT        NOT NULL CHECK (contract_kind IN ('timelock', 'safe')),
    event_name     TEXT        NOT NULL,
    op_id          BYTEA,
    detail         TEXT        NOT NULL DEFAULT '{}',
    indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS admin_events_chain_block_idx
    ON admin_events(chain_id, block_number DESC, log_index DESC);
