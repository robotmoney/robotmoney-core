//! Indexer orchestration. The hot path is `run_once`: one tick of the
//! poll loop, factored out so integration tests can drive it directly
//! without a long-running daemon.
//!
//! Sequence per ADR §3.2 / §3.3 / §3.5:
//!
//! 1. Open an `indexer_runs` row.
//! 2. Fetch `eth_blockNumber`; cap the safe head at `tip - CONFIRMATIONS`.
//! 3. Reorg check: compare stored hash for `last_indexed_block` against
//!    the chain's hash at the same height. On mismatch walk back, then
//!    `DELETE WHERE block_number > root` and reset `last_indexed_block`.
//! 4. For the range `[last+1, target]`: fetch all watched logs, fetch
//!    each block (header+txs), upsert blocks/transactions/events.
//! 5. State snapshots — for every contract whose events touched a block
//!    in this range, take a snapshot at that block. Apply heartbeat
//!    snapshot if the last snapshot is more than
//!    `SNAPSHOT_HEARTBEAT_BLOCKS` behind.
//! 6. Close the run with `last_indexed_block = target`.
//!
//! All errors short-circuit and write to the run's `error` column;
//! `last_indexed_block` is left at the last block we successfully
//! committed, so the next run resumes there.

use crate::abi::{IGatewayEvents, IVaultReads, Topics};
use crate::db::{Db, DbError};
use crate::rpc::{JsonRpc, LogEntry, RpcError};
use crate::{CONFIRMATIONS, SNAPSHOT_HEARTBEAT_BLOCKS};
use alloy_primitives::{Address, Bytes, U256};
use alloy_sol_types::{SolCall, SolEvent};
use std::collections::BTreeSet;

#[derive(Debug, thiserror::Error)]
pub enum IndexerError {
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("decode: {0}")]
    Decode(String),
}

#[derive(Debug, Clone)]
pub struct IndexerConfig {
    pub chain_id: i64,
    pub chain_name: String,
    pub rpc_label: String,
    /// Watched gateway address (one per chain).
    pub gateway: Address,
    /// Watched vault address (one per chain).
    pub vault: Address,
    /// Hard cap on per-tick block range. Protects against an unbounded
    /// `eth_getLogs` request when the indexer is far behind tip.
    pub max_blocks_per_tick: u64,
    /// Optional explicit upper bound — useful for bounded test runs.
    /// When `Some(end)`, the indexer never advances past `end`.
    pub end_block: Option<u64>,
}

impl IndexerConfig {
    pub fn watched_addresses(&self) -> Vec<Address> {
        vec![self.gateway, self.vault]
    }
}

#[derive(Debug, Clone, Default)]
pub struct IndexerOutcome {
    pub run_id: i64,
    pub from_block: i64,
    pub to_block: Option<i64>,
    pub last_indexed_block: Option<i64>,
    pub rows_inserted: i64,
    pub reorg_detected: bool,
    pub error: Option<String>,
}

/// One indexer tick. Returns the outcome (also written to `indexer_runs`).
pub async fn run_once(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
) -> Result<IndexerOutcome, IndexerError> {
    // Bookkeeping rows — chains/contracts must exist before any FK insert.
    db.upsert_chain(cfg.chain_id, &cfg.chain_name, &cfg.rpc_label)
        .await?;
    db.upsert_contract(cfg.chain_id, cfg.gateway.into_array(), "gateway", None)
        .await?;
    db.upsert_contract(cfg.chain_id, cfg.vault.into_array(), "vault", None)
        .await?;

    let last_indexed = db.last_indexed_block(cfg.chain_id).await?;
    let from_block = last_indexed.map(|x| x + 1).unwrap_or(0);
    let run_id = db.start_run(cfg.chain_id, from_block).await?;

    let outcome = match run_inner(db, rpc, cfg, last_indexed).await {
        Ok(mut o) => {
            o.run_id = run_id;
            o.from_block = from_block;
            db.finish_run(
                run_id,
                o.to_block,
                o.last_indexed_block,
                if o.reorg_detected { 1 } else { 0 },
                o.rows_inserted,
                None,
            )
            .await?;
            o
        }
        Err(e) => {
            let msg = format!("{e}");
            db.finish_run(run_id, None, last_indexed, 0, 0, Some(&msg))
                .await?;
            IndexerOutcome {
                run_id,
                from_block,
                to_block: None,
                last_indexed_block: last_indexed,
                rows_inserted: 0,
                reorg_detected: false,
                error: Some(msg),
            }
        }
    };
    Ok(outcome)
}

