// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
// Wire types for HTTP responses.
//
// All `uint256` values are serialized as decimal strings (per
// docs/technical/explorer-schema-decisions.md §3.5: the API formats on
// the way out from `NUMERIC(78,0)`). Every response object that surfaces
// chain state carries `block_number` and `indexed_at` so consumers can
// distinguish indexed data from live chain reads (§11 acceptance).

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde::Serialize;

/// Standard freshness header attached to every state-bearing response.
#[derive(Debug, Serialize, Clone)]
pub struct Freshness {
    pub block_number: i64,
    pub indexed_at: DateTime<Utc>,
}

/// Body of `GET /health`. The HTTP status is 200 whenever the API can read `indexer_runs`: readiness probes
/// gate on that. Whether the indexer is keeping up is in the body (DI-5).
#[derive(Debug, Serialize)]
pub struct Health {
    /// `"ok"`, or `"degraded"` when the newest finished indexer run failed (`last_run_error` is set)
    /// or the last good run is older than 300 s (`since_success_secs`): a stopped indexer writes no
    /// run, so only its age shows it.
    pub status: &'static str,
    /// Highest block a successful indexer run committed for this chain; null until one has.
    pub last_indexed_block: Option<i64>,
    /// Chain head the indexer last saw (`eth_blockNumber`); null until a tick has read it. A tick that read
    /// the head and then failed records it too, so this keeps moving while the indexer is wedged.
    pub chain_head_block: Option<i64>,
    /// `chain_head_block - last_indexed_block`: how many blocks the index trails the head the indexer last
    /// saw. About 5 when healthy (the indexer waits 5 confirmations); it grows while ticks fail. Null while
    /// either side is null.
    pub lag_blocks: Option<i64>,
    /// `indexer_runs.error` of the newest finished run for this chain; null when that run succeeded or no
    /// run has finished. A wedged indexer repeats the same error here every tick.
    pub last_run_error: Option<String>,
    /// Seconds since the newest successful indexer run with a cursor finished, on the database
    /// clock; null until there is one. A healthy indexer keeps it at a few seconds. Over 300 makes
    /// `status` `"degraded"` (security round 1).
    pub since_success_secs: Option<i64>,
    pub reorg_count: i32,
    /// The indexer's proxy upgrade backfill (`proxy_backfill_progress`, migration 0020; issue 1856); null
    /// before its first attempt. `refused` and `no_cursor` mean the upgrade history below the cursor is not
    /// indexed yet.
    pub proxy_backfill: Option<ProxyBackfillHealth>,
}

/// One chain's proxy upgrade backfill state.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ProxyBackfillHealth {
    /// `running`, `done`, `refused` or `no_cursor`.
    pub state: String,
    pub floor_block: Option<i64>,
    /// The cursor when the current pass began.
    pub target_block: Option<i64>,
    /// The first block the running pass has not scanned yet.
    pub next_block: Option<i64>,
    /// Why the pass was refused, and what to set.
    pub detail: Option<String>,
}

/// One Timelock, Safe or proxy-upgrade event (`admin_events`).
#[derive(Debug, Serialize)]
pub struct AdminEventEntry {
    pub chain_id: i64,
    pub block_number: i64,
    pub log_index: i32,
    pub tx_hash: String,
    /// The Timelock, Safe or proxied core contract that emitted it.
    pub contract: String,
    /// `timelock`, `safe`, or `proxy` (a core contract's `Upgraded` /
    /// `UpgradesFrozen`, issue 1810).
    pub contract_kind: String,
    pub event_name: String,
    /// Timelock operation id, or Safe transaction hash.
    pub op_id: Option<String>,
    /// The decoded event arguments.
    pub detail: serde_json::Value,
    pub indexed_at: DateTime<Utc>,
}

