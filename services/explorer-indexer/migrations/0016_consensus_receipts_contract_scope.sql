-- Canonical: docs/architecture.md §4.9 — Consensus Rebalance Receipt Contract
-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: Fusion round-2 code review T20 (contract-scoped receipt key) and
--             T12 (repairable payload verification state).
--
-- Rebuild procedure (MANDATORY reading before applying to a populated
-- database): docs/operations/explorer-db-rebuild.md.
--
-- ─── T20: key consensus_receipts by the EMITTING contract ────────────────────
--
-- `receipt_id = keccak256(domain || session_id || "\n" || subject_id)` carries
-- no deployment identity: it is byte-identical across every deployment of
-- ConsensusRecommendationReceipt. The 0015 primary key `(chain_id, receipt_id)`
-- therefore collides across two deployments on ONE chain — which devnet 918453
-- already carries — and because `insert_consensus_receipt` ended
-- `ON CONFLICT DO NOTHING`, the row from the SUPERSEDED contract wins for ever
-- while the explorer keeps serving its digest, uri, verified and released
-- state. `delete_above_block` cannot repair that: nothing was ever written
-- above a reorg root. The fix is to put the emitting contract in the key.
--
-- ─── T12: make the verification state repairable ─────────────────────────────
--
-- 0015 had no column that could record WHEN verification last ran or HOW MANY
-- times it had been attempted, and no code path anywhere ever updated
-- `verified`. One transient 502 from the payload host pinned an authentic,
-- correctly-signed receipt at `verified = false` for the life of the database.
-- `verified_at` / `verify_attempts` give the re-verification sweep
-- (`Db::list_unverified_receipts` / `Db::repair_receipt_verification`) the
-- state it needs to converge and to stop.

-- ─── Step 1: refuse to mis-attribute existing rows ───────────────────────────
--
-- There is no sound backfill. The emitting contract address was never
-- recorded, and guessing it from `contracts` would silently stamp rows written
-- by a superseded deployment with the address of the CURRENT one — manufacturing
-- exactly the false provenance this migration exists to prevent. So: a
-- populated table stops the migration with an actionable message. The remedy is
-- the documented rebuild (dump first, then re-index from genesis), which is the
-- sequenced Deploy-phase step anyway.
DO $$
DECLARE
    n BIGINT;
BEGIN
    IF to_regclass('public.consensus_receipts') IS NULL THEN
        RETURN;
    END IF;
    -- Already migrated (re-run against a database that carries the column).
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'consensus_receipts'
          AND column_name  = 'contract_address'
    ) THEN
        RETURN;
    END IF;
    SELECT count(*) INTO n FROM consensus_receipts;
    IF n > 0 THEN
        RAISE EXCEPTION
            'migration 0016 cannot backfill consensus_receipts.contract_address for % existing row(s): the emitting contract was never recorded, and inferring it would fabricate provenance. Dump the table, then rebuild/reindex the explorer database per docs/operations/explorer-db-rebuild.md.', n;
    END IF;
END
$$;

-- ─── Step 2: contract scope ──────────────────────────────────────────────────
ALTER TABLE consensus_receipts
    ADD COLUMN IF NOT EXISTS contract_address BYTEA NOT NULL DEFAULT '\x0000000000000000000000000000000000000000'::bytea;
-- The DEFAULT exists only so the ADD COLUMN is legal on the (necessarily empty)
-- table; every writer passes `log.address` explicitly, so drop it immediately
-- and let a missing value be a hard error rather than a zero-address row.
ALTER TABLE consensus_receipts ALTER COLUMN contract_address DROP DEFAULT;

ALTER TABLE consensus_receipts DROP CONSTRAINT IF EXISTS consensus_receipts_pkey;
ALTER TABLE consensus_receipts
    ADD CONSTRAINT consensus_receipts_pkey
    PRIMARY KEY (chain_id, contract_address, receipt_id);

-- Serving one receipt id without knowing the contract (the explorer-api
-- `/v1/consensus-receipts/:receipt_id` route) scans this.
CREATE INDEX IF NOT EXISTS consensus_receipts_chain_receipt_idx
    ON consensus_receipts (chain_id, receipt_id);

-- ─── Step 3: repairable verification state ───────────────────────────────────
ALTER TABLE consensus_receipts
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE consensus_receipts
    ADD COLUMN IF NOT EXISTS verify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE consensus_receipts
    ADD COLUMN IF NOT EXISTS last_verify_error TEXT;

-- The re-verification sweep's working set: rows that are still unverified and
-- have a URI worth re-fetching. Partial so it stays small once the backlog
-- converges — the steady state is zero rows.
CREATE INDEX IF NOT EXISTS consensus_receipts_unverified_idx
    ON consensus_receipts (chain_id, verify_attempts, block_number)
    WHERE verified = FALSE AND payload_uri <> '';
