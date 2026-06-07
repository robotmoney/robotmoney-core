//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! (See also: docs/technical/explorer-schema-decisions.md)
//! sqlx-Postgres pool wrapper plus all DML the indexer issues.
//!
//! Every write is keyed on the composite PKs from
//! `migrations/0001_minimum_tables.sql` (ADR §3.4) and uses
//! `ON CONFLICT DO NOTHING` so re-indexing the same range is a no-op
//! (issue #57 acceptance criterion).

use alloy_primitives::U256;
use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::str::FromStr;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migrate: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    /// Returned by [`CountTable::try_from`] when the caller supplies a
    /// string that is not in the known-good identifier allowlist.
    #[error("unknown table identifier: {0:?}")]
    UnknownTable(String),
}

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

/// Embed the migrations directory at compile time so `cargo test`
/// (which does not call sqlx-cli) can still apply schema.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// All countable tables (nine §11 tables plus the vault registry table
/// added in migration 0002, and the governance tables added in migration 0003).
///
/// Using a typed enum instead of a raw `&str` ensures no caller can
/// pass a user-controlled string to the dynamic `FORMAT` in
/// [`Db::count`] (issue #165).  Adding a new variant here is
/// intentionally explicit — the compiler will flag every incomplete
/// `match` if you add one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountTable {
    Chains,
    Contracts,
    Blocks,
    Transactions,
    AgentDeposits,
    AgentPolicies,
    VaultSnapshots,
    WalletPositions,
    IndexerRuns,
    /// Added in migration 0002 — vault registry table.
    Vaults,
    /// Added in migration 0003 — governance proposal events.
    GovernanceProposals,
    /// Added in migration 0003 — per-voter vote events.
    GovernanceVotes,
    /// Added in migration 0003 — weight-change history from WeightsApplied events.
    RouterWeightSnapshots,
    /// Added in migration 0006 — per-leg data from RouterDeposit events (issue #373).
    RouterDepositLegs,
    /// Added in migration 0008 — adapter allocation history (issue #675).
    AdapterAllocations,
    /// Added in migration 0008 — exit fee event log (issue #675).
    VaultFeeEvents,
    /// Added in migration 0008 — ERC-4626 deposit/withdrawal event log (issue #675).
    VaultTransferEvents,
    /// Added in migration 0009 — full account history events (issue #654).
    AccountHistoryEvents,
}

impl CountTable {
    /// Return the SQL table name for use in `FORMAT!("… FROM {}", …)`.
    fn as_str(self) -> &'static str {
        match self {
            CountTable::Chains => "chains",
            CountTable::Contracts => "contracts",
            CountTable::Blocks => "blocks",
            CountTable::Transactions => "transactions",
            CountTable::AgentDeposits => "agent_deposits",
            CountTable::AgentPolicies => "agent_policies",
            CountTable::VaultSnapshots => "vault_snapshots",
            CountTable::WalletPositions => "wallet_positions",
            CountTable::IndexerRuns => "indexer_runs",
            CountTable::Vaults => "vaults",
            CountTable::GovernanceProposals => "governance_proposals",
            CountTable::GovernanceVotes => "governance_votes",
            CountTable::RouterWeightSnapshots => "router_weight_snapshots",
            CountTable::RouterDepositLegs => "router_deposit_legs",
            CountTable::AdapterAllocations => "adapter_allocations",
            CountTable::VaultFeeEvents => "vault_fee_events",
            CountTable::VaultTransferEvents => "vault_transfer_events",
            CountTable::AccountHistoryEvents => "account_history_events",
        }
    }
}

