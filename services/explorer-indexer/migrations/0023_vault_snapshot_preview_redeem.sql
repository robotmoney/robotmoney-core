-- Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
-- Implements: QA plan v1 task X8, core issue 1795 — a position is worth what a redeem pays.
--
-- `/v1/accounts/:address/positions` priced a position at `shares * total_assets / total_supply`, the ERC-4626
-- `convertToAssets` value. That ignores every exit cost: the exit fee on both vault families, and the
-- `maxSlippageBps` floor a BasketVault applies to the swaps of a redeem. rmAGENT positions read about 3% above
-- what a redeem paid (core 1795).
--
-- The indexer now reads `previewRedeem(totalSupply())` with every snapshot: the USDC that redeeming every share
-- would pay at that block, after the exit costs the vault itself prices. The API scales it to a holder's
-- shares. NULL means "not read": a row written before this migration, or a read that failed. The indexer
-- re-reads a vault whose newest row is NULL on its next tick, so every vault has a value one tick after this
-- migration, and the API serves `usdc_value: null` until then (never the gross value).

ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS preview_redeem_total NUMERIC(78, 0);
