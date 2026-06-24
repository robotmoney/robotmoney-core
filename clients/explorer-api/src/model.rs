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

#[derive(Debug, Serialize)]
pub struct Health {
    pub status: &'static str,
    pub last_indexed_block: Option<i64>,
    pub reorg_count: i32,
}

#[derive(Debug, Serialize)]
pub struct Contract {
    pub chain_id: i64,
    pub address: String,
    pub kind: String,
    pub label: Option<String>,
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
    pub deposit_cap: String,
    /// Most recent `total_assets` from vault_snapshots; null when no snapshot exists.
    pub total_assets: Option<String>,
    /// Most recent `exit_fee_bps` from vault_snapshots; null when no snapshot exists.
    pub exit_fee_bps: Option<i64>,
    pub indexed_at: DateTime<Utc>,
}

/// Response envelope for GET /v1/vaults (list).
#[derive(Debug, Serialize)]
pub struct VaultsResponse {
    pub vaults: Vec<Vault>,
    #[serde(flatten)]
    pub freshness: Freshness,
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
    pub deposit_cap: String,
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
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── Governance types (issue #307) ─────────────────────────────────────────

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

/// Summary of a governance proposal for the list endpoint.
#[derive(Debug, Serialize)]
pub struct ProposalSummary {
    pub chain_id: i64,
    pub proposal_id: i64,
    pub proposer: String,
    pub description: String,
    pub created_at: i64,
    pub deadline_block: i64,
    /// "open" | "passed" | "executed" | "expired"
    pub status: &'static str,
    pub votes_for: i64,
    pub votes_against: i64,
    pub block_number: i64,
    pub indexed_at: chrono::DateTime<chrono::Utc>,
}

/// Response for GET /v1/governance/proposals.
#[derive(Debug, Serialize)]
pub struct ProposalsResponse {
    pub proposals: Vec<ProposalSummary>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// Per-voter vote entry for the detail endpoint.
#[derive(Debug, Serialize)]
pub struct VoteEntry {
    pub voter: String,
    /// true = For, false = Against.
    pub support: bool,
    pub weight: String,
    pub block_number: i64,
    pub tx_hash: String,
}

/// Detailed proposal for GET /v1/governance/proposals/:id.
#[derive(Debug, Serialize)]
pub struct ProposalDetail {
    pub chain_id: i64,
    pub proposal_id: i64,
    pub proposer: String,
    pub description: String,
    pub created_at: i64,
    pub deadline_block: i64,
    pub status: &'static str,
    pub votes_for: i64,
    pub votes_against: i64,
    pub executed_block: Option<i64>,
    pub block_number: i64,
    pub indexed_at: chrono::DateTime<chrono::Utc>,
    pub votes: Vec<VoteEntry>,
}

/// Response for GET /v1/governance/proposals/:id.
#[derive(Debug, Serialize)]
pub struct ProposalDetailResponse {
    pub proposal: ProposalDetail,
    #[serde(flatten)]
    pub freshness: Freshness,
}

/// Decode a governance proposal `status` smallint into a string label.
pub fn proposal_status_label(status: i16) -> &'static str {
    match status {
        0 => "open",
        1 => "passed",
        2 => "executed",
        _ => "expired",
    }
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
    /// per vault), as a decimal string.
    pub total_tvl: String,
    /// Count of distinct share_receiver addresses across all agent_deposits.
    pub unique_depositors: i64,
    /// Last 50 deposit events across all vaults, descending by block.
    pub activity_feed: Vec<ActivityEvent>,
    #[serde(flatten)]
    pub freshness: Freshness,
}

// ─── GET /v1/router/state ────────────────────────────────────────────────────

/// Response envelope for GET /v1/router/state.
#[derive(Debug, Serialize)]
pub struct RouterStateResponse {
    /// Most recent weight allocation (empty when no WeightsApplied ingested yet).
    pub current_weights: Vec<VaultWeight>,
    /// Full history of WeightsApplied events, ascending by block.
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
    /// USDC value of shares at the latest snapshot share price, decimal string.
    /// Computed as: shares * total_assets / total_supply.
    /// Null when no vault_snapshot exists for this vault.
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

// ─── GET /v1/accounts/:address/history ───────────────────────────────────────

/// Kinds of events that appear in the per-account history feed.
///
/// Architecture §5.4: "deposits, withdrawals, fee events, policy changes,
/// and governance votes."
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Deposit,
    Withdrawal,
    FeeCharged,
    PolicyChange,
    GovernanceVote,
}

impl EventKind {
    /// Parse the `kind` text column stored in `account_history_events`.
    pub fn from_db_kind(s: &str) -> Self {
        match s {
            "withdrawal" => Self::Withdrawal,
            "fee_charged" => Self::FeeCharged,
            "policy_change" => Self::PolicyChange,
            "governance_vote" => Self::GovernanceVote,
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
    /// `null` for policy_change and governance_vote events.
    pub vault: Option<String>,
    /// Agent address for deposit and policy_change events.
    /// `null` for withdrawal, fee_charged, and governance_vote events.
    pub agent: Option<String>,
    /// USDC amount for deposit, withdrawal, and fee_charged events.
    /// `null` for policy_change and governance_vote events.
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

/// Per-vault verified tilt aggregate for GET /v1/committee/tilts.
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
}
