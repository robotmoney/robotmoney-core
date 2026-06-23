-- Canonical: docs/code-review/20260619-code-review-internal-claude-scan-verification.md (IDX-8)
--            services/explorer-indexer/src/scan_residual_seams.rs §A2
--
-- IDX-8 — make vault status reorg-safe.
--
-- The `vaults` table (0002) carries `status` as an *in-place* column updated
-- by `update_vault_status()` from `VaultStatusChanged` events.  Because the
-- column was mutated rather than block-versioned, the reorg-rollback cascade
-- in `delete_above_block()` could not revert a status transition applied at a
-- block that a reorg later orphaned: `vaults` was not in the cascade list, and
-- there was no per-block history to roll back to.
--
-- This migration adds an append-only, block-numbered history of vault status
-- transitions.  The live `vaults.status` column is now *derived* from the
-- highest-block surviving event: `update_vault_status()` inserts a history row
-- and refreshes the live column, and `delete_above_block(root)` deletes the
-- history rows above `root` and re-derives `vaults.status` from the surviving
-- events `<= root` (falling back to 0 = Active, the registration default, when
-- no status event survives).
--
-- `registered_at` / `registered_block` / `status_changed_at` on `vaults` are
-- unchanged; only the `status` derivation gains a rollback-safe source.

CREATE TABLE IF NOT EXISTS vault_status_events (
    chain_id            BIGINT      NOT NULL REFERENCES chains(chain_id),
    -- ERC-4626 vault contract address (matches vaults.vault_address).
    vault_address       BYTEA       NOT NULL,
    -- Block at which the VaultStatusChanged event was observed.  Block-numbered
    -- so it participates in the delete_above_block() reorg cascade.
    block_number        BIGINT      NOT NULL,
    -- Log index within the block — disambiguates multiple status changes for
    -- the same vault in one block and gives a deterministic ordering.
    log_index           INTEGER     NOT NULL,
    -- 0 = Active, 1 = Paused, 2 = Retired (matches VaultStatus enum ordering).
    status              SMALLINT    NOT NULL,
    -- block.timestamp from the VaultStatusChanged event payload.
    changed_at          BIGINT      NOT NULL,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Idempotent re-index: one event per (chain, vault, block, log_index).
    PRIMARY KEY (chain_id, vault_address, block_number, log_index)
);

-- The re-derivation query in delete_above_block() selects the surviving
-- highest-block event per vault: (chain_id, vault_address, block_number DESC).
CREATE INDEX IF NOT EXISTS vault_status_events_vault_block_idx
    ON vault_status_events(chain_id, vault_address, block_number DESC, log_index DESC);
