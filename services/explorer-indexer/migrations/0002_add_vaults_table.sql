-- Canonical: docs/technical/vault-registry-decisions.md §3.5 (field mapping)
--            docs/implementation-plan.md §"Phase: Vault registry"
--
-- Adds the `vaults` table keyed by (chain_id, vault_address).  Each row
-- represents the current registered state of a vault as reported by the
-- on-chain VaultRegistry contract.  Rows are created from VaultRegistered
-- events and updated atomically from VaultStatusChanged events.
--
-- The existing `vault_snapshots` table (0001) is keyed by
-- (chain_id, contract, block_number) and retains all historical snapshot
-- rows — this migration does not alter or migrate any snapshot data.

CREATE TABLE IF NOT EXISTS vaults (
    chain_id            BIGINT          NOT NULL REFERENCES chains(chain_id),
    -- ERC-4626 vault contract address — primary key together with chain_id.
    vault_address       BYTEA           NOT NULL,
    name                TEXT            NOT NULL,
    risk_label          TEXT            NOT NULL,
    -- NUMERIC(78, 0) per ADR §3.1 — exact decimal, no float coercion.
    deposit_cap         NUMERIC(78, 0)  NOT NULL,
    -- 0 = Active, 1 = Paused, 2 = Retired  (matches VaultStatus enum ordering).
    status              SMALLINT        NOT NULL DEFAULT 0,
    -- block.timestamp from VaultRegistered event.
    registered_at       BIGINT          NOT NULL,
    -- Block and tx from VaultRegistered log metadata.
    registered_block    BIGINT          NOT NULL,
    registered_tx       BYTEA           NOT NULL,
    -- Filled in / updated on every VaultStatusChanged event.
    -- NULL until the first status-change event.
    status_changed_at   BIGINT,
    indexed_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, vault_address)
);

CREATE INDEX IF NOT EXISTS vaults_status_idx
    ON vaults(chain_id, status);
