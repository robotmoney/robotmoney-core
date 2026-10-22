// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
// HTTP route table.
//
// Endpoints are exactly the §11 list plus the vault registry additions (issue #296),
// the router-weight and admin-event additions (issue #307), and the multi-vault protocol stats
// additions (issue #316):
//   GET /health
//   GET /v1/chains/:chain_id/contracts               (only the served chain, X7)
//   GET /v1/vault/snapshot/latest?contract=          (required, X7)
//   GET /v1/vault/snapshots?from_block=&to_block=
//   GET /v1/agents/:address
//   GET /v1/agents/:address/deposits
//   GET /v1/transactions/:tx_hash
//   GET /v1/deposits/:deposit_id
//   GET /v1/vaults
//   GET /v1/vaults/:address
//   GET /v1/router/weights
//   GET /v1/governance/admin-events
//   GET /v1/stats
//   GET /v1/router/state
//   GET /v1/accounts/:address/positions
//   GET /v1/accounts/:address/history
//   GET /v1/accounts/:address/policies
//   GET /v1/accounts/:address/exclusion-claims       (core 1820, QA plan X7)
//
// Consensus recommendation receipts (issue #1247, docs/architecture.md §4.9 / §5.0):
//   GET /v1/consensus-receipts                        (protocol scope, ?limit=)
//   GET /v1/consensus-receipts/:receipt_id            (protocol scope, one)
//   GET /v1/accounts/:address/consensus-receipts      (account scope, by submitter)
//
// Boundary (§11): only GET methods. Any other method on any path returns
// 405. Any /v1/sign* or /v1/authorize* path falls through to a global 404
// handler. The router-introspection test asserts no non-GET routes exist.
//
// Schema source: this crate reads the canonical schema owned by
// `services/explorer-indexer/migrations/0001_minimum_tables.sql`
// (issue #87). All address / hash columns are `BYTEA`; we hex-encode
// on the way out to keep the JSON wire format stable.
//
// Chain scoping (docs/technical/explorer-schema-decisions.md §4):
// explorer-api is a single-chain service. `AppState::chain_id` is set at
// startup from `EXPLORER_API_CHAIN_ID` and is the sole chain filter for
// every query. The four ambiguous reads — get_agent, list_agent_deposits,
// get_transaction, get_deposit — all bind `state.chain_id` so rows from
// another chain can never be returned, even when two chains share the same
// address or identifier.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::model::{
    dec_to_string, exclusion_finalize_reason_label, headroom_of, position_exit_value,
    AccountExclusionClaimsResponse, AccountHistoryEntry, AccountHistoryResponse,
    AccountPoliciesResponse, AccountPolicy, AccountPositionsResponse, ActivityEvent,
    AdapterAllocationEntry, AdminEventEntry, AdminEventsResponse, AgentPolicy,
    AgentRegistrationsResponse, AgentResponse, ConsensusReceipt, ConsensusReceiptResponse,
    ConsensusReceiptsResponse, Contract, ContractsResponse, Deposit, DepositResponse,
    DepositsResponse, EventKind, ExclusionClaim, Freshness, Health, ProxyBackfillHealth,
    RouterStateResponse, RouterWeightsResponse, StatsResponse, Transaction, TransactionResponse,
    UpgradeState, Vault, VaultDetail, VaultDetailResponse, VaultFeeEntry, VaultPosition,
    VaultSnapshot, VaultSnapshotsResponse, VaultTransferEntry, VaultTvlPoint, VaultWeight,
    VaultsResponse, WeightHistoryEntry,
};
use crate::state::AppState;

// Row-type aliases used by `query_as` calls. Postgres returns positional
// tuples; declaring them here keeps clippy happy (`type_complexity`) and
// makes the SELECT column lists self-documenting. BYTEA columns are
// returned as `Vec<u8>` and converted to hex strings on the way out.
type DepositRow = (
    i64,
    i64,
    i32,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
    BigDecimal,
    DateTime<Utc>,
    Option<String>,
);

/// SQL for the id of the registration an `agent_deposits` / `agent_policies` row belongs to, or NULL.
/// Deterministic: chain, gateway deployment and the position of the event that started the registration
/// (migration 0031). The id is the wire identity of a registration.
const REGISTRATION_ID_SQL: &str = "CASE WHEN registration_block IS NULL THEN NULL ELSE \
    chain_id::TEXT || ':' || COALESCE('0x' || encode(gateway, 'hex'), 'none') || ':' || \
    registration_block::TEXT || ':' || registration_log_index::TEXT END";
type SnapshotRow = (i64, Vec<u8>, i64, BigDecimal, BigDecimal, DateTime<Utc>);
type TxRow = (i64, i64, Vec<u8>, Option<Vec<u8>>, i16, DateTime<Utc>);

// (chain_id, vault_address, name, risk_label, status, tvl_cap, per_deposit_cap, snapshot_block, total_assets,
//  exit_fee_bps, paused, indexed_at). The five snapshot columns are null together when a vault has no snapshot.
type VaultRow = (
    i64,
    Vec<u8>,
    String,
    String,
    i16,
    Option<BigDecimal>,
    Option<BigDecimal>,
    Option<i64>,
    Option<BigDecimal>,
    Option<i64>,
    Option<bool>,
    DateTime<Utc>,
);

// (vault_address, name, risk_label, status, indexed_at) — used by get_vault
type VaultDetailRow = (Vec<u8>, String, String, i16, DateTime<Utc>);

// (tvl_cap, per_deposit_cap, total_assets, block_number, paused) of the latest snapshot — used by get_vault
type VaultSnapshotRow = (
    Option<BigDecimal>,
    Option<BigDecimal>,
    BigDecimal,
    i64,
    bool,
);

// (block_number, total_assets, total_supply, indexed_at)
type TvlPointRow = (i64, BigDecimal, BigDecimal, DateTime<Utc>);

// Row type for router weight queries.
// (router_address BYTEA, block_number, log_index, tx_hash BYTEA, vault_addresses BYTEA[], bps_values BIGINT[], indexed_at)
type WeightSnapshotRow = (
    Vec<u8>,
    i64,
    i32,
    Vec<u8>,
    Vec<Vec<u8>>,
    Vec<i64>,
    chrono::DateTime<chrono::Utc>,
);

// (block_number, tx_hash, adapter BYTEA NULL, adapter_index BIGINT NULL, amount, event_kind, indexed_at)
type AdapterAllocationRow = (
    i64,
    Vec<u8>,
    Option<Vec<u8>>,
    Option<i64>,
    BigDecimal,
    String,
    DateTime<Utc>,
);

// (block_number, tx_hash, direction, caller BYTEA, owner_or_receiver BYTEA, assets, shares, indexed_at)
type VaultTransferRow = (
    i64,
    Vec<u8>,
    String,
    Vec<u8>,
    Vec<u8>,
    BigDecimal,
    BigDecimal,
    DateTime<Utc>,
);

// (block_number, tx_hash, owner BYTEA, receiver BYTEA, gross_assets, fee_amount, net_assets, indexed_at)
type VaultFeeRow = (
    i64,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
    BigDecimal,
    BigDecimal,
    BigDecimal,
    DateTime<Utc>,
);

// Row types for the new multi-vault endpoints.

// (chain_id, vault_address, block_number, shares, preview_redeem_total, total_supply, indexed_at)
// Used by get_account_positions to join wallet_positions with vault_snapshots.
type PositionRow = (
    i64,
    Vec<u8>,
    i64,
    BigDecimal,
    Option<BigDecimal>,
    Option<BigDecimal>,
    DateTime<Utc>,
);

// (chain_id, block_number, log_index, tx_hash, vault, agent, share_receiver, amount, indexed_at)
// Used by get_stats activity feed and get_account_history.
type DepositFeedRow = (
    i64,
    i64,
    i32,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
    BigDecimal,
    DateTime<Utc>,
);

/// Build the application router. All routes are GET-only.
///
/// `#[rustfmt::skip]` is intentional: the router-introspection test
/// (tests/router_introspection.rs) reads this source file and checks that
/// every route declaration uses only the GET method.  Rustfmt would split long
/// route declarations across multiple lines, causing the test to fail.
/// The skip keeps all route declarations on one line per §11 invariant.
#[rustfmt::skip]
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/chains/:chain_id/contracts", get(list_contracts))
        .route("/v1/vault/snapshot/latest", get(latest_vault_snapshot))
        .route("/v1/vault/snapshots", get(list_vault_snapshots))
        .route("/v1/agents/:address", get(get_agent))
        .route("/v1/agents/:address/deposits", get(list_agent_deposits))
        .route("/v1/agents/:address/registrations", get(list_agent_registrations))
        .route("/v1/transactions/:tx_hash", get(get_transaction))
        .route("/v1/deposits/:deposit_id", get(get_deposit))
        .route("/v1/vaults", get(list_vaults))
        .route("/v1/vaults/:address", get(get_vault))
        // Router weights and governed-change admin events (issues #307, #1731). There is no
        // proposals route: RouterGovernance voting was deleted (issue 1698, migration 0027).
        .route("/v1/router/weights", get(get_router_weights))
        .route("/v1/governance/admin-events", get(list_admin_events))
        // Multi-vault protocol stats endpoints (issue #316).
        .route("/v1/stats", get(get_stats))
        .route("/v1/router/state", get(get_router_state))
        .route("/v1/accounts/:address/positions", get(get_account_positions))
        .route("/v1/accounts/:address/history", get(get_account_history))
        .route("/v1/accounts/:address/policies", get(get_account_policies))
        // Exclusion-record claims — core issue 1820, QA plan X7.
        .route("/v1/accounts/:address/exclusion-claims", get(get_account_exclusion_claims))
        // Agent registration history (issue 1891): every registration of an agent address.
        // The committee and regime routes were retired with the IC policy; they fall through to 404.
        // Consensus recommendation receipts — issue #1247, docs/architecture.md §4.9.
        // Protocol scope (§5.0): no :address segment.
        .route("/v1/consensus-receipts", get(list_consensus_receipts))
        .route("/v1/consensus-receipts/:receipt_id", get(get_consensus_receipt))
        // Account scope (§5.0): receipts anchored by this submitter.
        .route("/v1/accounts/:address/consensus-receipts", get(list_account_consensus_receipts))
        .fallback(not_found)
        .with_state(state)
}

