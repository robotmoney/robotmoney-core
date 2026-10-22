-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
--            docs/technical/explorer-schema-decisions.md §3.4
-- Implements: core issue 1891 (IC-1019-9, IC-1019-15) — the Investment Committee policy and the
-- regime feed are retired. Forward-only: migrations 0014, 0021, 0022 and 0029 are applied history
-- and stay byte-identical.
--
-- The indexer no longer decodes InvestmentCommitteePolicy events and the API no longer serves
-- /v1/committee/* or /v1/regime/feed, so nothing writes or reads these tables.
--
--   committee_votes         — FK to committee_agents, so it is dropped first.
--   committee_agent_events  — append-only registration history of committee members (0022).
--   committee_agents        — derived member rows (0014).
--   regime_snapshots        — per-vault tilt aggregates (0014).
--
-- Contract rows of kind 'investment_committee' stay in `contracts`: they are a watched-address
-- record of past deployments and other rows may reference them.

DROP TABLE IF EXISTS committee_votes;
DROP TABLE IF EXISTS committee_agent_events;
DROP TABLE IF EXISTS committee_agents;
DROP TABLE IF EXISTS regime_snapshots;