/// Response for GET /v1/governance/admin-events.
#[derive(Debug, Serialize)]
pub struct AdminEventsResponse {
    pub events: Vec<AdminEventEntry>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[derive(Debug, Serialize)]
pub struct Contract {
    pub chain_id: i64,
    pub address: String,
    pub kind: String,
    pub label: Option<String>,
    /// The implementation behind this ERC-1967 proxy, from its newest indexed
    /// `Upgraded` event; null when none was indexed (issue 1810).
    pub implementation: Option<String>,
    /// [`UpgradeState`] as a string: `frozen`, `upgradeable` or `unknown`.
    pub upgrade_state: &'static str,
    /// Block of the indexed `UpgradesFrozen` event; null unless frozen.
    pub frozen_at_block: Option<i64>,
}

/// Whether a contract can still be upgraded, as far as the indexed events
/// show (issue 1810). Disclosure only: signing clients read the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradeState {
    /// An `UpgradesFrozen` event was indexed. Permanent: there is no unfreeze.
    Frozen,
    /// An `Upgraded` event was indexed and no freeze. The upgrade timelock can
    /// still replace the implementation.
    Upgradeable,
    /// No upgrade event was indexed: a direct (non-proxy) deployment, a
    /// non-core contract, or a proxy deployed before the indexer's first block.
    Unknown,
}