async fn not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "not_found",
            "message": "no such resource"
        })),
    )
}

async fn health(State(state): State<AppState>) -> ApiResult<Json<Health>> {
    let reorg_count: Option<i32> = sqlx::query_scalar(
        "SELECT reorg_count FROM indexer_runs WHERE chain_id = $1 ORDER BY run_id DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .fetch_optional(&state.pool)
    .await?;
    let progress = indexer_progress(&state).await?;
    let last_indexed_block = progress.map(|(b, _)| b);
    let chain_head_block = chain_head_block(&state).await?;
    // DI-5: `/health` used to say `ok` with a cursor that had not moved for hours, because nothing in it
    // showed that every tick was failing. The newest FINISHED run is the indexer's current verdict: the run
    // in flight has no outcome yet, and an older error that a later tick recovered from is history.
    let last_run_error: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT error FROM indexer_runs \
         WHERE chain_id = $1 AND finished_at IS NOT NULL \
         ORDER BY run_id DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    // Security round 1: a stopped indexer writes no run at all, so the newest run keeps its old
    // verdict and the head keeps its old lag, and both read healthy forever. The age of the last
    // good run is what shows it. Measured on the database clock, like the watchdog's
    // `[indexer_lag].max_silence_secs`, and with the same row: the newest successful run with a
    // cursor.
    let since_success_secs: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT GREATEST(EXTRACT(EPOCH FROM now() - COALESCE(finished_at, started_at))::BIGINT, 0) \
         FROM indexer_runs \
         WHERE chain_id = $1 AND error IS NULL AND last_indexed_block IS NOT NULL \
         ORDER BY run_id DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    let silent = since_success_secs.is_some_and(|s| s > HEALTH_MAX_SILENCE_SECS);
    // Issue 1856. A database the indexer has not migrated to 0020 yet has no
    // such table (42P01): report null rather than turn the probe red.
    let proxy_backfill: Option<ProxyBackfillHealth> = match sqlx::query_as(
        "SELECT state, floor_block, target_block, next_block, detail \
         FROM proxy_backfill_progress WHERE chain_id = $1",
    )
    .bind(state.chain_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("42P01") => None,
        Err(e) => return Err(e.into()),
    };
    Ok(Json(Health {
        status: if last_run_error.is_some() || silent {
            "degraded"
        } else {
            "ok"
        },
        last_indexed_block,
        chain_head_block,
        lag_blocks: chain_head_block
            .zip(last_indexed_block)
            .map(|(head, cursor)| head - cursor),
        last_run_error,
        since_success_secs,
        reorg_count: reorg_count.unwrap_or(0),
        proxy_backfill,
    }))
}

/// Seconds since the last good indexer run after which `/health` says `degraded` (security round
/// 1). The watchdog's default `[indexer_lag].max_silence_secs` (`DEFAULT_MAX_INDEXER_SILENCE_SECS`
/// in `services/watchdog/src/liveness.rs`), so the two surfaces call the same indexer stopped. A
/// healthy indexer finishes a run every poll, a few seconds apart.
pub const HEALTH_MAX_SILENCE_SECS: i64 = 300;

/// (address, kind, newest `Upgraded` detail, first `UpgradesFrozen` block, first `UpgradesFrozen` detail).
type ContractRow = (Vec<u8>, String, Option<String>, Option<i64>, Option<String>);

/// The `implementation` field of an indexed proxy event's `detail` JSON.
fn detail_implementation(detail: Option<&str>) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(detail?)
        .ok()?
        .get("implementation")?
        .as_str()
        .map(str::to_string)
}

/// GET /v1/chains/:chain_id/contracts
///
/// This service serves one chain (`state.chain_id`), and so does this route (QA
/// plan X7, DI-9). It used to bind the path's chain id, so `/v1/chains/1/contracts`
/// on the Base service listed another chain's rows from a shared database. A path
/// chain that is not the served one is 404, like any resource this service does
/// not have.
async fn list_contracts(
    State(state): State<AppState>,
    Path(chain_id): Path<i64>,
) -> ApiResult<Json<ContractsResponse>> {
    if chain_id != state.chain_id {
        return Err(ApiError::NotFound);
    }
    let chain_id = state.chain_id;
    // The canonical schema has no `label` column on `contracts`; surface
    // it as null so the wire format stays stable for existing clients.
    //
    // Issue 1810: each contract's implementation and freeze state come from
    // its newest indexed `Upgraded` and `UpgradesFrozen` events
    // (`admin_events`, contract_kind 'proxy'). A contract whose only indexed
    // proxy row is its `UpgradesFrozen` (its `Upgraded` predates the indexed
    // range) reports the implementation the freeze names (issue 1840).
    let rows: Vec<ContractRow> = sqlx::query_as(
        "SELECT c.address, c.kind, \
             (SELECT e.detail FROM admin_events e \
               WHERE e.chain_id = c.chain_id AND e.contract = c.address \
                 AND e.contract_kind = 'proxy' AND e.event_name = 'Upgraded' \
               ORDER BY e.block_number DESC, e.log_index DESC LIMIT 1) AS upgraded, \
             (SELECT e.block_number FROM admin_events e \
               WHERE e.chain_id = c.chain_id AND e.contract = c.address \
                 AND e.contract_kind = 'proxy' AND e.event_name = 'UpgradesFrozen' \
               ORDER BY e.block_number ASC, e.log_index ASC LIMIT 1) AS frozen_at_block, \
             (SELECT e.detail FROM admin_events e \
               WHERE e.chain_id = c.chain_id AND e.contract = c.address \
                 AND e.contract_kind = 'proxy' AND e.event_name = 'UpgradesFrozen' \
               ORDER BY e.block_number ASC, e.log_index ASC LIMIT 1) AS frozen \
         FROM contracts c WHERE c.chain_id = $1 ORDER BY c.address",
    )
    .bind(chain_id)
    .fetch_all(&state.pool)
    .await?;
    let contracts = rows
        .into_iter()
        .map(|(address, kind, upgraded, frozen_at_block, frozen)| {
            let implementation = detail_implementation(upgraded.as_deref())
                .or_else(|| detail_implementation(frozen.as_deref()));
            Contract {
                chain_id,
                address: addr_to_hex(&address),
                kind,
                label: None,
                upgrade_state: UpgradeState::of(upgraded.is_some(), frozen_at_block).as_str(),
                implementation,
                frozen_at_block,
            }
        })
        .collect();
    let freshness = current_freshness(&state, chain_id).await?;
    Ok(Json(ContractsResponse {
        chain_id,
        contracts,
        freshness,
    }))
}

#[derive(Debug, Deserialize)]
pub struct LatestSnapshotQuery {
    /// The vault whose latest snapshot to return. Required.
    pub contract: Option<String>,
}

