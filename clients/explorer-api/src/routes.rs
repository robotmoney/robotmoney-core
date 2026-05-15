// HTTP route table.
//
// Endpoints are exactly the §11 list plus the vault registry additions (issue #296),
// the governance additions (issue #307), and the multi-vault protocol stats
// additions (issue #316):
//   GET /health
//   GET /v1/chains/:chain_id/contracts
//   GET /v1/vault/snapshot/latest
//   GET /v1/vault/snapshots?from_block=&to_block=
//   GET /v1/agents/:address
//   GET /v1/agents/:address/deposits
//   GET /v1/transactions/:tx_hash
//   GET /v1/deposits/:deposit_id
//   GET /v1/vaults
//   GET /v1/vaults/:address
//   GET /v1/router/weights
//   GET /v1/governance/proposals
//   GET /v1/governance/proposals/:id
//   GET /v1/stats
//   GET /v1/router/state
//   GET /v1/accounts/:address/positions
//   GET /v1/accounts/:address/history
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
    dec_to_string, proposal_status_label, AccountHistoryEntry, AccountHistoryResponse,
    AccountPositionsResponse, ActivityEvent, AgentPolicy, AgentResponse, Contract,
    ContractsResponse, Deposit, DepositResponse, DepositsResponse, EventKind, Freshness, Health,
    ProposalDetail, ProposalDetailResponse, ProposalSummary, ProposalsResponse,
    RouterStateResponse, RouterWeightsResponse, StatsResponse, Transaction, TransactionResponse,
    Vault, VaultDetail, VaultDetailResponse, VaultPosition, VaultSnapshot, VaultSnapshotsResponse,
    VaultTvlPoint, VaultWeight, VaultsResponse, VoteEntry, WeightHistoryEntry,
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
);
type SnapshotRow = (i64, Vec<u8>, i64, BigDecimal, BigDecimal, DateTime<Utc>);
type TxRow = (i64, i64, Vec<u8>, Option<Vec<u8>>, i16, DateTime<Utc>);

// (chain_id, vault_address, name, risk_label, status, deposit_cap, total_assets, exit_fee_bps, indexed_at)
type VaultRow = (
    i64,
    Vec<u8>,
    String,
    String,
    i16,
    BigDecimal,
    Option<BigDecimal>,
    Option<i64>,
    DateTime<Utc>,
);

// (vault_address, name, risk_label, status, deposit_cap, indexed_at) — used by get_vault
type VaultDetailRow = (Vec<u8>, String, String, i16, BigDecimal, DateTime<Utc>);

// (block_number, total_assets, total_supply, indexed_at)
type TvlPointRow = (i64, BigDecimal, BigDecimal, DateTime<Utc>);

// Row types for governance queries.
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

// (chain_id, proposal_id, proposer BYTEA, description, created_at, deadline_block, status, votes_for, votes_against, block_number, executed_block, indexed_at)
type ProposalRow = (
    i64,
    i64,
    Vec<u8>,
    String,
    i64,
    i64,
    i16,
    i64,
    i64,
    i64,
    Option<i64>,
    chrono::DateTime<chrono::Utc>,
);

// (voter BYTEA, support, weight NUMERIC, block_number, tx_hash BYTEA)
type VoteRow = (Vec<u8>, bool, BigDecimal, i64, Vec<u8>);

// Row types for the new multi-vault endpoints.

// (chain_id, vault_address, block_number, shares, total_assets, total_supply, indexed_at)
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
/// (tests/router_introspection.rs) reads this source file line by line and
/// asserts that every `.route(` line also contains `get(`.  Rustfmt would
/// split long `.route(...)` calls across multiple lines, causing the test to
/// fail.  The skip keeps all route declarations on one line per §11 invariant.
#[rustfmt::skip]
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/chains/:chain_id/contracts", get(list_contracts))
        .route("/v1/vault/snapshot/latest", get(latest_vault_snapshot))
        .route("/v1/vault/snapshots", get(list_vault_snapshots))
        .route("/v1/agents/:address", get(get_agent))
        .route("/v1/agents/:address/deposits", get(list_agent_deposits))
        .route("/v1/transactions/:tx_hash", get(get_transaction))
        .route("/v1/deposits/:deposit_id", get(get_deposit))
        .route("/v1/vaults", get(list_vaults))
        .route("/v1/vaults/:address", get(get_vault))
        // Governance endpoints (issue #307).
        .route("/v1/router/weights", get(get_router_weights))
        .route("/v1/governance/proposals", get(list_proposals))
        .route("/v1/governance/proposals/:id", get(get_proposal))
        // Multi-vault protocol stats endpoints (issue #316).
        .route("/v1/stats", get(get_stats))
        .route("/v1/router/state", get(get_router_state))
        .route("/v1/accounts/:address/positions", get(get_account_positions))
        .route("/v1/accounts/:address/history", get(get_account_history))
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
    let row: Option<(Option<i64>, Option<i32>)> = sqlx::query_as(
        "SELECT last_indexed_block, reorg_count FROM indexer_runs ORDER BY run_id DESC LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await?;
    let (last_indexed_block, reorg_count) =
        row.map(|(b, r)| (b, r.unwrap_or(0))).unwrap_or((None, 0));
    Ok(Json(Health {
        status: "ok",
        last_indexed_block,
        reorg_count,
    }))
}

