-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: core issue 1741 (caps and headroom showed 0 on the read-only Base 8453 dapp).
--
-- `vault_snapshots.tvl_cap` was written as 0 whenever the `tvlCap()` read failed, and the API ignored it and
-- served the registry `vaults.deposit_cap` (always 0, the field is gone from the contract). A cap that could not
-- be read is NULL now, never 0, and the per-deposit cap is stored beside it.
--
-- Rows written before this migration cannot tell a failed read from a real zero, so their tvl_cap is reset to
-- NULL ("unknown"). The latest snapshot of every vault is rewritten by the next indexer tick.

ALTER TABLE vault_snapshots ALTER COLUMN tvl_cap DROP NOT NULL;
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS per_deposit_cap NUMERIC(78, 0);
UPDATE vault_snapshots SET tvl_cap = NULL WHERE tvl_cap = 0;