/// GET /v1/vault/snapshot/latest?contract=0x…
///
/// The newest `vault_snapshots` row of one vault on the served chain (QA plan
/// X7, DI-9). It used to read the newest row of the whole table, with no chain
/// and no vault, so with several vaults (and several chains in one database) it
/// answered whichever vault was read last. `multi-vault-explorer-decisions.md`
/// §3.2 named the fix: a required vault parameter, 400 without it. The
/// parameter is `contract`, the name `/v1/vault/snapshots` already uses. A vault
/// with no snapshot on this chain is 404.
async fn latest_vault_snapshot(
    State(state): State<AppState>,
    Query(q): Query<LatestSnapshotQuery>,
) -> ApiResult<Json<VaultSnapshotsResponse>> {
    let Some(contract) = q.contract.as_deref() else {
        return Err(ApiError::BadRequest(
            "contract query parameter is required: the vault whose latest snapshot to return"
                .into(),
        ));
    };
    let contract = decode_address_param(contract)?;
    let row: Option<SnapshotRow> = sqlx::query_as(
        "SELECT chain_id, contract, block_number, total_assets, total_supply, indexed_at \
         FROM vault_snapshots \
         WHERE chain_id = $1 AND contract = $2 \
         ORDER BY block_number DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(&contract[..])
    .fetch_optional(&state.pool)
    .await?;
    match row {
        None => Err(ApiError::NotFound),
        Some((chain_id, contract, block_number, total_assets, total_supply, indexed_at)) => {
            let snap = VaultSnapshot {
                chain_id,
                contract: addr_to_hex(&contract),
                block_number,
                total_assets: dec_to_string(&total_assets),
                total_supply: dec_to_string(&total_supply),
                indexed_at,
            };
            Ok(Json(VaultSnapshotsResponse {
                freshness: Freshness {
                    block_number: snap.block_number,
                    indexed_at: snap.indexed_at,
                },
                snapshots: vec![snap],
            }))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SnapshotsQuery {
    pub from_block: Option<i64>,
    pub to_block: Option<i64>,
    pub chain_id: Option<i64>,
    pub contract: Option<String>,
}

/// GET /v1/vault/snapshots?from_block=&to_block=&contract=&chain_id=
///
/// Snapshots of the served chain only (`state.chain_id`, security round 1). The query's `chain_id`
/// used to be the only chain filter, so without it the route returned every chain's rows from a
/// shared database, mixed, and took its freshness from whichever row came last. A `chain_id` that
/// is not the served chain is 404, as on `/v1/chains/:chain_id/contracts`.
async fn list_vault_snapshots(
    State(state): State<AppState>,
    Query(q): Query<SnapshotsQuery>,
) -> ApiResult<Json<VaultSnapshotsResponse>> {
    if q.chain_id.is_some_and(|c| c != state.chain_id) {
        return Err(ApiError::NotFound);
    }
    let from_block = q.from_block.unwrap_or(0);
    let to_block = q.to_block.unwrap_or(i64::MAX);
    if to_block < from_block {
        return Err(ApiError::BadRequest(
            "to_block must be >= from_block".into(),
        ));
    }
    // Optional contract filter is hex-decoded to BYTEA before binding so
    // the SELECT does not have to mix string/bytes types.
    let contract_bytes: Option<Vec<u8>> = match q.contract.as_deref() {
        Some(s) => Some(decode_address_param(s)?),
        None => None,
    };
    let rows: Vec<SnapshotRow> = sqlx::query_as(
        "SELECT chain_id, contract, block_number, total_assets, total_supply, indexed_at \
         FROM vault_snapshots \
         WHERE block_number BETWEEN $1 AND $2 \
           AND chain_id = $3 \
           AND ($4::BYTEA  IS NULL OR contract = $4) \
         ORDER BY block_number ASC \
         LIMIT 500",
    )
    .bind(from_block)
    .bind(to_block)
    .bind(state.chain_id)
    .bind(contract_bytes.as_deref())
    .fetch_all(&state.pool)
    .await?;
    let snapshots: Vec<VaultSnapshot> = rows
        .into_iter()
        .map(
            |(chain_id, contract, block_number, ta, ts, ia)| VaultSnapshot {
                chain_id,
                contract: addr_to_hex(&contract),
                block_number,
                total_assets: dec_to_string(&ta),
                total_supply: dec_to_string(&ts),
                indexed_at: ia,
            },
        )
        .collect();
    let freshness = match snapshots.last() {
        Some(s) => Freshness {
            block_number: s.block_number,
            indexed_at: s.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };
    Ok(Json(VaultSnapshotsResponse {
        snapshots,
        freshness,
    }))
}

async fn get_agent(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AgentResponse>> {
    let address_bytes = decode_address_param(&address)?;
    // The current policy is the newest LIVE registration of the address: a revoked or expired
    // registration is history and is listed by `/v1/agents/:address/registrations`, never here
    // (issue 1891). `authorized` is kept for the wire format and is true whenever a policy is
    // returned; `cap` is `max_per_window`.
    // Chain scoping: the registration projection filters agent_policies to state.chain_id so a
    // shared agent address on another chain is invisible here (issue #178).
    let live = query_registrations(&state, None, Some(address_bytes.clone()), None)
        .await?
        .into_iter()
        .filter(|p| p.status == "active")
        .max_by_key(|p| p.started_block);
    let policy = live.map(|p| AgentPolicy {
        agent: addr_to_hex(&address_bytes),
        authorized: true,
        cap: p.max_per_window,
        block_number: p.last_block,
    });
    let freshness = latest_freshness(&state).await?;
    Ok(Json(AgentResponse { policy, freshness }))
}

/// GET /v1/agents/:address/registrations — every registration of an agent address, live or closed,
/// with the owner it had, its status (`active`, `revoked` or `expired`) and its closing evidence.
/// Earlier registrations are never overwritten by a later one (issue 1891, RS-1019-18).
async fn list_agent_registrations(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AgentRegistrationsResponse>> {
    let address_bytes = decode_address_param(&address)?;
    let registrations = query_registrations(&state, None, Some(address_bytes.clone()), None)
        .await?
        .into_iter()
        .map(AccountPolicy::from)
        .collect();
    let freshness = latest_freshness(&state).await?;
    Ok(Json(AgentRegistrationsResponse {
        agent: addr_to_hex(&address_bytes),
        registrations,
        freshness,
    }))
}

async fn list_agent_deposits(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<DepositsResponse>> {
    let address_bytes = decode_address_param(&address)?;
    // Chain scoping: filter agent_deposits to state.chain_id so deposits from
    // the same agent address on another chain are excluded (issue #178).
    let rows: Vec<DepositRow> = sqlx::query_as(
        &format!(
            "SELECT chain_id, block_number, log_index, tx_hash, payment_id, agent, share_receiver, amount, indexed_at, \
                    {REGISTRATION_ID_SQL} AS registration_id \
             FROM agent_deposits \
             WHERE chain_id = $1 AND agent = $2 \
             ORDER BY block_number DESC, log_index DESC LIMIT 500"
        ),
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;
    let deposits: Vec<Deposit> = rows.into_iter().map(deposit_from_row).collect();
    let freshness = match deposits.first() {
        Some(d) => Freshness {
            block_number: d.block_number,
            indexed_at: d.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };
    Ok(Json(DepositsResponse {
        deposits,
        freshness,
    }))
}

async fn get_transaction(
    State(state): State<AppState>,
    Path(tx_hash): Path<String>,
) -> ApiResult<Json<TransactionResponse>> {
    let tx_hash_bytes = decode_hash_param(&tx_hash)?;
    // Chain scoping: filter transactions to state.chain_id so a tx hash that
    // exists on another chain cannot be returned here (issue #178).
    let row: Option<TxRow> = sqlx::query_as(
        "SELECT chain_id, block_number, from_addr, to_addr, status, indexed_at \
         FROM transactions WHERE chain_id = $1 AND tx_hash = $2 LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(&tx_hash_bytes[..])
    .fetch_optional(&state.pool)
    .await?;
    let (chain_id, block_number, from_addr, to_addr, status, indexed_at) =
        row.ok_or(ApiError::NotFound)?;
    let transaction = Transaction {
        chain_id,
        tx_hash: hash_to_hex(&tx_hash_bytes),
        block_number,
        from_address: addr_to_hex(&from_addr),
        to_address: to_addr.as_deref().map(addr_to_hex),
        status,
        indexed_at,
    };
    Ok(Json(TransactionResponse {
        freshness: Freshness {
            block_number: transaction.block_number,
            indexed_at: transaction.indexed_at,
        },
        transaction,
    }))
}

async fn get_deposit(
    State(state): State<AppState>,
    Path(deposit_id): Path<String>,
) -> ApiResult<Json<DepositResponse>> {
    // `deposit_id` is the on-chain `payment_id` (bytes32 hex).
    let payment_bytes = decode_hash_param(&deposit_id)?;
    // Chain scoping: filter agent_deposits to state.chain_id when looking up
    // by payment_id so a deposit on another chain with the same bytes32 id
    // cannot collide (issue #178).
    let row: Option<DepositRow> = sqlx::query_as(
        &format!(
            "SELECT chain_id, block_number, log_index, tx_hash, payment_id, agent, share_receiver, amount, indexed_at, \
                    {REGISTRATION_ID_SQL} AS registration_id \
             FROM agent_deposits WHERE chain_id = $1 AND payment_id = $2 LIMIT 1"
        ),
    )
    .bind(state.chain_id)
    .bind(&payment_bytes[..])
    .fetch_optional(&state.pool)
    .await?;
    let deposit = deposit_from_row(row.ok_or(ApiError::NotFound)?);
    Ok(Json(DepositResponse {
        freshness: Freshness {
            block_number: deposit.block_number,
            indexed_at: deposit.indexed_at,
        },
        deposit,
    }))
}

/// GET /v1/vaults — list all registered vaults including paused and retired ones.
///
/// Joins the latest vault_snapshot per vault to surface `total_assets` and
/// `exit_fee_bps`.  Vaults with no snapshot yet return null for those fields.
/// Chain-scoped to `state.chain_id` (issue #178).
async fn list_vaults(State(state): State<AppState>) -> ApiResult<Json<VaultsResponse>> {
    // LEFT JOIN the most recent snapshot per vault. DISTINCT ON is
    // Postgres-specific and matches the single-chain service constraint
    // (docs/technical/explorer-schema-decisions.md §3.1).
    let rows: Vec<VaultRow> = sqlx::query_as(
        "SELECT v.chain_id, v.vault_address, v.name, v.risk_label, v.status, \
                s.tvl_cap, \
                s.per_deposit_cap, \
                s.block_number, \
                s.total_assets, \
                s.exit_fee_bps, \
                s.paused, \
                v.indexed_at \
         FROM vaults v \
         LEFT JOIN LATERAL ( \
             SELECT tvl_cap, per_deposit_cap, block_number, total_assets, exit_fee_bps, paused \
             FROM vault_snapshots \
             WHERE chain_id = v.chain_id AND contract = v.vault_address \
             ORDER BY block_number DESC \
             LIMIT 1 \
         ) s ON true \
         WHERE v.chain_id = $1 \
         ORDER BY v.vault_address ASC",
    )
    .bind(state.chain_id)
    .fetch_all(&state.pool)
    .await?;

    let vaults: Vec<Vault> = rows
        .into_iter()
        .map(
            |(
                chain_id,
                vault_address,
                name,
                risk_label,
                status,
                tvl_cap,
                per_deposit_cap,
                snapshot_block,
                total_assets,
                exit_fee_bps,
                deposits_paused,
                indexed_at,
            )| {
                Vault {
                    chain_id,
                    address: addr_to_hex(&vault_address),
                    name,
                    risk_label,
                    status,
                    headroom: headroom_of(tvl_cap.as_ref(), total_assets.as_ref()),
                    tvl_cap: tvl_cap.as_ref().map(dec_to_string),
                    per_deposit_cap: per_deposit_cap.as_ref().map(dec_to_string),
                    snapshot_block,
                    total_assets: total_assets.as_ref().map(dec_to_string),
                    exit_fee_bps,
                    deposits_paused,
                    indexed_at,
                }
            },
        )
        .collect();

    let freshness = latest_freshness(&state).await?;
    let chain_head_block = chain_head_block(&state).await?;
    Ok(Json(VaultsResponse {
        vaults,
        freshness,
        chain_head_block,
    }))
}

/// GET /v1/vaults/:address — detail view for a single vault.
///
/// Returns 404 with a stable error body for an unregistered address.
/// Includes TVL timeseries (up to 500 rows) from vault_snapshots.
/// Chain-scoped to `state.chain_id` (issue #178).
async fn get_vault(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<VaultDetailResponse>> {
    let address_bytes = decode_address_param(&address)?;

    let row: Option<VaultDetailRow> = sqlx::query_as(
        "SELECT vault_address, name, risk_label, status, indexed_at \
         FROM vaults \
         WHERE chain_id = $1 AND vault_address = $2 \
         LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_optional(&state.pool)
    .await?;

    let (vault_address, name, risk_label, status, indexed_at) = row.ok_or(ApiError::NotFound)?;

    // The vault's own `depositsPaused()`, `tvlCap()` and `perDepositCap()` as of its latest snapshot; all null
    // when it has none (issues 1731 and 1741). A cap the indexer could not read is null, never 0.
    let snapshot: Option<VaultSnapshotRow> = sqlx::query_as(
        "SELECT tvl_cap, per_deposit_cap, total_assets, block_number, paused FROM vault_snapshots \
         WHERE chain_id = $1 AND contract = $2 \
         ORDER BY block_number DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_optional(&state.pool)
    .await?;
    let deposits_paused = snapshot.as_ref().map(|s| s.4);
    let snapshot_block = snapshot.as_ref().map(|s| s.3);
    let tvl_cap = snapshot.as_ref().and_then(|s| s.0.clone());
    let per_deposit_cap = snapshot.as_ref().and_then(|s| s.1.clone());
    let headroom = snapshot
        .as_ref()
        .and_then(|s| headroom_of(s.0.as_ref(), Some(&s.2)));

    // Fetch TVL timeseries — up to 500 rows ascending by block.
    let tvl_rows: Vec<TvlPointRow> = sqlx::query_as(
        "SELECT block_number, total_assets, total_supply, indexed_at \
         FROM vault_snapshots \
         WHERE chain_id = $1 AND contract = $2 \
         ORDER BY block_number ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let tvl_history: Vec<VaultTvlPoint> = tvl_rows
        .into_iter()
        .map(
            |(block_number, total_assets, total_supply, ia)| VaultTvlPoint {
                block_number,
                total_assets: dec_to_string(&total_assets),
                total_supply: dec_to_string(&total_supply),
                indexed_at: ia,
            },
        )
        .collect();

    // Fetch adapter allocation history — up to 500 rows ascending by block.
    let alloc_rows: Vec<AdapterAllocationRow> = sqlx::query_as(
        "SELECT block_number, tx_hash, adapter, adapter_index, amount, event_kind, indexed_at \
         FROM adapter_allocations \
         WHERE chain_id = $1 AND vault = $2 \
         ORDER BY block_number ASC, log_index ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let adapter_allocation_history: Vec<AdapterAllocationEntry> = alloc_rows
        .into_iter()
        .map(
            |(block_number, tx_hash, adapter, adapter_index, amount, event_kind, ia)| {
                AdapterAllocationEntry {
                    block_number,
                    tx_hash: hash_to_hex(&tx_hash),
                    adapter: adapter.as_deref().map(addr_to_hex),
                    adapter_index,
                    amount: dec_to_string(&amount),
                    event_kind,
                    indexed_at: ia,
                }
            },
        )
        .collect();

    // Fetch deposit/withdrawal log — up to 500 rows ascending by block.
    let transfer_rows: Vec<VaultTransferRow> = sqlx::query_as(
        "SELECT block_number, tx_hash, direction, caller, owner_or_receiver, assets, shares, indexed_at \
         FROM vault_transfer_events \
         WHERE chain_id = $1 AND vault = $2 \
         ORDER BY block_number ASC, log_index ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let deposit_withdrawal_log: Vec<VaultTransferEntry> = transfer_rows
        .into_iter()
        .map(
            |(block_number, tx_hash, direction, caller, owner_or_receiver, assets, shares, ia)| {
                VaultTransferEntry {
                    block_number,
                    tx_hash: hash_to_hex(&tx_hash),
                    direction,
                    caller: addr_to_hex(&caller),
                    owner_or_receiver: addr_to_hex(&owner_or_receiver),
                    assets: dec_to_string(&assets),
                    shares: dec_to_string(&shares),
                    indexed_at: ia,
                }
            },
        )
        .collect();

    // Fetch fee collection history — up to 500 rows ascending by block.
    let fee_rows: Vec<VaultFeeRow> = sqlx::query_as(
        "SELECT block_number, tx_hash, owner, receiver, gross_assets, fee_amount, net_assets, indexed_at \
         FROM vault_fee_events \
         WHERE chain_id = $1 AND vault = $2 \
         ORDER BY block_number ASC, log_index ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let fee_history: Vec<VaultFeeEntry> = fee_rows
        .into_iter()
        .map(
            |(block_number, tx_hash, owner, receiver, gross_assets, fee_amount, net_assets, ia)| {
                VaultFeeEntry {
                    block_number,
                    tx_hash: hash_to_hex(&tx_hash),
                    owner: addr_to_hex(&owner),
                    receiver: addr_to_hex(&receiver),
                    gross_assets: dec_to_string(&gross_assets),
                    fee_amount: dec_to_string(&fee_amount),
                    net_assets: dec_to_string(&net_assets),
                    indexed_at: ia,
                }
            },
        )
        .collect();

    // Freshness is the index cursor, as on every other endpoint. The block of the latest vault snapshot is
    // `vault.snapshot_block`: it trails the cursor by up to the snapshot heartbeat, and reporting it as the
    // index block made a healthy indexer look thousands of blocks behind (issue 1741).
    let freshness = latest_freshness(&state).await?;
    let chain_head_block = chain_head_block(&state).await?;

    let vault = VaultDetail {
        chain_id: state.chain_id,
        address: addr_to_hex(&vault_address),
        name,
        risk_label,
        status,
        tvl_cap: tvl_cap.as_ref().map(dec_to_string),
        per_deposit_cap: per_deposit_cap.as_ref().map(dec_to_string),
        headroom,
        snapshot_block,
        deposits_paused,
        tvl_history,
        adapter_allocation_history,
        deposit_withdrawal_log,
        fee_history,
        indexed_at,
    };

    Ok(Json(VaultDetailResponse {
        vault,
        freshness,
        chain_head_block,
    }))
}

// ─── Router weight and admin-event handlers (issues #307, #1731) ───────────

/// GET /v1/router/weights — current weight vector and history of WeightsSet
/// events for the PortfolioRouter.
async fn get_router_weights(
    State(state): State<AppState>,
) -> ApiResult<Json<RouterWeightsResponse>> {
    // Fetch all weight snapshots for this chain, ascending.
    let rows: Vec<WeightSnapshotRow> = sqlx::query_as(
        "SELECT router_address, block_number, log_index, tx_hash, vault_addresses, bps_values, indexed_at \
         FROM router_weight_snapshots \
         WHERE chain_id = $1 \
         ORDER BY block_number ASC, log_index ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .fetch_all(&state.pool)
    .await?;

    let mut history: Vec<WeightHistoryEntry> = rows
        .iter()
        .map(|(_, bn, _, tx, vaults, bps, ia)| {
            let weights = vaults
                .iter()
                .zip(bps.iter())
                .map(|(v, b)| VaultWeight {
                    vault: addr_to_hex(v),
                    bps: *b,
                })
                .collect();
            WeightHistoryEntry {
                block_number: *bn,
                tx_hash: hash_to_hex(tx),
                weights,
                indexed_at: *ia,
            }
        })
        .collect();

    // Current weights = last snapshot.
    let current_weights = history
        .last()
        .map(|e| e.weights.clone())
        .unwrap_or_default();

    // Sort history ascending (already sorted by query, but make explicit).
    history.sort_by_key(|e| e.block_number);

    let freshness = match history.last() {
        Some(e) => Freshness {
            block_number: e.block_number,
            indexed_at: e.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };

    Ok(Json(RouterWeightsResponse {
        current_weights,
        history,
        freshness,
    }))
}

// (block_number, log_index, tx_hash, contract, contract_kind, event_name, op_id, detail, indexed_at)
type AdminEventRow = (
    i64,
    i32,
    Vec<u8>,
    Vec<u8>,
    String,
    String,
    Option<Vec<u8>>,
    String,
    DateTime<Utc>,
);

/// GET /v1/governance/admin-events — the Timelock and Safe events of the governed-change path (newest
/// first, at most 500). The Safe and the Timelock themselves are listed by `/v1/chains/:chain_id/contracts`.
async fn list_admin_events(State(state): State<AppState>) -> ApiResult<Json<AdminEventsResponse>> {
    let rows: Vec<AdminEventRow> = sqlx::query_as(
        "SELECT block_number, log_index, tx_hash, contract, contract_kind, event_name, op_id, detail, indexed_at \
         FROM admin_events \
         WHERE chain_id = $1 \
         ORDER BY block_number DESC, log_index DESC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .fetch_all(&state.pool)
    .await?;
    let chain_id = state.chain_id;
    let events = rows
        .into_iter()
        .map(
            |(
                block_number,
                log_index,
                tx_hash,
                contract,
                contract_kind,
                event_name,
                op_id,
                detail,
                indexed_at,
            )| {
                AdminEventEntry {
                    chain_id,
                    block_number,
                    log_index,
                    tx_hash: hash_to_hex(&tx_hash),
                    contract: addr_to_hex(&contract),
                    contract_kind,
                    event_name,
                    op_id: op_id.map(|h| hash_to_hex(&h)),
                    detail: serde_json::from_str(&detail).unwrap_or(serde_json::Value::Null),
                    indexed_at,
                }
            },
        )
        .collect();
    let freshness = latest_freshness(&state).await?;
    Ok(Json(AdminEventsResponse { events, freshness }))
}

// ─── Multi-vault protocol stats handlers (issue #316) ─────────────────────

/// Counting rule for `unique_depositors` (issue 1766), documented in
/// `docs/explorer-api.md`. Change this one query to change the rule.
///
/// A depositor is a distinct address that currently holds shares (balance > 0)
/// in any vault. The balance is the latest `wallet_positions` row per
/// (vault, holder), which the indexer rolls forward from every vault
/// `Deposit` (direct, router and gateway paths all emit one) and back on every
/// `Withdraw`. An address is counted once however many vaults it holds, and an
/// address that redeemed everything is not counted. Addresses seen only in
/// `agent_deposits` (share_receiver) or `router_deposit_legs` (depositor) with
/// no position row at all are also counted, so rows indexed without a vault
/// `Deposit` are not lost.
const UNIQUE_DEPOSITORS_SQL: &str = "\
    WITH latest AS ( \
        SELECT DISTINCT ON (contract, owner) owner, shares \
        FROM wallet_positions \
        WHERE chain_id = $1 \
        ORDER BY contract, owner, block_number DESC \
    ) \
    SELECT COUNT(*)::BIGINT FROM ( \
        SELECT owner AS holder FROM latest GROUP BY owner HAVING SUM(shares) > 0 \
        UNION \
        SELECT addr FROM ( \
            SELECT share_receiver AS addr FROM agent_deposits WHERE chain_id = $1 \
            UNION \
            SELECT depositor AS addr FROM router_deposit_legs WHERE chain_id = $1 \
        ) seen \
        WHERE addr NOT IN (SELECT owner FROM latest) \
    ) holders";

/// `total_tvl` of `/v1/stats`: the sum of the latest `vault_snapshots.total_assets` per contract,
/// across the active vaults (architecture.md, Protocol stats).
///
/// The indexer snapshots every `vaults` row whatever its status, so a Retired vault's newest row
/// tracks its holders' exits (DI-2). The status filter lives here, in the product view: a
/// Retired (2) vault is left out, so the old rmPROTO stops counting toward protocol TVL once it is
/// retired, while `/v1/vaults` still shows its own live `total_assets`. A DepositsPaused (1) vault
/// still counts: the pause is temporary and its assets stay deployed. A snapshotted contract with
/// no `vaults` row (the pinned vault of a deployment without a registry) still counts.
const TOTAL_TVL_SQL: &str = "\
    SELECT SUM(latest.total_assets) \
    FROM ( \
        SELECT DISTINCT ON (s.chain_id, s.contract) s.total_assets \
        FROM vault_snapshots s \
        WHERE s.chain_id = $1 \
          AND NOT EXISTS ( \
              SELECT 1 FROM vaults v \
              WHERE v.chain_id = s.chain_id AND v.vault_address = s.contract AND v.status = 2 \
          ) \
        ORDER BY s.chain_id, s.contract, s.block_number DESC \
    ) AS latest";

/// GET /v1/stats — aggregate TVL, unique depositor count, and global activity feed.
///
/// TVL = sum of the latest total_assets snapshot per vault, leaving out every
/// vault whose registry status is Retired (see [`TOTAL_TVL_SQL`]).
/// Depositor count = distinct addresses currently holding vault shares
/// (see [`UNIQUE_DEPOSITORS_SQL`]).
/// Activity feed = last 50 deposit events across all vaults (descending by block).
/// Chain-scoped to state.chain_id.
async fn get_stats(State(state): State<AppState>) -> ApiResult<Json<StatsResponse>> {
    // Aggregate TVL: sum of the most recent total_assets per non-retired vault.
    let tvl_row: (Option<BigDecimal>,) = sqlx::query_as(TOTAL_TVL_SQL)
        .bind(state.chain_id)
        .fetch_one(&state.pool)
        .await?;
    let total_tvl = tvl_row
        .0
        .as_ref()
        .map(dec_to_string)
        .unwrap_or_else(|| "0".to_string());

    // Unique depositor count.
    let depositor_row: (i64,) = sqlx::query_as(UNIQUE_DEPOSITORS_SQL)
        .bind(state.chain_id)
        .fetch_one(&state.pool)
        .await?;
    let unique_depositors = depositor_row.0;

    // Global activity feed: last 50 deposit events.
    // Use the `vault` column added in migration 0006 (issue #373).
    // COALESCE with share_receiver provides backwards compatibility for
    // rows indexed before the migration (where vault IS NULL).
    let feed_rows: Vec<DepositFeedRow> = sqlx::query_as(
        "SELECT chain_id, block_number, log_index, tx_hash, \
                COALESCE(vault, share_receiver) AS vault, agent, share_receiver, amount, indexed_at \
         FROM agent_deposits \
         WHERE chain_id = $1 \
         ORDER BY block_number DESC, log_index DESC \
         LIMIT 50",
    )
    .bind(state.chain_id)
    .fetch_all(&state.pool)
    .await?;

    let activity_feed: Vec<ActivityEvent> = feed_rows
        .into_iter()
        .map(
            |(
                chain_id,
                block_number,
                log_index,
                tx_hash,
                vault,
                agent,
                share_receiver,
                amount,
                indexed_at,
            )| {
                ActivityEvent {
                    chain_id,
                    block_number,
                    log_index,
                    tx_hash: hash_to_hex(&tx_hash),
                    vault: addr_to_hex(&vault),
                    agent: addr_to_hex(&agent),
                    share_receiver: addr_to_hex(&share_receiver),
                    amount: dec_to_string(&amount),
                    indexed_at,
                }
            },
        )
        .collect();

    let freshness = latest_freshness(&state).await?;
    Ok(Json(StatsResponse {
        total_tvl,
        unique_depositors,
        activity_feed,
        freshness,
        chain_head_block: chain_head_block(&state).await?,
    }))
}

/// GET /v1/router/state — current PortfolioRouter weights and weight-change history.
///
/// Reads router_weight_snapshots (added in migration 0004).  Returns an empty
/// current_weights and empty history when no WeightsSet events have been
/// indexed yet (table exists but is empty). Chain-scoped to state.chain_id.
async fn get_router_state(State(state): State<AppState>) -> ApiResult<Json<RouterStateResponse>> {
    let rows: Vec<WeightSnapshotRow> = sqlx::query_as(
        "SELECT router_address, block_number, log_index, tx_hash, \
                vault_addresses, bps_values, indexed_at \
         FROM router_weight_snapshots \
         WHERE chain_id = $1 \
         ORDER BY block_number ASC, log_index ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .fetch_all(&state.pool)
    .await?;

    let history: Vec<WeightHistoryEntry> = rows
        .iter()
        .map(|(_, bn, _, tx, vaults, bps, ia)| {
            let weights = vaults
                .iter()
                .zip(bps.iter())
                .map(|(v, b)| VaultWeight {
                    vault: addr_to_hex(v),
                    bps: *b,
                })
                .collect();
            WeightHistoryEntry {
                block_number: *bn,
                tx_hash: hash_to_hex(tx),
                weights,
                indexed_at: *ia,
            }
        })
        .collect();

    let current_weights = history
        .last()
        .map(|e| e.weights.clone())
        .unwrap_or_default();

    let freshness = match history.last() {
        Some(e) => Freshness {
            block_number: e.block_number,
            indexed_at: e.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };

    Ok(Json(RouterStateResponse {
        current_weights,
        history,
        freshness,
    }))
}

/// GET /v1/accounts/:address/positions — receipt balance per vault and USDC value.
///
/// For each vault where the address holds a non-zero share balance (latest
/// wallet_positions row), computes:
///   usdc_value = shares * preview_redeem_total / total_supply
/// using the most recent vault_snapshot for that vault. `preview_redeem_total`
/// is the vault's `previewRedeem(totalSupply())` at the snapshot block, so the
/// value is what a redeem of `shares` pays after the exit fee and (BasketVault)
/// the slippage floor, never the gross `convertToAssets` value (core 1795, QA
/// plan X8). A snapshot without it (older than migration 0026) gives `null`.
/// Chain-scoped to state.chain_id.
async fn get_account_positions(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AccountPositionsResponse>> {
    let address_bytes = decode_address_param(&address)?;

    // Latest wallet_position per vault for this owner, joined with the
    // most recent vault_snapshot per vault for the exit-value computation.
    let rows: Vec<PositionRow> = sqlx::query_as(
        "SELECT wp.chain_id, wp.contract, wp.block_number, wp.shares, \
                s.preview_redeem_total, s.total_supply, wp.indexed_at \
         FROM ( \
             SELECT DISTINCT ON (chain_id, contract) \
                    chain_id, contract, block_number, shares, indexed_at \
             FROM wallet_positions \
             WHERE chain_id = $1 AND owner = $2 \
             ORDER BY chain_id, contract, block_number DESC \
         ) AS wp \
         LEFT JOIN LATERAL ( \
             SELECT preview_redeem_total, total_supply \
             FROM vault_snapshots \
             WHERE chain_id = wp.chain_id AND contract = wp.contract \
             ORDER BY block_number DESC \
             LIMIT 1 \
         ) AS s ON true \
         ORDER BY wp.contract ASC",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let positions: Vec<VaultPosition> = rows
        .into_iter()
        .map(
            |(
                _,
                contract,
                block_number,
                shares,
                preview_redeem_total,
                total_supply,
                indexed_at,
            )| {
                let usdc_value = position_exit_value(
                    &shares,
                    preview_redeem_total.as_ref(),
                    total_supply.as_ref(),
                )
                .map(|v| dec_to_string(&v));
                VaultPosition {
                    vault: addr_to_hex(&contract),
                    shares: dec_to_string(&shares),
                    usdc_value,
                    block_number,
                    indexed_at,
                }
            },
        )
        .collect();

    let freshness = match positions.first() {
        Some(p) => Freshness {
            block_number: p.block_number,
            indexed_at: p.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };

    Ok(Json(AccountPositionsResponse {
        address: addr_to_hex(&address_bytes),
        positions,
        freshness,
    }))
}

// (vault, ledger, exclusion_id, adapter, adapter_index, opened_block, snapshot_supply, balance_at,
//  recovered, claimed, claimable, finalize_reason)
type ExclusionClaimRow = (
    Vec<u8>,
    Vec<u8>,
    i64,
    Vec<u8>,
    i64,
    i64,
    BigDecimal,
    BigDecimal,
    BigDecimal,
    BigDecimal,
    BigDecimal,
    Option<i16>,
);

/// GET /v1/accounts/:address/exclusion-claims — this address's claim on every
/// exclusion record it held vault shares at (core issue 1820, QA plan X7).
///
/// A `RobotMoneyVault` that excludes a funded adapter opens a record in its
/// `ExclusionLedger`. Recovered USDC goes to the record, not to the vault, and
/// belongs pro rata to the holders at the record's snapshot, also those who
/// have since exited. Per record the claim is
/// `floor(recovered * balance_at / snapshot_supply) - claimed`, never below 0,
/// the same formula and rounding as `ExclusionLedger.claimable`:
///
/// - `recovered` is the record's newest `recoveredUsdc` (credit or close event),
/// - `balance_at` is the holder's `balanceAt(holder, id)` the indexer read,
/// - `claimed` is the sum of this holder's `ExclusionClaimed` amounts.
///
/// Records with no stored balance for this address are left out. The indexer
/// reads the balance of every address whose latest deposit-or-withdrawal
/// position in the vault before the snapshot's block holds shares, of every
/// address with a deposit or withdrawal in that block, and of any other address
/// once it claims. A holder whose followed position is zero while it still
/// holds shares (shares received by transfer, then partly withdrawn) and who
/// never claimed is not listed here, nor is one that only received shares by
/// transfer. The ledger's `claimable(id, holder)` is the authority.
/// Chain-scoped to `state.chain_id`, freshness is the index cursor.
async fn get_account_exclusion_claims(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AccountExclusionClaimsResponse>> {
    let address_bytes = decode_address_param(&address)?;

    let rows: Vec<ExclusionClaimRow> = sqlx::query_as(
        "SELECT vault_address, ledger_address, exclusion_id, adapter_address, adapter_index, \
                opened_block, snapshot_supply, balance_at, recovered, claimed, \
                GREATEST( \
                    COALESCE(div(recovered * balance_at, NULLIF(snapshot_supply, 0)), 0) - claimed, \
                    0) AS claimable, \
                reason \
         FROM ( \
             SELECT r.vault_address, r.ledger_address, r.exclusion_id, r.adapter_address, \
                    r.adapter_index, r.block_number AS opened_block, r.snapshot_supply, \
                    b.balance_at, \
                    GREATEST(COALESCE(rec.recovered, 0), COALESCE(f.recovered_total, 0)) \
                        AS recovered, \
                    COALESCE(paid.claimed, 0) AS claimed, \
                    f.reason \
             FROM exclusion_holder_balances b \
             JOIN exclusion_records r \
               ON r.chain_id = b.chain_id AND r.ledger_address = b.ledger_address \
              AND r.exclusion_id = b.exclusion_id \
             LEFT JOIN LATERAL ( \
                 SELECT MAX(x.recovered_total) AS recovered FROM exclusion_recoveries x \
                 WHERE x.chain_id = r.chain_id AND x.ledger_address = r.ledger_address \
                   AND x.exclusion_id = r.exclusion_id \
             ) rec ON TRUE \
             LEFT JOIN LATERAL ( \
                 SELECT SUM(c.amount) AS claimed FROM exclusion_claims c \
                 WHERE c.chain_id = b.chain_id AND c.ledger_address = b.ledger_address \
                   AND c.exclusion_id = b.exclusion_id AND c.holder = b.holder \
             ) paid ON TRUE \
             LEFT JOIN exclusion_finalizations f \
               ON f.chain_id = r.chain_id AND f.ledger_address = r.ledger_address \
              AND f.exclusion_id = r.exclusion_id \
             WHERE b.chain_id = $1 AND b.holder = $2 \
         ) t \
         ORDER BY vault_address, ledger_address, exclusion_id",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let mut total = BigDecimal::from(0);
    let claims: Vec<ExclusionClaim> = rows
        .into_iter()
        .map(
            |(
                vault,
                ledger,
                exclusion_id,
                adapter,
                adapter_index,
                opened_block,
                snapshot_supply,
                balance_at,
                recovered,
                claimed,
                claimable,
                reason,
            )| {
                total += &claimable;
                ExclusionClaim {
                    vault: addr_to_hex(&vault),
                    exclusion_ledger: addr_to_hex(&ledger),
                    exclusion_id,
                    adapter: addr_to_hex(&adapter),
                    adapter_index,
                    opened_block,
                    snapshot_supply: dec_to_string(&snapshot_supply),
                    balance_at: dec_to_string(&balance_at),
                    recovered_usdc: dec_to_string(&recovered),
                    claimed_usdc: dec_to_string(&claimed),
                    claimable_usdc: dec_to_string(&claimable),
                    finalized: reason.is_some(),
                    finalize_reason: reason.map(|r| exclusion_finalize_reason_label(r).to_string()),
                }
            },
        )
        .collect();

    Ok(Json(AccountExclusionClaimsResponse {
        address: addr_to_hex(&address_bytes),
        claims,
        total_claimable_usdc: dec_to_string(&total),
        freshness: latest_freshness(&state).await?,
    }))
}

/// GET /v1/accounts/:address/history — chronological event log (issue #654).
///
/// Returns all events from `account_history_events` where `account = address`,
/// covering the four architecture §5.4 event types: deposits, withdrawals,
/// fee events and policy changes. There is no governance-vote kind
/// (RouterGovernance voting was deleted, issue 1698).  Ordered by block
/// ascending (chronological).  Includes up to 500 rows.  Chain-scoped to
/// state.chain_id.
///
/// The response `kind` discriminant allows callers to filter by event type.
/// Existing `Deposit` entries continue to appear with `kind: "deposit"` —
/// no regression for deposit-only consumers.
async fn get_account_history(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AccountHistoryResponse>> {
    let address_bytes = decode_address_param(&address)?;

    // (chain_id, block_number, log_index, tx_hash, kind, vault, agent, amount, indexed_at)
    type HistoryRow = (
        i64,
        i64,
        i32,
        Vec<u8>,
        String,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        Option<BigDecimal>,
        DateTime<Utc>,
    );

    let rows: Vec<HistoryRow> = sqlx::query_as(
        "SELECT chain_id, block_number, log_index, tx_hash, kind, vault, agent, amount, indexed_at \
         FROM account_history_events \
         WHERE chain_id = $1 AND account = $2 \
         ORDER BY block_number ASC, log_index ASC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_all(&state.pool)
    .await?;

    let events: Vec<AccountHistoryEntry> = rows
        .into_iter()
        .map(
            |(
                chain_id,
                block_number,
                log_index,
                tx_hash,
                kind,
                vault,
                agent,
                amount,
                indexed_at,
            )| {
                AccountHistoryEntry {
                    kind: EventKind::from_db_kind(&kind),
                    chain_id,
                    block_number,
                    log_index,
                    tx_hash: hash_to_hex(&tx_hash),
                    vault: vault.as_deref().map(addr_to_hex),
                    agent: agent.as_deref().map(addr_to_hex),
                    amount: amount.as_ref().map(dec_to_string),
                    indexed_at,
                }
            },
        )
        .collect();

    let freshness = match events.last() {
        Some(e) => Freshness {
            block_number: e.block_number,
            indexed_at: e.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };

    Ok(Json(AccountHistoryResponse {
        address: addr_to_hex(&address_bytes),
        events,
        freshness,
    }))
}

/// Optional filters of `GET /v1/accounts/:address/policies`.
#[derive(Debug, Deserialize)]
struct PoliciesQuery {
    /// `true` keeps only live registrations (not revoked, not expired). Default: every registration.
    active: Option<bool>,
    /// 0x-prefixed gateway deployment address; keeps only that deployment's registrations.
    gateway: Option<String>,
}

/// One registration as projected from `agent_policies` (migration 0031).
struct RegistrationRow {
    registration_id: String,
    gateway: Option<Vec<u8>>,
    agent: Vec<u8>,
    owner: Option<Vec<u8>>,
    status: String,
    closed: bool,
    started_block: i64,
    closed_block: Option<i64>,
    closed_tx_hash: Option<Vec<u8>>,
    valid_until: Option<i64>,
    max_per_payment: Option<String>,
    max_per_window: Option<String>,
    window_usage_to_date: Option<String>,
    share_receiver: Option<Vec<u8>>,
    tx_hash: Vec<u8>,
    last_block: i64,
}

impl From<RegistrationRow> for AccountPolicy {
    fn from(p: RegistrationRow) -> Self {
        AccountPolicy {
            registration_id: p.registration_id,
            gateway: p.gateway.as_deref().map(addr_to_hex),
            agent: addr_to_hex(&p.agent),
            owner: p.owner.as_deref().map(addr_to_hex),
            revoked: p.closed,
            status: p.status,
            started_block: p.started_block,
            closed_block: p.closed_block,
            closed_tx_hash: p.closed_tx_hash.as_deref().map(hash_to_hex),
            valid_until: p.valid_until,
            max_per_payment: p.max_per_payment,
            max_per_window: p.max_per_window,
            window_usage_to_date: p.window_usage_to_date,
            share_receiver: p.share_receiver.as_deref().map(addr_to_hex),
            tx_hash: hash_to_hex(&p.tx_hash),
        }
    }
}

/// The registration projection behind `/v1/accounts/:address/policies`, `/v1/agents/:address` and
/// `/v1/agents/:address/registrations` (issue 1891, RS-1019-18).
///
/// A registration is the group of `agent_policies` rows that share `(gateway, agent,
/// registration_block, registration_log_index)`. Its latest state is projected inside the group before
/// any owner filter runs, so a later registration of the same address by another owner (or by the same
/// one) never hides or overwrites an earlier one.
///
/// - Policy fields and owner come from the owner's newest authorization row in the registration, so a
///   revoked registration still reports the policy it had. A historical `AgentOwnershipTransferred`
///   keeps the old owner's view as it was and adds one for the new owner.
/// - The status is the registration's: `revoked` once any row of it is a revoke, `expired` when its
///   newest authorization's `valid_until` is before the newest indexed block's timestamp, else `active`.
///   A pre-chain-tip wall clock stands in only when no block is indexed.
/// - The closing block and transaction are those of the revoke row.
///
/// `owner`, `agent` and `gateway` narrow the result when given. Chain-scoped to `state.chain_id`.
async fn query_registrations(
    state: &AppState,
    owner: Option<Vec<u8>>,
    agent: Option<Vec<u8>>,
    gateway: Option<Vec<u8>>,
) -> ApiResult<Vec<RegistrationRow>> {
    type Row = (
        Option<Vec<u8>>,
        Vec<u8>,
        i64,
        i32,
        Option<Vec<u8>>,
        String,
        bool,
        Option<i64>,
        Option<Vec<u8>>,
        Option<i64>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<Vec<u8>>,
        Vec<u8>,
        i64,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "WITH tip AS ( \
             SELECT COALESCE( \
                 (SELECT timestamp FROM blocks WHERE chain_id = $1 ORDER BY block_number DESC LIMIT 1), \
                 EXTRACT(EPOCH FROM now())::BIGINT) AS ts \
         ), reg AS ( \
             SELECT gateway, agent, registration_block, registration_log_index, \
                    bool_or(revoked) AS closed, \
                    MAX(block_number) AS last_block, \
                    (array_agg(valid_until ORDER BY block_number DESC, log_index DESC) \
                        FILTER (WHERE NOT revoked))[1] AS live_valid_until, \
                    (array_agg(block_number ORDER BY block_number DESC, log_index DESC) \
                        FILTER (WHERE revoked))[1] AS closed_block, \
                    (array_agg(tx_hash ORDER BY block_number DESC, log_index DESC) \
                        FILTER (WHERE revoked))[1] AS closed_tx \
             FROM agent_policies \
             WHERE chain_id = $1 AND registration_block IS NOT NULL \
               AND ($3::BYTEA IS NULL OR agent = $3) \
               AND ($4::BYTEA IS NULL OR gateway = $4) \
             GROUP BY gateway, agent, registration_block, registration_log_index \
         ), mine AS ( \
             SELECT DISTINCT ON (gateway, agent, registration_block, registration_log_index, owner) \
                    gateway, agent, registration_block, registration_log_index, owner, \
                    valid_until, max_per_payment, max_per_window, window_usage_to_date, \
                    share_receiver, tx_hash \
             FROM agent_policies \
             WHERE chain_id = $1 AND registration_block IS NOT NULL \
               AND ($2::BYTEA IS NULL OR owner = $2) \
               AND ($3::BYTEA IS NULL OR agent = $3) \
               AND ($4::BYTEA IS NULL OR gateway = $4) \
             ORDER BY gateway, agent, registration_block, registration_log_index, owner, \
                      revoked ASC, block_number DESC, log_index DESC \
         ) \
         SELECT m.gateway, m.agent, m.registration_block, m.registration_log_index, m.owner, \
                CASE WHEN reg.closed THEN 'revoked' \
                     WHEN reg.live_valid_until IS NOT NULL AND reg.live_valid_until < tip.ts THEN 'expired' \
                     ELSE 'active' END AS status, \
                reg.closed, reg.closed_block, reg.closed_tx, \
                m.valid_until, m.max_per_payment, m.max_per_window, m.window_usage_to_date, \
                m.share_receiver, m.tx_hash, reg.last_block \
         FROM mine m \
         JOIN reg ON reg.gateway IS NOT DISTINCT FROM m.gateway AND reg.agent = m.agent \
                 AND reg.registration_block = m.registration_block \
                 AND reg.registration_log_index = m.registration_log_index \
         CROSS JOIN tip \
         ORDER BY m.agent, m.registration_block, m.registration_log_index, m.owner",
    )
    .bind(state.chain_id)
    .bind(owner)
    .bind(agent)
    .bind(gateway)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                gateway,
                agent,
                registration_block,
                registration_log_index,
                owner,
                status,
                closed,
                closed_block,
                closed_tx_hash,
                valid_until,
                max_per_payment,
                max_per_window,
                window_usage_to_date,
                share_receiver,
                tx_hash,
                last_block,
            )| RegistrationRow {
                registration_id: registration_id(
                    state.chain_id,
                    gateway.as_deref(),
                    registration_block,
                    registration_log_index,
                ),
                gateway,
                agent,
                owner,
                status,
                closed,
                started_block: registration_block,
                closed_block,
                closed_tx_hash,
                valid_until,
                max_per_payment: max_per_payment.as_ref().map(dec_to_string),
                max_per_window: max_per_window.as_ref().map(dec_to_string),
                window_usage_to_date: window_usage_to_date.as_ref().map(dec_to_string),
                share_receiver,
                tx_hash,
                last_block,
            },
        )
        .collect())
}

/// The wire id of a registration, the same text [`REGISTRATION_ID_SQL`] builds for a deposit.
fn registration_id(
    chain_id: i64,
    gateway: Option<&[u8]>,
    registration_block: i64,
    registration_log_index: i32,
) -> String {
    let gateway = gateway
        .map(addr_to_hex)
        .unwrap_or_else(|| "none".to_string());
    format!("{chain_id}:{gateway}:{registration_block}:{registration_log_index}")
}

/// GET /v1/accounts/:address/policies — every agent registration an account owns or owned.
///
/// Registration-aware (issue 1891, RS-1019-18): one entry per registration whose owner is the queried
/// address, with its own policy, status and closing evidence. A registration revoked, or expired and
/// registered again by the same or another owner, stays listed under the owner it had. `?active=true`
/// keeps only the live ones, and `?gateway=0x..` only one gateway deployment's. Returns an empty array
/// (not 404) when the account has none. Chain-scoped to state.chain_id.
async fn get_account_policies(
    State(state): State<AppState>,
    Path(address): Path<String>,
    Query(q): Query<PoliciesQuery>,
) -> ApiResult<Json<AccountPoliciesResponse>> {
    let address_bytes = decode_address_param(&address)?;
    let gateway = q.gateway.as_deref().map(decode_address_param).transpose()?;
    let active_only = q.active.unwrap_or(false);
    let policies: Vec<AccountPolicy> =
        query_registrations(&state, Some(address_bytes.clone()), None, gateway)
            .await?
            .into_iter()
            .filter(|p| !active_only || p.status == "active")
            .map(AccountPolicy::from)
            .collect();

    let freshness = latest_freshness(&state).await?;
    Ok(Json(AccountPoliciesResponse {
        address: addr_to_hex(&address_bytes),
        policies,
        freshness,
    }))
}

fn deposit_from_row(row: DepositRow) -> Deposit {
    let (
        chain_id,
        block_number,
        log_index,
        tx_hash,
        payment_id,
        agent,
        share_receiver,
        amount,
        indexed_at,
        registration_id,
    ) = row;
    Deposit {
        chain_id,
        block_number,
        log_index,
        tx_hash: hash_to_hex(&tx_hash),
        payment_id: hash_to_hex(&payment_id),
        agent: addr_to_hex(&agent),
        share_receiver: addr_to_hex(&share_receiver),
        amount: dec_to_string(&amount),
        indexed_at,
        registration_id,
    }
}

/// Lower-case `0x`-prefixed hex string for an `address` BYTEA (any
/// length — typically 20 bytes for an address, 32 for a hash).
fn addr_to_hex(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn hash_to_hex(b: &[u8]) -> String {
    addr_to_hex(b)
}

/// Validate a 20-byte 0x-prefixed address path parameter and return the
/// raw bytes for binding to a BYTEA column.
fn decode_address_param(s: &str) -> ApiResult<Vec<u8>> {
    let s = s.trim();
    if !s.starts_with("0x") || s.len() != 42 {
        return Err(ApiError::BadRequest("invalid address".into()));
    }
    hex::decode(&s[2..]).map_err(|_| ApiError::BadRequest("invalid address hex".into()))
}

/// Validate a 32-byte 0x-prefixed hash (tx_hash, payment_id) path parameter.
fn decode_hash_param(s: &str) -> ApiResult<Vec<u8>> {
    let s = s.trim();
    if !s.starts_with("0x") || s.len() != 66 {
        return Err(ApiError::BadRequest("invalid hash".into()));
    }
    hex::decode(&s[2..]).map_err(|_| ApiError::BadRequest("invalid hash hex".into()))
}

/// Read the most recent indexer cursor as the freshness header for
/// responses that do not naturally carry one (e.g. an agent with no
/// deposits yet, an empty contract list).
async fn current_freshness(state: &AppState, _chain_id: i64) -> ApiResult<Freshness> {
    latest_freshness(state).await
}

/// The index cursor: the highest block a run WITHOUT AN ERROR committed for this chain, and when the
/// latest such run finished. Never the newest run row: that row is the tick in flight (nothing written
/// yet) or a failed tick, and reading it made `/health` say `null` and every response say `block_number: 0`
/// while the index was at the head (issue 1731). A reorg rollback caps the runs above the root, so the
/// maximum is the durable cursor.
async fn indexer_progress(state: &AppState) -> ApiResult<Option<(i64, DateTime<Utc>)>> {
    // The same definition the indexer resumes from (`Db::last_indexed_block`): the highest cursor of a run
    // with no error. A run in flight has no cursor yet (it is written when the run finishes), so it never
    // counts. `indexed_at` is when the newest such run finished.
    let row: Option<(Option<i64>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT MAX(last_indexed_block), \
                (SELECT COALESCE(r2.finished_at, r2.started_at) FROM indexer_runs r2 \
                  WHERE r2.chain_id = $1 AND r2.error IS NULL AND r2.last_indexed_block IS NOT NULL \
                  ORDER BY r2.run_id DESC LIMIT 1) \
         FROM indexer_runs \
         WHERE chain_id = $1 AND error IS NULL",
    )
    .bind(state.chain_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.and_then(|(b, t)| Some((b?, t?))))
}

/// The chain head the indexer saw on its latest tick that read one; null until there is one.
async fn chain_head_block(state: &AppState) -> ApiResult<Option<i64>> {
    let head: Option<i64> = sqlx::query_scalar(
        "SELECT chain_head_block FROM indexer_runs \
         WHERE chain_id = $1 AND chain_head_block IS NOT NULL \
         ORDER BY run_id DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(head)
}

async fn latest_freshness(state: &AppState) -> ApiResult<Freshness> {
    let (block_number, indexed_at) = indexer_progress(state).await?.unwrap_or((0, Utc::now()));
    Ok(Freshness {
        block_number,
        indexed_at,
    })
}

// ─── Consensus recommendation receipt endpoints ───────────────────────────────────
// Canonical: docs/architecture.md §4.9 — issue #1247.
//
// Read-scope taxonomy (docs/architecture.md §5.0): a route with no `:address`
// segment is PROTOCOL scope; `/v1/accounts/:address/...` is ACCOUNT scope.
// `/v1/consensus-receipts[...]` is protocol scope — the commitment register is
// a whole-protocol public record, not a per-depositor view.
//
// `verified` is DIGEST verification only, recomputed by the indexer. It is NOT
// a claim that each named analyst signed — those ed25519 signatures ride inside
// the payload and are verified off-chain (§4.9.1 answer 1). A client must label
// the payload's signature count as *off-chain analyst signatures*.

/// Default page size for the receipt list endpoints.
const CONSENSUS_RECEIPTS_DEFAULT_LIMIT: i64 = 100;
/// Hard upper bound so a caller cannot ask for an unbounded scan.
const CONSENSUS_RECEIPTS_MAX_LIMIT: i64 = 500;

#[derive(Debug, Deserialize)]
pub struct ConsensusReceiptsQuery {
    pub limit: Option<i64>,
}

/// Clamp a caller-supplied `?limit=` into `[1, CONSENSUS_RECEIPTS_MAX_LIMIT]`.
fn clamp_receipt_limit(limit: Option<i64>) -> ApiResult<i64> {
    match limit {
        None => Ok(CONSENSUS_RECEIPTS_DEFAULT_LIMIT),
        Some(n) if n < 1 => Err(ApiError::BadRequest("limit must be >= 1".into())),
        Some(n) => Ok(n.min(CONSENSUS_RECEIPTS_MAX_LIMIT)),
    }
}

// (contract_address, receipt_id, receipt_index, submitter, payload_digest,
//  payload_uri, recorded_at, block_number, tx_hash, verified, payload_bytes,
//  released, released_at)
//
// T20: `contract_address` leads, because `receipt_id` alone does not identify a
// row any more — it is deployment-independent, and one chain can carry several
// ConsensusRecommendationReceipt deployments.
type ConsensusReceiptRow = (
    Vec<u8>,
    Vec<u8>,
    i64,
    Vec<u8>,
    Vec<u8>,
    String,
    i64,
    i64,
    Vec<u8>,
    bool,
    Option<i64>,
    bool,
    Option<i64>,
);

/// Columns selected by every consensus-receipt query, in `ConsensusReceiptRow`
/// order. Kept in one constant so the three handlers cannot drift apart.
const CONSENSUS_RECEIPT_COLUMNS: &str =
    "contract_address, receipt_id, receipt_index, submitter, payload_digest, \
     payload_uri, recorded_at, block_number, tx_hash, verified, payload_bytes, \
     released, released_at";

fn receipt_from_row(row: ConsensusReceiptRow) -> ConsensusReceipt {
    let (
        contract_address,
        receipt_id,
        index,
        submitter,
        payload_digest,
        payload_uri,
        recorded_at,
        block_number,
        tx_hash,
        verified,
        payload_bytes,
        released,
        released_at,
    ) = row;
    ConsensusReceipt {
        contract_address: format!("0x{}", hex::encode(contract_address)),
        receipt_id: format!("0x{}", hex::encode(receipt_id)),
        index,
        submitter: format!("0x{}", hex::encode(submitter)),
        payload_digest: format!("0x{}", hex::encode(payload_digest)),
        payload_uri,
        recorded_at,
        block_number,
        tx_hash: format!("0x{}", hex::encode(tx_hash)),
        verified,
        // Security round 1: the size of what an unverified URI answered is not served. The URI is
        // chosen on chain and the indexer fetches it from its own network, so the size of an
        // unverified body would publish what an internal host returned.
        payload_bytes: if verified { payload_bytes } else { None },
        released,
        released_at,
    }
}

/// GET /v1/consensus-receipts?limit=
///
/// Protocol scope. Every recorded commitment, newest first. Unreleased and
/// unverified receipts are included — a receipt that governance declined, or
/// whose payload could not be fetched, must be visible as such rather than
/// absent (architecture §4.9.1 answer 3).
async fn list_consensus_receipts(
    State(state): State<AppState>,
    Query(q): Query<ConsensusReceiptsQuery>,
) -> ApiResult<Json<ConsensusReceiptsResponse>> {
    let limit = clamp_receipt_limit(q.limit)?;

    let sql = format!(
        "SELECT {CONSENSUS_RECEIPT_COLUMNS} \
         FROM consensus_receipts \
         WHERE chain_id = $1 \
         ORDER BY block_number DESC, log_index DESC \
         LIMIT $2"
    );
    let rows: Vec<ConsensusReceiptRow> = sqlx::query_as(&sql)
        .bind(state.chain_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;

    let receipts = rows.into_iter().map(receipt_from_row).collect();
    let freshness = latest_freshness(&state).await?;
    Ok(Json(ConsensusReceiptsResponse {
        receipts,
        freshness,
    }))
}

/// GET /v1/consensus-receipts/:receipt_id
///
/// Protocol scope. One commitment by its bytes32 receipt id.
///
/// T20: `receipt_id` is no longer unique within a chain — it is
/// deployment-independent, and the primary key is now
/// `(chain_id, contract_address, receipt_id)`. This route keeps its
/// address-free URL for compatibility and resolves the ambiguity
/// DETERMINISTICALLY, serving the most recently anchored commitment; the
/// response's `contract_address` says which deployment that was. The list
/// routes show every deployment's row.
async fn get_consensus_receipt(
    State(state): State<AppState>,
    Path(receipt_id): Path<String>,
) -> ApiResult<Json<ConsensusReceiptResponse>> {
    let id_bytes = decode_hash_param(&receipt_id)?;

    let sql = format!(
        "SELECT {CONSENSUS_RECEIPT_COLUMNS} \
         FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2 \
         ORDER BY block_number DESC, log_index DESC \
         LIMIT 1"
    );
    let row: Option<ConsensusReceiptRow> = sqlx::query_as(&sql)
        .bind(state.chain_id)
        .bind(&id_bytes)
        .fetch_optional(&state.pool)
        .await?;

    let Some(row) = row else {
        return Err(ApiError::NotFound);
    };

    let freshness = latest_freshness(&state).await?;
    Ok(Json(ConsensusReceiptResponse {
        receipt: receipt_from_row(row),
        freshness,
    }))
}

/// GET /v1/accounts/:address/consensus-receipts?limit=
///
/// Account scope. Receipts anchored by this submitter address, newest first.
async fn list_account_consensus_receipts(
    State(state): State<AppState>,
    Path(address): Path<String>,
    Query(q): Query<ConsensusReceiptsQuery>,
) -> ApiResult<Json<ConsensusReceiptsResponse>> {
    let addr_bytes = decode_address_param(&address)?;
    let limit = clamp_receipt_limit(q.limit)?;

    let sql = format!(
        "SELECT {CONSENSUS_RECEIPT_COLUMNS} \
         FROM consensus_receipts \
         WHERE chain_id = $1 AND submitter = $2 \
         ORDER BY block_number DESC, log_index DESC \
         LIMIT $3"
    );
    let rows: Vec<ConsensusReceiptRow> = sqlx::query_as(&sql)
        .bind(state.chain_id)
        .bind(&addr_bytes)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;

    let receipts = rows.into_iter().map(receipt_from_row).collect();
    let freshness = latest_freshness(&state).await?;
    Ok(Json(ConsensusReceiptsResponse {
        receipts,
        freshness,
    }))
}
