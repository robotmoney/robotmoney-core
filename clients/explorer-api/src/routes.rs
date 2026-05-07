// HTTP route table.
//
// Endpoints are exactly the §11 list:
//   GET /health
//   GET /v1/chains/:chain_id/contracts
//   GET /v1/vault/snapshot/latest
//   GET /v1/vault/snapshots?from_block=&to_block=
//   GET /v1/agents/:address
//   GET /v1/agents/:address/deposits
//   GET /v1/transactions/:tx_hash
//   GET /v1/deposits/:deposit_id
//
// Boundary (§11): only GET methods. Any other method on any path returns
// 405. Any /v1/sign* or /v1/authorize* path falls through to a global 404
// handler. The router-introspection test asserts no non-GET routes exist.

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
    dec_to_string, AgentPolicy, AgentResponse, Contract, ContractsResponse, Deposit,
    DepositResponse, DepositsResponse, Freshness, Health, Transaction, TransactionResponse,
    VaultSnapshot, VaultSnapshotsResponse,
};
use crate::state::AppState;

// Row-type aliases used by `query_as` calls. Postgres returns positional
// tuples; declaring them here keeps clippy happy (`type_complexity`) and
// makes the SELECT column lists self-documenting.
type DepositRow = (
    i64,
    i64,
    i32,
    String,
    String,
    String,
    String,
    BigDecimal,
    DateTime<Utc>,
);
type SnapshotRow = (i64, String, i64, BigDecimal, BigDecimal, DateTime<Utc>);
type TxRow = (i64, i64, String, Option<String>, i16, DateTime<Utc>);

/// Build the application router. All routes are GET-only.
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
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT address, kind, label FROM contracts WHERE chain_id = $1 ORDER BY address",
    )
    .bind(chain_id)
    .fetch_all(&state.pool)
    .await?;
    let contracts = rows
        .into_iter()
        .map(|(address, kind, label)| Contract {
            chain_id,
            address,
            kind,
            label,
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
                contract,
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
    let rows: Vec<SnapshotRow> = sqlx::query_as(
        "SELECT chain_id, contract, block_number, total_assets, total_supply, indexed_at \
         FROM vault_snapshots \
         WHERE block_number BETWEEN $1 AND $2 \
           AND ($3::BIGINT IS NULL OR chain_id = $3) \
           AND ($4::TEXT  IS NULL OR contract = $4) \
         ORDER BY block_number ASC \
         LIMIT 500",
    )
    .bind(from_block)
    .bind(to_block)
    .bind(q.chain_id)
    .bind(q.contract.as_deref())
    .fetch_all(&state.pool)
    .await?;
    let snapshots: Vec<VaultSnapshot> = rows
        .into_iter()
        .map(
            |(chain_id, contract, block_number, ta, ts, ia)| VaultSnapshot {
                chain_id,
                contract,
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
    let address = normalize_address(&address)?;
    let row: Option<(i64, bool, Option<BigDecimal>)> = sqlx::query_as(
        "SELECT block_number, authorized, cap FROM agent_policies \
         WHERE agent = $1 ORDER BY block_number DESC, log_index DESC LIMIT 1",
    )
    .bind(&address)
    .fetch_optional(&state.pool)
    .await?;
    let policy = row.map(|(block_number, authorized, cap)| AgentPolicy {
        agent: address.clone(),
        authorized,
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
    let address = normalize_address(&address)?;
    let rows: Vec<DepositRow> = sqlx::query_as(
        "SELECT chain_id, block_number, log_index, tx_hash, payment_id, agent, token, amount, indexed_at \
         FROM agent_deposits WHERE agent = $1 \
         ORDER BY block_number DESC, log_index DESC LIMIT 500",
    )
    .bind(&address)
    .fetch_all(&state.pool)
    .await?;
    let deposits: Vec<Deposit> = rows
        .into_iter()
        .map(
            |(
                chain_id,
                block_number,
                log_index,
                tx_hash,
                payment_id,
                agent,
                token,
                amount,
                indexed_at,
            )| {
                Deposit {
                    chain_id,
                    block_number,
                    log_index,
                    tx_hash,
                    payment_id,
                    agent,
                    token,
                    amount: dec_to_string(&amount),
                    indexed_at,
                }
            },
        )
        .collect();
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
    let tx_hash = normalize_tx_hash(&tx_hash)?;
    let row: Option<TxRow> = sqlx::query_as(
        "SELECT chain_id, block_number, from_address, to_address, status, indexed_at \
         FROM transactions WHERE tx_hash = $1 LIMIT 1",
    )
    .bind(&tx_hash)
    .fetch_optional(&state.pool)
    .await?;
    let (chain_id, block_number, from_address, to_address, status, indexed_at) =
        row.ok_or(ApiError::NotFound)?;
    let transaction = Transaction {
        chain_id,
        tx_hash,
        block_number,
        from_address,
        to_address,
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
    let deposit_id = normalize_tx_hash(&deposit_id)?;
    let row: Option<DepositRow> = sqlx::query_as(
        "SELECT chain_id, block_number, log_index, tx_hash, payment_id, agent, token, amount, indexed_at \
         FROM agent_deposits WHERE payment_id = $1 LIMIT 1",
    )
    .bind(&deposit_id)
    .fetch_optional(&state.pool)
    .await?;
    let (chain_id, block_number, log_index, tx_hash, payment_id, agent, token, amount, indexed_at) =
        row.ok_or(ApiError::NotFound)?;
    let deposit = Deposit {
        chain_id,
        block_number,
        log_index,
        tx_hash,
        payment_id,
        agent,
        token,
        amount: dec_to_string(&amount),
        indexed_at,
    };
    Ok(Json(DepositResponse {
        freshness: Freshness {
            block_number: deposit.block_number,
            indexed_at: deposit.indexed_at,
        },
        deposit,
    }))
}

/// Lowercase + 0x-prefix sanity check on a 20-byte address.
fn normalize_address(s: &str) -> ApiResult<String> {
    let s = s.trim();
    if !s.starts_with("0x") || s.len() != 42 {
        return Err(ApiError::BadRequest("invalid address".into()));
    }
    if hex::decode(&s[2..]).is_err() {
        return Err(ApiError::BadRequest("invalid address hex".into()));
    }
    Ok(s.to_ascii_lowercase())
}

/// Lowercase + 0x-prefix sanity check on a 32-byte hash (tx_hash, payment_id).
fn normalize_tx_hash(s: &str) -> ApiResult<String> {
    let s = s.trim();
    if !s.starts_with("0x") || s.len() != 66 {
        return Err(ApiError::BadRequest("invalid hash".into()));
    }
    if hex::decode(&s[2..]).is_err() {
        return Err(ApiError::BadRequest("invalid hash hex".into()));
    }
    Ok(s.to_ascii_lowercase())
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
