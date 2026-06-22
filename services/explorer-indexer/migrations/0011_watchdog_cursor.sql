-- Canonical: docs/technical/security-model.md §9 — automated watchdog.
-- Issue #990: give the watchdog a durable last-processed-block cursor so each
-- poll cycle evaluates *every* block newly indexed since it last ran, not just
-- the latest indexed block (scan finding WD-6).
--
-- Before this migration the watchdog re-evaluated only `MAX(last_indexed_block)`
-- each tick. When the indexer advanced more than one block per tick (the common
-- case far from tip, capped by `max_blocks_per_tick`), a per-block volume spike
-- in any non-MAX block was never per-block-evaluated — a deterministic bypass of
-- the per-block circuit breaker. The cursor lets the watchdog walk the half-open
-- range `(last_processed_block, latest_indexed_block]` and advance only after a
-- block is successfully evaluated, so a crash mid-range re-processes rather than
-- skips.
--
-- last_processed_block: the highest block whose per-block volume the watchdog has
-- already evaluated for this chain. NULL/absent row means the watchdog has never
-- run for this chain; the first cycle then seeds the cursor at the latest indexed
-- block minus one so the latest block is evaluated exactly once.

CREATE TABLE IF NOT EXISTS watchdog_cursor (
    chain_id             BIGINT      NOT NULL REFERENCES chains(chain_id),
    last_processed_block BIGINT      NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id)
);
