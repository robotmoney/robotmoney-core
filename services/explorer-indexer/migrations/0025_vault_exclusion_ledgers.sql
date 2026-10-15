-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
--            docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 — the ledger factory
-- Implements: QA plan v1 security round 1 (indexer lane), core issue 1820 —
--             each vault's ExclusionLedger is read from the chain, never derived.
-- (See also: contracts/ExclusionLedgerFactory.sol; contracts/RobotMoneyVault.sol
--  `_initLedger`; services/explorer-indexer/src/indexer.rs `exclusion_ledgers_of`.)
--
-- Migration 0021 indexed the ledger at an address the indexer derived: the
-- vault's CREATE address at nonce 1, which held while the vault constructor ran
-- `new ExclusionLedger(asset)`. ADR-0014 put every vault behind a proxy whose
-- initializer asks `ExclusionLedgerFactory` to create the ledger. The ledger now
-- sits at the factory's CREATE address and the derived address holds no code, so
-- no exclusion record was ever indexed.
--
-- One row per answer of a watched vault's own `exclusionLedger()` getter:
--   ledger_address  the vault's ledger, or NULL when the vault has no such getter
--                   (a BasketVault: the call reverted). A NULL row stops the
--                   indexer from asking again every tick.
--   block_number    the vault's first row: the block the read was made at (the
--                   tick's safe head). A later row: the block of the vault's
--                   `Upgraded` event that made the indexer read it again.
--                   The schema-derived reorg rollback (issue #1283) drops a row
--                   above the rollback root, and the indexer reads again.
--
-- The vault sets its ledger in `initialize`. Under ADR-0014 the one way to move
-- it is a governed upgrade whose reinitializer names a new ledger, so the
-- indexer reads the getter again in the tick that indexes the vault's `Upgraded`
-- event and adds a row when the answer is new (security round 2). A NULL row is
-- re-read the same way, so a basket vault that gains a ledger by an upgrade is
-- watched from then on.
--
-- The indexer watches every ledger named here, old ones included, so a late
-- claim against a ledger a vault has moved away from still indexes. It accepts an
-- exclusion-record event only from one of them.
--
-- Security round 2 amended this migration in place (it had not left the QA
-- branch): the key was (chain_id, vault_address), one row per vault for ever.

CREATE TABLE IF NOT EXISTS vault_exclusion_ledgers (
    chain_id        BIGINT      NOT NULL REFERENCES chains(chain_id),
    vault_address   BYTEA       NOT NULL,
    ledger_address  BYTEA,
    block_number    BIGINT      NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, vault_address, block_number)
);
CREATE INDEX IF NOT EXISTS vault_exclusion_ledgers_ledger_idx
    ON vault_exclusion_ledgers (chain_id, ledger_address);
