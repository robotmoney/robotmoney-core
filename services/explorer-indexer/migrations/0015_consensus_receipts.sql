-- Canonical: docs/architecture.md §4.9 — Consensus Rebalance Receipt Contract
-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: issue #1247 — (fusion) anchor the receipt on chain
--
-- One table for the on-chain consensus-receipt commitment register.
--
--   consensus_receipts — one row per ReceiptRecorded event. The indexer
--                        fetches `payload_uri` and sets `verified` from the
--                        keccak256 comparison against `payload_digest`.
--                        A ReceiptReleased event flips `released` /
--                        `released_at` / `released_block_number` in place.
--
-- PK convention (ADR §3.4): the PK starts with chain_id so rows from different
-- chains never collide, and re-indexing the same range is a no-op via
-- ON CONFLICT DO NOTHING.
--
-- REORG SAFETY (this is load-bearing — see Db::delete_above_block):
-- `block_number` is carried on every row precisely so the reorg rollback
-- (`DELETE ... WHERE chain_id = $1 AND block_number > $2`) can remove receipts
-- recorded on orphaned blocks. `released_block_number` is carried for the same
-- reason: release is an in-place mutation (like `vaults.status`, IDX-8), so a
-- rollback that does not reach the record block must still un-release a receipt
-- whose release landed above the reorg root. Both are handled in
-- `Db::delete_above_block`.
--
-- VERIFICATION SCOPE: `verified` records digest verification only — the indexer
-- independently recomputed keccak256(payload bytes) and compared it with the
-- on-chain `payload_digest`. Per-analyst ed25519 verification of the payload's
-- embedded signatures is `rmpc`'s job at submit time (architecture §4.9.1
-- answer 1) and a future indexer pass; nothing in this table asserts it.

CREATE TABLE IF NOT EXISTS consensus_receipts (
    chain_id                BIGINT      NOT NULL,
    receipt_id              BYTEA       NOT NULL,   -- bytes32 receiptId (keccak256 of the id preimage)
    receipt_index           BIGINT      NOT NULL,   -- uint256 append index (capped at i64::MAX)
    submitter               BYTEA       NOT NULL,   -- 20-byte committee agent EOA
    payload_digest          BYTEA       NOT NULL,   -- bytes32 keccak256 of the canonical receipt bytes
    payload_uri             TEXT        NOT NULL,   -- public route serving those exact bytes
    recorded_at             BIGINT      NOT NULL,   -- uint64 block timestamp from ReceiptRecorded
    block_number            BIGINT      NOT NULL,   -- block of the ReceiptRecorded log
    log_index               INT         NOT NULL,
    tx_hash                 BYTEA       NOT NULL,   -- 32-byte hash

    -- Digest verification state, recomputed by the indexer (never trusted input).
    verified                BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Byte length of the fetched payload; NULL when the fetch failed.
    payload_bytes           BIGINT,

    -- Release state (ReceiptReleased). An unreleased receipt is never deleted
    -- and never expires (architecture §4.9.1 answer 3).
    released                BOOLEAN     NOT NULL DEFAULT FALSE,
    released_at             BIGINT,                 -- uint64 block timestamp from ReceiptReleased
    released_block_number   BIGINT,                 -- block of the ReceiptReleased log (reorg rollback key)
    released_by             BYTEA,                  -- 20-byte address that called releaseReceipt

    indexed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (chain_id, receipt_id)
);

-- Protocol-scope listing: newest first.
CREATE INDEX IF NOT EXISTS consensus_receipts_block_idx
    ON consensus_receipts (chain_id, block_number DESC, log_index DESC);

-- Account-scope listing: receipts anchored by one submitter.
CREATE INDEX IF NOT EXISTS consensus_receipts_submitter_idx
    ON consensus_receipts (chain_id, submitter);

-- Reorg rollback of the in-place release mutation scans this.
CREATE INDEX IF NOT EXISTS consensus_receipts_released_block_idx
    ON consensus_receipts (chain_id, released_block_number);