/// Runtime allowlist check: parse a raw string identifier into a
/// [`CountTable`] variant.  Any string not in the known-good set is
/// rejected with [`DbError::UnknownTable`], preventing callers that
/// receive table names from external sources (config files, HTTP
/// query parameters, etc.) from accidentally expanding the SQL query
/// surface.
///
/// The compile-time path (passing a [`CountTable`] literal directly to
/// [`Db::count`]) is always preferred.  This impl exists for code paths
/// where the table name is only known at runtime.
impl TryFrom<&str> for CountTable {
    type Error = DbError;

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "chains" => Ok(CountTable::Chains),
            "contracts" => Ok(CountTable::Contracts),
            "blocks" => Ok(CountTable::Blocks),
            "transactions" => Ok(CountTable::Transactions),
            "agent_deposits" => Ok(CountTable::AgentDeposits),
            "agent_policies" => Ok(CountTable::AgentPolicies),
            "vault_snapshots" => Ok(CountTable::VaultSnapshots),
            "wallet_positions" => Ok(CountTable::WalletPositions),
            "indexer_runs" => Ok(CountTable::IndexerRuns),
            "vaults" => Ok(CountTable::Vaults),
            "governance_proposals" => Ok(CountTable::GovernanceProposals),
            "governance_votes" => Ok(CountTable::GovernanceVotes),
            "router_weight_snapshots" => Ok(CountTable::RouterWeightSnapshots),
            "router_deposit_legs" => Ok(CountTable::RouterDepositLegs),
            "adapter_allocations" => Ok(CountTable::AdapterAllocations),
            "vault_fee_events" => Ok(CountTable::VaultFeeEvents),
            "vault_transfer_events" => Ok(CountTable::VaultTransferEvents),
            "account_history_events" => Ok(CountTable::AccountHistoryEvents),
            other => Err(DbError::UnknownTable(other.to_owned())),
        }
    }
}

impl Db {
    pub async fn connect(database_url: &str) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn migrate(&self) -> Result<(), DbError> {
        MIGRATOR.run(&self.pool).await?;
        Ok(())
    }

