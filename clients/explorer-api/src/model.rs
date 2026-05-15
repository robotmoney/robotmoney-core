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
