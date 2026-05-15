-- Canonical: docs/technical/explorer-schema-decisions.md §3.4
--            docs/implementation-plan.md §"Phase: Multi-vault explorer"
-- Implements: issue #373 — decode AgentDepositRouted and RouterDeposit events
--
-- Two changes in this migration:
--
--   1. Add nullable `vault` column to `agent_deposits`.
--      - For `AgentDeposit` (single-vault path): populated with the gateway's
--        pinned vault address at index time.
--      - For `AgentDepositRouted` (router path): NULL — per-leg vault addresses
--        are stored in `router_deposit_legs` (see below).
--      - Legacy rows (indexed before this migration) remain NULL; callers
--        must COALESCE(vault, share_receiver) for backwards compatibility.
--
--   2. Create `router_deposit_legs` — one row per vault leg emitted by
--      the PortfolioRouter `RouterDeposit` event.  Each leg is linked
--      to the parent `AgentDepositRouted` by (chain_id, payment_id).
--
-- All uint256 values remain NUMERIC(78, 0) per ADR §3.1.

-- ── 1. agent_deposits: add vault column ──────────────────────────────────────

ALTER TABLE agent_deposits
    ADD COLUMN IF NOT EXISTS vault BYTEA;

CREATE INDEX IF NOT EXISTS agent_deposits_vault_idx
    ON agent_deposits(chain_id, vault);

-- ── 2. router_deposit_legs ───────────────────────────────────────────────────
--
-- One row per leg per routed deposit.
-- PK: (chain_id, block_number, log_index) — mirrors the RouterDeposit log position.
-- FK to agent_deposits via payment_id for cross-leg joins.

CREATE TABLE IF NOT EXISTS router_deposit_legs (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    -- Links to the AgentDepositRouted event for this payment.
    payment_id      BYTEA           NOT NULL,
    depositor       BYTEA           NOT NULL,  -- address indexed depositor
    vault           BYTEA           NOT NULL,  -- address indexed vault (per leg)
    amount          NUMERIC(78, 0)  NOT NULL,  -- USDC forwarded to this vault
    shares          NUMERIC(78, 0)  NOT NULL,  -- shares minted per leg
    weight_bps      NUMERIC(78, 0)  NOT NULL,  -- weight of this vault in BPS
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS router_deposit_legs_payment_id_idx
    ON router_deposit_legs(chain_id, payment_id);

CREATE INDEX IF NOT EXISTS router_deposit_legs_vault_idx
    ON router_deposit_legs(chain_id, vault);

CREATE INDEX IF NOT EXISTS router_deposit_legs_depositor_idx
    ON router_deposit_legs(chain_id, depositor);
