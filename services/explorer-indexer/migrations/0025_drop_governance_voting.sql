-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
--            docs/technical/governance-decisions.md §3.2 — a receipt is applied, not voted on
-- Implements: QA plan v1 task C1, core issue 1698 — RouterGovernance voting deleted.
--
-- `RouterGovernance` no longer has a propose/vote/execute path. It emits only
-- `ReceiptContractSet` and `ReceiptApplied`; the weight change itself arrives
-- as the router's `WeightsSet`, which still lands in `router_weight_snapshots`.
-- `ProposalCreated`, `VoteCast`, `ProposalExecuted` and `WeightsApplied` can
-- never be emitted again, so the indexer no longer subscribes to them and
-- explorer-api no longer serves `/v1/governance/proposals`.
--
-- This drops what those events fed:
--
--   governance_votes        — created in 0005 (FK to governance_proposals, so
--                             it is dropped first).
--   governance_proposals    — created in 0005, tally widened in 0013.
--   account_history_events  — rows of kind 'governance_vote' (0009). The
--                             history feed has no governance-vote kind now.
--
-- `router_weight_snapshots` (also created in 0005) stays: it is the router's
-- weight history and is still written from `WeightsSet`.

DELETE FROM account_history_events WHERE kind = 'governance_vote';

DROP TABLE IF EXISTS governance_votes;
DROP TABLE IF EXISTS governance_proposals;
