-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: core issue 1810 (upgradeability stage 3: indexer upgrade and freeze events).
--
-- Every proxied core contract (gateway, vaults, registry, router, RouterGovernance, IC policy, receipt
-- register) emits ERC-1967 `Upgraded(implementation)` and `UpgradesFrozen(proxy, implementation, codeHash)`
-- from its own address (contracts/lib/GovernedUUPS.sol). They are governed changes, so they join the
-- Timelock and Safe events in `admin_events` under `contract_kind = 'proxy'`. `detail` holds the
-- implementation and, for a freeze, its code hash. The rows carry `block_number`, so the reorg rollback
-- clears them with every other event table.
--
-- The explorer derives each contract's current implementation and freeze state from these rows. The
-- indexed history is disclosure only: it never authorizes signing (rmpc and the dapp read the chain).

ALTER TABLE admin_events DROP CONSTRAINT IF EXISTS admin_events_contract_kind_check;
ALTER TABLE admin_events
    ADD CONSTRAINT admin_events_contract_kind_check CHECK (contract_kind IN ('timelock', 'safe', 'proxy'));

CREATE INDEX IF NOT EXISTS admin_events_proxy_contract_idx
    ON admin_events(chain_id, contract, block_number DESC, log_index DESC)
    WHERE contract_kind = 'proxy';
