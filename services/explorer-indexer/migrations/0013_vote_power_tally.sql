-- Canonical: docs/code-review/20260619-code-review-internal-claude-scan-verification.md (IDX-5)
--            services/explorer-indexer/src/scan_residual_seams.rs §B2
--
-- IDX-5 — make the governance proposal tally power-weighted.
--
-- The running `votes_for` / `votes_against` counters on `governance_proposals`
-- were `BIGINT` and were incremented by `+ 1` per `VoteCast` event by
-- `insert_vote()`, so they counted *voters* rather than *voting power* — a
-- whale and a dust holder each moved the tally by 1, disagreeing with on-chain
-- quorum/threshold math.  The per-vote `weight` is already persisted exactly on
-- `governance_votes.weight` as `NUMERIC(78, 0)` (issue #307); `insert_vote()`
-- now sums that weight into the tally instead of `+ 1`.
--
-- A `U256` power sum overflows `BIGINT`, so the tally columns are widened to
-- `NUMERIC(78, 0)` to match `governance_votes.weight` and the rest of the
-- exact-decimal uint256 columns (ADR §3.1).  Existing rows are preserved by the
-- implicit `BIGINT -> NUMERIC` cast; the `NOT NULL DEFAULT 0` semantics are
-- retained.

ALTER TABLE governance_proposals
    ALTER COLUMN votes_for     TYPE NUMERIC(78, 0) USING votes_for::numeric,
    ALTER COLUMN votes_for     SET DEFAULT 0,
    ALTER COLUMN votes_against TYPE NUMERIC(78, 0) USING votes_against::numeric,
    ALTER COLUMN votes_against SET DEFAULT 0;
