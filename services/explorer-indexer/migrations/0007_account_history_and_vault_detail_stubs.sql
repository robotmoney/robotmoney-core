-- Dev-scout stubs: account history tables (issue #654) and vault detail tables (issue #675).
-- Canonical: docs/technical/explorer-schema-decisions.md §3.4
--
-- IMPORTANT: This migration is a NO-OP stub. The tables and columns defined
-- here document the *intended* schema shape so that downstream issues (#654,
-- #675, #661) have concrete query-function targets in db.rs to implement against.
-- Real data is never written by this migration branch; the tables will be
-- populated in the implementing PRs.
--
-- Downstream issue targets:
--   #654 — account_history: AgentWithdrawal, ExitFeeCharged, policy-change, governance-vote rows
--   #675 — vault_detail: adapter_allocations, vault_fee_events, vault_transfer_events
--   #661 — agent_policies: owner column + window_usage_to_date column
--   #695 — db::count() type-guard (no schema changes; code-only in db.rs)

-- ---------------------------------------------------------------------------
-- Issue #654: account_history tables
-- ---------------------------------------------------------------------------
-- Stores every event type that contributes to GET /v1/accounts/:address/history.
-- The existing `agent_deposits` table covers Deposit entries; this table covers
-- all other kinds (Withdrawal, FeeCharged, PolicyChange, GovernanceVote).
--
-- `event_kind` is a discriminant text column (not an enum) so that adding a
-- new kind does not require a DDL migration — only a new index path in the
-- indexer. The API validates the set of known values before returning.
--
-- Primary key follows the §3.4 event-sourced rule: (chain_id, block_number, log_index).
CREATE TABLE IF NOT EXISTS account_history_events (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    -- The account address this event belongs to. For Withdrawal and FeeCharged
    -- this is the `owner`; for PolicyChange the `agent`; for GovernanceVote the
    -- `voter`. Indexed so /v1/accounts/:address/history can filter cheaply.
    account         BYTEA           NOT NULL,
    -- Discriminant: 'withdrawal' | 'fee_charged' | 'policy_change' | 'governance_vote'
    event_kind      TEXT            NOT NULL,
    -- JSON-serialised event-specific payload. Kept as JSONB so the API can
    -- pass it through without needing a per-kind column set. The indexer
    -- serialises the decoded log fields; the API deserialises at read time.
    -- (Issue #654 may split this into typed columns if the JSONB approach
    -- proves awkward for ordering or filtering.)
    payload         JSONB           NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS account_history_events_account_idx
    ON account_history_events(chain_id, account, block_number DESC);
CREATE INDEX IF NOT EXISTS account_history_events_kind_idx
    ON account_history_events(chain_id, account, event_kind, block_number DESC);

-- ---------------------------------------------------------------------------
-- Issue #675: adapter_allocations — per-vault adapter allocation history
-- ---------------------------------------------------------------------------
-- Event-sourced from IVaultEvents.Allocated, .Pulled, .Rebalanced.
-- These events are currently decoded but their handle_log branches return
-- Ok(0) (indexer.rs line ~595). Issue #675 removes the Ok(0) stubs and
-- writes rows here.
--
-- `event_kind` discriminant: 'allocated' | 'pulled' | 'rebalanced'
CREATE TABLE IF NOT EXISTS adapter_allocations (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    vault           BYTEA           NOT NULL,   -- vault contract address
    adapter         BYTEA,                       -- NULL for Rebalanced (no single adapter)
    -- 'allocated' | 'pulled' | 'rebalanced'
    event_kind      TEXT            NOT NULL,
    amount          NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS adapter_allocations_vault_idx
    ON adapter_allocations(chain_id, vault, block_number DESC);

-- ---------------------------------------------------------------------------
-- Issue #675: vault_fee_events — per-vault ExitFeeCharged history
-- ---------------------------------------------------------------------------
-- Event-sourced from IVaultEvents.ExitFeeCharged.
-- Currently the event triggers a vault snapshot but is never stored as a
-- history row. Issue #675 stores it here.
CREATE TABLE IF NOT EXISTS vault_fee_events (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    vault           BYTEA           NOT NULL,
    owner           BYTEA           NOT NULL,
    receiver        BYTEA           NOT NULL,
    gross_assets    NUMERIC(78, 0)  NOT NULL,
    fee             NUMERIC(78, 0)  NOT NULL,
    net_assets      NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS vault_fee_events_vault_idx
    ON vault_fee_events(chain_id, vault, block_number DESC);

-- ---------------------------------------------------------------------------
-- Issue #675: vault_transfer_events — per-vault deposit/withdrawal event log
-- ---------------------------------------------------------------------------
-- Event-sourced from ERC-4626 Deposit and Withdraw events already watched by
-- the indexer (abi.rs). Currently these trigger snapshots but are not stored
-- as history rows. Issue #675 stores them here.
--
-- `event_kind` discriminant: 'deposit' | 'withdrawal'
CREATE TABLE IF NOT EXISTS vault_transfer_events (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    vault           BYTEA           NOT NULL,
    caller          BYTEA           NOT NULL,
    owner           BYTEA           NOT NULL,
    receiver        BYTEA,                       -- NULL for Deposit (no receiver field)
    assets          NUMERIC(78, 0)  NOT NULL,
    shares          NUMERIC(78, 0)  NOT NULL,
    event_kind      TEXT            NOT NULL,    -- 'deposit' | 'withdrawal'
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS vault_transfer_events_vault_idx
    ON vault_transfer_events(chain_id, vault, block_number DESC);

-- ---------------------------------------------------------------------------
-- Issue #661: agent_policies — add owner and window_usage_to_date columns
-- ---------------------------------------------------------------------------
-- The existing agent_policies table (migration 0001) stores only the `agent`
-- address. Issue #661 adds:
--   owner               BYTEA NOT NULL — the depositor who authorized the agent
--   window_usage_to_date NUMERIC(78,0) — cumulative usage in the current window
-- Both values are decoded from AgentAuthorized / AgentRevoked log fields.
--
-- This migration adds the columns as nullable (ALTER TABLE ADD COLUMN IF NOT EXISTS)
-- so the constraint can be tightened by issue #661's own migration once the
-- indexer is writing the values. The scout does not backfill existing rows.
ALTER TABLE agent_policies
    ADD COLUMN IF NOT EXISTS owner BYTEA,
    ADD COLUMN IF NOT EXISTS window_usage_to_date NUMERIC(78, 0);

-- Issue #661 should add a NOT NULL constraint + index in its own migration
-- after confirming all existing rows are backfilled. Placeholder index for
-- the query pattern documented in issue #661:
--   WHERE chain_id = $1 AND owner = $2 ORDER BY block_number DESC
CREATE INDEX IF NOT EXISTS agent_policies_owner_idx
    ON agent_policies(chain_id, owner, block_number DESC)
    WHERE owner IS NOT NULL;