async fn list_contracts(
    State(state): State<AppState>,
    Path(chain_id): Path<i64>,
) -> ApiResult<Json<ContractsResponse>> {
    // The canonical schema has no `label` column on `contracts`; surface
    // it as null so the wire format stays stable for existing clients.
    let rows: Vec<(Vec<u8>, String)> =
        sqlx::query_as("SELECT address, kind FROM contracts WHERE chain_id = $1 ORDER BY address")
            .bind(chain_id)
            .fetch_all(&state.pool)
            .await?;
    let contracts = rows
        .into_iter()
        .map(|(address, kind)| Contract {
            chain_id,
            address: addr_to_hex(&address),
            kind,
            label: None,
        })
        .collect();
    let freshness = current_freshness(&state, chain_id).await?;
    Ok(Json(ContractsResponse {
        chain_id,
        contracts,
        freshness,
    }))
}

async fn latest_vault_snapshot(
    State(state): State<AppState>,
) -> ApiResult<Json<VaultSnapshotsResponse>> {
    let row: Option<SnapshotRow> = sqlx::query_as(
        "SELECT chain_id, contract, block_number, total_assets, total_supply, indexed_at \
         FROM vault_snapshots ORDER BY block_number DESC LIMIT 1",
    )
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

async fn list_vault_snapshots(
    State(state): State<AppState>,
    Query(q): Query<SnapshotsQuery>,
) -> ApiResult<Json<VaultSnapshotsResponse>> {
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
           AND ($3::BIGINT IS NULL OR chain_id = $3) \
           AND ($4::BYTEA  IS NULL OR contract = $4) \
         ORDER BY block_number ASC \
         LIMIT 500",
    )
    .bind(from_block)
    .bind(to_block)
    .bind(q.chain_id)
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
    // The canonical schema stores tombstones via `revoked = true`; the
    // wire format keeps the legacy `authorized` boolean (= !revoked) and
    // surfaces `max_per_window` as `cap` (the closest fit per ADR §3.5).
    // Chain scoping: filter agent_policies to state.chain_id so a shared agent
    // address on another chain is invisible here (issue #178).
    let row: Option<(i64, bool, Option<BigDecimal>)> = sqlx::query_as(
        "SELECT block_number, revoked, max_per_window FROM agent_policies \
         WHERE chain_id = $1 AND agent = $2 \
         ORDER BY block_number DESC, log_index DESC LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_optional(&state.pool)
    .await?;
    let policy = row.map(|(block_number, revoked, cap)| AgentPolicy {
        agent: addr_to_hex(&address_bytes),
        authorized: !revoked,
        cap: cap.as_ref().map(dec_to_string),
        block_number,
    });
    let freshness = latest_freshness(&state).await?;
    Ok(Json(AgentResponse { policy, freshness }))
}

async fn list_agent_deposits(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<DepositsResponse>> {
    let address_bytes = decode_address_param(&address)?;
    // Chain scoping: filter agent_deposits to state.chain_id so deposits from
    // the same agent address on another chain are excluded (issue #178).
    let rows: Vec<DepositRow> = sqlx::query_as(
        "SELECT chain_id, block_number, log_index, tx_hash, payment_id, agent, share_receiver, amount, indexed_at \
         FROM agent_deposits \
         WHERE chain_id = $1 AND agent = $2 \
         ORDER BY block_number DESC, log_index DESC LIMIT 500",
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
        "SELECT chain_id, block_number, log_index, tx_hash, payment_id, agent, share_receiver, amount, indexed_at \
         FROM agent_deposits WHERE chain_id = $1 AND payment_id = $2 LIMIT 1",
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
                v.deposit_cap, \
                s.total_assets, \
                s.exit_fee_bps, \
                v.indexed_at \
         FROM vaults v \
         LEFT JOIN LATERAL ( \
             SELECT total_assets, exit_fee_bps \
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
                deposit_cap,
                total_assets,
                exit_fee_bps,
                indexed_at,
            )| {
                Vault {
                    chain_id,
                    address: addr_to_hex(&vault_address),
                    name,
                    risk_label,
                    status,
                    deposit_cap: dec_to_string(&deposit_cap),
                    total_assets: total_assets.as_ref().map(dec_to_string),
                    exit_fee_bps,
                    indexed_at,
                }
            },
        )
        .collect();

    let freshness = latest_freshness(&state).await?;
    Ok(Json(VaultsResponse { vaults, freshness }))
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
        "SELECT vault_address, name, risk_label, status, deposit_cap, indexed_at \
         FROM vaults \
         WHERE chain_id = $1 AND vault_address = $2 \
         LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(&address_bytes[..])
    .fetch_optional(&state.pool)
    .await?;

    let (vault_address, name, risk_label, status, deposit_cap, indexed_at) =
        row.ok_or(ApiError::NotFound)?;

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

    // Freshness is taken from the most recent TVL point if available,
    // otherwise falls back to the indexer cursor.
    let freshness = match tvl_history.last() {
        Some(p) => Freshness {
            block_number: p.block_number,
            indexed_at: p.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };

    let vault = VaultDetail {
        chain_id: state.chain_id,
        address: addr_to_hex(&vault_address),
        name,
        risk_label,
        status,
        deposit_cap: dec_to_string(&deposit_cap),
        tvl_history,
        indexed_at,
    };

    Ok(Json(VaultDetailResponse { vault, freshness }))
}

// ─── Governance handlers (issue #307) ──────────────────────────────────────

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

/// GET /v1/governance/proposals — list all proposals with status and tally.
async fn list_proposals(State(state): State<AppState>) -> ApiResult<Json<ProposalsResponse>> {
    let rows: Vec<ProposalRow> = sqlx::query_as(
        "SELECT chain_id, proposal_id, proposer, description, created_at, deadline_block, \
                status, votes_for, votes_against, block_number, executed_block, indexed_at \
         FROM governance_proposals \
         WHERE chain_id = $1 \
         ORDER BY block_number DESC, proposal_id DESC \
         LIMIT 500",
    )
    .bind(state.chain_id)
    .fetch_all(&state.pool)
    .await?;

    let proposals: Vec<ProposalSummary> = rows
        .into_iter()
        .map(
            |(
                chain_id,
                proposal_id,
                proposer,
                description,
                created_at,
                deadline_block,
                status,
                votes_for,
                votes_against,
                block_number,
                _executed_block,
                indexed_at,
            )| ProposalSummary {
                chain_id,
                proposal_id,
                proposer: addr_to_hex(&proposer),
                description,
                created_at,
                deadline_block,
                status: proposal_status_label(status),
                votes_for,
                votes_against,
                block_number,
                indexed_at,
            },
        )
        .collect();

    let freshness = match proposals.first() {
        Some(p) => Freshness {
            block_number: p.block_number,
            indexed_at: p.indexed_at,
        },
        None => latest_freshness(&state).await?,
    };

    Ok(Json(ProposalsResponse {
        proposals,
        freshness,
    }))
}

/// GET /v1/governance/proposals/:id — single proposal with per-voter tally.
async fn get_proposal(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<ProposalDetailResponse>> {
    let row: Option<ProposalRow> = sqlx::query_as(
        "SELECT chain_id, proposal_id, proposer, description, created_at, deadline_block, \
                status, votes_for, votes_against, block_number, executed_block, indexed_at \
         FROM governance_proposals \
         WHERE chain_id = $1 AND proposal_id = $2 \
         LIMIT 1",
    )
    .bind(state.chain_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;

    let (
        chain_id,
        proposal_id,
        proposer,
        description,
        created_at,
        deadline_block,
        status,
        votes_for,
        votes_against,
        block_number,
        executed_block,
        indexed_at,
    ) = row.ok_or(ApiError::NotFound)?;

    // Fetch per-voter votes.
    let vote_rows: Vec<VoteRow> = sqlx::query_as(
        "SELECT voter, support, weight, block_number, tx_hash \
         FROM governance_votes \
         WHERE chain_id = $1 AND proposal_id = $2 \
         ORDER BY block_number ASC, voter ASC",
    )
    .bind(state.chain_id)
    .bind(proposal_id)
    .fetch_all(&state.pool)
    .await?;

    let votes: Vec<VoteEntry> = vote_rows
        .into_iter()
        .map(|(voter, support, weight, bn, tx)| VoteEntry {
            voter: addr_to_hex(&voter),
            support,
            weight: dec_to_string(&weight),
            block_number: bn,
            tx_hash: hash_to_hex(&tx),
        })
        .collect();

    let proposal = ProposalDetail {
        chain_id,
        proposal_id,
        proposer: addr_to_hex(&proposer),
        description,
        created_at,
        deadline_block,
        status: proposal_status_label(status),
        votes_for,
        votes_against,
        executed_block,
        block_number,
        indexed_at,
        votes,
    };

    Ok(Json(ProposalDetailResponse {
        freshness: Freshness {
            block_number: proposal.block_number,
            indexed_at: proposal.indexed_at,
        },
        proposal,
    }))
}

// ─── Multi-vault protocol stats handlers (issue #316) ─────────────────────

/// GET /v1/stats — aggregate TVL, unique depositor count, and global activity feed.
///
/// TVL = sum of the latest total_assets snapshot per registered vault.
/// Depositor count = distinct share_receiver values in agent_deposits.
/// Activity feed = last 50 deposit events across all vaults (descending by block).
/// Chain-scoped to state.chain_id.
async fn get_stats(State(state): State<AppState>) -> ApiResult<Json<StatsResponse>> {
    // Aggregate TVL: sum of the most recent total_assets per vault.
    let tvl_row: (Option<BigDecimal>,) = sqlx::query_as(
        "SELECT SUM(latest.total_assets) \
         FROM ( \
             SELECT DISTINCT ON (chain_id, contract) total_assets \
             FROM vault_snapshots \
             WHERE chain_id = $1 \
             ORDER BY chain_id, contract, block_number DESC \
         ) AS latest",
    )
    .bind(state.chain_id)
    .fetch_one(&state.pool)
    .await?;
    let total_tvl = tvl_row
        .0
        .as_ref()
        .map(dec_to_string)
        .unwrap_or_else(|| "0".to_string());

    // Unique depositor count.
    let depositor_row: (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT share_receiver)::BIGINT FROM agent_deposits WHERE chain_id = $1",
    )
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
    }))
}

/// GET /v1/router/state — current PortfolioRouter weights and WeightsApplied history.
///
/// Reads router_weight_snapshots (added in migration 0003).  Returns an empty
/// current_weights and empty history when no WeightsApplied events have been
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
///   usdc_value = shares * total_assets / total_supply
/// using the most recent vault_snapshot for that vault.
/// Chain-scoped to state.chain_id.
async fn get_account_positions(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AccountPositionsResponse>> {
    let address_bytes = decode_address_param(&address)?;

    // Latest wallet_position per vault for this owner, joined with the
    // most recent vault_snapshot per vault for the share-price computation.
    let rows: Vec<PositionRow> = sqlx::query_as(
        "SELECT wp.chain_id, wp.contract, wp.block_number, wp.shares, \
                s.total_assets, s.total_supply, wp.indexed_at \
         FROM ( \
             SELECT DISTINCT ON (chain_id, contract) \
                    chain_id, contract, block_number, shares, indexed_at \
             FROM wallet_positions \
             WHERE chain_id = $1 AND owner = $2 \
             ORDER BY chain_id, contract, block_number DESC \
         ) AS wp \
         LEFT JOIN LATERAL ( \
             SELECT total_assets, total_supply \
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
            |(_, contract, block_number, shares, total_assets, total_supply, indexed_at)| {
                // usdc_value = shares * total_assets / total_supply
                // Use BigDecimal arithmetic; guard against zero supply.
                let usdc_value = match (total_assets.as_ref(), total_supply.as_ref()) {
                    (Some(ta), Some(ts)) if ts != &BigDecimal::from(0) => {
                        let val = &shares * ta / ts;
                        Some(dec_to_string(&val.with_scale(0)))
                    }
                    _ => None,
                };
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

/// GET /v1/accounts/:address/history — chronological deposit event log.
///
/// Returns all agent_deposits where share_receiver = address, ordered
/// by block ascending (chronological).  Includes up to 500 rows.
/// Chain-scoped to state.chain_id.
async fn get_account_history(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<AccountHistoryResponse>> {
    let address_bytes = decode_address_param(&address)?;

    let rows: Vec<DepositFeedRow> = sqlx::query_as(
        "SELECT chain_id, block_number, log_index, tx_hash, \
                COALESCE(vault, share_receiver) AS vault, agent, share_receiver, amount, indexed_at \
         FROM agent_deposits \
         WHERE chain_id = $1 AND share_receiver = $2 \
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
                vault,
                agent,
                _share_receiver,
                amount,
                indexed_at,
            )| {
                AccountHistoryEntry {
                    kind: EventKind::Deposit,
                    chain_id,
                    block_number,
                    log_index,
                    tx_hash: hash_to_hex(&tx_hash),
                    vault: addr_to_hex(&vault),
                    agent: addr_to_hex(&agent),
                    amount: dec_to_string(&amount),
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

async fn latest_freshness(state: &AppState) -> ApiResult<Freshness> {
    let row: Option<(Option<i64>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT last_indexed_block, finished_at FROM indexer_runs \
         ORDER BY run_id DESC LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await?;
    let (block_number, indexed_at) = row
        .map(|(b, t)| (b.unwrap_or(0), t.unwrap_or_else(Utc::now)))
        .unwrap_or((0, Utc::now()));
    Ok(Freshness {
        block_number,
        indexed_at,
    })
}
