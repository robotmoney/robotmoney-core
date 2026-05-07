-- Canonical: docs/implementation-plan.md §11 + docs/technical/explorer-schema-decisions.md §3.4
--
-- The nine "minimum tables" for Phase 5. Composite primary keys per the ADR:
-- events keyed (chain_id, block_number, log_index); state snapshots keyed
-- (chain_id, contract, block_number); supporting tables key on the
-- on-chain identifier (chain_id, address) or (chain_id, tx_hash).
--
-- All uint256 values are stored as NUMERIC(78, 0) per ADR §3.1 — exact
-- decimal, no implicit conversion through float.

CREATE TABLE IF NOT EXISTS chains (
    chain_id        BIGINT      PRIMARY KEY,
    name            TEXT        NOT NULL,
    -- Sanitized RPC label (no API key) used by the indexer that
    -- populated this row. Carried for data-lineage debugging.
    rpc_label       TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
    chain_id        BIGINT      NOT NULL REFERENCES chains(chain_id),
    address         BYTEA       NOT NULL,
    kind            TEXT        NOT NULL,  -- 'gateway' | 'vault'
    deployed_block  BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS blocks (
    chain_id        BIGINT      NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT      NOT NULL,
    hash            BYTEA       NOT NULL,
    parent_hash     BYTEA       NOT NULL,
    timestamp       BIGINT      NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS transactions (
    chain_id        BIGINT      NOT NULL REFERENCES chains(chain_id),
    tx_hash         BYTEA       NOT NULL,
    block_number    BIGINT      NOT NULL,
    tx_index        INTEGER     NOT NULL,
    from_addr       BYTEA       NOT NULL,
    to_addr         BYTEA,
    status          SMALLINT    NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, tx_hash)
);
CREATE INDEX IF NOT EXISTS transactions_block_idx
    ON transactions(chain_id, block_number);

-- Event-sourced from IGateway.AgentDeposit (ADR §3.5).
CREATE TABLE IF NOT EXISTS agent_deposits (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    payment_id      BYTEA           NOT NULL,
    order_id        BYTEA           NOT NULL,
    agent           BYTEA           NOT NULL,
    share_receiver  BYTEA           NOT NULL,
    amount          NUMERIC(78, 0)  NOT NULL,
    shares_minted   NUMERIC(78, 0)  NOT NULL,
    window_id       BIGINT          NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS agent_deposits_payment_id_idx
    ON agent_deposits(chain_id, payment_id);
CREATE INDEX IF NOT EXISTS agent_deposits_agent_idx
    ON agent_deposits(chain_id, agent);

-- Event-sourced from IGateway.AgentAuthorized / AgentRevoked (ADR §3.5).
-- `revoked = true` rows are tombstones; the latest-state view uses
-- `DISTINCT ON (chain_id, agent) ORDER BY block_number DESC`.
CREATE TABLE IF NOT EXISTS agent_policies (
    chain_id          BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number      BIGINT          NOT NULL,
    log_index         INTEGER         NOT NULL,
    tx_hash           BYTEA           NOT NULL,
    agent             BYTEA           NOT NULL,
    revoked           BOOLEAN         NOT NULL,
    valid_until       BIGINT,
    max_per_payment   NUMERIC(78, 0),
    max_per_window    NUMERIC(78, 0),
    share_receiver    BYTEA,
    indexed_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS agent_policies_agent_idx
    ON agent_policies(chain_id, agent, block_number DESC);

-- State-read row (ADR §3.5 trigger 1 / 2). Keyed by contract + block.
CREATE TABLE IF NOT EXISTS vault_snapshots (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    contract        BYTEA           NOT NULL,
    block_number    BIGINT          NOT NULL,
    total_assets    NUMERIC(78, 0)  NOT NULL,
    total_supply   NUMERIC(78, 0)  NOT NULL,
    exit_fee_bps    BIGINT          NOT NULL,
    tvl_cap         NUMERIC(78, 0)  NOT NULL,
    paused          BOOLEAN         NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, block_number),
    FOREIGN KEY (chain_id, contract) REFERENCES contracts(chain_id, address)
);

-- Per-owner balance snapshot at a known block.
CREATE TABLE IF NOT EXISTS wallet_positions (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    contract        BYTEA           NOT NULL,
    owner           BYTEA           NOT NULL,
    block_number    BIGINT          NOT NULL,
    shares          NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, owner, block_number),
    FOREIGN KEY (chain_id, contract) REFERENCES contracts(chain_id, address)
);

-- Append-only operational telemetry (ADR §3.4 — the only table with a serial PK).
CREATE TABLE IF NOT EXISTS indexer_runs (
    run_id              BIGSERIAL   PRIMARY KEY,
    chain_id            BIGINT      NOT NULL REFERENCES chains(chain_id),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    from_block          BIGINT      NOT NULL,
    to_block            BIGINT,
    last_indexed_block  BIGINT,
    reorg_count         INTEGER     NOT NULL DEFAULT 0,
    rows_inserted       BIGINT      NOT NULL DEFAULT 0,
    error               TEXT
);
CREATE INDEX IF NOT EXISTS indexer_runs_chain_started_idx
    ON indexer_runs(chain_id, started_at DESC);
