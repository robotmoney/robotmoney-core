-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 security round 3 (indexer lane) — a vote's memo fetch
--             shares the tick's inline fetch budget, and a budgeted sweep
--             re-verifies the votes that did not verify.
-- (See also: services/explorer-indexer/src/indexer.rs `handle_log_within`
--  (VoteSubmitted) and `sweep_unverified_votes`; migration 0016, which gave
--  consensus_receipts the same state.)
--
-- The VoteSubmitted branch fetched each vote's rationaleUri inline with no
-- deadline: up to 10 s of DNS plus 10 s of request per vote. Any committee
-- agent key can submit unlimited votes with any URI, so 1,000 votes pointing at
-- a host that never answers held one tick for hours, and the watchdog's
-- evaluation behind it. A vote past the tick's budget is now stored unfetched,
-- and a vote whose memo did not verify was `verified = false` for ever, since
-- nothing re-read it. These columns give the sweep the state it needs to
-- converge and to stop:
--   verify_attempts    memo fetches made (0: stored unfetched, past the budget)
--   last_verify_error  the last reason the memo did not verify, for operators

ALTER TABLE committee_votes
    ADD COLUMN IF NOT EXISTS verify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE committee_votes
    ADD COLUMN IF NOT EXISTS last_verify_error TEXT;

-- The sweep's working set. Partial, so it stays small once the backlog
-- converges.
CREATE INDEX IF NOT EXISTS committee_votes_unverified_idx
    ON committee_votes (chain_id, block_number DESC, log_index DESC)
    WHERE verified = FALSE AND rationale_uri <> '';
