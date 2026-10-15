-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
--            docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3, §5 — proxies and the freeze
-- Implements: QA plan v1 task P3, core issue 1810 (indexer half) — upgrade and freeze events.
--
-- Every proxied Robot Money contract (ADR-0014 §1) is an ERC1967Proxy. Its
-- implementation changes only through `upgradeToAndCall`, which emits
-- OpenZeppelin's `Upgraded(address indexed implementation)`; the proxy's
-- constructor emits the first one. The one-way freeze emits
-- `UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash)`.
--
-- One append-only table holds both. A contract's current implementation is
-- its newest `upgraded` row, and it is frozen once any `frozen` row exists.
-- The table is block-numbered and chain-scoped, so the schema-derived reorg
-- rollback (issue #1283) removes an orphaned upgrade or freeze with its block.
-- The explorer serves it at `/v1/upgrades`. Nothing signs from it: rmpc and
-- the dapp read the proxy slot from the chain.

CREATE TABLE IF NOT EXISTS proxy_upgrade_events (
    chain_id        BIGINT      NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT      NOT NULL,
    log_index       INTEGER     NOT NULL,
    tx_hash         BYTEA       NOT NULL,
    -- The proxy that emitted the event.
    contract        BYTEA       NOT NULL,
    -- 'upgraded' (Upgraded) or 'frozen' (UpgradesFrozen).
    kind            TEXT        NOT NULL CHECK (kind IN ('upgraded', 'frozen')),
    -- The implementation the proxy runs from this event on, or the one it froze on.
    implementation  BYTEA       NOT NULL,
    -- UpgradesFrozen only: that implementation's runtime code hash. NULL for an upgrade.
    code_hash       BYTEA,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS proxy_upgrade_events_contract_idx
    ON proxy_upgrade_events (chain_id, contract, block_number DESC, log_index DESC);
