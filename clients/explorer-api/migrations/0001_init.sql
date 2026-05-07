-- Explorer schema (Phase 5).
--
-- Canonical docs:
--   docs/implementation-plan.md §11 (Phase 5 — Simple Web Explorer API and Database)
--   docs/technical/explorer-schema-decisions.md §3.4 (per-table primary keys)
--
-- This migration is owned by the API crate so the integration test can
-- bring up an isolated Postgres without depending on the indexer service
-- binary (issue #57). When the indexer crate lands and ships its own
-- migrations crate, this file becomes the canonical copy and the indexer
-- depends on it.

CREATE TABLE IF NOT EXISTS chains (
    chain_id    BIGINT PRIMARY KEY,
    name        TEXT   NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
    chain_id    BIGINT NOT NULL,
    address     TEXT   NOT NULL,
    kind        TEXT   NOT NULL,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS blocks (
    chain_id     BIGINT NOT NULL,
    block_number BIGINT NOT NULL,
    hash         TEXT   NOT NULL,
    timestamp    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS transactions (
    chain_id     BIGINT NOT NULL,
    tx_hash      TEXT   NOT NULL,
    block_number BIGINT NOT NULL,
    from_address TEXT   NOT NULL,
    to_address   TEXT,
    status       SMALLINT NOT NULL,
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, tx_hash)
);
CREATE INDEX IF NOT EXISTS transactions_block_idx ON transactions (chain_id, block_number);

CREATE TABLE IF NOT EXISTS agent_deposits (
    chain_id     BIGINT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index    INTEGER NOT NULL,
    tx_hash      TEXT   NOT NULL,
    payment_id   TEXT   NOT NULL,
    agent        TEXT   NOT NULL,
    token        TEXT   NOT NULL,
    amount       NUMERIC(78,0) NOT NULL,
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS agent_deposits_agent_idx ON agent_deposits (chain_id, agent);
CREATE INDEX IF NOT EXISTS agent_deposits_payment_idx ON agent_deposits (chain_id, payment_id);
CREATE INDEX IF NOT EXISTS agent_deposits_tx_idx ON agent_deposits (chain_id, tx_hash);

CREATE TABLE IF NOT EXISTS agent_policies (
    chain_id     BIGINT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index    INTEGER NOT NULL,
    agent        TEXT   NOT NULL,
    authorized   BOOLEAN NOT NULL,
    cap          NUMERIC(78,0),
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS agent_policies_agent_idx ON agent_policies (chain_id, agent, block_number DESC);

CREATE TABLE IF NOT EXISTS vault_snapshots (
    chain_id        BIGINT NOT NULL,
    contract        TEXT   NOT NULL,
    block_number    BIGINT NOT NULL,
    total_assets    NUMERIC(78,0) NOT NULL,
    total_supply    NUMERIC(78,0) NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, block_number)
);

CREATE TABLE IF NOT EXISTS wallet_positions (
    chain_id     BIGINT NOT NULL,
    contract     TEXT   NOT NULL,
    owner        TEXT   NOT NULL,
    block_number BIGINT NOT NULL,
    shares       NUMERIC(78,0) NOT NULL,
    assets       NUMERIC(78,0) NOT NULL,
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, owner, block_number)
);

CREATE TABLE IF NOT EXISTS indexer_runs (
    run_id            BIGSERIAL PRIMARY KEY,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    last_indexed_block BIGINT,
    reorg_count       INTEGER NOT NULL DEFAULT 0,
    error             TEXT
);