impl UpgradeState {
    /// Derive the state from the indexed events: a freeze wins, any upgrade
    /// event without a freeze is upgradeable, nothing indexed is unknown.
    pub fn of(has_upgraded: bool, frozen_at_block: Option<i64>) -> Self {
        match (frozen_at_block, has_upgraded) {
            (Some(_), _) => UpgradeState::Frozen,
            (None, true) => UpgradeState::Upgradeable,
            (None, false) => UpgradeState::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpgradeState::Frozen => "frozen",
            UpgradeState::Upgradeable => "upgradeable",
            UpgradeState::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ContractsResponse {
    pub chain_id: i64,
    pub contracts: Vec<Contract>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[derive(Debug, Serialize)]
pub struct VaultSnapshot {
    pub chain_id: i64,
    pub contract: String,
    pub block_number: i64,
    pub total_assets: String,
    pub total_supply: String,
    pub indexed_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct VaultSnapshotsResponse {
    pub snapshots: Vec<VaultSnapshot>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[derive(Debug, Serialize)]
pub struct AgentPolicy {
    pub agent: String,
    pub authorized: bool,
    pub cap: Option<String>,
    pub block_number: i64,
}

#[derive(Debug, Serialize)]
pub struct AgentResponse {
    pub policy: Option<AgentPolicy>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[derive(Debug, Serialize)]
pub struct Deposit {
    pub chain_id: i64,
    pub block_number: i64,
    pub log_index: i32,
    pub tx_hash: String,
    pub payment_id: String,
    pub agent: String,
    /// `share_receiver` from the canonical `agent_deposits` row
    /// (issue #87 — the canonical indexer schema names this column
    /// `share_receiver`; there is no per-deposit `token` column).
    pub share_receiver: String,
    pub amount: String,
    pub indexed_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DepositsResponse {
    pub deposits: Vec<Deposit>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[derive(Debug, Serialize)]
pub struct DepositResponse {
    pub deposit: Deposit,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[derive(Debug, Serialize)]
pub struct Transaction {
    pub chain_id: i64,
    pub tx_hash: String,
    pub block_number: i64,
    pub from_address: String,
    pub to_address: Option<String>,
    pub status: i16,
    pub indexed_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct TransactionResponse {
    pub transaction: Transaction,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// `max(tvl_cap - total_assets, 0)`; `None` when either side is unknown. An unknown cap is never turned into a
/// zero headroom (issue 1741).
pub fn headroom_of(
    tvl_cap: Option<&BigDecimal>,
    total_assets: Option<&BigDecimal>,
) -> Option<String> {
    let (cap, assets) = (tvl_cap?, total_assets?);
    let room = cap - assets;
    Some(if room.sign() == bigdecimal::num_bigint::Sign::Minus {
        "0".to_string()
    } else {
        dec_to_string(&room)
    })
}

/// The USDC a redeem of `shares` pays, priced from the vault's newest snapshot:
/// `floor(shares * preview_redeem_total / total_supply)`, where `preview_redeem_total` is the
/// vault's `previewRedeem(totalSupply())` at that block (migration 0024).
///
/// `previewRedeem` is linear in the share count up to rounding, so this is the vault's own
/// `previewRedeem(shares)` to within one unit: net of the exit fee and, on a BasketVault, of the
/// `maxSlippageBps` floor. The gross `shares * total_assets / total_supply` (`convertToAssets`)
/// overstated rmAGENT positions by about 3% against what a redeem paid (core 1795, QA plan X8).
///
/// `None` when the snapshot has no exit value (a row older than migration 0024 or a failed read)
/// or a zero supply: the value is unknown, and the gross value is never served in its place.
pub fn position_exit_value(
    shares: &BigDecimal,
    preview_redeem_total: Option<&BigDecimal>,
    total_supply: Option<&BigDecimal>,
) -> Option<BigDecimal> {
    let (preview, supply) = (preview_redeem_total?, total_supply?);
    let (supply, _) = supply.with_scale(0).into_bigint_and_exponent();
    if supply.sign() != bigdecimal::num_bigint::Sign::Plus {
        return None;
    }
    let (shares, _) = shares.with_scale(0).into_bigint_and_exponent();
    let (preview, _) = preview.with_scale(0).into_bigint_and_exponent();
    // Integer division: exact floor for the non-negative NUMERIC(78,0) inputs.
    Some(BigDecimal::from(shares * preview / supply))
}

/// Format a `NUMERIC(78,0)` `BigDecimal` as a decimal string suitable for
/// JSON `uint256` fields.
pub fn dec_to_string(v: &BigDecimal) -> String {
    // Strip trailing fractional zeros — NUMERIC(78,0) rows always have
    // scale 0, but be defensive.
    v.with_scale(0).to_string()
}

/// A registered vault from the `vaults` table, optionally enriched with
/// the latest TVL data from `vault_snapshots`.
#[derive(Debug, Serialize)]
pub struct Vault {
    pub chain_id: i64,
    pub address: String,
    pub name: String,
    pub risk_label: String,
    /// 0 = Active, 1 = Paused, 2 = Retired (matches on-chain VaultStatus enum).
    pub status: i16,
    /// `tvlCap()` of the vault as of its most recent snapshot, in asset base units; null when no snapshot
    /// exists or the read failed. Null is "unknown" and a client must never show it as 0 (issue 1741).
    pub tvl_cap: Option<String>,
    /// `perDepositCap()` as of the most recent snapshot; null when unknown, like `tvl_cap`.
    pub per_deposit_cap: Option<String>,
    /// `max(tvl_cap - total_assets, 0)` from the same snapshot; null when either is unknown.
    pub headroom: Option<String>,
    /// Block of the snapshot `total_assets`, the caps and `deposits_paused` come from; null when none exists.
    /// It trails `block_number` by up to the snapshot heartbeat, so it is NOT the index block.
    pub snapshot_block: Option<i64>,
    /// Most recent `total_assets` from vault_snapshots; null when no snapshot exists.
    pub total_assets: Option<String>,
    /// Most recent `exit_fee_bps` from vault_snapshots; null when no snapshot exists.
    pub exit_fee_bps: Option<i64>,
    /// `depositsPaused()` of the vault as of its most recent snapshot; null when no snapshot exists, which
    /// a client must read as "unknown", never as "open". The registry `status` above is lifecycle state and
    /// does not follow a `pauseDeposits()` call on the vault.
    pub deposits_paused: Option<bool>,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/vaults (list).
#[derive(Debug, Serialize)]
pub struct VaultsResponse {
    pub vaults: Vec<Vault>,
    #[serde(flatten)]
    pub freshness: Freshness,
    /// Chain head the indexer last saw; null until a tick has read it.
    pub chain_head_block: Option<i64>,
}

/// Historical TVL data point from `vault_snapshots`.
#[derive(Debug, Serialize)]
pub struct VaultTvlPoint {
    pub block_number: i64,
    pub total_assets: String,
    pub total_supply: String,
    pub indexed_at: DateTime<Utc>,
}

/// One adapter allocation/pull/rebalance event from `adapter_allocations`.
/// Canonical: docs/architecture.md §5.4 — vault detail adapter allocation history.
#[derive(Debug, Serialize)]
pub struct AdapterAllocationEntry {
    pub block_number: i64,
    pub tx_hash: String,
    pub adapter: Option<String>,
    pub adapter_index: Option<i64>,
    pub amount: String,
    /// "allocated" | "pulled" | "rebalanced"
    pub event_kind: String,
    pub indexed_at: DateTime<Utc>,
}

/// One deposit or withdrawal event from `vault_transfer_events`.
/// Canonical: docs/architecture.md §5.4 — vault detail deposit/withdrawal log.
#[derive(Debug, Serialize)]
pub struct VaultTransferEntry {
    pub block_number: i64,
    pub tx_hash: String,
    /// "deposit" | "withdrawal"
    pub direction: String,
    pub caller: String,
    /// owner (for deposits) or receiver (for withdrawals)
    pub owner_or_receiver: String,
    pub assets: String,
    pub shares: String,
    pub indexed_at: DateTime<Utc>,
}

/// One exit-fee event from `vault_fee_events`.
/// Canonical: docs/architecture.md §5.4 — vault detail fee collection history.
#[derive(Debug, Serialize)]
pub struct VaultFeeEntry {
    pub block_number: i64,
    pub tx_hash: String,
    pub owner: String,
    pub receiver: String,
    pub gross_assets: String,
    pub fee_amount: String,
    pub net_assets: String,
    pub indexed_at: DateTime<Utc>,
}

/// Detailed single-vault response for GET /v1/vaults/:address.
#[derive(Debug, Serialize)]
pub struct VaultDetail {
    pub chain_id: i64,
    pub address: String,
    pub name: String,
    pub risk_label: String,
    /// 0 = Active, 1 = Paused, 2 = Retired.
    pub status: i16,
    /// `tvlCap()` as of the latest snapshot; null when unknown (issue 1741). See [`Vault::tvl_cap`].
    pub tvl_cap: Option<String>,
    /// `perDepositCap()` as of the latest snapshot; null when unknown.
    pub per_deposit_cap: Option<String>,
    /// `max(tvl_cap - total_assets, 0)` from the latest snapshot; null when either is unknown.
    pub headroom: Option<String>,
    /// Block of the latest snapshot; null when there is none. NOT the index block (see `block_number`).
    pub snapshot_block: Option<i64>,
    /// `depositsPaused()` as of the latest snapshot; null when there is none (read as unknown, never open).
    pub deposits_paused: Option<bool>,
    /// TVL history from vault_snapshots (up to 500 rows, ascending by block).
    pub tvl_history: Vec<VaultTvlPoint>,
    /// Adapter allocation history from adapter_allocations (up to 500 rows, ascending by block).
    pub adapter_allocation_history: Vec<AdapterAllocationEntry>,
    /// Deposit/withdrawal event log from vault_transfer_events (up to 500 rows, ascending by block).
    pub deposit_withdrawal_log: Vec<VaultTransferEntry>,
    /// Fee collection history from vault_fee_events (up to 500 rows, ascending by block).
    pub fee_history: Vec<VaultFeeEntry>,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/vaults/:address.
#[derive(Debug, Serialize)]
pub struct VaultDetailResponse {
    pub vault: VaultDetail,
    /// `block_number` is the index block: the last block the indexer committed (the same value as `/health`
    /// `last_indexed_block`), NOT the block of the latest vault snapshot (`vault.snapshot_block`). It used to be
    /// the snapshot block, which made a healthy indexer look thousands of blocks behind (issue 1741).
    #[serde(flatten)]
    pub freshness: Freshness,
    /// Chain head the indexer last saw; null until a tick has read it.
    pub chain_head_block: Option<i64>,
}

// ─── Router weight types (issue #307) ──────────────────────────────────────

/// Single vault weight entry in a weight snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct VaultWeight {
    /// Vault address in 0x-prefixed lower-case hex.
    pub vault: String,
    /// Weight in basis points (sum across all vaults = 10 000).
    pub bps: i64,
}

/// One entry in the weight change history.
#[derive(Debug, Serialize)]
pub struct WeightHistoryEntry {
    pub block_number: i64,
    pub tx_hash: String,
    pub weights: Vec<VaultWeight>,
    pub indexed_at: chrono::DateTime<chrono::Utc>,
}

/// Response for GET /v1/router/weights.
#[derive(Debug, Serialize)]
pub struct RouterWeightsResponse {
    /// Current weight vector (most recent WeightsSet snapshot).
    pub current_weights: Vec<VaultWeight>,
    /// Historical weight changes, ascending by block.
    pub history: Vec<WeightHistoryEntry>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── GET /v1/stats ──────────────────────────────────────────────────────────

/// A single entry in the global activity feed (last 50 events across all vaults).
#[derive(Debug, Serialize)]
pub struct ActivityEvent {
    pub chain_id: i64,
    pub block_number: i64,
    pub log_index: i32,
    pub tx_hash: String,
    /// Vault contract that received the deposit.
    pub vault: String,
    pub agent: String,
    pub share_receiver: String,
    pub amount: String,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/stats.
#[derive(Debug, Serialize)]
pub struct StatsResponse {
    /// Aggregate total_assets across all active vaults (sum of latest snapshot
    /// per vault, Retired vaults left out), as a decimal string.
    pub total_tvl: String,
    /// Count of distinct share_receiver addresses across all agent_deposits.
    pub unique_depositors: i64,
    /// Last 50 deposit events across all vaults, descending by block.
    pub activity_feed: Vec<ActivityEvent>,
    #[serde(flatten)]
    pub freshness: Freshness,
    /// Chain head the indexer last saw; null until a tick has read it.
    pub chain_head_block: Option<i64>,
}

// ─── GET /v1/router/state ────────────────────────────────────────────────────

/// Response envelope for GET /v1/router/state.
#[derive(Debug, Serialize)]
pub struct RouterStateResponse {
    /// Most recent weight allocation (empty when no WeightsSet ingested yet).
    pub current_weights: Vec<VaultWeight>,
    /// Full history of WeightsSet / DefaultWeightsSet events, ascending by block.
    pub history: Vec<WeightHistoryEntry>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── GET /v1/accounts/:address/positions ─────────────────────────────────────

/// Per-vault receipt balance and computed USDC value for one account.
#[derive(Debug, Serialize)]
pub struct VaultPosition {
    /// ERC-4626 vault contract address.
    pub vault: String,
    /// Most recent indexed share balance (receipt token units), decimal string.
    pub shares: String,
    /// USDC a redeem of `shares` pays at the latest snapshot, decimal string: the vault's
    /// `previewRedeem` semantics, net of the exit fee and (BasketVault) the slippage floor.
    /// Computed as: shares * previewRedeem(totalSupply) / total_supply ([`position_exit_value`],
    /// core 1795). Null when no vault_snapshot exists for this vault, or its newest snapshot has
    /// no `previewRedeem` reading yet.
    pub usdc_value: Option<String>,
    /// Block of the most recent wallet_positions row for this vault.
    pub block_number: i64,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/accounts/:address/positions.
#[derive(Debug, Serialize)]
pub struct AccountPositionsResponse {
    pub address: String,
    pub positions: Vec<VaultPosition>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── GET /v1/accounts/:address/exclusion-claims ──────────────────────────────

/// One holder's claim on one exclusion record (QA plan X7, core issue 1820).
///
/// When a `RobotMoneyVault` excludes a funded adapter, its `ExclusionLedger`
/// opens a record with a snapshot of the vault's shares. What is later
/// recovered from the adapter belongs pro rata to the holders at the snapshot,
/// including holders who have since exited. All amounts are decimal strings in
/// base units: shares for `snapshot_supply` and `balance_at`, the vault asset
/// (USDC, 6 decimals) for the `*_usdc` fields.
#[derive(Debug, Serialize)]
pub struct ExclusionClaim {
    /// The vault that excluded the adapter.
    pub vault: String,
    /// The vault's `ExclusionLedger`, which holds the recovered USDC and pays
    /// claims (`claim(exclusion_id, holder)`).
    pub exclusion_ledger: String,
    /// Record id inside that ledger (1-based).
    pub exclusion_id: i64,
    /// The excluded adapter and its registry index in the vault.
    pub adapter: String,
    pub adapter_index: i64,
    /// Block of the snapshot.
    pub opened_block: i64,
    /// Vault share supply at the snapshot.
    pub snapshot_supply: String,
    /// This holder's vault shares at the snapshot.
    pub balance_at: String,
    /// USDC credited to the record so far.
    pub recovered_usdc: String,
    /// USDC this holder has been paid from the record so far.
    pub claimed_usdc: String,
    /// USDC this holder can claim now:
    /// `floor(recovered_usdc * balance_at / snapshot_supply) - claimed_usdc`, never below 0.
    pub claimable_usdc: String,
    /// True once the record takes no more recovery. It stays claimable.
    pub finalized: bool,
    /// Why it closed: `restored`, `removed` or `force_removed`; null while open.
    pub finalize_reason: Option<String>,
}

/// Response envelope for GET /v1/accounts/:address/exclusion-claims.
#[derive(Debug, Serialize)]
pub struct AccountExclusionClaimsResponse {
    pub address: String,
    /// One entry per record this address held shares at, open or closed.
    pub claims: Vec<ExclusionClaim>,
    /// Sum of `claimable_usdc` over `claims`.
    pub total_claimable_usdc: String,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// Wire name of `ExclusionLedger.FinalizeReason`.
pub fn exclusion_finalize_reason_label(reason: i16) -> &'static str {
    match reason {
        0 => "restored",
        1 => "removed",
        2 => "force_removed",
        _ => "unknown",
    }
}

// ─── GET /v1/accounts/:address/history ───────────────────────────────────────

/// Kinds of events that appear in the per-account history feed.
///
/// Architecture §5.4: deposits, withdrawals, fee events and policy changes.
/// There is no vote kind: RouterGovernance voting was deleted (issue 1698)
/// and migration 0025 removed the old vote history rows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Deposit,
    Withdrawal,
    FeeCharged,
    PolicyChange,
}

impl EventKind {
    /// Parse the `kind` text column stored in `account_history_events`.
    pub fn from_db_kind(s: &str) -> Self {
        match s {
            "withdrawal" => Self::Withdrawal,
            "fee_charged" => Self::FeeCharged,
            "policy_change" => Self::PolicyChange,
            _ => Self::Deposit,
        }
    }
}

/// A single entry in the per-account chronological history.
#[derive(Debug, Serialize)]
pub struct AccountHistoryEntry {
    /// Discriminant for the event type (see `EventKind`).
    pub kind: EventKind,
    pub chain_id: i64,
    pub block_number: i64,
    pub log_index: i32,
    pub tx_hash: String,
    /// Vault contract address for deposit/withdrawal/fee events.
    /// `null` for policy_change events.
    pub vault: Option<String>,
    /// Agent address for deposit and policy_change events.
    /// `null` for withdrawal and fee_charged events.
    pub agent: Option<String>,
    /// USDC amount for deposit, withdrawal, and fee_charged events.
    /// `null` for policy_change events.
    pub amount: Option<String>,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/accounts/:address/history.
#[derive(Debug, Serialize)]
pub struct AccountHistoryResponse {
    pub address: String,
    pub events: Vec<AccountHistoryEntry>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── GET /v1/accounts/:address/policies ──────────────────────────────────────

/// A single agent-policy entry as returned by GET /v1/accounts/:address/policies.
///
/// Represents the latest-state snapshot for one agent authorized by `owner`.
/// `revoked = true` rows are tombstones; consumers should filter them when
/// showing only active authorizations.
#[derive(Debug, Serialize)]
pub struct AccountPolicy {
    /// Agent address that was authorized.
    pub agent: String,
    /// Owner (depositor) address that called gateway.authorizeAgent.
    pub owner: String,
    /// True when the latest event for this agent is an AgentRevoked tombstone.
    pub revoked: bool,
    /// Block timestamp after which the authorization expires (Unix seconds).
    /// Null for revoked tombstone rows.
    pub valid_until: Option<i64>,
    /// Maximum USDC amount per single payment, decimal string.
    pub max_per_payment: Option<String>,
    /// Maximum USDC amount per window period, decimal string.
    pub max_per_window: Option<String>,
    /// Running total consumed within the current window, decimal string.
    /// Null when not tracked by the indexer.
    pub window_usage_to_date: Option<String>,
    /// Share-receiver address for this authorization.
    pub share_receiver: Option<String>,
    /// Transaction hash of the AgentAuthorized / AgentRevoked event.
    pub tx_hash: String,
}

/// Response envelope for GET /v1/accounts/:address/policies.
#[derive(Debug, Serialize)]
pub struct AccountPoliciesResponse {
    /// Queried owner address.
    pub address: String,
    /// One entry per agent authorized by this owner (latest state per agent).
    pub policies: Vec<AccountPolicy>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── Investment Committee (IC) models ────────────────────────────────────────
// Canonical: docs/architecture.md §5.4 — issue #1053.

/// A registered IC committee agent.
#[derive(Debug, Serialize)]
pub struct CommitteeAgent {
    pub address: String,
    pub agent_id: String,
    pub active: bool,
    pub registered_at: i64,
    pub revoked_at: Option<i64>,
}

/// Response envelope for GET /v1/committee/agents.
#[derive(Debug, Serialize)]
pub struct CommitteeAgentsResponse {
    pub agents: Vec<CommitteeAgent>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// A single verified vote in an agent's track record.
#[derive(Debug, Serialize)]
pub struct CommitteeVoteEntry {
    /// The InvestmentCommitteePolicy deployment that emitted `VoteSubmitted`,
    /// 0x-prefixed hex. `vote_id` is an index into one deployment's votes, so
    /// a redeployed policy reuses every id, and only this field tells two such
    /// votes apart (DI-10, migration 0021).
    pub contract_address: String,
    pub vote_id: i64,
    pub vault: String,
    pub stance: i16,
    pub target_weight_bps: i16,
    pub confidence: i16,
    pub rationale_uri: String,
    pub verified: bool,
    pub block_number: i64,
    pub timestamp_secs: i64,
}

/// Response envelope for GET /v1/committee/agents/:address/track-record.
#[derive(Debug, Serialize)]
pub struct CommitteeTrackRecordResponse {
    pub agent: String,
    pub votes: Vec<CommitteeVoteEntry>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// Per-vault tilt aggregate for GET /v1/committee/tilts. `vote_count` is the
/// number of members counted: one latest, verified, fresh signal per active
/// member (issue #1790), never the raw number of votes.
#[derive(Debug, Serialize)]
pub struct CommitteeTilt {
    pub vault: String,
    pub avg_weight_bps: String,
    pub vote_count: i64,
}

/// Response envelope for GET /v1/committee/tilts.
#[derive(Debug, Serialize)]
pub struct CommitteeTiltsResponse {
    pub tilts: Vec<CommitteeTilt>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// A per-vault regime snapshot row.
#[derive(Debug, Serialize)]
pub struct RegimeSnapshot {
    pub vault: String,
    pub avg_weight_bps: String,
    pub vote_count: i32,
    pub block_number: i64,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/regime/feed.
#[derive(Debug, Serialize)]
pub struct RegimeFeedResponse {
    pub snapshots: Vec<RegimeSnapshot>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── Consensus recommendation receipt models ──────────────────────────────────────
// Canonical: docs/architecture.md §4.9 — issue #1247.
//
// One on-chain commitment per row. `verified` is DIGEST verification only:
// the indexer independently fetched `payload_uri` and recomputed
// keccak256(bytes) == `payload_digest`. It does NOT assert that each named
// analyst signed — those ed25519 signatures ride inside the payload and are
// verified off-chain (architecture §4.9.1 answer 1). Surfaces must label the
// payload's signature count as *off-chain analyst signatures*, never as
// on-chain approvals.

/// A single consensus recommendation receipt commitment.
#[derive(Debug, Serialize)]
pub struct ConsensusReceipt {
    /// The ConsensusRecommendationReceipt deployment that emitted
    /// `ReceiptRecorded`, 0x-prefixed hex.
    ///
    /// T20: `receipt_id` is `keccak256(domain || session_id || "\n" ||
    /// subject_id)` and is therefore byte-identical across every deployment of
    /// the contract. Without the emitting address the public surface cannot say
    /// WHICH contract a commitment belongs to, and devnet 918453 already carries
    /// two live deployments.
    pub contract_address: String,
    /// bytes32 receiptId, 0x-prefixed hex.
    pub receipt_id: String,
    /// uint256 append index from `ReceiptRecorded`.
    pub index: i64,
    /// Committee agent EOA that attested for the committee.
    pub submitter: String,
    /// bytes32 keccak256 of the receipt's canonical bytes, 0x-prefixed hex.
    pub payload_digest: String,
    /// Public route serving those exact bytes.
    pub payload_uri: String,
    /// uint64 block timestamp of `recordReceipt`.
    pub recorded_at: i64,
    pub block_number: i64,
    pub tx_hash: String,
    /// Digest verification state recomputed by the indexer — NOT a claim
    /// about the payload's embedded analyst signatures.
    pub verified: bool,
    /// Byte length of the verified payload; null while `verified` is false
    /// (a failed fetch, or a body that did not hash to the digest).
    pub payload_bytes: Option<i64>,
    /// Whether an admin (the timelock) has released the receipt. An
    /// unreleased receipt is still an immutable public record.
    pub released: bool,
    /// uint64 block timestamp of `releaseReceipt`, or null.
    pub released_at: Option<i64>,
}

/// Response envelope for GET /v1/consensus-receipts (protocol scope) and
/// GET /v1/accounts/:address/consensus-receipts (account scope).
#[derive(Debug, Serialize)]
pub struct ConsensusReceiptsResponse {
    pub receipts: Vec<ConsensusReceipt>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// Response envelope for GET /v1/consensus-receipts/:receipt_id.
#[derive(Debug, Serialize)]
pub struct ConsensusReceiptResponse {
    pub receipt: ConsensusReceipt,
    #[serde(flatten)]
    pub freshness: Freshness,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// Issue #1041 / #1038 root cause: the GET /v1/accounts/:address/positions
    /// vault-address field serializes as `vault`, NOT `vault_addr`. This pins
    /// the wire contract that docs/explorer-api.md documents so the two cannot
    /// drift, and so a future rename can't silently reintroduce the
    /// `PositionSelector` crash.
    #[test]
    fn vault_position_serializes_vault_key_not_vault_addr() {
        let pos = VaultPosition {
            vault: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            shares: "1000000000000000000".to_string(),
            usdc_value: Some("1010000000000000000".to_string()),
            block_number: 12_345_678,
            indexed_at: Utc.with_ymd_and_hms(2026, 6, 7, 0, 0, 0).unwrap(),
        };

        let v = serde_json::to_value(&pos).expect("VaultPosition must serialize");
        let obj = v
            .as_object()
            .expect("VaultPosition serializes to an object");

        assert!(
            obj.contains_key("vault"),
            "VaultPosition must serialize a `vault` key (the documented \
             explorer-api wire contract); got keys: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            !obj.contains_key("vault_addr"),
            "VaultPosition must NOT serialize a `vault_addr` key — that token \
             is the dapp's internal client field, never a wire field (#1038)."
        );
        assert_eq!(
            obj["vault"],
            serde_json::json!("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "the `vault` field must carry the ERC-4626 vault contract address"
        );
        // Remaining documented fields are present.
        for key in ["shares", "usdc_value", "block_number", "indexed_at"] {
            assert!(
                obj.contains_key(key),
                "VaultPosition must serialize the documented `{key}` field"
            );
        }
    }

    /// The `usdc_value` field is nullable when no vault_snapshot exists; the
    /// documented `string | null` contract must hold.
    #[test]
    fn vault_position_usdc_value_serializes_null_when_absent() {
        let pos = VaultPosition {
            vault: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            shares: "0".to_string(),
            usdc_value: None,
            block_number: 1,
            indexed_at: Utc.with_ymd_and_hms(2026, 6, 7, 0, 0, 0).unwrap(),
        };

        let v = serde_json::to_value(&pos).expect("VaultPosition must serialize");
        assert!(
            v["usdc_value"].is_null(),
            "usdc_value must serialize as JSON null when None"
        );
    }

    /// Core 1795 (QA plan X8): a position is priced at `previewRedeem`, what a redeem pays after
    /// exit costs, not at the gross `convertToAssets` share price. rmAGENT-like numbers: 1000 USDC of
    /// assets over 1000e18 shares, a 5% slippage floor, so `previewRedeem(totalSupply())` is 950 USDC.
    #[test]
    fn position_exit_value_is_preview_redeem_not_convert_to_assets() {
        let d = |s: &str| s.parse::<BigDecimal>().unwrap();
        let supply = d("1000000000000000000000");
        let preview_total = d("950000000");
        let shares = d("100000000000000000000"); // a tenth of the supply
        assert_eq!(
            position_exit_value(&shares, Some(&preview_total), Some(&supply))
                .map(|v| dec_to_string(&v)),
            Some("95000000".to_string()),
            "95 USDC, not the 100 USDC convertToAssets gives"
        );
        // Floor, like the vault's own rounding: 2 of 3 shares worth 10 in all is 6 (6.67), not 7.
        assert_eq!(
            position_exit_value(&d("2"), Some(&d("10")), Some(&d("3"))).map(|v| dec_to_string(&v)),
            Some("6".to_string())
        );
        // No exit value on the snapshot (older than migration 0024): unknown, never the gross value.
        assert_eq!(position_exit_value(&shares, None, Some(&supply)), None);
        // No snapshot, or a zero supply: unknown.
        assert_eq!(
            position_exit_value(&shares, Some(&preview_total), None),
            None
        );
        assert_eq!(
            position_exit_value(&shares, Some(&preview_total), Some(&d("0"))),
            None
        );
    }
}
