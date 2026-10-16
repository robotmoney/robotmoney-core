-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: core issue 1856 (follow-ups from 1854: the proxy upgrade backfill).
--
-- The indexer backfills every watched proxy's `Upgraded` and `UpgradesFrozen` events from the deploy floor to
-- the cursor (issue 1840). It used to do that in one call inside the tick loop, with no checkpoint: up to
-- 10000 `eth_getLogs` requests that stalled live ingestion, restarted from the floor on any RPC error, and a
-- refused or cursorless run was marked done in memory and only logged once.
--
-- This table is the backfill's checkpoint and its health record, one row per chain:
--
-- - `state`: `running` (a pass is in progress), `done` (the last pass reached `target_block`), `refused`
--   (the floor-to-cursor range is too wide; set INDEXER_START_BLOCK) or `no_cursor` (nothing indexed yet).
--   `refused` and `no_cursor` are retried every tick. `/health` reports the row as `proxy_backfill`.
-- - `floor_block`, `target_block`: the pass's range. `target_block` is the cursor when the pass began; live
--   ingestion covers everything above it.
-- - `next_block`: the first block the pass has not scanned yet. Each tick scans one bounded slice from here
--   and saves the new value, so a restart resumes instead of starting again from the floor.
-- - `detail`: why a pass was refused, for the operator.
--
-- The row holds no chain data, so the reorg rollback leaves it alone: a reorg deletes the event rows above its
-- root and live ingestion re-indexes them, proxy topics included.

CREATE TABLE IF NOT EXISTS proxy_backfill_progress (
    chain_id     BIGINT      NOT NULL REFERENCES chains(chain_id),
    state        TEXT        NOT NULL CHECK (state IN ('running', 'done', 'refused', 'no_cursor')),
    floor_block  BIGINT,
    target_block BIGINT,
    next_block   BIGINT,
    detail       TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id)
);
