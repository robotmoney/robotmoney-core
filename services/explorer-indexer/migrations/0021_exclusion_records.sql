-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 task X7, core issue 1820 (indexer half) — exclusion
--             records and each holder's claim on them.
-- (See also: contracts/ExclusionLedger.sol, contracts/RobotMoneyVault.sol
--  `_syncExclusions`.)
--
-- When a `RobotMoneyVault` excludes a funded adapter from NAV it opens a record
-- in its `ExclusionLedger` with a snapshot of its share supply. Everything later
-- recovered from that adapter goes to the record, not to vault idle, and belongs
-- pro rata to the holders at the snapshot (owner decision 2026-10-13). A holder
-- who exits during the exclusion keeps the claim. The claim is
--
--     floor(recovered * balance_at_snapshot / snapshot_supply) - already_claimed
--
-- and the API computes it from the tables below (`/v1/accounts/:address/
-- exclusion-claims`).
--
-- Every table is block-numbered and chain-scoped, so the schema-derived reorg
-- rollback (issue #1283) clears an orphaned record, credit, close, claim or
-- holder balance with its block. Every table is append-only: a credit or a
-- claim is a new row, never an update, and the running totals are aggregates.

-- ─── exclusion_records ──────────────────────────────────────────────────────
-- One row per `ExclusionOpened`. `exclusion_id` is the ledger's record id
-- (1-based, per ledger), so the ledger address is part of the key.
CREATE TABLE IF NOT EXISTS exclusion_records (
    chain_id         BIGINT          NOT NULL REFERENCES chains(chain_id),
    -- The ExclusionLedger that emitted the event.
    ledger_address   BYTEA           NOT NULL,
    exclusion_id     BIGINT          NOT NULL,
    -- The RobotMoneyVault whose ledger it is.
    vault_address    BYTEA           NOT NULL,
    adapter_index    BIGINT          NOT NULL,
    adapter_address  BYTEA           NOT NULL,
    -- Vault totalSupply() at the snapshot. Claims divide by this.
    snapshot_supply  NUMERIC(78, 0)  NOT NULL,
    -- The adapter's self-reported value at exclusion. Informational only.
    adapter_value    NUMERIC(78, 0)  NOT NULL,
    block_number     BIGINT          NOT NULL,
    log_index        INTEGER         NOT NULL,
    tx_hash          BYTEA           NOT NULL,
    indexed_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, ledger_address, exclusion_id)
);
CREATE INDEX IF NOT EXISTS exclusion_records_vault_idx
    ON exclusion_records (chain_id, vault_address);

-- ─── exclusion_recoveries ───────────────────────────────────────────────────
-- One row per `ExclusionRecoveryCredited`. `recovered_total` is the record's
-- total after this credit, as the event reports it; the newest one is the
-- record's recovered USDC.
CREATE TABLE IF NOT EXISTS exclusion_recoveries (
    chain_id         BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number     BIGINT          NOT NULL,
    log_index        INTEGER         NOT NULL,
    tx_hash          BYTEA           NOT NULL,
    ledger_address   BYTEA           NOT NULL,
    exclusion_id     BIGINT          NOT NULL,
    -- ExclusionLedger.RecoverySource: 0 EmergencyWithdrawAdapter, 1 EmergencyWithdraw,
    -- 2 AdminRebalance, 3 Restoration.
    source           SMALLINT        NOT NULL,
    amount           NUMERIC(78, 0)  NOT NULL,
    recovered_total  NUMERIC(78, 0)  NOT NULL,
    indexed_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS exclusion_recoveries_record_idx
    ON exclusion_recoveries (chain_id, ledger_address, exclusion_id);

-- ─── exclusion_finalizations ────────────────────────────────────────────────
-- One row per `ExclusionFinalized`: the record takes no more recovery. It stays
-- claimable forever.
CREATE TABLE IF NOT EXISTS exclusion_finalizations (
    chain_id         BIGINT          NOT NULL REFERENCES chains(chain_id),
    ledger_address   BYTEA           NOT NULL,
    exclusion_id     BIGINT          NOT NULL,
    -- ExclusionLedger.FinalizeReason: 0 Restored, 1 Removed, 2 ForceRemoved.
    reason           SMALLINT        NOT NULL,
    recovered_total  NUMERIC(78, 0)  NOT NULL,
    block_number     BIGINT          NOT NULL,
    log_index        INTEGER         NOT NULL,
    tx_hash          BYTEA           NOT NULL,
    indexed_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, ledger_address, exclusion_id)
);

-- ─── exclusion_claims ───────────────────────────────────────────────────────
-- One row per `ExclusionClaimed`: USDC paid to `holder` from a record.
CREATE TABLE IF NOT EXISTS exclusion_claims (
    chain_id         BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number     BIGINT          NOT NULL,
    log_index        INTEGER         NOT NULL,
    tx_hash          BYTEA           NOT NULL,
    ledger_address   BYTEA           NOT NULL,
    exclusion_id     BIGINT          NOT NULL,
    holder           BYTEA           NOT NULL,
    amount           NUMERIC(78, 0)  NOT NULL,
    indexed_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS exclusion_claims_holder_idx
    ON exclusion_claims (chain_id, holder);

-- ─── exclusion_holder_balances ──────────────────────────────────────────────
-- A holder's vault shares at a record's snapshot: `ExclusionLedger.balanceAt
-- (holder, exclusion_id)`, read from the chain by the indexer. The value never
-- changes once the record exists. Written for every known share holder of the
-- vault when the record opens (`block_number` = the record's block), and for a
-- holder first seen claiming (`block_number` = the claim's block). Only
-- non-zero balances are stored.
CREATE TABLE IF NOT EXISTS exclusion_holder_balances (
    chain_id         BIGINT          NOT NULL REFERENCES chains(chain_id),
    ledger_address   BYTEA           NOT NULL,
    exclusion_id     BIGINT          NOT NULL,
    holder           BYTEA           NOT NULL,
    balance_at       NUMERIC(78, 0)  NOT NULL,
    block_number     BIGINT          NOT NULL,
    indexed_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, ledger_address, exclusion_id, holder)
);
CREATE INDEX IF NOT EXISTS exclusion_holder_balances_holder_idx
    ON exclusion_holder_balances (chain_id, holder);