    /// Idempotent insert for the `chains` row.
    pub async fn upsert_chain(
        &self,
        chain_id: i64,
        name: &str,
        rpc_label: &str,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, $2, $3) \
             ON CONFLICT (chain_id) DO NOTHING",
        )
        .bind(chain_id)
        .bind(name)
        .bind(rpc_label)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Idempotent insert for a watched contract row.
    pub async fn upsert_contract(
        &self,
        chain_id: i64,
        address: [u8; 20],
        kind: &str,
        deployed_block: Option<i64>,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO contracts (chain_id, address, kind, deployed_block) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (chain_id, address) DO NOTHING",
        )
        .bind(chain_id)
        .bind(&address[..])
        .bind(kind)
        .bind(deployed_block)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Idempotent block insert. Returns rows_affected so the caller can
    /// distinguish "new block" vs "already had it".
    pub async fn insert_block(
        &self,
        chain_id: i64,
        block_number: i64,
        hash: [u8; 32],
        parent_hash: [u8; 32],
        timestamp: i64,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO blocks (chain_id, block_number, hash, parent_hash, timestamp) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chain_id, block_number) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(&hash[..])
        .bind(&parent_hash[..])
        .bind(timestamp)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    pub async fn get_block_hash(
        &self,
        chain_id: i64,
        block_number: i64,
    ) -> Result<Option<[u8; 32]>, DbError> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT hash FROM blocks WHERE chain_id = $1 AND block_number = $2")
                .bind(chain_id)
                .bind(block_number)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|(v,)| v.try_into().ok()))
    }

    /// Reorg recovery: delete every row with block_number > `root` for
    /// the given chain. Per ADR §3.3, this is preferred over soft-delete.
    pub async fn delete_above_block(&self, chain_id: i64, root: i64) -> Result<u64, DbError> {
        let mut tx = self.pool.begin().await?;
        let mut total = 0u64;
        for table in [
            "wallet_positions",
            "vault_snapshots",
            "agent_deposits",
            "agent_policies",
            "governance_votes",
            "governance_proposals",
            "router_weight_snapshots",
            "router_deposit_legs",
            "adapter_allocations",
            "vault_fee_events",
            "vault_transfer_events",
            "account_history_events",
            "transactions",
            "blocks",
        ] {
            let q = format!(
                "DELETE FROM {} WHERE chain_id = $1 AND block_number > $2",
                table
            );
            let r = sqlx::query(&q)
                .bind(chain_id)
                .bind(root)
                .execute(&mut *tx)
                .await?;
            total += r.rows_affected();
        }
        tx.commit().await?;
        Ok(total)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_transaction(
        &self,
        chain_id: i64,
        tx_hash: [u8; 32],
        block_number: i64,
        tx_index: i32,
        from_addr: [u8; 20],
        to_addr: Option<[u8; 20]>,
        status: i16,
    ) -> Result<u64, DbError> {
        let to_bytes: Option<&[u8]> = to_addr.as_ref().map(|a| &a[..]);
        let r = sqlx::query(
            "INSERT INTO transactions (chain_id, tx_hash, block_number, tx_index, from_addr, to_addr, status) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (chain_id, tx_hash) DO NOTHING",
        )
        .bind(chain_id)
        .bind(&tx_hash[..])
        .bind(block_number)
        .bind(tx_index)
        .bind(&from_addr[..])
        .bind(to_bytes)
        .bind(status)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Insert a row into `agent_deposits`.
    ///
    /// `vault` is the vault address the deposit was routed to.  For
    /// single-vault `AgentDeposit` events, pass the gateway's pinned vault
    /// address.  For multi-leg `AgentDepositRouted` events, pass `None`
    /// (per-leg vault addresses are stored in `router_deposit_legs`).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_agent_deposit(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        payment_id: [u8; 32],
        order_id: [u8; 32],
        agent: [u8; 20],
        share_receiver: [u8; 20],
        amount: U256,
        shares_minted: U256,
        window_id: i64,
        vault: Option<[u8; 20]>,
    ) -> Result<u64, DbError> {
        let vault_bytes: Option<&[u8]> = vault.as_ref().map(|a| &a[..]);
        let r = sqlx::query(
            "INSERT INTO agent_deposits (chain_id, block_number, log_index, tx_hash, payment_id, order_id, agent, share_receiver, amount, shares_minted, window_id, vault) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&payment_id[..])
        .bind(&order_id[..])
        .bind(&agent[..])
        .bind(&share_receiver[..])
        .bind(u256_to_decimal(amount))
        .bind(u256_to_decimal(shares_minted))
        .bind(window_id)
        .bind(vault_bytes)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Insert a per-leg row into `router_deposit_legs` from a `RouterDeposit`
    /// event emitted by `PortfolioRouter`.  Uses `ON CONFLICT DO NOTHING` so
    /// re-indexing the same range is a no-op (issue #57 AC).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_router_deposit_leg(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        payment_id: [u8; 32],
        depositor: [u8; 20],
        vault: [u8; 20],
        amount: U256,
        shares: U256,
        weight_bps: U256,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO router_deposit_legs \
             (chain_id, block_number, log_index, tx_hash, payment_id, depositor, vault, amount, shares, weight_bps) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&payment_id[..])
        .bind(&depositor[..])
        .bind(&vault[..])
        .bind(u256_to_decimal(amount))
        .bind(u256_to_decimal(shares))
        .bind(u256_to_decimal(weight_bps))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_agent_policy(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        agent: [u8; 20],
        revoked: bool,
        valid_until: Option<i64>,
        max_per_payment: Option<U256>,
        max_per_window: Option<U256>,
        share_receiver: Option<[u8; 20]>,
    ) -> Result<u64, DbError> {
        let sr_bytes: Option<&[u8]> = share_receiver.as_ref().map(|a| &a[..]);
        let r = sqlx::query(
            "INSERT INTO agent_policies (chain_id, block_number, log_index, tx_hash, agent, revoked, valid_until, max_per_payment, max_per_window, share_receiver) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&agent[..])
        .bind(revoked)
        .bind(valid_until)
        .bind(max_per_payment.map(u256_to_decimal))
        .bind(max_per_window.map(u256_to_decimal))
        .bind(sr_bytes)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_vault_snapshot(
        &self,
        chain_id: i64,
        contract: [u8; 20],
        block_number: i64,
        total_assets: U256,
        total_supply: U256,
        exit_fee_bps: i64,
        tvl_cap: U256,
        paused: bool,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, exit_fee_bps, tvl_cap, paused) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (chain_id, contract, block_number) DO NOTHING",
        )
        .bind(chain_id)
        .bind(&contract[..])
        .bind(block_number)
        .bind(u256_to_decimal(total_assets))
        .bind(u256_to_decimal(total_supply))
        .bind(exit_fee_bps)
        .bind(u256_to_decimal(tvl_cap))
        .bind(paused)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    pub async fn insert_wallet_position(
        &self,
        chain_id: i64,
        contract: [u8; 20],
        owner: [u8; 20],
        block_number: i64,
        shares: U256,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO wallet_positions (chain_id, contract, owner, block_number, shares) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (chain_id, contract, owner, block_number) DO NOTHING",
        )
        .bind(chain_id)
        .bind(&contract[..])
        .bind(&owner[..])
        .bind(block_number)
        .bind(u256_to_decimal(shares))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Idempotent insert of a vault registration row sourced from a
    /// `VaultRegistered` event.  Uses `ON CONFLICT DO NOTHING` so
    /// re-indexing the same registration block is a no-op.
    ///
    /// `status` is the small integer encoding of `VaultStatus`:
    /// 0 = Active, 1 = Paused, 2 = Retired.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_vault(
        &self,
        chain_id: i64,
        vault_address: [u8; 20],
        name: &str,
        risk_label: &str,
        deposit_cap: U256,
        status: i16,
        registered_at: i64,
        registered_block: i64,
        registered_tx: [u8; 32],
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO vaults \
             (chain_id, vault_address, name, risk_label, deposit_cap, status, \
              registered_at, registered_block, registered_tx) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (chain_id, vault_address) DO NOTHING",
        )
        .bind(chain_id)
        .bind(&vault_address[..])
        .bind(name)
        .bind(risk_label)
        .bind(u256_to_decimal(deposit_cap))
        .bind(status)
        .bind(registered_at)
        .bind(registered_block)
        .bind(&registered_tx[..])
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Atomically update the `status` and `status_changed_at` columns of
    /// a previously-registered vault from a `VaultStatusChanged` event.
    ///
    /// A no-op if the vault address is unknown (forward-safety: the
    /// indexer may not have seen the `VaultRegistered` event yet).
    pub async fn update_vault_status(
        &self,
        chain_id: i64,
        vault_address: [u8; 20],
        new_status: i16,
        changed_at: i64,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "UPDATE vaults \
             SET status = $3, status_changed_at = $4, indexed_at = now() \
             WHERE chain_id = $1 AND vault_address = $2",
        )
        .bind(chain_id)
        .bind(&vault_address[..])
        .bind(new_status)
        .bind(changed_at)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Idempotent insert of a governance proposal row from a `ProposalCreated`
    /// event.  Uses `ON CONFLICT DO NOTHING` so re-indexing is a no-op.
    ///
    /// `status` is initialised to 0 (open); it is updated by subsequent
    /// `ProposalExecuted` events via [`Db::execute_proposal`].
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_proposal(
        &self,
        chain_id: i64,
        proposal_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        proposer: [u8; 20],
        description: &str,
        created_at: i64,
        deadline_block: i64,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO governance_proposals \
             (chain_id, proposal_id, block_number, log_index, tx_hash, proposer, description, created_at, deadline_block) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (chain_id, proposal_id) DO NOTHING",
        )
        .bind(chain_id)
        .bind(proposal_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&proposer[..])
        .bind(description)
        .bind(created_at)
        .bind(deadline_block)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Idempotent insert of a per-voter vote row from a `VoteCast` event.
    /// Uses `ON CONFLICT DO NOTHING` (one vote per voter per proposal).
    ///
    /// Also increments the running `votes_for` or `votes_against` counter
    /// on the parent `governance_proposals` row — but only when the vote row
    /// is new (rows_affected == 1).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_vote(
        &self,
        chain_id: i64,
        proposal_id: i64,
        voter: [u8; 20],
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        support: bool,
        weight: U256,
    ) -> Result<u64, DbError> {
        let mut tx = self.pool.begin().await?;
        let r = sqlx::query(
            "INSERT INTO governance_votes \
             (chain_id, proposal_id, voter, block_number, log_index, tx_hash, support, weight) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (chain_id, proposal_id, voter) DO NOTHING",
        )
        .bind(chain_id)
        .bind(proposal_id)
        .bind(&voter[..])
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(support)
        .bind(u256_to_decimal(weight))
        .execute(&mut *tx)
        .await?;

        if r.rows_affected() == 1 {
            // Update running tally on the proposal.
            let col = if support {
                "votes_for"
            } else {
                "votes_against"
            };
            let q = format!(
                "UPDATE governance_proposals SET {} = {} + 1 \
                 WHERE chain_id = $1 AND proposal_id = $2",
                col, col
            );
            sqlx::query(&q)
                .bind(chain_id)
                .bind(proposal_id)
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        Ok(r.rows_affected())
    }

    /// Mark a proposal as executed (status = 2) from a `ProposalExecuted`
    /// event.  A no-op if the proposal is unknown or already executed.
    pub async fn execute_proposal(
        &self,
        chain_id: i64,
        proposal_id: i64,
        executed_block: i64,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "UPDATE governance_proposals \
             SET status = 2, executed_block = $3, indexed_at = now() \
             WHERE chain_id = $1 AND proposal_id = $2 AND status < 2",
        )
        .bind(chain_id)
        .bind(proposal_id)
        .bind(executed_block)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Idempotent insert of a `WeightsApplied` snapshot row.
    /// `vault_addresses` and `bps_values` are parallel arrays.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_router_weight_snapshot(
        &self,
        chain_id: i64,
        router_address: [u8; 20],
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        vault_addresses: Vec<[u8; 20]>,
        bps_values: Vec<i64>,
    ) -> Result<u64, DbError> {
        // Encode each vault address as a Postgres BYTEA literal so we can
        // pass the whole array via a single placeholder.
        let vault_bytes: Vec<Vec<u8>> = vault_addresses.into_iter().map(|a| a.to_vec()).collect();
        let r = sqlx::query(
            "INSERT INTO router_weight_snapshots \
             (chain_id, router_address, block_number, log_index, tx_hash, vault_addresses, bps_values) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (chain_id, router_address, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(&router_address[..])
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&vault_bytes)
        .bind(&bps_values)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Insert a row into `account_history_events` (issue #654).
    ///
    /// One row per source log, keyed by `(chain_id, block_number, log_index)`.
    /// `ON CONFLICT DO NOTHING` keeps re-indexing idempotent.
    ///
    /// `kind` must be one of: `"deposit"`, `"withdrawal"`, `"fee_charged"`,
    /// `"policy_change"`, `"governance_vote"`.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_history_event(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        account: [u8; 20],
        kind: &str,
        vault: Option<[u8; 20]>,
        agent: Option<[u8; 20]>,
        amount: Option<U256>,
    ) -> Result<u64, DbError> {
        let vault_bytes: Option<&[u8]> = vault.as_ref().map(|a| &a[..]);
        let agent_bytes: Option<&[u8]> = agent.as_ref().map(|a| &a[..]);
        let r = sqlx::query(
            "INSERT INTO account_history_events \
             (chain_id, block_number, log_index, tx_hash, account, kind, vault, agent, amount) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&account[..])
        .bind(kind)
        .bind(vault_bytes)
        .bind(agent_bytes)
        .bind(amount.map(u256_to_decimal))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Open a new `indexer_runs` row, return the surrogate `run_id`.
    pub async fn start_run(&self, chain_id: i64, from_block: i64) -> Result<i64, DbError> {
        let row: (i64,) = sqlx::query_as(
            "INSERT INTO indexer_runs (chain_id, from_block) VALUES ($1, $2) RETURNING run_id",
        )
        .bind(chain_id)
        .bind(from_block)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0)
    }

    /// Close a run. `error` is `Some(...)` on failure, `None` on success.
    pub async fn finish_run(
        &self,
        run_id: i64,
        to_block: Option<i64>,
        last_indexed_block: Option<i64>,
        reorg_count: i32,
        rows_inserted: i64,
        error: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "UPDATE indexer_runs SET finished_at = now(), to_block = $2, last_indexed_block = $3, reorg_count = $4, rows_inserted = $5, error = $6 \
             WHERE run_id = $1",
        )
        .bind(run_id)
        .bind(to_block)
        .bind(last_indexed_block)
        .bind(reorg_count)
        .bind(rows_inserted)
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Highest `last_indexed_block` written by any successful run for
    /// this chain.
    pub async fn last_indexed_block(&self, chain_id: i64) -> Result<Option<i64>, DbError> {
        let row: Option<(Option<i64>,)> = sqlx::query_as(
            "SELECT MAX(last_indexed_block) FROM indexer_runs WHERE chain_id = $1 AND error IS NULL",
        )
        .bind(chain_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|(v,)| v))
    }

    /// Most recent run (success or failure) for ops tooling.
    pub async fn latest_run(&self, chain_id: i64) -> Result<Option<RunRow>, DbError> {
        let row: Option<RunRow> = sqlx::query_as(
            "SELECT run_id, chain_id, started_at, finished_at, from_block, to_block, last_indexed_block, reorg_count, rows_inserted, error \
             FROM indexer_runs WHERE chain_id = $1 ORDER BY run_id DESC LIMIT 1",
        )
        .bind(chain_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// Insert a row into `adapter_allocations` from a `VaultAllocated`,
    /// `VaultPulled`, or `VaultRebalanced` event.
    /// Uses `ON CONFLICT DO NOTHING` for idempotency (issue #57 AC).
    ///
    /// `adapter` and `adapter_index` may be `None` for `Rebalanced` events
    /// (which carry only a `totalMoved` amount).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_adapter_allocation(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        vault: [u8; 20],
        adapter: Option<[u8; 20]>,
        adapter_index: Option<i64>,
        amount: U256,
        event_kind: &str,
    ) -> Result<u64, DbError> {
        let adapter_bytes: Option<&[u8]> = adapter.as_ref().map(|a| &a[..]);
        let r = sqlx::query(
            "INSERT INTO adapter_allocations \
             (chain_id, block_number, log_index, tx_hash, vault, adapter, adapter_index, amount, event_kind) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&vault[..])
        .bind(adapter_bytes)
        .bind(adapter_index)
        .bind(u256_to_decimal(amount))
        .bind(event_kind)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Insert a row into `vault_fee_events` from an `ExitFeeCharged` event.
    /// Uses `ON CONFLICT DO NOTHING` for idempotency (issue #57 AC).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_vault_fee_event(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        vault: [u8; 20],
        owner: [u8; 20],
        receiver: [u8; 20],
        gross_assets: U256,
        fee_amount: U256,
        net_assets: U256,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO vault_fee_events \
             (chain_id, block_number, log_index, tx_hash, vault, owner, receiver, \
              gross_assets, fee_amount, net_assets) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&vault[..])
        .bind(&owner[..])
        .bind(&receiver[..])
        .bind(u256_to_decimal(gross_assets))
        .bind(u256_to_decimal(fee_amount))
        .bind(u256_to_decimal(net_assets))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Insert a row into `vault_transfer_events` from an ERC-4626
    /// `Deposit` or `Withdraw` event emitted by a vault contract.
    /// Uses `ON CONFLICT DO NOTHING` for idempotency (issue #57 AC).
    ///
    /// `direction` must be `"deposit"` or `"withdrawal"`.
    /// `owner_or_receiver` is the `owner` field for Deposit events and
    /// the `receiver` field for Withdraw events.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_vault_transfer_event(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        vault: [u8; 20],
        direction: &str,
        caller: [u8; 20],
        owner_or_receiver: [u8; 20],
        assets: U256,
        shares: U256,
    ) -> Result<u64, DbError> {
        let r = sqlx::query(
            "INSERT INTO vault_transfer_events \
             (chain_id, block_number, log_index, tx_hash, vault, direction, \
              caller, owner_or_receiver, assets, shares) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (chain_id, block_number, log_index) DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx_hash[..])
        .bind(&vault[..])
        .bind(direction)
        .bind(&caller[..])
        .bind(&owner_or_receiver[..])
        .bind(u256_to_decimal(assets))
        .bind(u256_to_decimal(shares))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Row count for any of the nine §11 tables.
    ///
    /// Accepts a [`CountTable`] enum value instead of a raw `&str` so
    /// no caller — current or future — can accidentally pass a
    /// user-controlled string into the dynamic `FORMAT` statement
    /// (issue #165).  `sqlx` does not support placeholder-binding for
    /// identifiers, so the `format!()` is unavoidable; the enum
    /// closes the injection surface at the type level.
    pub async fn count(&self, table: CountTable) -> Result<i64, DbError> {
        let q = format!("SELECT COUNT(*)::BIGINT FROM {}", table.as_str());
        let row: (i64,) = sqlx::query_as(&q).fetch_one(&self.pool).await?;
        Ok(row.0)
    }

    // -----------------------------------------------------------------------
    // Dev-scout stubs — issue #703
    // -----------------------------------------------------------------------
    // The function signatures below are the integration points for the four
    // data-layer issues that extend this service.  Each stub is annotated
    // with the implementing issue number, the migration file that creates its
    // target table, and the query pattern it must execute.
    //
    // All stubs compile, panic at runtime if called, and will be replaced by
    // real implementations in their respective feature branches.
    // -----------------------------------------------------------------------

    // NOTE: The dev-scout (#703) provided #654 stubs for
    // `insert_account_history_event` and `list_account_history` here. Issue #654
    // (this PR) implements account history for real: rows are written via
    // `insert_history_event` (above) and read by the explorer API's raw query in
    // `clients/explorer-api/src/routes.rs` (`get_account_history`). The scout
    // stubs and their placeholder `AccountHistoryRow` type were removed during
    // the rebase to avoid dead, schema-stale definitions.

    // NOTE: The dev-scout (#703) provided #675 stubs for
    // `insert_adapter_allocation`, `insert_vault_fee_event`, and
    // `insert_vault_transfer_event` here. Issue #675 implements them for real
    // earlier in this impl block; the stubs were removed during the rebase to
    // avoid duplicate definitions.

    /// Insert an agent policy row, including the `owner` and `window_usage_to_date`
    /// fields added by migration 0007 (issue #661).
    ///
    /// # Target issue: #661 — GET /v1/accounts/:address/policies endpoint
    ///
    /// The existing `insert_agent_policy` (above) does not accept `owner` or
    /// `window_usage_to_date`. Issue #661 adds those columns to the migration
    /// and updates the existing function signature — OR adds a new
    /// `insert_agent_policy_v2` — to pass them.
    ///
    /// This stub documents the *intended* extended signature so issue #661
    /// implementors have a concrete target.
    ///
    /// Migration: `0007_account_history_and_vault_detail_stubs.sql`
    ///   ALTER TABLE agent_policies ADD COLUMN IF NOT EXISTS owner BYTEA
    ///   ALTER TABLE agent_policies ADD COLUMN IF NOT EXISTS window_usage_to_date NUMERIC(78,0)
    ///
    /// Explorer API consumer:
    ///   `GET /v1/accounts/:address/policies` (new route, issue #661)
    ///   Query: SELECT … FROM agent_policies WHERE chain_id = $1 AND owner = $2
    ///           ORDER BY block_number DESC
    #[allow(dead_code, unused_variables, clippy::too_many_arguments)]
    pub async fn insert_agent_policy_with_owner(
        &self,
        chain_id: i64,
        block_number: i64,
        log_index: i32,
        tx_hash: [u8; 32],
        agent: [u8; 20],
        owner: [u8; 20],
        revoked: bool,
        valid_until: Option<i64>,
        max_per_payment: Option<U256>,
        max_per_window: Option<U256>,
        window_usage_to_date: Option<U256>,
        share_receiver: Option<[u8; 20]>,
    ) -> Result<u64, DbError> {
        // STUB — replaced by issue #661.
        // Real implementation inserts owner and window_usage_to_date into
        // the agent_policies row. Issue #661 may choose to:
        //   (a) add parameters to the existing insert_agent_policy, or
        //   (b) keep this as a separate function for the AgentAuthorized-with-owner path.
        // The ABI drift fix in issue #366 is a prerequisite: AgentAuthorized currently
        // drops `address indexed owner` (abi.rs drift map, § IGatewayEvents).
        unimplemented!("stub — implement in issue #661 (requires issue #366 ABI fix first)")
    }

    /// List all agent policies owned by a depositor address.
    ///
    /// # Target issue: #661 — GET /v1/accounts/:address/policies endpoint
    ///
    /// Query pattern (after issue #661's migration lands):
    ///   SELECT DISTINCT ON (chain_id, agent) * FROM agent_policies
    ///   WHERE chain_id = $1 AND owner = $2
    ///   ORDER BY chain_id, agent, block_number DESC
    ///
    /// Returns the latest policy state per agent for the given owner.
    #[allow(dead_code, unused_variables)]
    pub async fn list_policies_by_owner(
        &self,
        chain_id: i64,
        owner: [u8; 20],
    ) -> Result<Vec<AgentPolicyRow>, DbError> {
        // STUB — replaced by issue #661.
        unimplemented!("stub — implement in issue #661")
    }
}

/// Stub row type for `list_policies_by_owner` — issue #661.
///
/// The real implementation extends the existing `agent_policies` columns with
/// `owner` and `window_usage_to_date` from migration 0007.
#[derive(Debug, Clone)]
pub struct AgentPolicyRow {
    pub chain_id: i64,
    pub block_number: i64,
    pub log_index: i32,
    pub tx_hash: Vec<u8>,
    pub agent: Vec<u8>,
    pub owner: Option<Vec<u8>>,
    pub revoked: bool,
    pub valid_until: Option<i64>,
    pub max_per_payment: Option<BigDecimal>,
    pub max_per_window: Option<BigDecimal>,
    pub window_usage_to_date: Option<BigDecimal>,
    pub share_receiver: Option<Vec<u8>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RunRow {
    pub run_id: i64,
    pub chain_id: i64,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub from_block: i64,
    pub to_block: Option<i64>,
    pub last_indexed_block: Option<i64>,
    pub reorg_count: i32,
    pub rows_inserted: i64,
    pub error: Option<String>,
}

/// uint256 → exact decimal `NUMERIC(78, 0)` value. ADR §3.1.
fn u256_to_decimal(v: U256) -> BigDecimal {
    // U256::to_string is the decimal representation; BigDecimal parses
    // it losslessly.
    BigDecimal::from_str(&v.to_string()).expect("U256 always parses as BigDecimal")
}

#[cfg(test)]
mod count_guard_tests {
    //! Unit tests for the `CountTable` type-guard / allowlist (issue #695).
    //!
    //! These tests run without a live Postgres connection — they only exercise
    //! the pure-Rust allowlist logic.

    use super::{CountTable, DbError};

    /// Every known table name round-trips: `CountTable::try_from(name)` succeeds
    /// and `as_str()` returns the same name.
    #[test]
    fn known_tables_round_trip() {
        let known = [
            "chains",
            "contracts",
            "blocks",
            "transactions",
            "agent_deposits",
            "agent_policies",
            "vault_snapshots",
            "wallet_positions",
            "indexer_runs",
            "vaults",
            "governance_proposals",
            "governance_votes",
            "router_weight_snapshots",
            "router_deposit_legs",
        ];
        for name in known {
            let variant = CountTable::try_from(name)
                .unwrap_or_else(|_| panic!("known table {name:?} was rejected by allowlist"));
            assert_eq!(
                variant.as_str(),
                name,
                "as_str() for {name:?} must match the input"
            );
        }
    }

    /// An arbitrary / user-controlled string must be rejected with
    /// `DbError::UnknownTable` — it must never reach the SQL formatter.
    #[test]
    fn unknown_table_returns_err() {
        let adversarial = [
            "DROP TABLE chains",
            "chains; DROP TABLE blocks --",
            "wallets",
            "users",
            "pg_tables",
            "",
            " chains",
            "CHAINS",
        ];
        for s in adversarial {
            match CountTable::try_from(s) {
                Err(DbError::UnknownTable(rejected)) => {
                    assert_eq!(
                        rejected, s,
                        "error payload must echo back the rejected string"
                    );
                }
                Ok(v) => panic!("expected Err for {s:?} but got Ok({:?})", v.as_str()),
                Err(other) => panic!("unexpected error variant for {s:?}: {other}"),
            }
        }
    }
}
