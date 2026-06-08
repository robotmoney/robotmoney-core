-- Canonical: docs/architecture.md §5.4 — account history event log
--            docs/technical/explorer-schema-decisions.md §3.4
-- Implements: issue #654 — full account history endpoint
--
-- Adds `account_history_events` table to store all five event types
-- that appear in the per-account history feed:
--
--   deposit        — indexed from AgentDeposit / AgentDepositRouted events
--                    (these rows shadow agent_deposits; the GET endpoint
--                    reads from this table rather than agent_deposits for
--                    history, so all kinds are in one place).
--   withdrawal     — indexed from ERC-4626 Withdraw events (IVaultEvents).
--   fee_charged    — indexed from ExitFeeCharged events (IVaultEvents).
--   policy_change  — indexed from AgentAuthorized / AgentRevoked (IGatewayEvents).
--   governance_vote — indexed from VoteCast (IRouterGovernanceEvents).
--
-- Architecture §5.4 notes: "no on-chain governance token exists in the MVP;
-- governance votes are admin-weighted. GovernanceVote entries are stored
-- when a VoteCast event names the account as the voter."
--
-- PK: (chain_id, block_number, log_index) — mirrors the source log position
-- so ON CONFLICT DO NOTHING makes re-indexing idempotent.
--
-- Reconciliation with dev-scout migration 0007
-- (0007_account_history_and_vault_detail_stubs.sql):
--   The scout created a no-op STUB version of `account_history_events` with a
--   placeholder column shape (`event_kind` + a JSONB `payload` blob). The scout
--   never writes rows to it. This migration drops that stub and recreates the
--   table with the real typed schema (`kind`, `vault`, `agent`, `amount`) that
--   the db.rs query layer and the GET /v1/accounts/:address/history API depend
--   on.

DROP TABLE IF EXISTS account_history_events;

CREATE TABLE IF NOT EXISTS account_history_events (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    -- The account address this event belongs to. For deposits this is
    -- share_receiver; for withdrawals it is the owner; for fee events it
    -- is the owner; for policy changes it is the agent address; for
    -- governance votes it is the voter address.
    account         BYTEA           NOT NULL,
    -- Event kind: 'deposit' | 'withdrawal' | 'fee_charged' |
    --             'policy_change' | 'governance_vote'
    kind            TEXT            NOT NULL,
    -- Vault contract address (NULL for policy_change and governance_vote kinds).
    vault           BYTEA,
    -- Agent address (NULL for fee_charged, governance_vote kinds).
    agent           BYTEA,
    -- USDC amount involved (NULL for policy_change and governance_vote kinds).
    amount          NUMERIC(78, 0),
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS account_history_events_account_idx
    ON account_history_events(chain_id, account, block_number ASC);

CREATE INDEX IF NOT EXISTS account_history_events_kind_idx
    ON account_history_events(chain_id, kind);
