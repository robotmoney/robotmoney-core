-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 task X4 (review finding DI-10) — contract-scoped
--             committee vote key.
--
-- Rebuild procedure (MANDATORY reading before applying to a populated
-- database): docs/operations/explorer-db-rebuild.md.
--
-- ─── Key committee_votes by the EMITTING contract ────────────────────────────
--
-- `voteId` is the index into one InvestmentCommitteePolicy deployment's vote
-- array (`voteId = _votes.length`), so a redeployed policy counts from 0 again.
-- The 0014 primary key `(chain_id, vote_id)` therefore collides across two
-- deployments on one chain, and because `insert_committee_vote` ended
-- `ON CONFLICT DO NOTHING`, every vote of the new policy whose id the old one
-- had already used was dropped with no error. The tilt then kept reading the
-- superseded policy's vote. Migration 0016 fixed the same defect for consensus
-- receipts; this is that fix for votes.

-- ─── Step 1: refuse to mis-attribute existing rows ───────────────────────────
--
-- There is no sound backfill, for the reason 0016 gives: the emitting policy
-- address was never recorded, and guessing it from `contracts` or the indexer
-- config would stamp votes cast on a superseded deployment with the address of
-- the current one. A populated table stops the migration with an actionable
-- message. The remedy is the documented rebuild.
DO $$
DECLARE
    n BIGINT;
BEGIN
    IF to_regclass('public.committee_votes') IS NULL THEN
        RETURN;
    END IF;
    -- Already migrated (re-run against a database that carries the column).
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'committee_votes'
          AND column_name  = 'contract_address'
    ) THEN
        RETURN;
    END IF;
    SELECT count(*) INTO n FROM committee_votes;
    IF n > 0 THEN
        RAISE EXCEPTION
            'migration 0019 cannot backfill committee_votes.contract_address for % existing row(s): the emitting policy contract was never recorded, and inferring it would fabricate provenance. Dump the table, then rebuild/reindex the explorer database per docs/operations/explorer-db-rebuild.md.', n;
    END IF;
END
$$;

-- ─── Step 2: contract scope ──────────────────────────────────────────────────
ALTER TABLE committee_votes
    ADD COLUMN IF NOT EXISTS contract_address BYTEA NOT NULL DEFAULT '\x0000000000000000000000000000000000000000'::bytea;
-- The DEFAULT exists only so the ADD COLUMN is legal on the (necessarily empty)
-- table; every writer passes `log.address` explicitly, so drop it immediately
-- and let a missing value be a hard error rather than a zero-address row.
ALTER TABLE committee_votes ALTER COLUMN contract_address DROP DEFAULT;

ALTER TABLE committee_votes DROP CONSTRAINT IF EXISTS committee_votes_pkey;
ALTER TABLE committee_votes
    ADD CONSTRAINT committee_votes_pkey
    PRIMARY KEY (chain_id, contract_address, vote_id);
