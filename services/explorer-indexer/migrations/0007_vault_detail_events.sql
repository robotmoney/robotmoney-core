-- Canonical: docs/architecture.md §5.4 — vault detail data sets
-- Implements: issue #675 — adapter allocation history, deposit/withdrawal log,
--             and fee collection history for GET /v1/vaults/:address
--
-- Three new tables:
--
--   adapter_allocations — one row per VaultAllocated / VaultPulled /
--     VaultRebalanced event. Records which adapter received or returned
--     funds and how much.
--
--   vault_fee_events — one row per ExitFeeCharged event.
--     Records the gross assets, fee amount, and net assets for each
--     redemption that incurred an exit fee.
--
--   vault_transfer_events — one row per ERC-4626 Deposit or Withdraw event
--     emitted by the vault contract. Records caller, owner/receiver, assets,
--     shares, and direction so the API can serve a unified deposit/withdrawal
--     log without joining agent_deposits.
--
-- All uint256 values remain NUMERIC(78, 0) per ADR §3.1.

-- ── 1. adapter_allocations ───────────────────────────────────────────────────
--
-- Event kind:
--   'allocated'  — VaultAllocated (Allocated event: index, adapter, amount)
--   'pulled'     — VaultPulled    (Pulled event: index, adapter, amount)
--   'rebalanced' — VaultRebalanced (Rebalanced event: totalMoved)

CREATE TABLE IF NOT EXISTS adapter_allocations (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    vault           BYTEA           NOT NULL,  -- vault contract that emitted the event
    adapter         BYTEA,                     -- adapter address (NULL for Rebalanced)
    adapter_index   BIGINT,                    -- adapter index (NULL for Rebalanced)
    amount          NUMERIC(78, 0)  NOT NULL,  -- USDC amount allocated/pulled/moved
    event_kind      TEXT            NOT NULL,  -- 'allocated' | 'pulled' | 'rebalanced'
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS adapter_allocations_vault_idx
    ON adapter_allocations(chain_id, vault, block_number ASC);

-- ── 2. vault_fee_events ──────────────────────────────────────────────────────
--
-- Event: ExitFeeCharged(address indexed owner, address indexed receiver,
--                       uint256 grossAssets, uint256 fee, uint256 netAssets)

CREATE TABLE IF NOT EXISTS vault_fee_events (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    vault           BYTEA           NOT NULL,  -- vault contract that charged the fee
    owner           BYTEA           NOT NULL,  -- share owner being redeemed
    receiver        BYTEA           NOT NULL,  -- asset receiver
    gross_assets    NUMERIC(78, 0)  NOT NULL,
    fee_amount      NUMERIC(78, 0)  NOT NULL,
    net_assets      NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS vault_fee_events_vault_idx
    ON vault_fee_events(chain_id, vault, block_number ASC);

-- ── 3. vault_transfer_events ─────────────────────────────────────────────────
--
-- ERC-4626 Deposit:  Deposit(address caller, address owner, uint256 assets, uint256 shares)
-- ERC-4626 Withdraw: Withdraw(address caller, address receiver, address owner,
--                             uint256 assets, uint256 shares)
--
-- direction: 'deposit' | 'withdrawal'

CREATE TABLE IF NOT EXISTS vault_transfer_events (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    vault           BYTEA           NOT NULL,  -- vault contract
    direction       TEXT            NOT NULL,  -- 'deposit' | 'withdrawal'
    caller          BYTEA           NOT NULL,
    owner_or_receiver BYTEA         NOT NULL,  -- owner for Deposit, receiver for Withdraw
    assets          NUMERIC(78, 0)  NOT NULL,
    shares          NUMERIC(78, 0)  NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS vault_transfer_events_vault_idx
    ON vault_transfer_events(chain_id, vault, block_number ASC);