async fn run_inner(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
    last_indexed: Option<i64>,
) -> Result<IndexerOutcome, IndexerError> {
    let topics = Topics::new();

    // Reorg check: compare stored hash for `last_indexed` against chain.
    let mut reorg_detected = false;
    let mut last_indexed = last_indexed;
    if let Some(li) = last_indexed {
        if let Some(stored_hash) = db.get_block_hash(cfg.chain_id, li).await? {
            if let Some(header) = rpc.block_header(li as u64).await? {
                if header.hash.0 != stored_hash {
                    let root = walk_back_to_match(db, rpc, cfg.chain_id, li).await?;
                    db.delete_above_block(cfg.chain_id, root).await?;
                    last_indexed = if root < 0 { None } else { Some(root) };
                    reorg_detected = true;
                }
            }
        }
    }

    let from_block = last_indexed.map(|x| x + 1).unwrap_or(0);

    let tip = rpc.block_number().await?;
    let safe_head = tip.saturating_sub(CONFIRMATIONS);
    if (from_block as u64) > safe_head {
        return Ok(IndexerOutcome {
            to_block: None,
            last_indexed_block: last_indexed,
            rows_inserted: 0,
            reorg_detected,
            ..Default::default()
        });
    }
    let mut target = safe_head;
    if let Some(e) = cfg.end_block {
        target = target.min(e);
    }
    let max_advance = (from_block as u64).saturating_add(cfg.max_blocks_per_tick - 1);
    target = target.min(max_advance);
    if (from_block as u64) > target {
        return Ok(IndexerOutcome {
            to_block: None,
            last_indexed_block: last_indexed,
            rows_inserted: 0,
            reorg_detected,
            ..Default::default()
        });
    }

    let watched = cfg.watched_addresses();
    let topic0 = topics.all_topic0();
    let logs = rpc
        .get_logs(from_block as u64, target, &watched, &topic0)
        .await?;

    // Group logs by (block_number, contract) so we know which blocks
    // need state snapshots per ADR §3.5 trigger 1.
    let mut event_blocks_per_contract: BTreeSet<(u64, Address)> = BTreeSet::new();
    let mut blocks_with_events: BTreeSet<u64> = BTreeSet::new();
    for log in &logs {
        event_blocks_per_contract.insert((log.block_number, log.address));
        blocks_with_events.insert(log.block_number);
    }

    let mut rows_inserted: i64 = 0;

    // Ingest blocks (and their txs) for every block we touch — only
    // those with at least one watched event for now, so we don't pull
    // every tx on Base. The §11 acceptance criterion says "each row
    // carries chain_id and block_number"; non-event blocks aren't
    // required by the schema.
    for &bn in &blocks_with_events {
        let (header, txs) = rpc.block_with_txs(bn).await?;
        let r = db
            .insert_block(
                cfg.chain_id,
                bn as i64,
                header.hash.0,
                header.parent_hash.0,
                header.timestamp as i64,
            )
            .await?;
        rows_inserted += r as i64;
        for t in txs {
            let r = db
                .insert_transaction(
                    cfg.chain_id,
                    t.tx_hash.0,
                    bn as i64,
                    t.tx_index as i32,
                    t.from.into_array(),
                    t.to.map(|a| a.into_array()),
                    t.status as i16,
                )
                .await?;
            rows_inserted += r as i64;
        }
    }

    // Always persist the cursor block header, even when `target` had no
    // watched events. Without a stored hash at `target`, the next tick
    // cannot perform a reorg check (the `get_block_hash` guard short-
    // circuits) and stale rows below a no-event cursor block would
    // survive a reorg undetected (issue #177).
    if !blocks_with_events.contains(&target) {
        if let Some(header) = rpc.block_header(target).await? {
            let r = db
                .insert_block(
                    cfg.chain_id,
                    target as i64,
                    header.hash.0,
                    header.parent_hash.0,
                    header.timestamp as i64,
                )
                .await?;
            rows_inserted += r as i64;
        }
    }

    // Decode + insert events.
    for log in &logs {
        rows_inserted += handle_log(db, cfg, &topics, log).await? as i64;
    }

    // State snapshots — event-driven (one per touched contract per
    // touched block). Heartbeat handled below.
    for (bn, contract) in &event_blocks_per_contract {
        if *contract == cfg.vault {
            rows_inserted += snapshot_vault(db, rpc, cfg, *bn).await? as i64;
        }
    }

    // Heartbeat snapshot — if no event touched the vault in this range
    // and the previous snapshot is more than SNAPSHOT_HEARTBEAT_BLOCKS
    // behind `target`, take one at `target`. (The PK on
    // (chain_id, contract, block_number) makes this naturally
    // deduplicate against any event-driven snapshot.)
    let last_vault_snap: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(block_number) FROM vault_snapshots WHERE chain_id = $1 AND contract = $2",
    )
    .bind(cfg.chain_id)
    .bind(&cfg.vault.into_array()[..])
    .fetch_one(db.pool())
    .await
    .map_err(DbError::from)?;
    let needs_heartbeat = match last_vault_snap {
        Some(prev) => (target as i64 - prev) >= SNAPSHOT_HEARTBEAT_BLOCKS as i64,
        None => true,
    };
    if needs_heartbeat {
        rows_inserted += snapshot_vault(db, rpc, cfg, target).await? as i64;
    }

    Ok(IndexerOutcome {
        to_block: Some(target as i64),
        last_indexed_block: Some(target as i64),
        rows_inserted,
        reorg_detected,
        ..Default::default()
    })
}

