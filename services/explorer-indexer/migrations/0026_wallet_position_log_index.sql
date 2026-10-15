-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 security round 1 (indexer lane) — a second share change
--             of one owner in one block is no longer dropped.
-- (See also: services/explorer-indexer/src/db.rs `apply_wallet_position_delta`.)
--
-- `wallet_positions` holds one row per (contract, owner, block): the owner's
-- share balance after that block. The writer read the newest row at or below the
-- block, added the event's shares and inserted with ON CONFLICT DO NOTHING. A
-- second Deposit or Withdraw of the same owner in the same block read the row
-- the first one had just written, and its insert was dropped, so the position
-- kept only the first change until a later event.
--
-- `last_log_index` is the log index of the newest event the row includes. The
-- writer now updates the block's row in place for a later log and skips a log at
-- or below it, which keeps a replayed tick idempotent. NULL marks a row written
-- before this migration; the writer treats it as final, as before.

ALTER TABLE wallet_positions
    ADD COLUMN IF NOT EXISTS last_log_index INTEGER;
