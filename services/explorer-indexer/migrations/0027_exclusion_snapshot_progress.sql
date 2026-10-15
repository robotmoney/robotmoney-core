-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 security round 2 (indexer lane) — an exclusion record's
--             snapshot balances are read by a budgeted pass, never all inside one tick.
-- (See also: services/explorer-indexer/src/indexer.rs `read_snapshot_balances`;
--  migration 0022 `exclusion_holder_balances`.)
--
-- When a record opened, the tick read `ExclusionLedger.balanceAt` for every
-- depositor in the vault's history, one eth_call at a time, and one failed read
-- failed the tick. Deposits have no minimum and an arbitrary receiver, so dust
-- receivers could stretch that into an hours-long stall during an incident.
--
-- A pass now reads the holders of each open snapshot in owner order under a time
-- budget per tick, and stores here how far it got. Only an owner whose latest
-- `wallet_positions` row at or below the record's block holds shares is read. A
-- zero answer is not stored in `exclusion_holder_balances` (migration 0022), and
-- this cursor is what keeps it from being read again.
--   read_through  the last owner read, in byte order; NULL before the first.
--   done          every candidate owner has been read.
--   block_number  the record's block, so the schema-derived reorg rollback
--                 (issue #1283) drops the progress with the record.

CREATE TABLE IF NOT EXISTS exclusion_snapshot_progress (
    chain_id         BIGINT      NOT NULL REFERENCES chains(chain_id),
    ledger_address   BYTEA       NOT NULL,
    exclusion_id     BIGINT      NOT NULL,
    read_through     BYTEA,
    done             BOOLEAN     NOT NULL DEFAULT FALSE,
    block_number     BIGINT      NOT NULL,
    indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, ledger_address, exclusion_id)
);