/// Walk back from `start` until we find a block whose stored hash
/// matches the on-chain hash. Returns that block number as the reorg
/// root. Returns `-1` if we walk past block 0 without finding a match,
/// which signals the caller to wipe all data (effectively a full
/// re-index).
///
/// A block with **no stored hash** is skipped — a missing hash means the
/// indexer never persisted this block (it had no watched events and was
/// not the cursor). Treating a missing-hash block as a "clean root"
/// would incorrectly stop the walk, leaving stale event rows below the
/// true reorg point undetected (issue #177 bug fix).
async fn walk_back_to_match(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    start: i64,
) -> Result<i64, IndexerError> {
    let mut n = start;
    while n >= 0 {
        let stored = db.get_block_hash(chain_id, n).await?;
        if let Some(stored) = stored {
            if let Some(header) = rpc.block_header(n as u64).await? {
                if header.hash.0 == stored {
                    return Ok(n);
                }
            }
            // Hash mismatch — keep walking back.
        }
        // No stored hash for this height — we never persisted this block
        // so we cannot validate it as a canonical root. Keep walking.
        n -= 1;
    }
    Ok(-1)
}

async fn handle_log(
    db: &Db,
    cfg: &IndexerConfig,
    topics: &Topics,
    log: &LogEntry,
) -> Result<u64, IndexerError> {
    let topic0 = match log.topics.first() {
        Some(t) => *t,
        None => return Ok(0),
    };

    if topic0 == topics.agent_deposit {
        let decoded = IGatewayEvents::AgentDeposit::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentDeposit: {e}")))?;
        let r = db
            .insert_agent_deposit(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.paymentId.0,
                decoded.orderId.0,
                decoded.agent.into_array(),
                decoded.shareReceiver.into_array(),
                decoded.amount,
                decoded.sharesMinted,
                decoded.windowId as i64,
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.agent_authorized {
        let decoded = IGatewayEvents::AgentAuthorized::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentAuthorized: {e}")))?;
        let r = db
            .insert_agent_policy(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                false,
                Some(decoded.validUntil as i64),
                Some(decoded.maxPerPayment),
                Some(decoded.maxPerWindow),
                Some(decoded.shareReceiver.into_array()),
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.agent_revoked {
        let decoded = IGatewayEvents::AgentRevoked::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentRevoked: {e}")))?;
        let r = db
            .insert_agent_policy(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                true,
                None,
                None,
                None,
                None,
            )
            .await?;
        return Ok(r);
    }

    // Vault event triggers — we intentionally do not store these as
    // their own rows in Phase 5; they only drive state snapshots
    // (handled by the caller). Returning 0 here preserves the row
    // count.
    if topic0 == topics.vault_allocated
        || topic0 == topics.vault_pulled
        || topic0 == topics.vault_rebalanced
        || topic0 == topics.vault_exit_fee_charged
        || topic0 == topics.paused
        || topic0 == topics.unpaused
    {
        return Ok(0);
    }

    Ok(0)
}

/// Convert our local `LogEntry` to the `alloy_primitives::Log` shape
/// `SolEvent::decode_log` expects.
fn into_alloy_log(log: &LogEntry) -> alloy_primitives::Log {
    alloy_primitives::Log {
        address: log.address,
        data: alloy_primitives::LogData::new_unchecked(log.topics.clone(), log.data.clone()),
    }
}

/// Read totalAssets / totalSupply / exitFeeBps / tvlCap / paused from
/// the vault at `block` and write a `vault_snapshots` row.
async fn snapshot_vault(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
    block: u64,
) -> Result<u64, IndexerError> {
    let total_assets = call_u256(
        rpc,
        cfg.vault,
        IVaultReads::totalAssetsCall {}.abi_encode(),
        block,
    )
    .await?;
    let total_supply = call_u256(
        rpc,
        cfg.vault,
        IVaultReads::totalSupplyCall {}.abi_encode(),
        block,
    )
    .await?;
    let exit_fee_bps = call_u256(
        rpc,
        cfg.vault,
        IVaultReads::exitFeeBpsCall {}.abi_encode(),
        block,
    )
    .await
    .unwrap_or(U256::ZERO);
    let tvl_cap = call_u256(
        rpc,
        cfg.vault,
        IVaultReads::tvlCapCall {}.abi_encode(),
        block,
    )
    .await
    .unwrap_or(U256::ZERO);
    let paused = call_bool(
        rpc,
        cfg.vault,
        IVaultReads::pausedCall {}.abi_encode(),
        block,
    )
    .await
    .unwrap_or(false);

    db.insert_vault_snapshot(
        cfg.chain_id,
        cfg.vault.into_array(),
        block as i64,
        total_assets,
        total_supply,
        exit_fee_bps.try_into().unwrap_or(0i64),
        tvl_cap,
        paused,
    )
    .await
    .map_err(IndexerError::Db)
}

async fn call_u256(
    rpc: &JsonRpc,
    to: Address,
    data: Vec<u8>,
    block: u64,
) -> Result<U256, IndexerError> {
    let bytes = rpc.eth_call_at(to, Bytes::from(data), block).await?;
    if bytes.len() < 32 {
        return Err(IndexerError::Decode(format!(
            "u256 read: short response ({} bytes)",
            bytes.len()
        )));
    }
    Ok(U256::from_be_slice(&bytes[..32]))
}

async fn call_bool(
    rpc: &JsonRpc,
    to: Address,
    data: Vec<u8>,
    block: u64,
) -> Result<bool, IndexerError> {
    let v = call_u256(rpc, to, data, block).await?;
    Ok(v != U256::ZERO)
}
