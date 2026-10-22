//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! Indexer orchestration. The hot path is `run_once`: one tick of the
//! poll loop, factored out so integration tests can drive it directly
//! without a long-running daemon.
//!
//! Sequence per ADR §3.2 / §3.3 / §3.5:
//!
//! 0. Register every configured contract, then DERIVE the first block worth
//!    reading from the chain itself — the lowest block at which those
//!    contracts have code ([`resolve_deploy_floor`]). Detected once, persisted
//!    in `contracts.deployed_block`, and reused on every tick after that.
//! 1. Open an `indexer_runs` row.
//! 2. Fetch `eth_blockNumber`; cap the safe head at `tip - CONFIRMATIONS`.
//! 3. Reorg check: compare stored hash for `last_indexed_block` against
//!    the chain's hash at the same height. On mismatch walk back, then
//!    `DELETE WHERE block_number > root` and reset `last_indexed_block`.
//!    The rows that are not block-numbered are reconciled in the same
//!    transaction: `vaults` (a registration above the root is deleted).
//!    Agent registrations need no reconciliation: every `agent_policies` and
//!    `agent_deposits` row carries its registration, derived when it was
//!    inserted, so deleting the rows above the root and replaying them
//!    reproduces the same boundaries (migration 0031).
//! 4. For the range `[last+1, target]`: fetch all watched logs (the configured
//!    contracts, every `vaults` row whatever its status (DI-2), and each of
//!    those vaults' ExclusionLedger (X7)), fetch the header of each block
//!    that has one, and the receipt of each
//!    transaction that carries one (never the block's other transactions, X6),
//!    upsert blocks/transactions/events. Before that fetch, the registry's
//!    `VaultRegistered` logs of the same range are read first, so a vault
//!    registered inside the range is in the address set and its own logs from
//!    the registration block on are fetched in the same tick (issue 1796,
//!    DI-1). Its ledger is read at its registration block.
//! 5. State snapshots — for every contract whose events touched a block
//!    in this range, take a snapshot at that block. Sampling cadence
//!    (issues 1768, 1781): a vault with no row gets one at the target block.
//!    After that a tick reads the vault at the target only when it emitted a
//!    watched log in the tick, holds nothing (zero TVL), has an unknown cap or
//!    exit value, or its newest row is at least `SNAPSHOT_HEARTBEAT_BLOCKS` (7200 blocks)
//!    behind ([`snapshot_read`]). A read writes a new row only when `total_assets`,
//!    `total_supply`, `exit_fee_bps`, either cap, the paused flag or the exit value
//!    differs from the newest row, except the heartbeat read, which writes an
//!    identical row on purpose. So every vault has a row at least once per
//!    heartbeat interval. A zero-TVL vault is NOT re-snapshotted every tick.
//!    A row with unknown (NULL) caps (issue 1741) is filled by the same
//!    per-tick read once the caps answer, without repeated identical rows.
//!    The exit value is `previewRedeem(totalSupply())`, what redeeming every
//!    share pays after the exit costs; the API prices a position with it
//!    (core 1795, QA plan X8). A row without it (older than migration 0026)
//!    is filled the same way.
//! 6. Close the run with `last_indexed_block = target`.
//!
//! All errors short-circuit and write to the run's `error` column;
//! `last_indexed_block` is left at the last block we successfully
//! committed, so the next run resumes there. A failed run still records the
//! chain head it read in step 2, so the head-minus-cursor lag that `/health`
//! and the watchdog read keeps growing while the indexer is wedged (DI-5).

use crate::abi::{
    IConsensusRecommendationReceiptEvents, IExclusionLedgerEvents, IExclusionLedgerReads,
    IGatewayEvents, IGovernedUpgradeEvents, IPortfolioRouterEvents, IRobotMoneyVaultReads,
    ITimelockEvents, IVaultEvents, IVaultReads, IVaultRegistryEvents, Topics,
};
use crate::db::{Db, DbError, ProxyBackfillProgress, ReceiptVerification};
use crate::rpc::{JsonRpc, LogEntry, RpcError};
use crate::{CONFIRMATIONS, SNAPSHOT_HEARTBEAT_BLOCKS};
use alloy_primitives::{Address, Bytes, U256};
use alloy_sol_types::{SolCall, SolEvent};
use std::collections::{BTreeMap, BTreeSet};

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
    /// Optional watched gateway address (one per chain). The gateway system is indexed independently of
    /// the vaults system (docs/architecture.md section 5.4): with `None` no gateway address is watched,
    /// registered or called, and no gateway table is written.
    pub gateway: Option<Address>,
    /// Watched vault address (one per chain, legacy single-vault config).
    pub vault: Address,
    /// Optional on-chain VaultRegistry contract address.  When set, the
    /// indexer calls `listVaults()` on each tick and ingests
    /// `VaultRegistered` / `VaultStatusChanged` events from the registry.
    pub registry: Option<Address>,
    /// Optional RouterGovernance (the router's weight setter) address. When
    /// set, the indexer registers it in `contracts` (kind `router_governance`)
    /// and counts it toward the deploy-block floor. Its voting events were
    /// deleted with its voting (issue #1698), and the weights it sets are
    /// indexed from the router's own `WeightsSet`. It is watched for its proxy
    /// `Upgraded` / `UpgradesFrozen` events only (issue 1810).
    pub router_governance: Option<Address>,
    /// Optional PortfolioRouter contract address (may differ from
    /// `router_governance`).  When set, the indexer ingests `WeightsSet`
    /// and `DefaultWeightsSet` events emitted by `setWeights()` (which
    /// `RouterGovernance.applyReceipt` calls) / `setDefaultWeights()`, and
    /// watches `RouterDeposit` events to take a fresh TVL snapshot of every
    /// registered vault in any block where a router deposit is processed —
    /// ensuring deposits via the router are reflected in the TVL index without
    /// waiting for the SNAPSHOT_HEARTBEAT_BLOCKS interval.
    pub portfolio_router: Option<Address>,
    /// Optional ConsensusRecommendationReceipt contract address.
    /// When set, the indexer ingests `ReceiptRecorded` and `ReceiptReleased`
    /// events, fetches each receipt's `payloadUri` to recompute its keccak256
    /// digest, and writes to the `consensus_receipts` table
    /// (issue #1247, docs/architecture.md §4.9).
    pub consensus_receipt: Option<Address>,
    /// Optional TimelockController address. When set, the indexer registers it in `contracts` (kind
    /// `timelock`) and ingests `CallScheduled`, `CallExecuted`, `Cancelled` and `MinDelayChange` into
    /// `admin_events` (issue #1731).
    pub timelock: Option<Address>,
    /// Optional Safe address. When set, the indexer registers it in `contracts` (kind `safe`) and ingests
    /// `ExecutionSuccess`, `ExecutionFailure`, `AddedOwner`, `RemovedOwner` and `ChangedThreshold` into
    /// `admin_events` (issue #1731).
    pub safe: Option<Address>,
    /// Hard cap on per-tick block range. Protects against an unbounded
    /// `eth_getLogs` request when the indexer is far behind tip.
    pub max_blocks_per_tick: u64,
    /// Explicit first block to read (issue 1725). When set, it IS the deploy floor and the
    /// `eth_getCode` search is skipped: public Base RPCs are not archive nodes, so that search
    /// degrades to block 0 there. Use the first block of the deployment being watched.
    pub start_block: Option<u64>,
    /// Optional explicit upper bound — useful for bounded test runs.
    /// When `Some(end)`, the indexer never advances past `end`.
    pub end_block: Option<u64>,
    /// Feature flag bitmap loaded from `FEATURE_FLAGS` env var via
    /// `feature_flags::bitmap_from_env()`.  Bit positions are defined in
    /// `config/feature-flags.json` and `feature_flags.rs`.  Default `0`
    /// disables all optional paths (conservative / backwards-compatible).
    pub feature_flags: u64,
}

impl IndexerConfig {
    pub fn watched_addresses(&self) -> Vec<Address> {
        let mut addrs = vec![self.vault];
        if let Some(gw) = self.gateway {
            addrs.insert(0, gw);
        }
        // Gate VaultRegistry event ingestion behind INDEXER_MULTI_VAULT_EVENTS
        // (config/feature-flags.json id=2).
        if crate::feature_flags::is_enabled(
            crate::feature_flags::INDEXER_MULTI_VAULT_EVENTS,
            self.feature_flags,
        ) {
            if let Some(reg) = self.registry {
                addrs.push(reg);
            }
        }
        if let Some(pr) = self.portfolio_router {
            if !addrs.contains(&pr) {
                addrs.push(pr);
            }
        }
        if let Some(cr) = self.consensus_receipt {
            if !addrs.contains(&cr) {
                addrs.push(cr);
            }
        }
        for a in [self.router_governance, self.timelock, self.safe]
            .into_iter()
            .flatten()
        {
            if !addrs.contains(&a) {
                addrs.push(a);
            }
        }
        addrs
    }

    /// Contracts fetched for their proxy `Upgraded` / `UpgradesFrozen` events
    /// ONLY: the registry while `INDEXER_MULTI_VAULT_EVENTS` is off (issue
    /// 1840). The registry is a proxied core contract, so its upgrades and
    /// freeze are indexed whatever the flag says. Its other events
    /// (`VaultRegistered`, `VaultStatusChanged`) stay behind the flag exactly as
    /// before: `run_inner` drops every non-proxy log from these addresses.
    pub fn proxy_only_addresses(&self) -> Vec<Address> {
        let watched = self.watched_addresses();
        self.registry
            .into_iter()
            .filter(|r| !watched.contains(r))
            .collect()
    }

    /// Every contract whose `Upgraded` / `UpgradesFrozen` the indexer records:
    /// the watched set and the proxy-only set, without the Timelock and the
    /// Safe, which are not Robot Money proxies. Registry-discovered vaults are
    /// added by the caller, which reads them from the database.
    pub fn proxy_addresses(&self) -> Vec<Address> {
        let mut out = self.watched_addresses();
        out.extend(self.proxy_only_addresses());
        out.retain(|a| Some(*a) != self.timelock && Some(*a) != self.safe);
        out
    }

    /// Every contract `run_once` registers in `contracts`, paired with the
    /// `kind` it registers under, deduplicated by address.
    ///
    /// First kind wins on a duplicate, which is precisely what the upsert's
    /// `ON CONFLICT` has always produced when `portfolio_router ==
    /// router_governance`: the row keeps `router_governance`. Folding the
    /// registration list into one function keeps it from drifting away from
    /// the set deploy-block detection runs over — a contract worth registering
    /// is a contract whose deploy block bounds the earliest block worth
    /// reading.
    ///
    /// This is deliberately NOT [`Self::watched_addresses`]. The registry is
    /// registered unconditionally but only *watched* behind
    /// `INDEXER_MULTI_VAULT_EVENTS`, and since the floor is a MINIMUM over
    /// this set, including an extra contract can only lower it. A floor that
    /// is too low costs blocks; a floor that is too high loses events.
    pub fn configured_contracts(&self) -> Vec<(Address, &'static str)> {
        let mut out: Vec<(Address, &'static str)> = Vec::new();
        let mut push = |addr: Address, kind: &'static str| {
            if !out.iter().any(|(a, _)| *a == addr) {
                out.push((addr, kind));
            }
        };
        if let Some(gw) = self.gateway {
            push(gw, "gateway");
        }
        push(self.vault, "vault");
        if let Some(reg) = self.registry {
            push(reg, "vault_registry");
        }
        if let Some(gov) = self.router_governance {
            push(gov, "router_governance");
        }
        if let Some(pr) = self.portfolio_router {
            push(pr, "portfolio_router");
        }
        if let Some(cr) = self.consensus_receipt {
            push(cr, "consensus_receipt");
        }
        if let Some(t) = self.timelock {
            push(t, "timelock");
        }
        if let Some(sf) = self.safe {
            push(sf, "safe");
        }
        out
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
    /// The chain head (`eth_blockNumber`) this tick saw. `None` when the tick failed before reading it.
    /// The explorer reports it next to the last indexed block so a reader can see how far behind the index is.
    /// A tick that read the head and then failed records it too (DI-5): a wedged indexer's head keeps moving
    /// while its cursor does not, so `/health` and the watchdog see the lag grow instead of a frozen one.
    pub chain_head_block: Option<i64>,
    /// True when the tick failed because an endpoint refused the request (HTTP 401 or 403). That is a final
    /// answer that retrying every tick cannot change, so the caller backs off instead of hammering.
    pub refused: bool,
}

/// How many ticks of runway still count as "converging" for the lag warning
/// below.
///
/// The budget is in TICKS, not blocks, because that is the unit the operator
/// actually waits in: at the default cadence (`DEFAULT_TICK_SECONDS` = 12 s)
/// 300 ticks is one hour of catching up, which is a long but recoverable cold
/// start. Anything beyond it is not a slow start, it is a broken derivation —
/// the live case that produced this constant was a `from_block` of 0 against an
/// the Twin fork (an anvil lazy fork) head of ~48.9M, i.e. ~49_000 ticks (about seven days)
/// of ticks that could never have succeeded anyway, because that chain holds no
/// history below its fork point. Expressing the threshold in ticks also makes
/// it scale with `max_blocks_per_tick`: raising the per-tick cap raises the gap
/// an operator may legitimately be behind by.
pub const CONVERGENCE_TICK_BUDGET: u64 = 300;

/// Longest wait between ticks while an endpoint keeps refusing the indexer (HTTP 401 or 403).
pub const REFUSAL_BACKOFF_CAP_SECS: u64 = 300;

/// The wait after the `consecutive`-th refusal in a row: the tick interval doubled per refusal, capped at
/// [`REFUSAL_BACKOFF_CAP_SECS`]. A refusal is a final answer, so the indexer slows down instead of asking
/// every tick.
pub fn refusal_backoff(consecutive: u32, tick_seconds: u64) -> std::time::Duration {
    let factor = 1u64
        .checked_shl(consecutive.saturating_sub(1).min(16))
        .unwrap_or(u64::MAX);
    let secs = tick_seconds
        .max(1)
        .saturating_mul(factor)
        .min(REFUSAL_BACKOFF_CAP_SECS);
    std::time::Duration::from_secs(secs)
}

/// One `eth_getCode` probe, classified.
///
/// The point of this enum is that an ERROR is information. Below the earliest
/// block an the Twin fork (an anvil lazy fork) chain can serve, `eth_getCode` does not answer
/// "no code here" — it fails with `BlockOutOfRangeError`, and a search that
/// read that as a failure would give up on exactly the chain that needs the
/// search most.
///
/// [`CodeProbe::Empty`] and [`CodeProbe::BelowHistory`] are distinct verdicts
/// that drive the SAME move, and that collapse from three cases to two moves is
/// what lets one algorithm be correct everywhere: on a full-history Geth devnet
/// it finds the true deploy block, on restored fork state it converges to the
/// earliest servable block where the contract is visible, and on real mainnet
/// it finds the true deploy block instead of scanning from genesis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeProbe {
    /// The address has code at this height — at or above the deploy block.
    Present,
    /// The address has no code at this height — below the deploy block.
    Empty,
    /// The chain holds no state at this height, so it cannot answer: below the
    /// earliest block it can serve.
    BelowHistory,
    /// The probe failed for a reason that says nothing about the height — a
    /// transport error, a stub that answers nothing, an unparseable reply.
    ///
    /// The search ABORTS on this instead of guessing. Guessing "below" walks
    /// the lower bound up towards the head, and a floor at the head misses
    /// every event — the one outcome worse than starting at 0.
    Unusable,
}

/// Does this server-error text mean "that height is below what I can serve"?
///
/// Every backend phrases it differently and none of them use a distinct error
/// code, so the match is on the message. The markers, in the order they were
/// measured:
///
///  * `BlockOutOfRangeError` — the Twin fork (an anvil lazy fork) below the fork point,
///    reported under JSON-RPC code `-32602`.
///  * `not found` — Geth's `header not found`, and Anvil's `block 0x3e8 not
///    found` for a height inside the hole below its restored range.
///
/// `missing trie node` is deliberately NOT a marker here, and the omission is
/// the whole finding. It means the node pruned the STATE at that height, not
/// that it lacks the block, and state availability is not log availability:
/// the same node answers `eth_getLogs` — the read this indexer actually makes
/// — across its entire range. Counted as a boundary it made an ordinary
/// non-archive Base mainnet endpoint (the `--chain-id` 8453 default) answer
/// "below history" to every probe outside its ~128-block state window, so the
/// search converged on roughly `head - 128`, persisted that as the deploy
/// block, and skipped every event the contracts ever emitted while logging a
/// success line. As [`CodeProbe::Unusable`] it aborts detection instead and
/// the tick degrades to floor `0` — slow, and loud.
///
/// `-32602` is matched too, and it is worth saying why that is safe even
/// though it is the generic "invalid params" code. Every probe in one search
/// sends the identical request shape at a different height, so a request that
/// is malformed at one height is malformed at all of them — including at the
/// head, where [`detect_deploy_block`] probes first and gives up. A genuinely
/// malformed request therefore aborts detection rather than being mistaken for
/// a history boundary.
fn is_below_history(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("blockoutofrange") || m.contains("not found") || m.contains("-32602")
}

/// Classify one `eth_getCode` outcome. Pure, so the three classifications are
/// covered without a chain.
pub fn classify_code_probe(outcome: &Result<Bytes, RpcError>) -> CodeProbe {
    match outcome {
        Ok(code) if !code.is_empty() => CodeProbe::Present,
        Ok(_) => CodeProbe::Empty,
        Err(RpcError::Server { message, .. }) if is_below_history(message) => {
            CodeProbe::BelowHistory
        }
        Err(_) => CodeProbe::Unusable,
    }
}

/// Binary-search the lowest block in `0..=head` at which `probe` reports code.
///
/// The caller must already have established [`CodeProbe::Present`] at `head`;
/// that is the invariant `hi` carries, and without it the answer would be
/// `head + 1` dressed up as a deploy block.
///
/// Returns `None` when a probe came back [`CodeProbe::Unusable`] — detection
/// that cannot run must say so, never round down to a guess. About 26 probes
/// per address on a 48.9M-block chain, once.
pub async fn search_lowest_code_block<F, Fut>(head: u64, probe: F) -> Option<u64>
where
    F: Fn(u64) -> Fut,
    Fut: std::future::Future<Output = CodeProbe>,
{
    let mut lo = 0u64;
    let mut hi = head;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match probe(mid).await {
            CodeProbe::Present => hi = mid,
            // Two verdicts, one move: nothing at or below `mid` can be the
            // deploy block, either because the contract was not there yet or
            // because the chain cannot show us that far back.
            CodeProbe::Empty | CodeProbe::BelowHistory => lo = mid + 1,
            CodeProbe::Unusable => return None,
        }
    }
    Some(lo)
}

/// What detection concluded about one address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployBlock {
    /// Lowest block at which this chain shows the address holding code.
    At(u64),
    /// No code even at the head, so this is not a contract on this chain — a
    /// zero-address placeholder, or an address left over from another
    /// deployment. It bounds nothing and is excluded from the floor.
    NoCode,
    /// Could not be determined. Never silently folded into either of the
    /// other two.
    Undetermined,
}

/// Probe one height, and make a below-history verdict EARN belief by asking
/// twice.
///
/// [`CodeProbe::BelowHistory`] is the only verdict derived from an error
/// message rather than from an answer, and it is the only one that is taken as
/// authoritative about every height beneath it — `search_lowest_code_block`
/// walks `lo` above it and never looks there again. One transient reply of that
/// shape (`header not found` from a node restarting mid-search, a load-balanced
/// URL whose pruned backend answered this one probe) therefore converges the
/// search ABOVE the true deploy block, and that number is persisted, so every
/// event below it is skipped for the life of the database with no log line.
///
/// A boundary is a property of the chain, so it is still there a moment later.
/// Noise is not. Asking the same height twice separates them for the price of
/// one extra round trip on exactly the probes that move `lo` on a Twin fork
/// chain. A second answer that DISAGREES is not a boundary and not a reading
/// either — it is proof the first reply was noise — so it aborts detection via
/// [`CodeProbe::Unusable`] rather than picking a winner, and the tick degrades
/// to floor `0` and re-detects next tick.
async fn confirmed_probe(rpc: &JsonRpc, address: Address, block: u64) -> CodeProbe {
    let first = classify_code_probe(&rpc.get_code_at(address, block).await);
    if first != CodeProbe::BelowHistory {
        return first;
    }
    match classify_code_probe(&rpc.get_code_at(address, block).await) {
        CodeProbe::BelowHistory => CodeProbe::BelowHistory,
        second => {
            tracing::warn!(
                contract = %address,
                block,
                ?second,
                "an eth_getCode probe reported this height as below the chain's history and                  then answered differently at the same height; treating the pair as noise                  rather than a history boundary, because believing the first reply would                  raise the derived start block above the deploy block and skip events                  permanently"
            );
            CodeProbe::Unusable
        }
    }
}

/// Probe one address for the lowest block at which it has code.
async fn detect_deploy_block(rpc: &JsonRpc, address: Address, head: u64) -> DeployBlock {
    // Probe the head FIRST, for the search's invariant and for an honest
    // answer to "is this even a contract here?". Without it, an address with
    // no code anywhere would walk the lower bound all the way up and report
    // the head as its deploy block — a floor at the head, which misses every
    // event.
    match classify_code_probe(&rpc.get_code_at(address, head).await) {
        CodeProbe::Present => {}
        CodeProbe::Empty => return DeployBlock::NoCode,
        CodeProbe::BelowHistory | CodeProbe::Unusable => return DeployBlock::Undetermined,
    }
    match search_lowest_code_block(head, |block| confirmed_probe(rpc, address, block)).await {
        Some(block) => DeployBlock::At(block),
        None => DeployBlock::Undetermined,
    }
}

/// Fold per-contract detection results into the floor a tick may not start
/// below: the MINIMUM over the contracts that produced a definite block.
///
/// Pure, so the degradation rules below are covered without a chain or a
/// database. `undetermined` is the count of contracts detection could not
/// answer for, and it is what makes this function refuse rather than average.
///
/// Returning `0` is "behave exactly as this indexer always has": start at
/// `last_indexed + 1`, or at genesis on a fresh database. It is the honest
/// degradation because it is only ever SLOW. The tempting alternative — take
/// the minimum over the contracts we did resolve — is not: that minimum can sit
/// above the deploy block of the contract we failed to resolve, and every event
/// that contract emitted below it would be skipped silently and for ever. Slow
/// is recoverable on the next tick; skipped is not.
pub fn fold_deploy_floor(found: &[u64], undetermined: usize) -> Option<u64> {
    if undetermined > 0 {
        return None;
    }
    found.iter().copied().min()
}

/// What one probe at an ALREADY-PERSISTED deploy block concluded about it.
///
/// A remembered block is a claim about a chain, and `contracts.deployed_block`
/// is keyed by `(chain_id, address)` — which is not a chain identity. Both
/// backends on the stage host run as chain id 918453 at the same deterministic
/// addresses, so a value detected against the Geth devnet reads as perfectly
/// valid to the the Twin fork (an anvil lazy fork) chain that replaced it. That is the same
/// shape as the stale cursor this floor was built to override, one level down,
/// and it is worse: the cursor is re-derived every tick, whereas the floor was
/// trusted for ever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FloorCheck {
    /// The chain now answering still shows code at the remembered block, so it
    /// is a claim about THIS chain.
    Holds,
    /// The chain served the block and there is no code at it. The address was
    /// deployed elsewhere, so the value was recorded against a different chain.
    /// Clear it and re-detect.
    Stale,
    /// The chain could not serve the block at all. Measured on the live
    /// the Twin fork (an anvil lazy fork) devnet: it retains a rolling window of roughly
    /// 3,600 blocks, so a correctly detected floor drops out of history a few
    /// blocks later through nothing but time passing. Treating that as
    /// [`FloorCheck::Stale`] made every tick clear all five contracts,
    /// re-detect, and warn that the chain was "gone" while it was serving
    /// requests normally — about 130 probes a tick, for ever, and an alarm that
    /// was false every time it fired.
    ///
    /// A pruned floor still needs raising, because the old value names a block
    /// nothing can read. It is not evidence of a replaced chain.
    HistoryMoved,
    /// The probe said nothing about the block. Keep the remembered value: there
    /// is no evidence against it, and discarding a good floor on a flaky round
    /// trip would re-run the full search every tick.
    Inconclusive,
}

/// Read one validation probe. Pure, so the three outcomes are covered without a
/// chain.
pub fn classify_floor_check(probe: CodeProbe) -> FloorCheck {
    match probe {
        CodeProbe::Present => FloorCheck::Holds,
        // These two do NOT say the same thing, and collapsing them cost a
        // per-tick re-detect on every pruning chain. "The chain served that
        // height and there is no code" means the address was deployed
        // somewhere else — a different chain. "The chain cannot serve that
        // height" means only that its retained history no longer reaches back
        // that far, which is ordinary behaviour for a rolling-window node and
        // says nothing about which chain is answering.
        CodeProbe::Empty => FloorCheck::Stale,
        CodeProbe::BelowHistory => FloorCheck::HistoryMoved,
        CodeProbe::Unusable => FloorCheck::Inconclusive,
    }
}

/// Derive the first block worth reading, from the chain itself. No setting.
///
/// The semantically correct start is the block at which the watched contracts
/// came into existence, and the indexer already knows every one of their
/// addresses — it registers them just above this call. So it asks the chain,
/// once, and remembers the answer in `contracts.deployed_block`.
///
/// REVALIDATION: a remembered floor is re-checked with ONE `eth_getCode` probe
/// per tick, at the minimum of the persisted values — the only one that can
/// move `from_block`, since the floor is that minimum, and a stale value above
/// it can only be higher than a floor already in force. Anything but
/// [`CodeProbe::Present`] there clears `contracts.deployed_block` for every
/// watched contract on this chain and re-detects, because the chain that
/// answered is not the chain the values were recorded against. Without it the
/// bug this whole derivation fixes comes back one level down and permanently:
/// the Geth devnet persists `deployed_block = 4`, the backend is swapped for
/// the Twin fork (an anvil lazy fork) on the same Postgres, and every later tick takes floor
/// 4, keeps the dead cursor of 5999 because `6000 >= 4`, and fails on
/// `eth_getLogs` for ever with no line in the log saying why.
///
/// COST: detection costs ~26 `eth_getCode` probes per address on a 48.9M-block
/// chain (up to twice that where the chain answers below-history, because
/// [`confirmed_probe`] makes that verdict earn belief) and runs only for
/// addresses whose block is not already persisted, so a steady-state tick
/// spends one SELECT per contract and one probe. An address with no code at
/// all (a placeholder such as `Address::ZERO`) is the one case that re-detects
/// each tick — a single probe at the head — because "definitively not a
/// contract here" has no representation in a nullable `BIGINT`, and inventing a
/// sentinel for it would put a lie in a column named `deployed_block`.
///
/// DEGRADATION: every failure path returns `0`, which is today's behaviour, and
/// says why at WARN. Detection that cannot run must never become "start at the
/// head".
pub async fn resolve_deploy_floor(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
    stored_cursor: Option<i64>,
) -> u64 {
    if let Some(block) = configured_start_floor(cfg) {
        tracing::info!(
            start_block = block,
            chain_id = cfg.chain_id,
            "INDEXER_START_BLOCK is set; using it as the deploy floor and skipping eth_getCode detection"
        );
        return block;
    }
    let contracts = cfg.configured_contracts();
    if contracts.is_empty() {
        tracing::warn!(
            chain_id = cfg.chain_id,
            "no watched contracts configured, so there is nothing to derive a start block \
             from; falling back to indexing from the stored cursor (or genesis)"
        );
        return 0;
    }

    let mut cached: Vec<(Address, &'static str, u64)> = Vec::new();
    let mut to_detect: Vec<(Address, &'static str)> = Vec::new();
    for (address, kind) in contracts {
        match db.deployed_block(cfg.chain_id, address.into_array()).await {
            // A negative stored value is not a block; re-detect rather than
            // trust it.
            Ok(Some(block)) if block >= 0 => cached.push((address, kind, block as u64)),
            Ok(_) => to_detect.push((address, kind)),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    contract = %address,
                    chain_id = cfg.chain_id,
                    "cannot read the persisted deploy block; falling back to indexing from \
                     the stored cursor (or genesis)"
                );
                return 0;
            }
        }
    }

    // A floor only matters while the cursor is BELOW it. `from_block` is
    // `max(cursor + 1, floor)`, so once the cursor has caught up, the floor
    // cannot change what this tick reads and revalidating it is pure cost —
    // which on a rolling-window node is also a probe that fails every tick by
    // construction, because the recorded block keeps ageing out of history.
    // Steady state is therefore one SELECT per contract and no probe at all.
    if to_detect.is_empty() {
        if let Some(&(_, _, min_block)) = cached.iter().min_by_key(|(_, _, b)| *b) {
            if stored_cursor.is_some_and(|c| c >= 0 && (c as u64).saturating_add(1) >= min_block) {
                return min_block;
            }
        }
    }

    // Make the remembered floor prove it belongs to the chain now answering,
    // before anything is derived from it. One probe, at the minimum — see
    // REVALIDATION above for why that one is enough and why trusting it blindly
    // reintroduces the original bug permanently.
    if let Some(&(address, _, block)) = cached.iter().min_by_key(|(_, _, b)| *b) {
        match classify_floor_check(confirmed_probe(rpc, address, block).await) {
            FloorCheck::Holds => {}
            FloorCheck::Inconclusive => tracing::warn!(
                contract = %address,
                deployed_block = block,
                chain_id = cfg.chain_id,
                "could not re-check the persisted deploy block against the chain; keeping it \
                 for this tick, because there is no evidence against it and discarding a good \
                 floor on a flaky round trip would re-run the whole search every tick"
            ),
            outcome @ (FloorCheck::Stale | FloorCheck::HistoryMoved) => {
                // Same mechanics either way — the old value names a block that
                // cannot be read, so it has to be replaced. Only the diagnosis
                // differs, and saying "the chain is gone" about a node that is
                // simply pruning is an alarm that is false every time it fires.
                if outcome == FloorCheck::Stale {
                    tracing::warn!(
                        contract = %address,
                        stale_deployed_block = block,
                        chain_id = cfg.chain_id,
                        "the chain now answering serves this block but shows no contract code \
                         at it, so these values were recorded against a chain that is gone (the \
                         chain id is reused across backends); clearing contracts.deployed_block \
                         for every watched contract on this chain and re-detecting now — the \
                         newly detected numbers are logged per contract below"
                    );
                } else {
                    tracing::info!(
                        contract = %address,
                        pruned_deployed_block = block,
                        chain_id = cfg.chain_id,
                        "the chain's retained history no longer reaches the recorded deploy \
                         block, which is ordinary for a rolling-window node and is NOT evidence \
                         of a replaced chain; raising the floor to the earliest block still \
                         readable and re-detecting now"
                    );
                }
                for (address, kind, stale) in std::mem::take(&mut cached) {
                    if let Err(e) = db
                        .clear_deployed_block(cfg.chain_id, address.into_array())
                        .await
                    {
                        // Re-detect anyway: this tick gets a correct floor, and
                        // the value simply will not stick until the clear
                        // succeeds.
                        tracing::warn!(
                            error = %e,
                            contract = %address,
                            stale_deployed_block = stale,
                            "could not clear the stale deploy block; re-detecting it for this \
                             tick and retrying the clear next tick"
                        );
                    }
                    to_detect.push((address, kind));
                }
            }
        }
    }

    let mut found: Vec<u64> = cached.iter().map(|&(_, _, block)| block).collect();

    if to_detect.is_empty() {
        return fold_deploy_floor(&found, 0).unwrap_or(0);
    }

    let head = match rpc.block_number().await {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(
                error = %e,
                chain_id = cfg.chain_id,
                pending = to_detect.len(),
                "cannot read the chain head, so deploy-block detection cannot run; falling \
                 back to indexing from the stored cursor (or genesis) and retrying next tick"
            );
            return 0;
        }
    };

    let mut undetermined = 0usize;
    for (address, kind) in to_detect {
        match detect_deploy_block(rpc, address, head).await {
            DeployBlock::At(block) => {
                // Persist through the upsert, whose conflict arm fills a NULL
                // `deployed_block` — the row already exists from the
                // registration above, so a DO NOTHING here would detect the
                // same value on every tick for ever.
                let stored: i64 = block.try_into().unwrap_or(i64::MAX);
                match db
                    .upsert_contract(cfg.chain_id, address.into_array(), kind, Some(stored))
                    .await
                {
                    Ok(_) => tracing::info!(
                        contract = %address,
                        kind,
                        deployed_block = block,
                        head,
                        chain_id = cfg.chain_id,
                        "detected the lowest block at which this contract has code; persisted \
                         to contracts.deployed_block and reused from here on"
                    ),
                    Err(e) => {
                        // The value is right, only the remembering failed. Use
                        // it for this tick and re-detect next tick.
                        tracing::warn!(
                            error = %e,
                            contract = %address,
                            deployed_block = block,
                            "detected the deploy block but could not persist it; using it for \
                             this tick and re-detecting next tick"
                        );
                    }
                }
                found.push(block);
            }
            DeployBlock::NoCode => tracing::info!(
                contract = %address,
                kind,
                head,
                chain_id = cfg.chain_id,
                "watched contract has no code at the chain head, so it is not deployed on \
                 this chain; it bounds nothing and is excluded from the start block"
            ),
            DeployBlock::Undetermined => {
                undetermined += 1;
                tracing::warn!(
                    contract = %address,
                    kind,
                    head,
                    chain_id = cfg.chain_id,
                    "deploy-block detection could not answer for this contract"
                );
            }
        }
    }

    match fold_deploy_floor(&found, undetermined) {
        Some(floor) => floor,
        None if undetermined > 0 => {
            tracing::warn!(
                undetermined,
                resolved = found.len(),
                chain_id = cfg.chain_id,
                "deploy-block detection failed for at least one watched contract; falling \
                 back to indexing from the stored cursor (or genesis) rather than from the \
                 minimum over the rest, because that minimum can sit above the unresolved \
                 contract's deploy block and would skip its events silently"
            );
            0
        }
        None => {
            tracing::warn!(
                chain_id = cfg.chain_id,
                head,
                "no watched contract has code on this chain, so no start block can be \
                 derived; falling back to indexing from the stored cursor (or genesis)"
            );
            0
        }
    }
}

/// Where a tick's cursor resolves to, decided BEFORE the reorg check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorStart {
    /// The cursor the tick should treat as "last indexed".
    pub cursor: Option<i64>,
    /// The stored cursor that the derived floor discarded, when it discarded
    /// one. `None` on every path where the stored cursor survived.
    pub overridden: Option<i64>,
}

/// Reconcile the stored cursor against the derived deploy floor.
///
/// A stored cursor whose next block is at or above `deploy_floor` always wins,
/// so on a Geth deployment — where the floor is the small true deploy block — a
/// healthy cursor is untouched and nothing about the existing behaviour
/// changes. When detection could not run the floor is `0`, and then nothing can
/// be overridden at all.
///
/// A stored cursor BELOW the floor is discarded, and that is what makes the
/// stale-cursor case correct rather than merely configured. Both the Geth and
/// the Anvil backend run as chain id 918453, so a cursor of 5999 left by a
/// destroyed Geth chain looks perfectly valid to a fresh Anvil fork on which
/// block 5999 does not exist. That is the shape of the project's own note 9: a
/// plausible record from a chain that is gone.
///
/// The discard is expressed as `cursor: None`, NOT as a rollback, and the
/// distinction matters twice:
///
///  * The reorg check in `run_inner` is keyed on `Some(last_indexed)`. Handing
///    it 5999 would make it fetch a header this chain never had and, on a
///    backend that answers with *something*, mistake a dead cursor for a reorg
///    and run `walk_back_to_match` / `delete_above_block` over it.
///  * `rollback_cursor` (IDX-2) is seeded from this same value, so returning
///    `None` keeps the error arm from persisting a cursor pointing at a block
///    the chain cannot serve.
pub fn resolve_cursor_start(last_indexed: Option<i64>, deploy_floor: u64) -> CursorStart {
    let floor: i64 = deploy_floor.try_into().unwrap_or(i64::MAX);
    match last_indexed {
        Some(li) if li.saturating_add(1) < floor => CursorStart {
            cursor: None,
            overridden: Some(li),
        },
        other => CursorStart {
            cursor: other,
            overridden: None,
        },
    }
}

/// The first block a tick reads: `max(last_indexed + 1, deploy_floor)`.
///
/// Both `from_block` sites go through this, so the pre- and post-reorg cursors
/// obey the same floor. A reorg that walks the root below the floor resumes at
/// the floor rather than at blocks that hold nothing, or that the chain cannot
/// serve at all.
pub fn first_block(last_indexed: Option<i64>, deploy_floor: u64) -> i64 {
    let resume = last_indexed.map(|x| x.saturating_add(1)).unwrap_or(0);
    let floor: i64 = deploy_floor.try_into().unwrap_or(i64::MAX);
    resume.max(floor)
}

/// The operator-configured first block, when there is one. Pure so the rule is testable without a chain.
pub fn configured_start_floor(cfg: &IndexerConfig) -> Option<u64> {
    cfg.start_block
}

/// One indexer tick. Returns the outcome (also written to `indexer_runs`).
pub async fn run_once(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
) -> Result<IndexerOutcome, IndexerError> {
    // Bookkeeping rows — chains/contracts must exist before any FK insert, and
    // before detection, which fills in the `deployed_block` of rows written
    // here.  `configured_contracts()` is the same list this used to spell out
    // inline, deduplicated the same way the upsert's ON CONFLICT already was.
    db.upsert_chain(cfg.chain_id, &cfg.chain_name, &cfg.rpc_label)
        .await?;
    for (address, kind) in cfg.configured_contracts() {
        db.upsert_contract(cfg.chain_id, address.into_array(), kind, None)
            .await?;
    }

    // Ask the chain where its own history usefully begins.  Cheap after the
    // first tick (one SELECT per contract) and never fatal: every failure path
    // returns 0, which is exactly how this indexer behaved before.
    // Read the cursor FIRST: a floor only matters while the cursor is below it,
    // and resolve_deploy_floor skips its revalidation probe entirely once the
    // cursor has caught up.
    let stored_cursor = db.last_indexed_block(cfg.chain_id).await?;
    let deploy_floor = resolve_deploy_floor(db, rpc, cfg, stored_cursor).await;
    // Reconcile the stored cursor with the derived floor BEFORE anything reads
    // it — before the reorg check, and before `rollback_cursor` is seeded from
    // it.
    let start = resolve_cursor_start(stored_cursor, deploy_floor);
    if let Some(discarded) = start.overridden {
        // Never jump silently. This discards an indexed range, and a silent
        // discard is exactly how the 48.9M-block version of this bug stayed
        // invisible for a week of ticks. Name BOTH numbers and the reason.
        tracing::info!(
            stored_cursor = discarded,
            deploy_floor,
            chain_id = cfg.chain_id,
            "stored cursor is below the block the watched contracts came into \
             existence at; ignoring it and starting at that block instead — rows \
             at or below the stored cursor are left in place but are no longer \
             the resume point (a cursor from a chain that no longer exists reads \
             as valid because the chain id is reused)"
        );
    }
    let last_indexed = start.cursor;
    let from_block = first_block(last_indexed, deploy_floor);
    let run_id = db.start_run(cfg.chain_id, from_block).await?;

    // IDX-2: `run_inner` may roll a reorg back via `delete_above_block` and
    // *then* fail (e.g. an RPC error fetching the new range).  The corrected
    // post-rollback cursor must survive into the error arm — recording the
    // stale pre-reorg cursor here would leave the next run resuming above the
    // deleted blocks.  `run_inner` writes the post-rollback cursor into
    // `rollback_cursor` before any fallible step that follows the rollback, so
    // the error arm persists `root` (the durable cursor) rather than the
    // pre-reorg value captured above.
    //
    // Seeded from the FLOOR-RESOLVED cursor, not the stored one: when the
    // derived deploy floor discarded the stored cursor this is `None`, so the
    // error arm cannot persist a cursor pointing at a block this chain never
    // had.
    let mut rollback_cursor = last_indexed;
    // The chain head `run_inner` read, published as soon as it is read so the error arm can record it
    // (DI-5). Without it a tick that fails after `eth_blockNumber` (an FK miss, a refused `eth_getLogs`)
    // left `chain_head_block` NULL, the newest recorded head stayed where the last good tick saw it, and a
    // wedged indexer read as "5 blocks behind" forever.
    let mut seen_head: Option<i64> = None;

    // T12: drain a bounded batch of the unverified-receipt backlog every tick.
    // Deliberately BEFORE `run_inner`, so it runs on a tick whose log scan later
    // fails: repairing a stale `verified = false` must not depend on the chain
    // being reachable, and the payload host and the RPC fail independently.
    //
    // The sweep runs under a SWEEP_TIME_BUDGET deadline.
    let sweep_deadline = tokio::time::Instant::now() + SWEEP_TIME_BUDGET;
    let repaired = sweep_unverified_receipts(db, cfg, sweep_deadline).await;
    if repaired > 0 {
        tracing::info!(
            repaired,
            "consensus receipt re-verification sweep repaired rows this tick"
        );
    }

    let outcome = match run_inner(
        db,
        rpc,
        cfg,
        last_indexed,
        deploy_floor,
        &mut rollback_cursor,
        &mut seen_head,
    )
    .await
    {
        Ok(mut o) => {
            o.run_id = run_id;
            o.from_block = from_block;
            if let Some(head) = o.chain_head_block {
                db.set_run_chain_head(run_id, head).await?;
            }
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
            let refused = matches!(&e, IndexerError::Rpc(RpcError::Refused { .. }));
            // Persist the post-rollback cursor, not the pre-reorg one.  Note
            // this run row is `error IS NOT NULL` so it is excluded from the
            // `last_indexed_block()` MAX; the durable cursor reconciliation
            // happens inside `delete_above_block`, which caps any successful
            // run's cursor down to root.  Recording `rollback_cursor` here
            // keeps the failed run's audit row internally consistent with the
            // rollback.
            //
            // The head this tick read is recorded even though the tick failed
            // (DI-5): it is what makes a wedged indexer's lag grow.
            if let Some(head) = seen_head {
                db.set_run_chain_head(run_id, head).await?;
            }
            db.finish_run(run_id, None, rollback_cursor, 0, 0, Some(&msg))
                .await?;
            IndexerOutcome {
                run_id,
                from_block,
                to_block: None,
                last_indexed_block: rollback_cursor,
                rows_inserted: 0,
                reorg_detected: false,
                error: Some(msg),
                chain_head_block: seen_head,
                refused,
            }
        }
    };
    Ok(outcome)
}

/// The last block of the tick that starts at `from_block`: the safe head, bounded by `end_block` and
/// by `max_blocks_per_tick` blocks from `from_block`. `None` when there is nothing to read.
pub fn tick_target(
    from_block: u64,
    safe_head: u64,
    end_block: Option<u64>,
    max_blocks_per_tick: u64,
) -> Option<u64> {
    let mut target = safe_head;
    if let Some(e) = end_block {
        target = target.min(e);
    }
    target = target.min(from_block.saturating_add(max_blocks_per_tick.max(1) - 1));
    (from_block <= target).then_some(target)
}

/// What one `exclusionLedger()` read of a vault said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerRead {
    /// The vault's ledger: a `RobotMoneyVault`.
    Ledger(Address),
    /// The vault has no `exclusionLedger()` (the call reverted, or answered a word that is not an
    /// address): a `BasketVault`. Final, and stored so the vault is not read again.
    NoLedger,
    /// No answer yet: no code at the read block (the configured vault before its deployment), a
    /// proxy not yet initialized (the zero address), or a reply that did not decode. Not stored,
    /// so the next tick reads again.
    Unknown,
}

/// Classify the reply of `exclusionLedger()` on a vault (QA plan security round 1, core 1820).
///
/// A revert is a final "no ledger": `exclusionLedger()` is a plain storage getter, and only a
/// contract without it (a `BasketVault`, also behind its proxy) reverts. Any other server error
/// (`header not found`, `missing trie node`), a refused endpoint or a transport failure is
/// returned as an error, so the tick fails and its cursor stays: a ledger the indexer failed to
/// read would lose its events for the whole range.
pub fn classify_ledger_read(reply: Result<Bytes, RpcError>) -> Result<LedgerRead, RpcError> {
    match reply {
        Ok(bytes) if bytes.len() >= 32 => {
            let word = &bytes[..32];
            if word[..12].iter().any(|b| *b != 0) {
                return Ok(LedgerRead::NoLedger);
            }
            let ledger = Address::from_slice(&word[12..]);
            Ok(if ledger == Address::ZERO {
                LedgerRead::Unknown
            } else {
                LedgerRead::Ledger(ledger)
            })
        }
        Ok(_) => Ok(LedgerRead::Unknown),
        Err(RpcError::Server { message, .. })
            if message.to_ascii_lowercase().contains("revert") =>
        {
            Ok(LedgerRead::NoLedger)
        }
        Err(RpcError::Decode { .. }) => Ok(LedgerRead::Unknown),
        Err(e) => Err(e),
    }
}

/// The `ExclusionLedger`s of each vault in `vaults` that has one, read from the chain (QA plan X7,
/// core 1820; security rounds 1 to 3), oldest first.
///
/// Every vault is a governed proxy (ADR-0014). Its initializer creates the ledger
/// (`contracts/RobotMoneyVault.sol`), so nothing about the vault's own address predicts it. The indexer used to derive it as the vault's
/// CREATE address at nonce 1 (true while the vault constructor ran `new ExclusionLedger`): on a
/// proxy that address holds no code, and no exclusion record was ever indexed.
///
/// The vault's own `exclusionLedger()` getter is the authority. Each entry of `vaults` is a vault
/// and the block to read it at: the first block of the tick's range, or a new vault's registration
/// block. A vault with no stored answer is read there once ([`read_ledger_at`]) and the answer is
/// stored in `vault_exclusion_ledgers` as of the block it was read at. Later ticks read the table,
/// plus one read per `Upgraded` or `Initialized` event of the vault
/// ([`exclusion_ledgers_moved_by_upgrades`]): a reinitializer is the one way to move the ledger.
/// Every ledger a vault ever named stays in the answer, so a late claim against an old ledger still
/// indexes. The emitter gate of `handle_log` ([`vault_of_exclusion_ledger`]) accepts an
/// exclusion-record event only from a ledger stored here.
///
/// Security round 3: the read used to be made at the tick's safe head. A rebuild from the deploy
/// floor, or a vault discovered after a ledger move, then stored only the newest ledger, and the
/// older ledger's records, recoveries and claims were never fetched. Read at the range's own block,
/// the first answer is the ledger of that time, and each later move is a trigger in the range.
pub async fn exclusion_ledgers_of(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    vaults: &[(Address, u64)],
    safe_head: u64,
) -> Result<BTreeMap<Address, Vec<Address>>, IndexerError> {
    let mut stored: BTreeMap<[u8; 20], Vec<Option<[u8; 20]>>> = BTreeMap::new();
    for (vault, ledger) in db.vault_exclusion_ledgers(chain_id).await? {
        stored.entry(vault).or_default().push(ledger);
    }
    let mut out = BTreeMap::new();
    for &(vault, read_block) in vaults {
        let ledgers: Vec<Address> = match stored.get(&vault.into_array()) {
            Some(answers) => answers
                .iter()
                .flatten()
                .map(|l| Address::from(*l))
                .collect(),
            None => {
                match read_exclusion_ledger(db, rpc, chain_id, vault, read_block, safe_head).await?
                {
                    LedgerRead::Ledger(ledger) => vec![ledger],
                    LedgerRead::NoLedger | LedgerRead::Unknown => Vec::new(),
                }
            }
        };
        if !ledgers.is_empty() {
            out.insert(vault, ledgers);
        }
    }
    Ok(out)
}

/// Read `vault`'s `exclusionLedger()` at `block` (the state after that block), and say which block
/// answered (security round 3).
///
/// A node that keeps no state at `block` (a pruned, non-archive node answers `missing trie node`,
/// or a provider refuses an archive call) is asked at `safe_head` instead, which every node holds.
/// That answer names only the vault's newest ledger, so on such a node a ledger the vault moved
/// away from before `safe_head` is learned only by an indexer that was live before the move. A
/// transport failure is returned as an error, so the tick fails and reads again.
async fn read_ledger_at(
    rpc: &JsonRpc,
    vault: Address,
    block: u64,
    safe_head: u64,
) -> Result<(LedgerRead, u64), IndexerError> {
    let data = Bytes::from(IRobotMoneyVaultReads::exclusionLedgerCall {}.abi_encode());
    match classify_ledger_read(rpc.eth_call_at(vault, data.clone(), block).await) {
        Ok(read) => Ok((read, block)),
        Err(e @ (RpcError::Server { .. } | RpcError::Refused { .. })) if block != safe_head => {
            tracing::warn!(
                vault = %vault,
                block,
                safe_head,
                error = %e,
                "the node holds no state to read the vault's exclusionLedger() at this block; \
                 reading it at the safe head instead, so a ledger the vault named only before \
                 then is not learned (use an archive RPC to index every ledger)"
            );
            let read = classify_ledger_read(rpc.eth_call_at(vault, data, safe_head).await)?;
            Ok((read, safe_head))
        }
        Err(e) => Err(e.into()),
    }
}

/// Read `vault`'s `exclusionLedger()` at `read_block` ([`read_ledger_at`]) and store a final
/// answer (a ledger, or no ledger) as of the block that answered. An [`LedgerRead::Unknown`]
/// answer (no code or no initialized ledger there yet) is not stored, and the vault is read again
/// next tick.
async fn read_exclusion_ledger(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    vault: Address,
    read_block: u64,
    safe_head: u64,
) -> Result<LedgerRead, IndexerError> {
    let (read, answered_at) = read_ledger_at(rpc, vault, read_block, safe_head).await?;
    match read {
        LedgerRead::Ledger(ledger) => {
            db.insert_vault_exclusion_ledger(
                chain_id,
                vault.into_array(),
                Some(ledger.into_array()),
                answered_at as i64,
            )
            .await?;
            tracing::info!(
                vault = %vault,
                ledger = %ledger,
                read_block = answered_at,
                "vault's ExclusionLedger read from the chain"
            );
        }
        LedgerRead::NoLedger => {
            db.insert_vault_exclusion_ledger(
                chain_id,
                vault.into_array(),
                None,
                answered_at as i64,
            )
            .await?;
        }
        LedgerRead::Unknown => {
            tracing::debug!(
                vault = %vault,
                read_block = answered_at,
                "vault named no ExclusionLedger yet; reading again next tick"
            );
        }
    }
    Ok(read)
}

/// The ledgers that the `Upgraded` and `Initialized` events in `logs` moved a vault in `vaults` to,
/// each with the block of the first event in `logs` that named it (security rounds 2 and 3).
///
/// `exclusionLedger()` is a plain storage variable, and under ADR-0014 the way to fix a ledger bug
/// is a governed upgrade whose reinitializer points the vault at a new ledger. The indexer read
/// the getter once and kept the answer for ever, so it went on watching the old ledger and dropped
/// every record of the new one at the emitter gate. A basket vault that gained a ledger by an
/// upgrade kept its "no ledger" row the same way.
///
/// Security round 3: an upgrade installed without a call leaves its reinitializer pending
/// (an upgrade whose call data is empty), and a later timelock operation runs it. That transaction
/// emits `Initialized(uint64)`, not `Upgraded`, so `Initialized` is a trigger too. Each trigger is
/// read at its own block ([`read_ledger_at`]), not at the safe head: two moves in one range, or a
/// rebuild that reaches a move long after it happened, name each ledger in turn. A vault's own
/// first `Initialized` names its first ledger the same way.
///
/// A ledger the vault has not named before is stored as of the trigger's block, so a reorg that
/// orphans the trigger drops it too, and is returned so the tick fetches its logs from that block
/// before the cursor moves. Earlier rows stay.
pub async fn exclusion_ledgers_moved_by_upgrades(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    topics: &Topics,
    logs: &[LogEntry],
    vaults: &BTreeSet<Address>,
    safe_head: u64,
) -> Result<BTreeMap<Address, u64>, IndexerError> {
    // One read per (vault, block): an `upgradeToAndCall` emits `Upgraded` and `Initialized`
    // together.
    let triggers: BTreeSet<(Address, u64)> = logs
        .iter()
        .filter(|log| {
            matches!(
                log.topics.first(),
                Some(t) if *t == topics.proxy_upgraded || *t == topics.proxy_initialized
            ) && vaults.contains(&log.address)
        })
        .map(|log| (log.address, log.block_number))
        .collect();
    if triggers.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut known: BTreeMap<[u8; 20], Vec<[u8; 20]>> = BTreeMap::new();
    for (vault, ledger) in db.vault_exclusion_ledgers(chain_id).await? {
        if let Some(ledger) = ledger {
            known.entry(vault).or_default().push(ledger);
        }
    }
    let mut moved: BTreeMap<Address, u64> = BTreeMap::new();
    for (vault, trigger_block) in triggers {
        let (read, answered_at) = read_ledger_at(rpc, vault, trigger_block, safe_head).await?;
        let LedgerRead::Ledger(ledger) = read else {
            continue;
        };
        let named = known.entry(vault.into_array()).or_default();
        if named.contains(&ledger.into_array()) {
            continue;
        }
        db.insert_vault_exclusion_ledger(
            chain_id,
            vault.into_array(),
            Some(ledger.into_array()),
            trigger_block as i64,
        )
        .await?;
        named.push(ledger.into_array());
        tracing::warn!(
            vault = %vault,
            ledger = %ledger,
            trigger_block,
            read_block = answered_at,
            "an upgrade or reinitializer moved the vault to a new ExclusionLedger; watching it \
             from that block and keeping the old one"
        );
        let first = moved.entry(ledger).or_insert(trigger_block);
        *first = (*first).min(trigger_block);
    }
    Ok(moved)
}

/// The watched vault whose ExclusionLedger is `ledger` ([`exclusion_ledgers_of`] stored it), or
/// `None`. Exclusion-record events are rare, so one read per event is cheap.
async fn vault_of_exclusion_ledger(
    db: &Db,
    cfg: &IndexerConfig,
    ledger: Address,
) -> Result<Option<Address>, IndexerError> {
    Ok(db
        .vault_of_exclusion_ledger(cfg.chain_id, ledger.into_array())
        .await?
        .map(Address::from))
}

/// Read and store the snapshot balance of each holder that a claim in `logs` revealed (QA plan X7,
/// core issue 1820). Returns the rows written.
///
/// `handle_log` stored the records. A claim is `recovered * balanceAt(holder, id) / snapshotSupply`,
/// and `balanceAt` lives on the chain. The holders a record's snapshot covers are read by
/// [`read_snapshot_balances`] under a budget (security round 2). A claim from a holder with no
/// stored balance (one who received its shares by a plain transfer, which `wallet_positions` does
/// not follow) reads that holder here, stored at the claim's block. One read per claim log, and a
/// claim is a transaction that pays out, so this stays small.
///
/// The read is made at `read_block` (the tick's safe head), not at the log's block. `balanceAt` for an
/// existing record never changes, and the safe head is a block every node still holds state for, also
/// during a catch-up against a node that keeps no archive. A failed read fails the tick like a failed
/// `eth_getLogs`, so the cursor stays and the next tick reads again; every write is idempotent.
async fn record_exclusion_balances(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
    topics: &Topics,
    logs: &[LogEntry],
    read_block: u64,
) -> Result<u64, IndexerError> {
    let mut rows = 0u64;
    for log in logs {
        if log.topics.first() != Some(&topics.exclusion_claimed) {
            continue;
        }
        let ledger = log.address.into_array();
        let d = IExclusionLedgerEvents::ExclusionClaimed::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("ExclusionClaimed: {e}")))?;
        let id: i64 = d.exclusionId.try_into().unwrap_or(i64::MAX);
        let holder = d.holder.into_array();
        if db
            .exclusion_record_vault(cfg.chain_id, ledger, id)
            .await?
            .is_none()
            || db
                .has_exclusion_holder_balance(cfg.chain_id, ledger, id, holder)
                .await?
        {
            continue;
        }
        let balance =
            exclusion_balance_at(rpc, log.address, holder, d.exclusionId, read_block).await?;
        if balance > U256::ZERO {
            rows += db
                .insert_exclusion_holder_balance(
                    cfg.chain_id,
                    ledger,
                    id,
                    holder,
                    balance,
                    log.block_number as i64,
                )
                .await?;
        }
    }
    Ok(rows)
}

/// Security round 2: the wall-clock budget of one tick's snapshot-balance pass
/// ([`read_snapshot_balances`]).
pub const SNAPSHOT_READ_TIME_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);

/// Candidate owners the snapshot pass loads from the database at a time.
const SNAPSHOT_READ_BATCH: i64 = 256;

/// Read the snapshot balance of the holders of every exclusion record not yet fully read, under
/// [`SNAPSHOT_READ_TIME_BUDGET`] (QA plan X7, core 1820; security round 2). Returns the rows written.
///
/// When a record opened, the tick used to read `balanceAt` for every depositor in the vault's
/// history, one eth_call at a time, and one failed read failed the tick. Deposits have no minimum
/// and take any receiver, so about $1k of gas buys 100,000 dust holders, and the tick that indexed
/// an exclusion during an adapter incident then made 100,000 sequential reads (hours), starting
/// over on every refused one, while the watchdog evaluated nothing.
///
/// Now each tick reads holders in owner order until the budget is spent, and stores how far it got
/// (`exclusion_snapshot_progress`), so the next tick goes on from there and a zero balance is not
/// read again. Only an owner whose latest position before the record's block holds shares, or who
/// has a position in that block, is read ([`Db::exclusion_snapshot_candidates`]; security round 3:
/// a holder who exited later in the record's own block still has its claim). A failed or cut read
/// ends the pass for this tick
/// without failing the tick; that owner is read again next tick. The dapp reads claims on chain,
/// so a snapshot that takes several ticks only delays the explorer's copy.
///
/// The read is made at `read_block` (the tick's safe head), as in [`record_exclusion_balances`]. Each
/// balance is stored at the record's block, so it rolls back with the record.
async fn read_snapshot_balances(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    read_block: u64,
) -> Result<u64, IndexerError> {
    let pending = db.exclusion_snapshots_pending(chain_id).await?;
    if pending.is_empty() {
        return Ok(0);
    }
    let deadline = tokio::time::Instant::now() + SNAPSHOT_READ_TIME_BUDGET;
    let mut rows = 0u64;
    for rec in pending {
        let ledger = Address::from(rec.ledger_address);
        let id = U256::from(rec.exclusion_id as u64);
        let mut through = rec.read_through;
        loop {
            let holders = db
                .exclusion_snapshot_candidates(
                    chain_id,
                    rec.vault_address,
                    rec.ledger_address,
                    rec.exclusion_id,
                    rec.opened_block,
                    through,
                    SNAPSHOT_READ_BATCH,
                )
                .await?;
            if holders.is_empty() {
                db.set_exclusion_snapshot_progress(
                    chain_id,
                    rec.ledger_address,
                    rec.exclusion_id,
                    through,
                    true,
                    rec.opened_block,
                )
                .await?;
                break;
            }
            let mut stopped = false;
            for holder in holders {
                if tokio::time::Instant::now() >= deadline {
                    stopped = true;
                    break;
                }
                let read = tokio::time::timeout_at(
                    deadline,
                    exclusion_balance_at(rpc, ledger, holder, id, read_block),
                )
                .await;
                let balance = match read {
                    Ok(Ok(balance)) => balance,
                    Ok(Err(e)) => {
                        tracing::warn!(
                            ledger = %ledger,
                            exclusion_id = rec.exclusion_id,
                            holder = %Address::from(holder),
                            error = %e,
                            "snapshot balance read failed; the pass goes on from this holder next tick"
                        );
                        stopped = true;
                        break;
                    }
                    Err(_) => {
                        stopped = true;
                        break;
                    }
                };
                if balance > U256::ZERO {
                    rows += db
                        .insert_exclusion_holder_balance(
                            chain_id,
                            rec.ledger_address,
                            rec.exclusion_id,
                            holder,
                            balance,
                            rec.opened_block,
                        )
                        .await?;
                }
                through = Some(holder);
            }
            db.set_exclusion_snapshot_progress(
                chain_id,
                rec.ledger_address,
                rec.exclusion_id,
                through,
                false,
                rec.opened_block,
            )
            .await?;
            if stopped {
                tracing::info!(
                    ledger = %ledger,
                    exclusion_id = rec.exclusion_id,
                    budget_secs = SNAPSHOT_READ_TIME_BUDGET.as_secs(),
                    "exclusion snapshot balances: this tick's pass stopped; the rest waits for the \
                     next tick"
                );
                return Ok(rows);
            }
        }
    }
    Ok(rows)
}

/// `ExclusionLedger.balanceAt(holder, id)` at `block`.
async fn exclusion_balance_at(
    rpc: &JsonRpc,
    ledger: Address,
    holder: [u8; 20],
    id: U256,
    block: u64,
) -> Result<U256, IndexerError> {
    let data = IExclusionLedgerReads::balanceAtCall {
        holder: Address::from(holder),
        id,
    }
    .abi_encode();
    call_u256(rpc, ledger, data, block).await
}

async fn run_inner(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
    last_indexed: Option<i64>,
    deploy_floor: u64,
    rollback_cursor: &mut Option<i64>,
    seen_head: &mut Option<i64>,
) -> Result<IndexerOutcome, IndexerError> {
    let topics = Topics::new();

    // Reorg check: compare stored hash for `last_indexed` against chain.
    let mut reorg_detected = false;
    let mut last_indexed = last_indexed;
    if let Some(li) = last_indexed {
        if let Some(stored_hash) = db.get_block_hash(cfg.chain_id, li).await? {
            if let Some(header) = rpc.block_header(li as u64).await? {
                if header.hash.0 != stored_hash {
                    let root = walk_back_to_match(db, rpc, cfg.chain_id, li, deploy_floor).await?;
                    db.delete_above_block(cfg.chain_id, root).await?;
                    last_indexed = if root < 0 { None } else { Some(root) };
                    // IDX-2: publish the post-rollback cursor *immediately* after
                    // the rollback commits, so a later failure in this same run
                    // carries `root` into the error arm.
                    *rollback_cursor = last_indexed;
                    reorg_detected = true;
                }
            }
        }
    }

    // The same floor as the pre-reorg site, re-applied: a rollback root below
    // the floor must not resume below it either.  Note this can only RAISE the
    // resume point relative to the rollback, never lower it, so it cannot
    // reopen the range `delete_above_block` just cleared.
    let from_block = first_block(last_indexed, deploy_floor);

    let tip = rpc.block_number().await?;
    // Publish the head before any later step can fail, so the error arm records it (DI-5).
    *seen_head = i64::try_from(tip).ok();
    let safe_head = tip.saturating_sub(CONFIRMATIONS);

    // Say out loud when this run cannot converge. The failure this guards
    // against is not an error — every tick "succeeds", advances
    // `max_blocks_per_tick`, inserts nothing, and logs `rows=0` — so without a
    // warning the only symptom is a per-vault `skipping vault snapshot ...
    // BlockOutOfRangeError` line that reads like a flaky RPC. Name the gap AND
    // the derived floor, because a floor of 0 here means detection degraded and
    // the log that says why is the one to go and read.
    let lag = safe_head.saturating_sub(from_block as u64);
    let converge_budget = cfg
        .max_blocks_per_tick
        .saturating_mul(CONVERGENCE_TICK_BUDGET);
    if lag > converge_budget {
        tracing::warn!(
            from_block,
            safe_head,
            blocks_behind = lag,
            deploy_floor,
            max_blocks_per_tick = cfg.max_blocks_per_tick,
            ticks_to_converge = lag / cfg.max_blocks_per_tick.max(1),
            "indexer starts too far behind the safe head to converge; deploy-block \
             detection did not give this run a usable floor (a deploy_floor of 0 \
             means it degraded — the warning naming the contract says why), and on \
             a Twin fork chain the blocks below the fork point do not exist, so \
             every historical read of them fails"
        );
    }

    let chain_head_block = i64::try_from(tip).ok();
    if (from_block as u64) > safe_head {
        return Ok(IndexerOutcome {
            to_block: None,
            last_indexed_block: last_indexed,
            rows_inserted: 0,
            reorg_detected,
            chain_head_block,
            ..Default::default()
        });
    }
    let Some(target) = tick_target(
        from_block as u64,
        safe_head,
        cfg.end_block,
        cfg.max_blocks_per_tick,
    ) else {
        return Ok(IndexerOutcome {
            to_block: None,
            last_indexed_block: last_indexed,
            rows_inserted: 0,
            reorg_detected,
            chain_head_block,
            ..Default::default()
        });
    };

    // Static watched set (gateway, pinned vault, registry, router) plus every
    // registry-discovered vault, including paused and retired generations. Without the latter, ERC-4626
    // `Deposit`/`Withdraw` logs emitted by vaults learned from `VaultRegistered`
    // are never fetched, so their burn volume is invisible to the watchdog
    // (scan finding IDX-6). `get_logs` filters server-side on the address set, so
    // a registered vault that emits a withdrawal in a block where the gateway is
    // idle would otherwise be dropped entirely.
    //
    // Every status, not only Active (DI-2). A DepositsPaused (1) or Retired (2) vault still
    // holds shares, and its holders still redeem from it (ADR-0009: a retired vault is
    // withdraw-only). Dropping it here lost those `Withdraw` logs, so positions kept exited
    // shares, the watchdog's burn volume missed them, and the vault's last snapshot (the
    // old rmPROTO after its redeploy) stayed as its TVL forever. Status is a product
    // question (`/v1/stats.total_tvl` leaves Retired vaults out), never an indexing one.
    let mut watched = cfg.watched_addresses();
    let mut registered_vaults: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT vault_address FROM vaults WHERE chain_id = $1 ORDER BY vault_address",
    )
    .bind(cfg.chain_id)
    .fetch_all(db.pool())
    .await
    .map_err(DbError::from)?;
    // Discover registrations in this very interval before requesting vault logs.
    // This includes standalone exits in the registration/cutover block and the
    // interval before the next tick discovers the new generation (issue 1796, DI-1).
    // `registered_in_range` keeps the block of each newly found vault's registration: its
    // ExclusionLedger is read there (X7), not at the range's first block, where the vault may
    // not exist yet.
    let mut registered_in_range: BTreeMap<Address, u64> = BTreeMap::new();
    if let Some(registry) = cfg.registry {
        let discovery = rpc
            .get_logs(
                from_block as u64,
                target,
                &[registry],
                &[topics.vault_registered],
            )
            .await?;
        for log in discovery {
            if log.address != registry || log.topics.first() != Some(&topics.vault_registered) {
                continue;
            }
            let event =
                IVaultRegistryEvents::VaultRegistered::decode_log(&into_alloy_log(&log), true)
                    .map_err(|e| IndexerError::Decode(format!("VaultRegistered discovery: {e}")))?;
            let address = event.vault.as_slice().to_vec();
            if !registered_vaults.contains(&address) {
                registered_vaults.push(address);
                registered_in_range.insert(event.vault, log.block_number);
            } else if let Some(first) = registered_in_range.get_mut(&event.vault) {
                *first = (*first).min(log.block_number);
            }
        }
    }
    for vault in &registered_vaults {
        if let Ok(bytes) = <[u8; 20]>::try_from(vault.as_slice()) {
            let address = Address::from(bytes);
            if !watched.contains(&address) {
                watched.push(address);
            }
        }
    }
    // The exclusion records of a vault (QA plan X7, core 1820) are events of its ExclusionLedger,
    // which emits them from its own address. Watch the ledger of every vault watched above, as the
    // vault's own `exclusionLedger()` names it (security round 1: a derived address holds no code
    // on a proxy vault). A vault of another family has no ledger.
    let ledger_vaults: Vec<Address> = std::iter::once(cfg.vault)
        .chain(
            registered_vaults
                .iter()
                .filter_map(|v| <[u8; 20]>::try_from(v.as_slice()).ok())
                .map(Address::from),
        )
        .collect();
    // Each vault with no stored answer is read at the first block of the range (security round 3),
    // or, for a vault registered inside the range, at its registration block (DI-1).
    let first_reads: Vec<(Address, u64)> = ledger_vaults
        .iter()
        .map(|&vault| {
            let block = registered_in_range
                .get(&vault)
                .copied()
                .unwrap_or(from_block as u64);
            (vault, block)
        })
        .collect();
    let ledgers = exclusion_ledgers_of(db, rpc, cfg.chain_id, &first_reads, safe_head).await?;
    for ledger in ledgers.into_values().flatten() {
        if !watched.contains(&ledger) {
            watched.push(ledger);
        }
    }
    // The registry's proxy events are fetched whatever INDEXER_MULTI_VAULT_EVENTS
    // says (issue 1840); its other events are dropped below while the flag is off.
    let proxy_only = cfg.proxy_only_addresses();
    for address in &proxy_only {
        if !watched.contains(address) {
            watched.push(*address);
        }
    }
    let topic0 = topics.all_topic0();
    let mut logs = rpc
        .get_logs(from_block as u64, target, &watched, &topic0)
        .await?;
    logs.retain(|log| !proxy_only.contains(&log.address) || is_proxy_log(&topics, log));

    // Ledger moves (security rounds 2 and 3). A vault that emitted `Upgraded` or `Initialized` in
    // this range is read again at that block: a reinitializer is the one way to point it at a new
    // ExclusionLedger, and it runs either in the upgrade's own transaction or in a later timelock
    // operation that emits only `Initialized`. The new ledger was not in the filter above, so its
    // logs from that block to `target` are fetched now, before the cursor advances. They are
    // appended, so `handle_log` applies the upgrade and stores nothing out of order.
    let upgrade_vaults: BTreeSet<Address> = ledger_vaults.iter().copied().collect();
    let moved = exclusion_ledgers_moved_by_upgrades(
        db,
        rpc,
        cfg.chain_id,
        &topics,
        &logs,
        &upgrade_vaults,
        safe_head,
    )
    .await?;
    let moved: BTreeMap<Address, u64> = moved
        .into_iter()
        .filter(|(ledger, _)| !watched.contains(ledger))
        .collect();
    if let Some(&first_move) = moved.values().min() {
        let new_ledgers: Vec<Address> = moved.keys().copied().collect();
        let mut late = rpc
            .get_logs(first_move, target, &new_ledgers, &topic0)
            .await?;
        late.retain(|l| {
            moved
                .get(&l.address)
                .is_some_and(|&from| l.block_number >= from)
        });
        tracing::info!(
            ledgers = new_ledgers.len(),
            first_move,
            target,
            late_logs = late.len(),
            "vaults moved to a new ExclusionLedger in this tick; fetched its logs before \
             advancing the cursor"
        );
        logs.extend(late);
    }

    // Group logs by (block_number, contract) so we know which blocks
    // need state snapshots per ADR §3.5 trigger 1.
    let mut event_blocks_per_contract: BTreeSet<(u64, Address)> = BTreeSet::new();
    let mut blocks_with_events: BTreeSet<u64> = BTreeSet::new();
    for log in &logs {
        event_blocks_per_contract.insert((log.block_number, log.address));
        blocks_with_events.insert(log.block_number);
    }

    let mut rows_inserted: i64 = 0;

    // Ingest a `blocks` row for every block we touch — only those with at least one watched event,
    // so we don't pull every block on Base. The §11 acceptance criterion says "each row carries
    // chain_id and block_number"; non-event blocks aren't required by the schema.
    //
    // `transactions` holds only the transactions that carry a watched log (QA plan X6, DI-6). The
    // hash, the block and the index come from the log; one receipt per transaction adds from, to and
    // status. The header is fetched without its transactions. Pulling every transaction of the block
    // with a serial receipt for each cost one request per Base transaction in every event block and
    // dominated a catch-up (issue 1780). Every read of a block happens before its rows are written, so
    // a null receipt (an error, see `JsonRpc::tx_receipt`) fails the tick with nothing half-written.
    let mut created: Vec<(alloy_primitives::B256, Address)> = Vec::new();
    let mut log_txs: BTreeMap<u64, BTreeMap<alloy_primitives::B256, u32>> = BTreeMap::new();
    for log in &logs {
        log_txs
            .entry(log.block_number)
            .or_default()
            .entry(log.tx_hash)
            .or_insert(log.tx_index);
    }
    for &bn in &blocks_with_events {
        let header = rpc
            .block_header(bn)
            .await?
            .ok_or_else(|| RpcError::Server {
                method: "eth_getBlockByNumber".into(),
                message: format!("block {bn} missing"),
            })?;
        let mut txs = Vec::new();
        for (hash, index) in log_txs.get(&bn).into_iter().flatten() {
            let receipt = rpc.tx_receipt(*hash).await?;
            created.extend(receipt.contract_address.map(|c| (*hash, c)));
            txs.push((*hash, *index, receipt));
        }
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
        for (hash, index, receipt) in txs {
            let r = db
                .insert_transaction(
                    cfg.chain_id,
                    hash.0,
                    bn as i64,
                    index as i32,
                    receipt.from.into_array(),
                    receipt.to.map(|a| a.into_array()),
                    i16::from(receipt.status),
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

    // Decode + insert events. The payload fetches of the receipts among them and the memo fetches
    // of the votes share one budget (security rounds 2 and 3), so a tick full of receipts or votes
    // whose hosts never answer cannot stall it.
    let inline_fetch_deadline = tokio::time::Instant::now() + INLINE_FETCH_TIME_BUDGET;
    for log in &logs {
        rows_inserted +=
            handle_log_within(db, cfg, &topics, log, Some(inline_fetch_deadline), &created).await?
                as i64;
    }

    // Each holder's share balance at the snapshot of every exclusion record (X7, core 1820).
    // `handle_log` stored the records; the balances need a chain read.
    rows_inserted +=
        record_exclusion_balances(db, rpc, cfg, &topics, &logs, safe_head).await? as i64;
    // The holders of each record's snapshot, under a per-tick budget (security round 2).
    rows_inserted += read_snapshot_balances(db, rpc, cfg.chain_id, safe_head).await? as i64;

    // Reuse the registered-vault set gathered above for the watched-address
    // union; it drives both the event-driven snapshot (router-deposit path) and
    // the heartbeat. Like the watched set it holds every status (DI-2): a retired
    // vault's TVL and supply keep moving while its holders exit, and its supply is
    // the operator's open-obligation signal (retired-v1-vault-maintenance.md).
    let mut heartbeat_vaults = vec![cfg.vault];
    for vault in &registered_vaults {
        if let Ok(bytes) = <[u8; 20]>::try_from(vault.as_slice()) {
            let address = Address::from(bytes);
            if !heartbeat_vaults.contains(&address) {
                heartbeat_vaults.push(address);
            }
        }
    }

    // State snapshots — event-driven (one per touched vault contract per
    // touched block). Heartbeat handled below.
    //
    // For the primary vault: snapshot whenever it had an event.
    // For registered extra vaults: snapshot whenever the PortfolioRouter
    // had an event in that block — router deposits update TVL in extra
    // vaults that are not individually watched, so piggybacking on the
    // router's event blocks keeps their total_assets current without
    // waiting for the SNAPSHOT_HEARTBEAT_BLOCKS interval.
    let router_event_blocks: BTreeSet<u64> = match cfg.portfolio_router {
        Some(router) => event_blocks_per_contract
            .iter()
            .filter(|(_, c)| *c == router)
            .map(|(bn, _)| *bn)
            .collect(),
        None => BTreeSet::new(),
    };
    for (bn, contract) in &event_blocks_per_contract {
        if heartbeat_vaults.contains(contract) {
            rows_inserted +=
                snapshot_vault_or_skip(db, rpc, cfg.chain_id, *contract, *bn, None).await;
        }
    }
    // A DepositsPaused or DepositsUnpaused log from a vault changes what `/v1/vaults` reports as
    // `deposits_paused`, so take a snapshot at that block. Without this the flag stays at the last
    // heartbeat (up to SNAPSHOT_HEARTBEAT_BLOCKS old) after a pause or an unpause.
    for log in &logs {
        let is_pause_log = log
            .topics
            .first()
            .is_some_and(|t| *t == topics.deposits_paused || *t == topics.deposits_unpaused);
        if is_pause_log
            && Some(log.address) != cfg.gateway
            && heartbeat_vaults.contains(&log.address)
        {
            rows_inserted +=
                snapshot_vault_or_skip(db, rpc, cfg.chain_id, log.address, log.block_number, None)
                    .await;
        }
    }
    // Snapshot all registered vaults for every block where the router processed deposits.
    for bn in &router_event_blocks {
        for vault in &heartbeat_vaults {
            rows_inserted += snapshot_vault_or_skip(db, rpc, cfg.chain_id, *vault, *bn, None).await;
        }
    }

    // Heartbeat snapshots — cover the legacy configured vault and every
    // vault learned from VaultRegistry events, whatever its status. The PK on
    // (chain_id, contract, block_number) deduplicates against event-driven
    // snapshots.
    //
    // A vault is read at `target` only when `snapshot_read` says so (issue 1781): it has no row, its
    // heartbeat is due, it is zero-TVL, a cap or its exit value is unknown, or it emitted a watched log
    // in this tick. Reading every vault every tick cost seven `eth_call`s per vault per tick, which
    // dominated a catch-up with four vaults. A quiet vault's state moves only through its own events (deposits,
    // withdrawals, cap, fee, pause, shutdown, in-kind exits, all watched) or through yield and prices,
    // which the heartbeat samples.
    let vaults_with_logs: BTreeSet<Address> = logs.iter().map(|l| l.address).collect();

    for vault in heartbeat_vaults {
        // The newest stored row decides whether a heartbeat read is worth a new row (issue 1768).
        let last_snap: Option<(i64, VaultState)> = sqlx::query_as::<_, (i64, String, String, i64, Option<String>, Option<String>, bool, Option<String>)>(
            "SELECT block_number, CAST(total_assets AS text), CAST(total_supply AS text), exit_fee_bps, \
                    CAST(tvl_cap AS text), CAST(per_deposit_cap AS text), paused, \
                    CAST(preview_redeem_total AS text) \
             FROM vault_snapshots \
             WHERE chain_id = $1 AND contract = $2 \
             ORDER BY block_number DESC LIMIT 1",
        )
        .bind(cfg.chain_id)
        .bind(&vault.into_array()[..])
        .fetch_optional(db.pool())
        .await
        .map_err(DbError::from)?
        .map(|(bn, total_assets, total_supply, exit_fee_bps, tvl_cap, per_deposit_cap, paused, preview_redeem_total)| {
            (
                bn,
                VaultState {
                    total_assets,
                    total_supply,
                    exit_fee_bps,
                    tvl_cap,
                    per_deposit_cap,
                    paused,
                    preview_redeem_total,
                },
            )
        });
        let newest = last_snap.as_ref().map(|(bn, state)| (*bn, state));
        // A read writes a row only when the state differs from the newest row or the heartbeat is due
        // (issue 1768). A row whose caps are unknown (issue 1741) is filled by the same read once the
        // caps answer, and while they stay unreadable the unchanged state writes nothing.
        let skip_if_equal = match snapshot_read(newest, target, vaults_with_logs.contains(&vault)) {
            SnapshotRead::Skip => continue,
            SnapshotRead::Write => None,
            SnapshotRead::WriteIfChanged => newest.map(|(_, state)| state),
        };
        rows_inserted +=
            snapshot_vault_or_skip(db, rpc, cfg.chain_id, vault, target, skip_if_equal).await;
    }

    Ok(IndexerOutcome {
        to_block: Some(target as i64),
        last_indexed_block: Some(target as i64),
        rows_inserted,
        reorg_detected,
        chain_head_block,
        ..Default::default()
    })
}

/// Decode a Timelock, Safe or proxy-upgrade log into an `admin_events` row. `None` when the log is not one
/// of these events, or a Timelock or Safe event not emitted by the configured Timelock or Safe.
///
/// Proxy events (issue 1810): `Upgraded` and `UpgradesFrozen` from any other watched contract (every proxied
/// core contract emits them from its own address) become `contract_kind = 'proxy'` rows. The Timelock and
/// the Safe are not Robot Money proxies, so the same topics from them are not recorded.
pub fn admin_event_of(
    cfg: &IndexerConfig,
    topics: &Topics,
    log: &LogEntry,
) -> Result<Option<AdminEvent>, IndexerError> {
    let Some(&topic0) = log.topics.first() else {
        return Ok(None);
    };
    let word =
        |i: usize| -> Option<[u8; 32]> { log.data.get(i * 32..i * 32 + 32)?.try_into().ok() };
    let u256_at = |i: usize| word(i).map(|w| U256::from_be_bytes(w).to_string());
    let addr_at = |i: usize| word(i).map(|w| format!("{:#x}", Address::from_slice(&w[12..])));
    if Some(log.address) == cfg.timelock {
        let al = into_alloy_log(log);
        let (name, op_id, detail) = if topic0 == topics.timelock_call_scheduled {
            let d = ITimelockEvents::CallScheduled::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("CallScheduled: {e}")))?;
            (
                "CallScheduled",
                Some(d.id.0),
                serde_json::json!({
                    "index": d.index.to_string(),
                    "target": format!("{:#x}", d.target),
                    "value": d.value.to_string(),
                    "data": format!("0x{}", alloy_primitives::hex::encode(&d.data.data)),
                    "predecessor": format!("{:#x}", d.predecessor),
                    "delay": d.delay.to_string(),
                }),
            )
        } else if topic0 == topics.timelock_call_executed {
            let d = ITimelockEvents::CallExecuted::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("CallExecuted: {e}")))?;
            (
                "CallExecuted",
                Some(d.id.0),
                serde_json::json!({
                    "index": d.index.to_string(),
                    "target": format!("{:#x}", d.target),
                    "value": d.value.to_string(),
                    "data": format!("0x{}", alloy_primitives::hex::encode(&d.data.data)),
                }),
            )
        } else if topic0 == topics.timelock_cancelled {
            let d = ITimelockEvents::Cancelled::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("Cancelled: {e}")))?;
            ("Cancelled", Some(d.id.0), serde_json::json!({}))
        } else if topic0 == topics.timelock_min_delay_change {
            let d = ITimelockEvents::MinDelayChange::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("MinDelayChange: {e}")))?;
            (
                "MinDelayChange",
                None,
                serde_json::json!({
                    "old_delay": d.oldDuration.to_string(),
                    "new_delay": d.newDuration.to_string(),
                }),
            )
        } else {
            return Ok(None);
        };
        return Ok(Some(AdminEvent {
            contract_kind: "timelock",
            event_name: name,
            op_id,
            detail,
        }));
    }
    if Some(log.address) == cfg.safe {
        // Safe 1.3 puts the transaction hash in the data, Safe 1.4 in topic 1. Both carry payment in data.
        let (name, op_id, detail) =
            if topic0 == topics.safe_execution_success || topic0 == topics.safe_execution_failure {
                let name = if topic0 == topics.safe_execution_success {
                    "ExecutionSuccess"
                } else {
                    "ExecutionFailure"
                };
                let (hash, payment) = if log.topics.len() >= 2 {
                    (Some(log.topics[1].0), u256_at(0))
                } else {
                    (word(0), u256_at(1))
                };
                (
                    name,
                    hash,
                    serde_json::json!({ "payment": payment.unwrap_or_default() }),
                )
            } else if topic0 == topics.safe_added_owner || topic0 == topics.safe_removed_owner {
                let name = if topic0 == topics.safe_added_owner {
                    "AddedOwner"
                } else {
                    "RemovedOwner"
                };
                (name, None, serde_json::json!({ "owner": addr_at(0) }))
            } else if topic0 == topics.safe_changed_threshold {
                (
                    "ChangedThreshold",
                    None,
                    serde_json::json!({ "threshold": u256_at(0) }),
                )
            } else {
                return Ok(None);
            };
        return Ok(Some(AdminEvent {
            contract_kind: "safe",
            event_name: name,
            op_id,
            detail,
        }));
    }
    if topic0 == topics.proxy_upgraded {
        let d = IGovernedUpgradeEvents::Upgraded::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("Upgraded: {e}")))?;
        return Ok(Some(AdminEvent {
            contract_kind: "proxy",
            event_name: "Upgraded",
            op_id: None,
            detail: serde_json::json!({ "implementation": format!("{:#x}", d.implementation) }),
        }));
    }
    if topic0 == topics.proxy_upgrades_frozen {
        let d = IGovernedUpgradeEvents::UpgradesFrozen::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("UpgradesFrozen: {e}")))?;
        // GovernedUUPS always names the proxy itself (`address(this)` under DELEGATECALL), so a
        // freeze that names another proxy than its emitter is not one of ours and is not recorded.
        if d.proxy != log.address {
            tracing::warn!(
                log_address = %log.address,
                named_proxy = %d.proxy,
                block_number = log.block_number,
                "ignoring an UpgradesFrozen log that names another proxy than its emitter"
            );
            return Ok(None);
        }
        return Ok(Some(AdminEvent {
            contract_kind: "proxy",
            event_name: "UpgradesFrozen",
            op_id: None,
            detail: serde_json::json!({
                "implementation": format!("{:#x}", d.implementation),
                "code_hash": format!("{:#x}", d.codeHash),
            }),
        }));
    }
    Ok(None)
}

/// One Timelock, Safe or proxy-upgrade event, ready for `Db::insert_admin_event`.
#[derive(Debug, Clone, PartialEq)]
pub struct AdminEvent {
    pub contract_kind: &'static str,
    pub event_name: &'static str,
    /// Timelock operation id, or Safe transaction hash.
    pub op_id: Option<[u8; 32]>,
    pub detail: serde_json::Value,
}

/// Contracts created at top level in a range: `(transaction, created contract)` from each stored
/// receipt's `contractAddress`.
pub type CreatedContracts = [(alloy_primitives::B256, Address)];

/// Is this proxy event its contract's deployment? Only when its transaction created THIS proxy (the
/// receipt's `contractAddress` is the emitter), issue 1840. A bare contract-creation transaction is
/// not enough: the timelock's executor role is open, so anyone can execute a ready upgrade from a
/// throwaway contract's constructor, and that upgrade must still page.
pub fn is_proxy_deployment(created: &CreatedContracts, log: &LogEntry) -> bool {
    created
        .iter()
        .any(|(tx, contract)| *tx == log.tx_hash && *contract == log.address)
}

async fn handle_admin_log(
    db: &Db,
    cfg: &IndexerConfig,
    topics: &Topics,
    log: &LogEntry,
    created: &CreatedContracts,
) -> Result<Option<u64>, IndexerError> {
    let Some(mut ev) = admin_event_of(cfg, topics, log)? else {
        return Ok(None);
    };
    // The watchdog pages every proxy row except one marked as the deployment.
    let deployment = ev.contract_kind == "proxy" && is_proxy_deployment(created, log);
    if deployment {
        ev.detail["deployment"] = serde_json::Value::Bool(true);
    }
    let n = db
        .insert_admin_event(
            cfg.chain_id,
            log.block_number as i64,
            log.log_index as i32,
            log.tx_hash.0,
            log.address.into_array(),
            &ev,
        )
        .await?;
    if n == 0 && deployment {
        // Indexed before the receipt check existed: mark it now.
        db.mark_proxy_deployment(cfg.chain_id, log.block_number as i64, log.log_index as i32)
            .await?;
    }
    Ok(Some(n))
}

/// Is `log` an ERC-1967 `Upgraded` or a `UpgradesFrozen`?
fn is_proxy_log(topics: &Topics, log: &LogEntry) -> bool {
    log.topics
        .first()
        .is_some_and(|t| *t == topics.proxy_upgraded || *t == topics.proxy_upgrades_frozen)
}

/// Most `eth_getLogs` requests one proxy backfill pass may make. At the default
/// 1000-block range that is ten million blocks, about eight months of Base.
/// A wider range means the deploy floor degraded to 0: the backfill refuses
/// and says to set `INDEXER_START_BLOCK`, rather than scan from genesis.
pub const PROXY_BACKFILL_MAX_REQUESTS: u64 = 10_000;

/// Most `eth_getLogs` requests one backfill slice makes (issue 1856). The
/// main loop runs one slice per tick, so a tick spends at most this many
/// requests (plus one block fetch per event block) on the backfill before
/// live ingestion runs again. At the default 1000-block range a slice is
/// 25000 blocks, and the widest allowed pass takes 400 ticks.
pub const PROXY_BACKFILL_SLICE_REQUESTS: u64 = 25;

/// What one [`backfill_proxy_events`] call did (issue 1856).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyBackfillOutcome {
    /// Nothing is indexed yet, so there is no range to backfill. Saved as
    /// `no_cursor`; the next call tries again.
    NoCursor,
    /// The floor-to-cursor range needs more than
    /// [`PROXY_BACKFILL_MAX_REQUESTS`] requests (a floor of 0 means deploy-block
    /// detection degraded). Saved as `refused`; the next call tries again.
    Refused {
        floor: u64,
        cursor: u64,
        requests: u64,
    },
    /// One slice is scanned and the checkpoint saved; blocks
    /// `next_block..=target_block` remain.
    Progress {
        next_block: u64,
        target_block: u64,
        inserted: u64,
    },
    /// The pass reached its target block. Saved as `done`.
    Done { inserted: u64 },
}

impl ProxyBackfillOutcome {
    /// Rows this call inserted.
    pub fn inserted(&self) -> u64 {
        match self {
            Self::Progress { inserted, .. } | Self::Done { inserted } => *inserted,
            Self::NoCursor | Self::Refused { .. } => 0,
        }
    }
}

/// Backfill every watched proxy's `Upgraded` and `UpgradesFrozen` events from
/// the deploy floor to the stored cursor (issue 1840), one slice per call
/// (issue 1856).
///
/// Live ingestion only reads blocks above the cursor. So a proxy added to the
/// config after the cursor passed its deploy block, a vault discovered from the
/// registry, and every block indexed before the proxy topics existed would
/// never have their upgrade history indexed, and the explorer would report
/// `upgrade_state = 'unknown'` for ever. The watchdog relies on the deploy-time
/// rows too: without them a later upgrade cannot be told from a deployment.
///
/// A pass covers the deploy floor to the cursor at the time the pass began
/// (`target_block`). Each call scans at most [`PROXY_BACKFILL_SLICE_REQUESTS`]
/// requests of `max_blocks_per_tick` blocks from the checkpoint in
/// `proxy_backfill_progress` (migration 0020) and saves the new checkpoint, so
/// live ingestion keeps moving between slices and a restart or an RPC error
/// resumes from the last saved slice instead of the floor. A call with no pass
/// `running` starts a new one. The main loop calls this once per good tick
/// until it returns [`ProxyBackfillOutcome::Done`], so every process start runs
/// one pass: a vault registered while the indexer runs is backfilled at the
/// next restart. A pass resumed after a restart keeps its proxy list's range,
/// so a vault registered in between is only scanned from the checkpoint up.
///
/// A refused range and a missing cursor are not done: they are saved as
/// `refused` / `no_cursor` (which `/health` reports as `proxy_backfill`) and
/// the next call tries again.
///
/// Idempotent: rows insert on the existing `(chain_id, block_number,
/// log_index)` key with `ON CONFLICT DO NOTHING`, so a second pass inserts
/// nothing. Each event block's header and transactions are stored as well. A
/// row whose transaction created that proxy (receipt `contractAddress`) is
/// marked `"deployment": true`, including a row indexed before this check
/// existed, so the watchdog does not page it.
pub async fn backfill_proxy_events(
    db: &Db,
    rpc: &JsonRpc,
    cfg: &IndexerConfig,
) -> Result<ProxyBackfillOutcome, IndexerError> {
    let prior = db.proxy_backfill_progress(cfg.chain_id).await?;
    let span = cfg.max_blocks_per_tick.max(1);
    let resumed = prior.as_ref().and_then(|p| match p {
        ProxyBackfillProgress {
            state,
            floor_block: Some(floor),
            target_block: Some(target),
            next_block: Some(next),
            ..
        } if state == "running" => Some((
            u64::try_from(*floor).ok()?,
            u64::try_from(*target).ok()?,
            u64::try_from(*next).ok()?,
        )),
        _ => None,
    });
    let (floor, target, next) = match resumed {
        Some(r) => r,
        None => {
            let cursor = db
                .last_indexed_block(cfg.chain_id)
                .await?
                .and_then(|c| u64::try_from(c).ok());
            let Some(cursor) = cursor else {
                if prior.as_ref().map(|p| p.state.as_str()) != Some("no_cursor") {
                    tracing::warn!(
                        chain_id = cfg.chain_id,
                        "proxy upgrade backfill waiting: nothing is indexed yet"
                    );
                }
                save_backfill_state(db, cfg, "no_cursor", None, None, None, None).await?;
                return Ok(ProxyBackfillOutcome::NoCursor);
            };
            let floor = resolve_deploy_floor(db, rpc, cfg, Some(cursor as i64)).await;
            if floor > cursor {
                save_backfill_state(db, cfg, "done", Some(floor), Some(cursor), None, None).await?;
                return Ok(ProxyBackfillOutcome::Done { inserted: 0 });
            }
            let requests = (cursor - floor) / span + 1;
            if requests > PROXY_BACKFILL_MAX_REQUESTS {
                let detail = format!(
                    "proxy upgrade backfill refused: the range from the deploy floor {floor} to \
                     the cursor {cursor} needs {requests} eth_getLogs requests, more than \
                     {PROXY_BACKFILL_MAX_REQUESTS} (a floor of 0 means deploy-block detection \
                     degraded). Set INDEXER_START_BLOCK to the deployment's first block and restart"
                );
                // Said loudly once; a repeat each tick would bury every other line.
                if prior.as_ref().map(|p| p.state.as_str()) != Some("refused") {
                    tracing::error!(chain_id = cfg.chain_id, "{detail}");
                }
                save_backfill_state(
                    db,
                    cfg,
                    "refused",
                    Some(floor),
                    Some(cursor),
                    None,
                    Some(detail),
                )
                .await?;
                return Ok(ProxyBackfillOutcome::Refused {
                    floor,
                    cursor,
                    requests,
                });
            }
            (floor, cursor, floor)
        }
    };
    // A reorg may have rolled the cursor back below the pass's target since the
    // pass began. Live ingestion re-indexes everything above the cursor, proxy
    // topics included, so the pass stops at the cursor and never writes blocks
    // above it.
    let Some(cursor) = db
        .last_indexed_block(cfg.chain_id)
        .await?
        .and_then(|c| u64::try_from(c).ok())
    else {
        save_backfill_state(db, cfg, "no_cursor", None, None, None, None).await?;
        return Ok(ProxyBackfillOutcome::NoCursor);
    };
    let target = target.min(cursor);
    if next > target {
        save_backfill_state(db, cfg, "done", Some(floor), Some(target), None, None).await?;
        tracing::info!(
            chain_id = cfg.chain_id,
            floor,
            target,
            "proxy upgrade backfill complete: the cursor fell back below the checkpoint"
        );
        return Ok(ProxyBackfillOutcome::Done { inserted: 0 });
    }
    let slice_end = next
        .saturating_add(span.saturating_mul(PROXY_BACKFILL_SLICE_REQUESTS) - 1)
        .min(target);

    let mut proxies = cfg.proxy_addresses();
    let registered: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT vault_address FROM vaults WHERE chain_id = $1")
            .bind(cfg.chain_id)
            .fetch_all(db.pool())
            .await
            .map_err(DbError::from)?;
    for vault in registered {
        if let Ok(bytes) = <[u8; 20]>::try_from(vault.as_slice()) {
            let address = Address::from(bytes);
            if !proxies.contains(&address) {
                proxies.push(address);
            }
        }
    }

    let topics = Topics::new();
    let proxy_topics = [topics.proxy_upgraded, topics.proxy_upgrades_frozen];
    let mut inserted = 0u64;
    let mut stored_blocks: BTreeSet<u64> = BTreeSet::new();
    let mut created: Vec<(alloy_primitives::B256, Address)> = Vec::new();
    let mut from = next;
    while from <= slice_end {
        let to = from.saturating_add(span - 1).min(slice_end);
        let logs = rpc.get_logs(from, to, &proxies, &proxy_topics).await?;
        let proxy_logs: Vec<&LogEntry> = logs
            .iter()
            .filter(|l| {
                proxies.contains(&l.address)
                    && is_proxy_log(&topics, l)
                    && (from..=to).contains(&l.block_number)
            })
            .collect();
        // Each event block's header and the transactions that carry a proxy log (QA plan X6, DI-6:
        // the log gives the hash, the block and the index, one receipt adds from, to and status).
        // The receipt's `contractAddress` is how a deployment is told from an upgrade (issue 1840).
        // Every read of a block happens before its rows are written.
        let mut block_txs: BTreeMap<u64, BTreeMap<alloy_primitives::B256, u32>> = BTreeMap::new();
        for log in &proxy_logs {
            if !stored_blocks.contains(&log.block_number) {
                block_txs
                    .entry(log.block_number)
                    .or_default()
                    .entry(log.tx_hash)
                    .or_insert(log.tx_index);
            }
        }
        for (bn, txs) in block_txs {
            let header = rpc
                .block_header(bn)
                .await?
                .ok_or_else(|| RpcError::Server {
                    method: "eth_getBlockByNumber".into(),
                    message: format!("block {bn} missing"),
                })?;
            let mut receipts = Vec::new();
            for (hash, index) in txs {
                let receipt = rpc.tx_receipt(hash).await?;
                created.extend(receipt.contract_address.map(|c| (hash, c)));
                receipts.push((hash, index, receipt));
            }
            db.insert_block(
                cfg.chain_id,
                bn as i64,
                header.hash.0,
                header.parent_hash.0,
                header.timestamp as i64,
            )
            .await?;
            for (hash, index, receipt) in receipts {
                db.insert_transaction(
                    cfg.chain_id,
                    hash.0,
                    bn as i64,
                    index as i32,
                    receipt.from.into_array(),
                    receipt.to.map(|a| a.into_array()),
                    i16::from(receipt.status),
                )
                .await?;
            }
            stored_blocks.insert(bn);
        }
        for log in proxy_logs {
            inserted += handle_admin_log(db, cfg, &topics, log, &created)
                .await?
                .unwrap_or(0);
        }
        from = to + 1;
    }

    if slice_end >= target {
        save_backfill_state(db, cfg, "done", Some(floor), Some(target), None, None).await?;
        tracing::info!(
            chain_id = cfg.chain_id,
            floor,
            target,
            proxies = proxies.len(),
            inserted,
            "proxy upgrade backfill complete"
        );
        return Ok(ProxyBackfillOutcome::Done { inserted });
    }
    let next_block = slice_end + 1;
    save_backfill_state(
        db,
        cfg,
        "running",
        Some(floor),
        Some(target),
        Some(next_block),
        None,
    )
    .await?;
    tracing::info!(
        chain_id = cfg.chain_id,
        next_block,
        target,
        inserted,
        "proxy upgrade backfill slice saved"
    );
    Ok(ProxyBackfillOutcome::Progress {
        next_block,
        target_block: target,
        inserted,
    })
}

/// Save one `proxy_backfill_progress` row (see [`backfill_proxy_events`]).
async fn save_backfill_state(
    db: &Db,
    cfg: &IndexerConfig,
    state: &str,
    floor: Option<u64>,
    target: Option<u64>,
    next: Option<u64>,
    detail: Option<String>,
) -> Result<(), IndexerError> {
    let block = |b: Option<u64>| b.and_then(|b| i64::try_from(b).ok());
    db.save_proxy_backfill_progress(
        cfg.chain_id,
        &ProxyBackfillProgress {
            state: state.to_string(),
            floor_block: block(floor),
            target_block: block(target),
            next_block: block(next),
            detail,
        },
    )
    .await?;
    Ok(())
}

/// Walk back from `start` until we find a block whose stored hash
/// matches the on-chain hash. Returns that block number as the reorg
/// root. Returns `deploy_floor - 1` if we reach the floor without finding a
/// match, which signals the caller to wipe everything at or above it (a
/// full re-index of the range this indexer can have) — and that is `-1`, the
/// original "wipe all data", whenever the floor is `0`.
///
/// A block with **no stored hash** is skipped — a missing hash means the
/// indexer never persisted this block (it had no watched events and was
/// not the cursor). Treating a missing-hash block as a "clean root"
/// would incorrectly stop the walk, leaving stale event rows below the
/// true reorg point undetected (issue #177 bug fix).
///
/// The walk STOPS at `deploy_floor`, the same floor `first_block` applies two
/// lines below the call. That bound is not an optimisation, it is what keeps
/// the descent finite in the case this floor exists for: on a Twin fork chain
/// the cursor sits at ~48.9M, so a single hash mismatch — anvil re-mining its
/// tip after a restart, or a regenerated state fixture — sent this loop one
/// height at a time towards genesis, roughly 48.9 million `SELECT hash FROM
/// blocks` round trips inside one tick, with no timeout, blocking the poll loop
/// for hours before either wiping the chain or erroring on
/// `BlockOutOfRangeError` at a leftover row from the dead chain below the
/// floor — and repeating the whole scan on the next tick. Below the floor there
/// is nothing this indexer wrote and nothing this chain can serve, so there is
/// no root to find down there.
async fn walk_back_to_match(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    start: i64,
    deploy_floor: u64,
) -> Result<i64, IndexerError> {
    let floor: i64 = deploy_floor.try_into().unwrap_or(i64::MAX);
    let stop = floor.max(0);
    let mut n = start;
    while n >= stop {
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
    Ok(stop - 1)
}

/// Dispatch a single decoded log to its writer(s).  Public so integration
/// tests can drive one synthetic event through the full handler-wiring path
/// (IDX-3 regression coverage) without booting a chain.
///
/// A receipt's payload or a vote's memo is fetched with no tick budget here;
/// the tick itself calls [`handle_log_within`] with one.
pub async fn handle_log(
    db: &Db,
    cfg: &IndexerConfig,
    topics: &Topics,
    log: &LogEntry,
) -> Result<u64, IndexerError> {
    handle_log_within(db, cfg, topics, log, None, &[]).await
}

/// Security round 2: the wall-clock budget a tick may spend fetching the payloads of the receipts
/// and the memos of the votes it indexes ([`handle_log_within`]).
///
/// One `ReceiptRecorded` whose payload host accepts and never answers costs
/// [`PAYLOAD_FETCH_ATTEMPTS`] timeouts plus the backoff, about 23 s, and any committee agent can
/// record receipts with an arbitrary URI. A hundred of them in one block held the tick for about
/// 40 minutes, and the watchdog's evaluation behind it. Past this budget a receipt is stored
/// unfetched (`verified = false`, no attempt counted) and the re-verification sweep, under its own
/// budget, fetches it on a later tick. Security round 3: a `VoteSubmitted` memo fetch (up to 10 s
/// of DNS plus 10 s of request) shares this budget the same way, and [`sweep_unverified_votes`]
/// fetches a vote stored past it.
pub const INLINE_FETCH_TIME_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

/// [`handle_log`] under the tick's inline fetch deadline: a `ReceiptRecorded` or a `VoteSubmitted`
/// past `inline_fetch_deadline` is stored without a fetch, and the fetch in flight at the deadline
/// is cut (security rounds 2 and 3). `None` fetches without a deadline.
async fn handle_log_within(
    db: &Db,
    cfg: &IndexerConfig,
    topics: &Topics,
    log: &LogEntry,
    inline_fetch_deadline: Option<tokio::time::Instant>,
    created: &CreatedContracts,
) -> Result<u64, IndexerError> {
    let topic0 = match log.topics.first() {
        Some(t) => *t,
        None => return Ok(0),
    };

    // GATEWAY SYSTEM ISOLATION. The agent_* events write the gateway tables, so only the configured
    // gateway may emit them. With no gateway configured nothing here is written.
    let from_gateway = cfg.gateway == Some(log.address);
    if !from_gateway
        && (topic0 == topics.agent_deposit
            || topic0 == topics.agent_deposit_routed
            || topic0 == topics.agent_withdrawal
            || topic0 == topics.agent_authorized
            || topic0 == topics.agent_ownership_transferred
            || topic0 == topics.agent_revoked)
    {
        return Ok(0);
    }

    if topic0 == topics.agent_deposit {
        let decoded = IGatewayEvents::AgentDeposit::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentDeposit: {e}")))?;
        let mut r = db
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
                // Single-vault path: the deposit went to the gateway's pinned vault.
                Some(cfg.vault.into_array()),
                Some(log.address.into_array()),
            )
            .await?;
        // Store in account_history_events for the share_receiver.
        r += db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.shareReceiver.into_array(),
                "deposit",
                Some(cfg.vault.into_array()),
                Some(decoded.agent.into_array()),
                Some(decoded.amount),
            )
            .await?;
        return Ok(r);
    }

    // AgentDepositRouted — multi-leg router deposit (IGateway.sol:156).
    // Stores a parent row in agent_deposits (vault = NULL; per-leg data is
    // written by the corresponding RouterDeposit events from PortfolioRouter).
    if topic0 == topics.agent_deposit_routed {
        let decoded = IGatewayEvents::AgentDepositRouted::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentDepositRouted: {e}")))?;
        // Sum sharesPerLeg to populate shares_minted on the parent row.
        let total_shares: U256 = decoded
            .sharesPerLeg
            .iter()
            .copied()
            .fold(U256::ZERO, |acc, s| acc.saturating_add(s));
        let mut r = db
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
                total_shares,
                decoded.windowId as i64,
                // Router path: vault is NULL; per-leg rows carry the vault address.
                None,
                Some(log.address.into_array()),
            )
            .await?;
        // Store in account_history_events for the share_receiver (vault=NULL for routed).
        r += db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.shareReceiver.into_array(),
                "deposit",
                None,
                Some(decoded.agent.into_array()),
                Some(decoded.amount),
            )
            .await?;
        return Ok(r);
    }

    // AgentWithdrawal — gateway-level withdrawal (IGateway.sol:176).
    // Stores a withdrawal history row for the agent address.
    // The ERC-4626 Withdraw event (emitted by the vault in the same tx)
    // is stored separately — both coexist because they have distinct log_index values.
    if topic0 == topics.agent_withdrawal {
        let decoded = IGatewayEvents::AgentWithdrawal::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentWithdrawal: {e}")))?;
        let r = db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                "withdrawal",
                Some(decoded.sourceVault.into_array()),
                Some(decoded.agent.into_array()),
                Some(decoded.assetsOut),
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.agent_authorized {
        let decoded = IGatewayEvents::AgentAuthorized::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentAuthorized: {e}")))?;
        let mut r = db
            .insert_agent_policy(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                Some(decoded.owner.into_array()),
                false,
                Some(decoded.validUntil as i64),
                Some(decoded.maxPerPayment),
                Some(decoded.maxPerWindow),
                None, // window_usage_to_date not available from AgentAuthorized event
                Some(decoded.shareReceiver.into_array()),
                Some(log.address.into_array()),
            )
            .await?;
        // Store policy change in account history for the agent.
        r += db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                "policy_change",
                None,
                Some(decoded.agent.into_array()),
                None,
            )
            .await?;
        return Ok(r);
    }

    // AgentOwnershipTransferred (IGateway.sol:116, issue #1476): the owner
    // changes, the policy does not. A new agent_policies row names the new
    // owner and carries the policy fields forward, so the latest row per agent
    // stays the current state.
    if topic0 == topics.agent_ownership_transferred {
        let decoded =
            IGatewayEvents::AgentOwnershipTransferred::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("AgentOwnershipTransferred: {e}")))?;
        let mut r = db
            .insert_agent_owner_transfer(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                decoded.newOwner.into_array(),
                Some(log.address.into_array()),
            )
            .await?;
        r += db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                "policy_change",
                None,
                Some(decoded.agent.into_array()),
                None,
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.agent_revoked {
        let decoded = IGatewayEvents::AgentRevoked::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("AgentRevoked: {e}")))?;
        let mut r = db
            .insert_agent_policy(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                Some(decoded.owner.into_array()),
                true,
                None,
                None,
                None,
                None, // window_usage_to_date not available from AgentRevoked event
                None,
                Some(log.address.into_array()),
            )
            .await?;
        // Store policy change (revocation) in account history for the agent.
        r += db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.agent.into_array(),
                "policy_change",
                None,
                Some(decoded.agent.into_array()),
                None,
            )
            .await?;
        return Ok(r);
    }

    // RouterDeposit — per-leg event from PortfolioRouter.sol:71.
    // Each leg records (depositor, vault, amount, shares, weightBps) for one
    // vault in the router's weight vector.  Legs are linked to the parent
    // AgentDepositRouted row via payment_id.
    //
    // Note: RouterDeposit carries no paymentId of its own — the payment_id
    // stored here is the tx_hash (best-effort correlation key) because the
    // PortfolioRouter does not forward the gateway's paymentId.  Callers
    // should join on (chain_id, tx_hash) to correlate with agent_deposits.
    if topic0 == topics.router_deposit {
        let decoded = IPortfolioRouterEvents::RouterDeposit::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("RouterDeposit: {e}")))?;
        // Use the tx_hash as the payment_id correlation key: PortfolioRouter
        // does not forward the gateway's paymentId, so the tx hash is the
        // best available link between leg rows and the parent deposit.
        let r = db
            .insert_router_deposit_leg(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.tx_hash.0, // payment_id = tx_hash (correlation key)
                decoded.depositor.into_array(),
                decoded.vault.into_array(),
                decoded.amount,
                decoded.shares,
                decoded.weightBps,
            )
            .await?;
        return Ok(r);
    }

    // ERC-4626 Withdraw — Withdraw(address indexed caller, address indexed receiver,
    //                              address indexed owner, uint256 assets, uint256 shares).
    // A single Withdraw log must persist BOTH:
    //   1. an account_history_events withdrawal row attributed to `owner` (issue #654, §5.4), and
    //   2. a vault_transfer_events row with direction='withdrawal' (issue #675 AC-2),
    //      which is the table the watchdog burn-volume circuit breaker reads.
    // These were previously split across two branches keyed on the same Withdraw
    // topic0; the first returned early, leaving the vault_transfer_events writer
    // unreachable and stranding the watchdog burn alarm (issue #989). They are now
    // merged into this single reachable branch.
    if topic0 == topics.erc4626_withdraw {
        let decoded = IVaultEvents::Withdraw::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("Withdraw: {e}")))?;
        let mut r = db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.owner.into_array(),
                "withdrawal",
                Some(log.address.into_array()),
                None,
                Some(decoded.assets),
            )
            .await?;
        r += db
            .insert_vault_transfer_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.address.into_array(),
                "withdrawal",
                decoded.caller.into_array(),
                decoded.receiver.into_array(),
                decoded.assets,
                decoded.shares,
            )
            .await?;
        // IDX-3: roll the owner's wallet_positions balance back by the burned
        // shares.  ERC-4626 `Withdraw` burns `shares` from `owner`; the new
        // balance is prior - shares (saturating at zero).
        r += persist_wallet_position(
            db,
            cfg,
            log,
            decoded.owner.into_array(),
            decoded.shares,
            false,
        )
        .await?;
        return Ok(r);
    }

    // VaultAllocated — Allocated(uint256 indexed index, address indexed adapter, uint256 amount).
    // Persists an adapter_allocations row so the vault detail API can surface
    // per-adapter allocation history (issue #675 AC-2).
    if topic0 == topics.vault_allocated {
        let decoded = IVaultEvents::Allocated::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("Allocated: {e}")))?;
        let r = db
            .insert_adapter_allocation(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.address.into_array(),
                Some(decoded.adapter.into_array()),
                Some(decoded.index.try_into().unwrap_or(i64::MAX)),
                decoded.amount,
                "allocated",
            )
            .await?;
        return Ok(r);
    }

    // VaultPulled — Pulled(uint256 indexed index, address indexed adapter, uint256 amount).
    // Mirrors VaultAllocated but records a withdrawal from the adapter back to the vault.
    if topic0 == topics.vault_pulled {
        let decoded = IVaultEvents::Pulled::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("Pulled: {e}")))?;
        let r = db
            .insert_adapter_allocation(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.address.into_array(),
                Some(decoded.adapter.into_array()),
                Some(decoded.index.try_into().unwrap_or(i64::MAX)),
                decoded.amount,
                "pulled",
            )
            .await?;
        return Ok(r);
    }

    // VaultRebalanced — Rebalanced(uint256 totalMoved).
    // No adapter address in this event; adapter and adapter_index are NULL.
    if topic0 == topics.vault_rebalanced {
        let decoded = IVaultEvents::Rebalanced::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("Rebalanced: {e}")))?;
        let r = db
            .insert_adapter_allocation(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.address.into_array(),
                None,
                None,
                decoded.totalMoved,
                "rebalanced",
            )
            .await?;
        return Ok(r);
    }

    // ExitFeeCharged — ExitFeeCharged(address indexed owner, address indexed receiver,
    //                                 uint256 grossAssets, uint256 fee, uint256 netAssets).
    // One event drives two tables:
    //   * vault_fee_events — fee collection history for the vault detail API
    //     (issue #675 AC-2).
    //   * account_history_events — a 'fee_charged' row attributed to the owner
    //     so the per-account history feed surfaces the fee (issue #654, §5.4).
    if topic0 == topics.vault_exit_fee_charged {
        let decoded = IVaultEvents::ExitFeeCharged::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("ExitFeeCharged: {e}")))?;
        let fee_rows = db
            .insert_vault_fee_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.address.into_array(),
                decoded.owner.into_array(),
                decoded.receiver.into_array(),
                decoded.grossAssets,
                decoded.fee,
                decoded.netAssets,
            )
            .await?;
        let history_rows = db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.owner.into_array(),
                "fee_charged",
                Some(log.address.into_array()),
                None,
                Some(decoded.fee),
            )
            .await?;
        return Ok(fee_rows + history_rows);
    }

    // DepositsPaused / DepositsUnpaused (gateway and vaults share the topic-0s).
    // They only drive state snapshots; no dedicated table row. A deposit pause
    // stops new deposits only and never freezes withdrawals (core 1494).
    if topic0 == topics.deposits_paused || topic0 == topics.deposits_unpaused {
        return Ok(0);
    }

    // VaultRegistered — upsert a row into `vaults`.
    // New signature: (address indexed vault, string name, address indexed asset).
    // Fields riskLabel/depositCap/registeredAt removed from contract; use
    // empty-string/zero/block_number as DB defaults.
    if topic0 == topics.vault_registered {
        let decoded = IVaultRegistryEvents::VaultRegistered::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("VaultRegistered: {e}")))?;
        db.upsert_contract(cfg.chain_id, decoded.vault.into_array(), "vault", None)
            .await?;
        let r = db
            .upsert_vault(
                cfg.chain_id,
                decoded.vault.into_array(),
                &decoded.name,
                risk_label_from_vault_name(decoded.vault, &decoded.name),
                U256::ZERO,              // depositCap removed
                0i16,                    // VaultStatus::Active at registration
                log.block_number as i64, // registeredAt removed; use block_number
                log.block_number as i64,
                log.tx_hash.0,
            )
            .await?;
        return Ok(r);
    }

    // VaultStatusChanged — update `status` and `status_changed_at`.
    // New signature: (address indexed vault, uint8 indexed newStatus, uint256 timestamp).
    if topic0 == topics.vault_status_changed {
        let decoded =
            IVaultRegistryEvents::VaultStatusChanged::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("VaultStatusChanged: {e}")))?;
        let r = db
            .update_vault_status(
                cfg.chain_id,
                decoded.vault.into_array(),
                log.block_number as i64,
                log.log_index as i32,
                decoded.newStatus as i16,
                decoded.timestamp.try_into().unwrap_or(i64::MAX),
            )
            .await?;
        return Ok(r);
    }

    // WeightsSet — PortfolioRouter.setWeights(), called by
    // RouterGovernance.applyReceipt (and by the demo seed script).
    // Signature: WeightsSet(address[] vaults, uint256[] bps).
    if topic0 == topics.weights_set {
        let decoded = IPortfolioRouterEvents::WeightsSet::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("WeightsSet: {e}")))?;
        let vault_addresses: Vec<[u8; 20]> =
            decoded.vaults.iter().map(|a| a.into_array()).collect();
        let bps_values: Vec<i64> = decoded
            .bps
            .iter()
            .map(|b| b.try_into().unwrap_or(i64::MAX))
            .collect();
        let r = db
            .insert_router_weight_snapshot(
                cfg.chain_id,
                log.address.into_array(),
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                vault_addresses,
                bps_values,
            )
            .await?;
        return Ok(r);
    }

    // DefaultWeightsSet — direct admin call to PortfolioRouter.setDefaultWeights().
    // Signature: DefaultWeightsSet(address[] vaults, uint256[] bps).
    // Emitted by ADMIN_ROLE setting the fallback weight vector.
    if topic0 == topics.default_weights_set {
        let decoded =
            IPortfolioRouterEvents::DefaultWeightsSet::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("DefaultWeightsSet: {e}")))?;
        let vault_addresses: Vec<[u8; 20]> =
            decoded.vaults.iter().map(|a| a.into_array()).collect();
        let bps_values: Vec<i64> = decoded
            .bps
            .iter()
            .map(|b| b.try_into().unwrap_or(i64::MAX))
            .collect();
        let r = db
            .insert_router_weight_snapshot(
                cfg.chain_id,
                log.address.into_array(),
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                vault_addresses,
                bps_values,
            )
            .await?;
        return Ok(r);
    }

    // ERC-4626 Deposit — Deposit(address indexed caller, address indexed owner,
    //                            uint256 assets, uint256 shares).
    // Persists a vault_transfer_events row for the deposit/withdrawal log
    // (issue #675 AC-2). The event-driven snapshot is still handled by the
    // caller via `event_blocks_per_contract`.
    if topic0 == topics.erc4626_deposit {
        let decoded = IVaultEvents::Deposit::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("ERC4626 Deposit: {e}")))?;
        let mut r = db
            .insert_vault_transfer_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                log.address.into_array(),
                "deposit",
                decoded.caller.into_array(),
                decoded.owner.into_array(),
                decoded.assets,
                decoded.shares,
            )
            .await?;
        // IDX-3: roll the owner's wallet_positions balance forward by the
        // minted shares so the account-positions view is populated.  A deposit
        // mints `shares` to `owner`; the new balance is prior + shares.
        r += persist_wallet_position(
            db,
            cfg,
            log,
            decoded.owner.into_array(),
            decoded.shares,
            true,
        )
        .await?;
        return Ok(r);
    }

    // ─── ExclusionLedger event handlers ───────────────────────────────────────────
    // Implements: QA plan v1 task X7, core issue 1820 (indexer half). Migration 0025.
    //
    // Four events, each one append-only row: ExclusionOpened (the record and its snapshot
    // supply), ExclusionRecoveryCredited, ExclusionFinalized, ExclusionClaimed. The holders'
    // snapshot balances need a chain read, which `handle_log` cannot make; `run_inner` reads them
    // after this loop (`record_exclusion_balances`).
    //
    // GATED ON THE EMITTING CONTRACT, as the receipt handlers below are: dispatch is on topic-0
    // over every watched address, so only the ExclusionLedger of a watched vault may write the
    // exclusion tables.
    if topic0 == topics.exclusion_opened
        || topic0 == topics.exclusion_recovery_credited
        || topic0 == topics.exclusion_finalized
        || topic0 == topics.exclusion_claimed
    {
        let Some(vault) = vault_of_exclusion_ledger(db, cfg, log.address).await? else {
            tracing::warn!(
                address = %log.address,
                block_number = log.block_number,
                "exclusion-record event from a contract that is not the ExclusionLedger of a \
                 watched vault; ignored"
            );
            return Ok(0);
        };
        let ledger = log.address.into_array();
        let block = log.block_number as i64;
        let log_index = log.log_index as i32;
        let tx = log.tx_hash.0;
        let al = into_alloy_log(log);
        let r = if topic0 == topics.exclusion_opened {
            let d = IExclusionLedgerEvents::ExclusionOpened::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("ExclusionOpened: {e}")))?;
            db.insert_exclusion_record(
                cfg.chain_id,
                ledger,
                d.exclusionId.try_into().unwrap_or(i64::MAX),
                vault.into_array(),
                d.adapterIndex.try_into().unwrap_or(i64::MAX),
                d.adapter.into_array(),
                d.snapshotSupply,
                d.adapterValue,
                block,
                log_index,
                tx,
            )
            .await?
        } else if topic0 == topics.exclusion_recovery_credited {
            let d = IExclusionLedgerEvents::ExclusionRecoveryCredited::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("ExclusionRecoveryCredited: {e}")))?;
            db.insert_exclusion_recovery(
                cfg.chain_id,
                block,
                log_index,
                tx,
                ledger,
                d.exclusionId.try_into().unwrap_or(i64::MAX),
                i16::from(d.source),
                d.amount,
                d.recoveredUsdc,
            )
            .await?
        } else if topic0 == topics.exclusion_finalized {
            let d = IExclusionLedgerEvents::ExclusionFinalized::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("ExclusionFinalized: {e}")))?;
            db.insert_exclusion_finalization(
                cfg.chain_id,
                ledger,
                d.exclusionId.try_into().unwrap_or(i64::MAX),
                i16::from(d.reason),
                d.recoveredUsdc,
                block,
                log_index,
                tx,
            )
            .await?
        } else {
            let d = IExclusionLedgerEvents::ExclusionClaimed::decode_log(&al, true)
                .map_err(|e| IndexerError::Decode(format!("ExclusionClaimed: {e}")))?;
            db.insert_exclusion_claim(
                cfg.chain_id,
                block,
                log_index,
                tx,
                ledger,
                d.exclusionId.try_into().unwrap_or(i64::MAX),
                d.holder.into_array(),
                d.amount,
            )
            .await?
        };
        return Ok(r);
    }

    // ─── ConsensusRecommendationReceipt event handlers ─────────────────────────────
    // Canonical: docs/architecture.md §4.9 — issue #1247.
    //
    // Two events: ReceiptRecorded (append) and ReceiptReleased (in-place flip).
    // Neither carries a signature parameter — the analysts' ed25519 signatures
    // are payload data, never event data.

    // T20 — GATE ON THE EMITTING CONTRACT.
    //
    // `handle_log` dispatches on `topic0` alone, over a watched-address set that
    // also carries the gateway, the vaults, the registry and the router. `ReceiptRecorded`'s topic0 is just a hash: ANY watched
    // contract that emits an event with that signature lands in the branches
    // below. Only the configured ConsensusRecommendationReceipt deployment may
    // write the receipt register, so check the address before decoding rather
    // than trusting the topic.
    // Timelock and Safe governance events (issue #1731). The topic-0s are generic hashes, so the emitter
    // must be the configured Timelock or Safe before anything is written.
    if let Some(n) = handle_admin_log(db, cfg, topics, log, created).await? {
        return Ok(n);
    }

    if (topic0 == topics.consensus_receipt_recorded || topic0 == topics.consensus_receipt_released)
        && Some(log.address) != cfg.consensus_receipt
    {
        tracing::warn!(
            log_address = %log.address,
            configured = ?cfg.consensus_receipt,
            block_number = log.block_number,
            log_index = log.log_index,
            "ignoring consensus-receipt-shaped log from an unconfigured contract"
        );
        return Ok(0);
    }

    if topic0 == topics.consensus_receipt_recorded {
        let decoded = IConsensusRecommendationReceiptEvents::ReceiptRecorded::decode_log(
            &into_alloy_log(log),
            true,
        )
        .map_err(|e| IndexerError::Decode(format!("ReceiptRecorded: {e}")))?;
        let receipt_id: [u8; 32] = decoded.receiptId.0;
        let payload_digest: [u8; 32] = decoded.payloadDigest.0;
        let receipt_index: i64 = decoded.index.try_into().unwrap_or(i64::MAX);

        // Independent digest verification: fetch the bytes the on-chain commitment
        // points at and recompute keccak256 over them.  A fetch failure is
        // NON-FATAL — the commitment row is always stored, with verified = false,
        // so a suppressed or unreachable payload is visible as such rather than
        // silently absent (architecture §4.9: the record's whole point is that it
        // cannot be quietly withheld).
        //
        // T12: the fetch is now BOUNDED-RETRY, and the row it writes is
        // REPAIRABLE. A `verified = false` written here is a provisional state
        // that `sweep_unverified_receipts` (below) and any re-index both
        // converge out of — it is not the permanent verdict it used to be.
        //
        // Security round 2: every fetch of the tick shares INLINE_FETCH_TIME_BUDGET. Past it the
        // receipt is stored unfetched and the sweep fetches it later.
        //
        // SCOPE: this verifies the payload DIGEST only.  Per-analyst ed25519
        // verification of the signatures embedded in the payload is `rmpc`'s job
        // at submit time (architecture §4.9.1 answer 1: rmpc refuses to submit a
        // receipt whose digest or embedded signatures do not verify) and a future
        // indexer pass.  The EVM has no ed25519 precompile and ADR-0012 §5 closes
        // that seam, so nothing on chain asserts it either.
        let verification = if decoded.payloadUri.is_empty() {
            ReceiptVerification {
                verified: false,
                payload_bytes: None,
                attempts: 0,
                last_error: Some("payload_uri is empty".to_string()),
            }
        } else if inline_fetch_deadline.is_some_and(|d| tokio::time::Instant::now() >= d) {
            // Security round 2: the tick's inline fetch budget is spent. Store the commitment
            // unfetched; the sweep's working set holds it (no attempt counted against it).
            ReceiptVerification {
                verified: false,
                payload_bytes: None,
                attempts: 0,
                last_error: Some(format!(
                    "not fetched at index time: the tick's {}s inline fetch budget was spent; \
                     the re-verification sweep fetches it",
                    INLINE_FETCH_TIME_BUDGET.as_secs()
                )),
            }
        } else {
            let fetch = fetch_and_verify_payload(&decoded.payloadUri, payload_digest);
            let outcome = match inline_fetch_deadline {
                Some(deadline) => match tokio::time::timeout_at(deadline, fetch).await {
                    Ok(outcome) => outcome,
                    Err(_) => ReceiptVerification {
                        verified: false,
                        payload_bytes: None,
                        attempts: 1,
                        last_error: Some(format!(
                            "payload fetch cut by the tick's {}s inline fetch budget",
                            INLINE_FETCH_TIME_BUDGET.as_secs()
                        )),
                    },
                },
                None => fetch.await,
            };
            if let Some(err) = outcome.last_error.as_deref() {
                tracing::warn!(
                    receipt_id = %alloy_primitives::hex::encode(receipt_id),
                    payload_uri = %decoded.payloadUri,
                    attempts = outcome.attempts,
                    error = %err,
                    "consensus receipt payload fetch/verify did not verify; \
                     storing receipt with verified=false (repairable — the \
                     re-verification sweep will retry)"
                );
            }
            outcome
        };

        let r = db
            .insert_consensus_receipt(
                cfg.chain_id,
                log.address.into_array(),
                receipt_id,
                receipt_index,
                decoded.submitter.into_array(),
                payload_digest,
                &decoded.payloadUri,
                decoded.recordedAt as i64,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                verification,
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.consensus_receipt_released {
        let decoded = IConsensusRecommendationReceiptEvents::ReceiptReleased::decode_log(
            &into_alloy_log(log),
            true,
        )
        .map_err(|e| IndexerError::Decode(format!("ReceiptReleased: {e}")))?;
        let r = db
            .mark_consensus_receipt_released(
                cfg.chain_id,
                log.address.into_array(),
                decoded.receiptId.0,
                decoded.releasedBy.into_array(),
                decoded.releasedAt as i64,
                log.block_number as i64,
            )
            .await?;
        return Ok(r);
    }

    Ok(0)
}

/// T12: how many times one pass of [`fetch_and_verify_payload`] will try.
const PAYLOAD_FETCH_ATTEMPTS: u32 = 3;
/// T12: per-attempt HTTP timeout. 3 attempts plus the backoff below stay inside
/// the ~30 s budget the review asked for, so one tick cannot stall on one URI.
const PAYLOAD_FETCH_TIMEOUT_SECS: u64 = 5;
/// T12: backoff before attempts 2 and 3.
const PAYLOAD_FETCH_BACKOFF: [u64; 2] = [2, 6];

/// T12: how many receipts one tick's re-verification sweep may re-fetch.
const SWEEP_BATCH: i64 = 16;
/// Security round 1: the wall-clock budget of one tick's re-verification sweeps.
///
/// The sweep runs before the tick indexes anything. One receipt can take
/// [`PAYLOAD_FETCH_ATTEMPTS`] timeouts plus the backoff (about 23 s), so a batch
/// of [`SWEEP_BATCH`] payload hosts that never answer held every tick for about
/// six minutes, and the watchdog's volume evaluation behind it. Past this budget
/// the sweep starts no further fetch and cuts the one in flight; the cut attempt
/// still counts toward [`SWEEP_MAX_ATTEMPTS`], and the rest waits for the next tick.
/// Security round 3: the receipt sweep and the vote memo sweep
/// ([`sweep_unverified_votes`]) share one deadline of this width per tick.
pub const SWEEP_TIME_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);
/// Security round 1: the most bytes a payload or memo fetch reads. The body is
/// streamed and the fetch fails once it passes this, before it is all buffered.
const MAX_FETCH_BODY: usize = 1024 * 1024;
/// T12: attempts after which the sweep gives up on a receipt.
///
/// This is what makes the sweep TERMINATE. Without a ceiling, a receipt whose
/// payload host is permanently gone is re-fetched on every tick for the life of
/// the database — the sweep would become a self-inflicted, unbounded outbound
/// request loop against a dead host. A row that hits the ceiling keeps its
/// `last_verify_error` and stays publicly visible as unverified; a deliberate
/// operator re-index (which resets nothing but re-runs the insert path) is the
/// escape hatch.
const SWEEP_MAX_ATTEMPTS: i32 = 12;

/// T12 — the re-verification sweep.
///
/// One 502 from the payload host during a frontend redeploy used to pin an
/// authentic, correctly-signed receipt at `verified = false` FOR THE LIFE OF THE
/// DATABASE: the fetch was single-attempt, every error was swallowed, no code
/// path anywhere updated `verified`, and the insert ended
/// `ON CONFLICT DO NOTHING` so even a full deliberate re-index changed nothing.
/// The only remedy was wiping the explorer database — which is also where the
/// watchdog's un-resettable cold-start baseline `MIN(indexer_runs.started_at)`
/// lives, so the remedy paged.
///
/// This closes it: every tick, re-fetch a bounded batch of rows that are still
/// unverified, and repair the ones that now verify. Repair NEVER downgrades (see
/// [`Db::repair_receipt_verification`]) and the digest is still compared against
/// the on-chain `payload_digest`, so convergence cannot admit a wrong preimage.
///
/// A sweep failure is never fatal to the tick: the receipts are already stored,
/// and the next tick tries again. It starts no fetch past `deadline` and cuts the one in
/// flight at it ([`SWEEP_TIME_BUDGET`]).
async fn sweep_unverified_receipts(
    db: &Db,
    cfg: &IndexerConfig,
    deadline: tokio::time::Instant,
) -> u64 {
    if cfg.consensus_receipt.is_none() {
        return 0;
    }
    let pending = match db
        .list_unverified_receipts(cfg.chain_id, SWEEP_MAX_ATTEMPTS, SWEEP_BATCH)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "consensus receipt re-verification sweep: query failed");
            return 0;
        }
    };

    let mut repaired = 0u64;
    for row in pending {
        let mut digest = [0u8; 32];
        if row.payload_digest.len() != 32 {
            tracing::warn!(
                receipt_id = %alloy_primitives::hex::encode(&row.receipt_id),
                "consensus receipt re-verification sweep: payload_digest is not 32 bytes; skipping"
            );
            continue;
        }
        digest.copy_from_slice(&row.payload_digest);

        // Security round 1: the sweep runs before the tick indexes, so it gets a fixed budget.
        if tokio::time::Instant::now() >= deadline {
            tracing::info!(
                budget_secs = SWEEP_TIME_BUDGET.as_secs(),
                "consensus receipt re-verification sweep: time budget spent; the rest waits for \
                 the next tick"
            );
            break;
        }
        let outcome = match tokio::time::timeout_at(
            deadline,
            fetch_and_verify_payload(&row.payload_uri, digest),
        )
        .await
        {
            Ok(outcome) => outcome,
            // Recorded as an attempt, so a payload host that never answers reaches
            // SWEEP_MAX_ATTEMPTS and stops taking the budget of every tick.
            Err(_) => ReceiptVerification {
                verified: false,
                payload_bytes: None,
                attempts: 1,
                last_error: Some(format!(
                    "payload fetch cut by the sweep's {}s per-tick budget",
                    SWEEP_TIME_BUDGET.as_secs()
                )),
            },
        };
        match db
            .repair_receipt_verification(
                cfg.chain_id,
                &row.contract_address,
                &row.receipt_id,
                outcome.verified,
                outcome.payload_bytes,
                outcome.last_error.as_deref(),
            )
            .await
        {
            Ok(_) if outcome.verified => {
                repaired += 1;
                tracing::info!(
                    receipt_id = %alloy_primitives::hex::encode(&row.receipt_id),
                    "consensus receipt re-verification sweep: repaired to verified=true"
                );
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(
                error = %e,
                receipt_id = %alloy_primitives::hex::encode(&row.receipt_id),
                "consensus receipt re-verification sweep: repair write failed"
            ),
        }
    }
    repaired
}

/// Fetch the canonical receipt bytes from `payload_uri` and verify their
/// keccak256 against the on-chain `expected_digest`.
///
/// T12 — BOUNDED RETRY. The previous shape was one 10 s GET, no retry, every
/// error swallowed into `(false, None)`. A transient 502 (a frontend redeploy
/// is enough) therefore decided an authentic receipt's public `verified` flag
/// for ever. This retries [`PAYLOAD_FETCH_ATTEMPTS`] times with the
/// [`PAYLOAD_FETCH_BACKOFF`] delays, and only for TRANSPORT failures: a body
/// that is fetched successfully and does not hash to the digest is a
/// deterministic answer, and re-fetching it is pure load. The returned
/// [`ReceiptVerification`] carries the attempt count and the last error so the
/// stored row says *why* it is unverified — which is what the compromise
/// runbook needs to distinguish an unreachable host from a forgery.
///
/// Never errors: every failure mode is represented in the returned value,
/// because the commitment row is stored either way.
async fn fetch_and_verify_payload(
    payload_uri: &str,
    expected_digest: [u8; 32],
) -> ReceiptVerification {
    let mut attempts: i32 = 0;
    let mut last_error: Option<String> = None;

    for attempt in 0..PAYLOAD_FETCH_ATTEMPTS {
        if attempt > 0 {
            let backoff = PAYLOAD_FETCH_BACKOFF
                .get(attempt as usize - 1)
                .copied()
                .unwrap_or(*PAYLOAD_FETCH_BACKOFF.last().unwrap());
            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        }
        attempts += 1;

        match fetch_payload_once(payload_uri).await {
            // Transport succeeded. Whatever the digest comparison says is the
            // final answer for this pass — a mismatching body will mismatch
            // again, so do not spend the remaining attempts on it.
            Ok(body) => {
                let (verified, err) = digest_matches(&body, expected_digest);
                return ReceiptVerification {
                    verified,
                    payload_bytes: Some(body.len() as i64),
                    attempts,
                    last_error: err,
                };
            }
            Err(e) => {
                last_error = Some(e);
            }
        }
    }

    ReceiptVerification {
        verified: false,
        payload_bytes: None,
        attempts,
        last_error: last_error.or_else(|| Some("payload fetch failed".to_string())),
    }
}

/// One HTTP attempt at the payload. Transport-level errors only, plus a URI the
/// indexer refuses to fetch ([`guarded_fetch_client`]).
pub async fn fetch_payload_once(payload_uri: &str) -> Result<Vec<u8>, String> {
    let (client, url) = guarded_fetch_client(
        payload_uri,
        std::time::Duration::from_secs(PAYLOAD_FETCH_TIMEOUT_SECS),
    )
    .await?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {payload_uri}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GET {payload_uri} returned {}", resp.status()));
    }

    read_capped_body(resp, MAX_FETCH_BODY)
        .await
        .map_err(|e| format!("receipt payload {e}"))
}

/// AWS's IPv6 instance metadata endpoint. It sits in the unique-local range,
/// which the indexer otherwise allows (a devnet can serve from it).
const AWS_IMDS_V6: std::net::Ipv6Addr =
    std::net::Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254);

/// Whether the indexer refuses to fetch an on-chain URI from `ip` (security
/// round 1): link-local (the cloud metadata endpoint 169.254.169.254 is one),
/// unspecified, broadcast and multicast addresses, AWS's IPv6 metadata address,
/// and the IPv4-mapped form of each. No payload host is ever one of them.
///
/// Loopback and private ranges are allowed on purpose: a devnet and the tests
/// serve receipts from them, and their responses reveal no more than a public
/// host's (a verified flag; [`fetch_payload_once`] streams at most 1 MiB, and the
/// explorer serves the size of a verified payload only).
pub fn is_forbidden_fetch_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_forbidden_fetch_ip(IpAddr::V4(v4));
            }
            v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6 == AWS_IMDS_V6
        }
    }
}

/// A client for one GET of an on-chain URI (a receipt's `payloadUri`, a vote's
/// `rationaleUri`), and the parsed URL (security round 1).
///
/// An allowlisted receipt submitter or a committee member picks the URI, and the
/// indexer fetches it from its own network position. So the scheme must be http
/// or https, and the host must not be (or resolve to) an address
/// [`is_forbidden_fetch_ip`] refuses. The client connects only to the addresses
/// that were checked, so a second DNS answer cannot move it, and it follows a
/// redirect (at most 5) only to the same host.
pub async fn guarded_fetch_client(
    uri: &str,
    timeout: std::time::Duration,
) -> Result<(reqwest::Client, reqwest::Url), String> {
    let url = reqwest::Url::parse(uri).map_err(|e| format!("invalid URI {uri:?}: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "refused {uri}: only http and https URIs are fetched"
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| format!("refused {uri}: no host"))?
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let mut builder = reqwest::Client::builder().timeout(timeout);
    let literal = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok();
    match literal {
        Some(ip) => {
            if is_forbidden_fetch_ip(ip) {
                return Err(format!("refused {uri}: {ip} is not a payload host"));
            }
        }
        None => {
            let addrs = resolve_within(
                &host,
                timeout,
                tokio::net::lookup_host((host.as_str(), port)),
            )
            .await?;
            if addrs.is_empty() {
                return Err(format!("resolve {host}: no address"));
            }
            if let Some(bad) = addrs.iter().find(|a| is_forbidden_fetch_ip(a.ip())) {
                return Err(format!(
                    "refused {uri}: {host} resolves to {}, not a payload host",
                    bad.ip()
                ));
            }
            builder = builder.resolve_to_addrs(&host, &addrs);
        }
    }
    let same_host = host.clone();
    builder = builder.redirect(reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if attempt.url().host_str() == Some(same_host.as_str()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    }));
    let client = builder.build().map_err(|e| format!("build client: {e}"))?;
    Ok((client, url))
}

/// Await `lookup` (a DNS resolution of `host`) for at most `timeout` (security round 2).
///
/// The fetch's `timeout` bounds the request reqwest makes, and the resolution runs before the
/// client exists, so it was unbounded: a name whose authoritative server never answers added the
/// system resolver's own timeout (tens of seconds with retries) to every attempt. The resolution
/// now shares the attempt's budget.
pub async fn resolve_within<I, F>(
    host: &str,
    timeout: std::time::Duration,
    lookup: F,
) -> Result<Vec<std::net::SocketAddr>, String>
where
    I: Iterator<Item = std::net::SocketAddr>,
    F: std::future::Future<Output = std::io::Result<I>>,
{
    match tokio::time::timeout(timeout, lookup).await {
        Ok(Ok(addrs)) => Ok(addrs.collect()),
        Ok(Err(e)) => Err(format!("resolve {host}: {e}")),
        Err(_) => Err(format!("resolve {host}: no answer within {timeout:?}")),
    }
}

/// Read `resp`'s body, failing once it passes `max` bytes: a declared
/// `Content-Length` over the cap fails before any byte is read, and a streamed
/// body fails at the chunk that crosses it. Never buffers more than `max` plus
/// one chunk.
async fn read_capped_body(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > max as u64 {
            return Err(format!("too large: {len} bytes (max {max})"));
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        if body.len() + chunk.len() > max {
            return Err(format!("too large: over {max} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Compare a fetched body against the on-chain digest.
///
/// TWO ADMISSIBLE PREIMAGES, IN THIS ORDER, AND NEVER A THIRD.
///
/// 1. The served bytes themselves. This is the literal reading of the
///    commitment and stays the first thing tried, so a `payload_uri` that
///    serves the exact canonical bytes is verified without parsing anything.
///
/// 2. The canonical bytes RE-DERIVED from the served JSON by the same parser
///    and canonicalizer `rmpc` uses (`ConsensusReceipt::from_json_slice` ->
///    `canonical_bytes()`), which also unwraps an unambiguous envelope.
///    robotmoney-frontend's public route serves that envelope
///    (`{sessionId, …, receipt, canonicalBytes, verified, …}`), so its
///    keccak256 is NOT the anchored digest even though the receipt inside is
///    exactly the anchored object. Without this branch the indexer stores
///    `verified = false` for every real frontend receipt while `rmpc` (which
///    was taught the same unwrap at af878e46) reports the anchor as correct.
///
/// This can never accept a wrong digest: the comparison is still against the
/// on-chain `expected_digest`, the canonicalization is deterministic, and the
/// re-derivation reads only the receipt object. The envelope's `verified` flag
/// is still never trusted — it is the server's own claim. Its `canonicalBytes`
/// are used only as a CROSS-CHECK, never as a source: `from_json_slice` compares
/// them against core's own re-derivation and returns
/// `ErrReceiptCanonicalBytesMismatch` when the two producers disagree
/// (T03/R27), which lands here as `verified = false`. So a publisher that hashes
/// a preimage core would not re-derive can never be recorded verified by
/// agreeing with itself.
///
/// Returns `(verified, explanation_when_not_verified)`.
fn digest_matches(body: &[u8], expected_digest: [u8; 32]) -> (bool, Option<String>) {
    if alloy_primitives::keccak256(body).0 == expected_digest {
        return (true, None);
    }

    match rust_payment_client::consensus_receipt::ConsensusReceipt::canonical_bytes_from_json_slice(
        body,
    ) {
        Ok(canonical) => {
            if alloy_primitives::keccak256(&canonical).0 == expected_digest {
                (true, None)
            } else {
                (
                    false,
                    Some(
                        "digest mismatch: neither the served bytes nor the re-derived \
                          canonical bytes hash to the on-chain payloadDigest"
                            .to_string(),
                    ),
                )
            }
        }
        // Not parseable as a schema-1.0 receipt (or an envelope carrying one)
        // and not a byte match either: unverified, and the row still stores.
        Err(e) => (
            false,
            Some(format!(
                "digest mismatch and payload is not a parseable consensus receipt: {e}"
            )),
        ),
    }
}

/// IDX-3: persist the owner's resulting `wallet_positions` share balance after
/// an ERC-4626 mint/burn event.  Applies the `shares` delta (`add = true` for a
/// deposit/mint, `false` for a withdraw/burn, saturating at zero) to the owner's
/// balance in this vault (`contract = log.address`) just before this log, and
/// writes the block's balance ([`Db::apply_wallet_position_delta`]). A second
/// share change of the same owner in the same block updates that block's row
/// (security round 1). Returns the rows written (0 for a log already applied).
async fn persist_wallet_position(
    db: &Db,
    cfg: &IndexerConfig,
    log: &LogEntry,
    owner: [u8; 20],
    shares: U256,
    add: bool,
) -> Result<u64, IndexerError> {
    let r = db
        .apply_wallet_position_delta(
            cfg.chain_id,
            log.address.into_array(),
            owner,
            log.block_number as i64,
            log.log_index as i32,
            shares,
            add,
        )
        .await?;
    Ok(r)
}

/// Convert our local `LogEntry` to the `alloy_primitives::Log` shape
/// `SolEvent::decode_log` expects.
fn into_alloy_log(log: &LogEntry) -> alloy_primitives::Log {
    alloy_primitives::Log {
        address: log.address,
        data: alloy_primitives::LogData::new_unchecked(log.topics.clone(), log.data.clone()),
    }
}

/// The stored state of a `vault_snapshots` row, compared with a fresh chain read to decide whether a
/// heartbeat read is worth a new row (issue 1768). Numbers are decimal strings, `None` is unknown (NULL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultState {
    pub total_assets: String,
    pub total_supply: String,
    pub exit_fee_bps: i64,
    pub tvl_cap: Option<String>,
    pub per_deposit_cap: Option<String>,
    pub paused: bool,
    /// `previewRedeem(totalSupply())`: what redeeming every share pays after the exit costs (core 1795).
    pub preview_redeem_total: Option<String>,
}

/// What a tick does with one vault at its target block (issue 1781, QA plan X6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotRead {
    /// No `eth_call`s for this vault in this tick.
    Skip,
    /// Read the vault and write a row whatever its state.
    Write,
    /// Read the vault and write a row only when the state differs from the newest row.
    WriteIfChanged,
}

/// Decide whether a tick ending at `target` reads a vault whose newest `vault_snapshots` row is
/// `newest` (block and state), and whether an unchanged read writes a row (issue 1781).
///
/// - No row yet: read and write, so every vault has a first row in the tick that first sees it.
/// - A row at `target` already (an event-driven snapshot in this tick): no read.
/// - The newest row is `SNAPSHOT_HEARTBEAT_BLOCKS` or more behind: read and write, an identical row on
///   purpose (issue 1768).
/// - Otherwise read, writing only a change, when the vault emitted a watched log in this tick
///   (`emitted_log`), holds nothing (`total_assets` 0, so its first deposit shows within a tick),
///   has an unknown cap (the issue 1741 retry), or has no exit value (a row older than migration 0026,
///   or a failed `previewRedeem` read; core 1795).
/// - Any other vault is not read. Its state changes only through its own watched events, or through
///   yield and prices, which the heartbeat samples.
pub fn snapshot_read(
    newest: Option<(i64, &VaultState)>,
    target: u64,
    emitted_log: bool,
) -> SnapshotRead {
    let Some((block, state)) = newest else {
        return SnapshotRead::Write;
    };
    let target = i64::try_from(target).unwrap_or(i64::MAX);
    if block >= target {
        return SnapshotRead::Skip;
    }
    if target - block >= SNAPSHOT_HEARTBEAT_BLOCKS as i64 {
        return SnapshotRead::Write;
    }
    let zero_tvl = state.total_assets == "0";
    let unknown_cap = state.tvl_cap.is_none() || state.per_deposit_cap.is_none();
    let unknown_exit_value = state.preview_redeem_total.is_none();
    if emitted_log || zero_tvl || unknown_cap || unknown_exit_value {
        SnapshotRead::WriteIfChanged
    } else {
        SnapshotRead::Skip
    }
}

/// Read totalAssets / totalSupply / previewRedeem(totalSupply) / exitFeeBps / tvlCap /
/// perDepositCap / depositsPaused from a
/// vault at `block` and write a `vault_snapshots` row. The `paused` column
/// keeps its historical name but stores `depositsPaused()` (a deposit-only
/// pause; withdrawals are never frozen).
/// Snapshot one vault, logging and skipping on failure instead of propagating.
///
/// A single vault's `totalAssets()`/`totalSupply()` read can fail for reasons
/// that must not wedge the whole indexer — e.g. the call lands on a block where
/// that vault had no code yet (router-event-block snapshots of a vault registered
/// later return an empty `eth_call` -> "u256 read: short response (0 bytes)"), or
/// a transient revert. Previously the `?` in `snapshot_vault_address` aborted the
/// entire tick, so one un-snapshottable vault left every other registered vault's
/// TVL null forever and stalled the indexer (issue #878). Returning the rows
/// inserted (0 on failure) keeps the tick advancing; the next heartbeat re-snaps
/// the skipped vault at `target`, where it does have code.
async fn snapshot_vault_or_skip(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    vault: Address,
    block: u64,
    skip_if_equal: Option<&VaultState>,
) -> i64 {
    match snapshot_vault_address(db, rpc, chain_id, vault, block, skip_if_equal).await {
        Ok(n) => n as i64,
        Err(e) => {
            tracing::warn!(vault = %vault, block, error = %e, "skipping vault snapshot");
            0
        }
    }
}

async fn snapshot_vault_address(
    db: &Db,
    rpc: &JsonRpc,
    chain_id: i64,
    vault: Address,
    block: u64,
    skip_if_equal: Option<&VaultState>,
) -> Result<u64, IndexerError> {
    let total_assets = call_u256(
        rpc,
        vault,
        IVaultReads::totalAssetsCall {}.abi_encode(),
        block,
    )
    .await?;
    let total_supply = call_u256(
        rpc,
        vault,
        IVaultReads::totalSupplyCall {}.abi_encode(),
        block,
    )
    .await?;
    // What redeeming the whole supply pays after the exit costs the vault prices itself: the exit fee on both
    // families and the `maxSlippageBps` floor on a BasketVault (core 1795). The API scales it to a holder's
    // shares, so a position is shown at `previewRedeem`, never at the gross `convertToAssets`. A failed read is
    // `None` (stored NULL, served as an unknown value) and the vault is read again next tick.
    let preview_redeem_total = call_u256(
        rpc,
        vault,
        IVaultReads::previewRedeemCall {
            shares: total_supply,
        }
        .abi_encode(),
        block,
    )
    .await
    .map_err(|e| tracing::warn!(vault = %vault, block, error = %e, "previewRedeem(totalSupply) read failed; stored as unknown"))
    .ok();
    let exit_fee_bps = call_u256(
        rpc,
        vault,
        IVaultReads::exitFeeBpsCall {}.abi_encode(),
        block,
    )
    .await
    .unwrap_or(U256::ZERO);
    // Both caps are public getters on RobotMoneyVault and on every BasketVault. A failed read is `None` (stored
    // NULL, served as unknown), never 0: a zero cap would read as "deposits impossible" (issue 1741).
    let tvl_cap = call_u256(rpc, vault, IVaultReads::tvlCapCall {}.abi_encode(), block)
        .await
        .map_err(|e| tracing::warn!(vault = %vault, block, error = %e, "tvlCap() read failed; stored as unknown"))
        .ok();
    let per_deposit_cap = call_u256(
        rpc,
        vault,
        IVaultReads::perDepositCapCall {}.abi_encode(),
        block,
    )
    .await
    .map_err(|e| tracing::warn!(vault = %vault, block, error = %e, "perDepositCap() read failed; stored as unknown"))
    .ok();
    // `depositsPaused()` exists on every vault, the v1 vault included. A failed read skips the snapshot
    // (the caller retries on the next heartbeat) rather than recording "not paused": the explorer shows
    // this flag next to the vault, and "open" must never be a guess.
    let deposits_paused = call_bool(
        rpc,
        vault,
        IVaultReads::depositsPausedCall {}.abi_encode(),
        block,
    )
    .await?;

    let exit_fee_bps: i64 = exit_fee_bps.try_into().unwrap_or(0i64);
    if let Some(prev) = skip_if_equal {
        let now = VaultState {
            total_assets: total_assets.to_string(),
            total_supply: total_supply.to_string(),
            exit_fee_bps,
            tvl_cap: tvl_cap.map(|c| c.to_string()),
            per_deposit_cap: per_deposit_cap.map(|c| c.to_string()),
            paused: deposits_paused,
            preview_redeem_total: preview_redeem_total.map(|v| v.to_string()),
        };
        if now == *prev {
            return Ok(0);
        }
    }
    db.insert_vault_snapshot(
        chain_id,
        vault.into_array(),
        block as i64,
        total_assets,
        total_supply,
        exit_fee_bps,
        tvl_cap,
        per_deposit_cap,
        deposits_paused,
        preview_redeem_total,
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

/// Label stored when a registration name matches no discriminator.
const DEFAULT_RISK_LABEL: &str = "STABLE_YIELD";

/// Classify a vault registration name into its PRD §11 risk label, or `None`
/// when no discriminator matches.
///
/// The deploy scripts register `Robot Money ...` names (`Robot Money USDC`,
/// `Robot Money Protocol`, `Robot Money Agent Tokens`, `Robot Money RWA`); the
/// legacy `RM ...` names also classify. The name is lower-cased and
/// whitespace-collapsed first, because the rmUSDC name is a deploy-time env
/// input. Basket discriminators (agent, rwa, protocol) are tested before
/// `usdc` so a basket vault denominated in USDC classifies on what it holds.
fn classify_vault_risk_label(name: &str) -> Option<&'static str> {
    let n = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if n.contains("agent") || n.contains("rwa") {
        Some("SPECULATIVE")
    } else if n.contains("protocol") {
        Some("VOLATILE")
    } else if n.contains("usdc") {
        Some("STABLE_YIELD")
    } else {
        None
    }
}

/// Map vault name to risk label per PRD §11.
/// The VaultRegistered event carries only (vault, name, asset), so the indexer
/// derives risk_label from the registration name via
/// [`classify_vault_risk_label`]. An unrecognised name stores STABLE_YIELD and
/// logs a warning, because the dapp renders basket composition off this column.
fn risk_label_from_vault_name(vault: Address, name: &str) -> &'static str {
    classify_vault_risk_label(name).unwrap_or_else(|| {
        tracing::warn!(
            vault = %vault,
            name = %name,
            "vault name matches no risk-label discriminator; defaulting to STABLE_YIELD"
        );
        DEFAULT_RISK_LABEL
    })
}

/// Unit coverage for the deploy-block derivation (the start-block bug).
///
/// These are in-crate and chain-free on purpose: the search, the probe
/// classification and the cursor reconciliation are the parts that have to be
/// right on THREE different chain shapes, and none of those shapes is
/// reproducible from a single live backend. The end-to-end behaviour against a
/// simulated the Twin fork (an anvil lazy fork) chain is in
/// `tests/deploy_block_detection.rs`.
#[cfg(test)]
mod tests {
    use super::*;

    // ── risk_label classification (issue 1566) ──────────────────────────────

    #[test]
    fn risk_label_robot_money_names() {
        for (name, want) in [
            ("Robot Money USDC", "STABLE_YIELD"),
            ("Robot Money Protocol", "VOLATILE"),
            ("Robot Money Agent Tokens", "SPECULATIVE"),
            ("Robot Money RWA", "SPECULATIVE"),
            ("Robot Money RWA / Thematic", "SPECULATIVE"),
        ] {
            assert_eq!(classify_vault_risk_label(name), Some(want), "{name}");
        }
    }

    #[test]
    fn risk_label_legacy_rm_names() {
        for (name, want) in [
            ("RM USDC", "STABLE_YIELD"),
            ("RM Protocol", "VOLATILE"),
            ("RM Agent Tokens", "SPECULATIVE"),
            ("RM RWA / Thematic", "SPECULATIVE"),
        ] {
            assert_eq!(classify_vault_risk_label(name), Some(want), "{name}");
        }
    }

    #[test]
    fn risk_label_normalises_case_and_whitespace() {
        for name in [
            "ROBOT MONEY AGENT TOKENS",
            "  robot  money\tagent   tokens\n",
        ] {
            assert_eq!(classify_vault_risk_label(name), Some("SPECULATIVE"));
        }
    }

    #[test]
    fn risk_label_basket_outranks_usdc() {
        assert_eq!(
            classify_vault_risk_label("Robot Money Protocol (USDC)"),
            Some("VOLATILE")
        );
    }

    #[test]
    fn risk_label_unrecognised_is_none_and_defaults() {
        assert_eq!(classify_vault_risk_label("Some Unrelated Vault"), None);
        assert_eq!(
            risk_label_from_vault_name(Address::ZERO, "Some Unrelated Vault"),
            "STABLE_YIELD"
        );
    }

    #[test]
    fn risk_label_deploy_script_vault_names_classify_as_baskets() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/script");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("read contracts/script") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("sol") {
                continue;
            }
            for line in std::fs::read_to_string(&path).expect("read script").lines() {
                let t = line.trim_start();
                if t.starts_with("//") || !t.contains("VAULT_NAME = \"") {
                    continue;
                }
                if !t.contains("string public constant VAULT_NAME") {
                    continue;
                }
                let lit = t.split('"').nth(1).expect("string literal");
                found.push(lit.to_string());
            }
        }
        assert!(
            found.len() >= 3,
            "scraped only {found:?}; scrape went blind"
        );
        for name in &found {
            let label = classify_vault_risk_label(name);
            assert!(
                matches!(label, Some("VOLATILE") | Some("SPECULATIVE")),
                "{name} classified {label:?}, expected a basket label"
            );
        }
    }

    fn server_error(message: &str) -> Result<Bytes, RpcError> {
        Err(RpcError::Server {
            method: "eth_getCode".to_string(),
            message: message.to_string(),
        })
    }

    // ── the three probe classifications ─────────────────────────────────────

    #[test]
    fn code_present_classifies_as_present() {
        let code = Ok(Bytes::from_static(&[0x60, 0x80, 0x60, 0x40]));
        assert_eq!(classify_code_probe(&code), CodeProbe::Present);
    }

    #[test]
    fn empty_code_classifies_as_empty() {
        // `0x` — the address exists as far as the chain is concerned, and has
        // no code there. This is the ONLY "no" that means "below the deploy".
        assert_eq!(classify_code_probe(&Ok(Bytes::new())), CodeProbe::Empty);
    }

    #[test]
    fn out_of_range_errors_classify_as_below_history() {
        // Verbatim from the live stage host's the Twin fork (an anvil lazy fork) chain.
        assert_eq!(
            classify_code_probe(&server_error(
                "{\"code\":-32602,\"message\":\"BlockOutOfRangeError: block height is \
                 48897128 but requested was 3999\"}"
            )),
            CodeProbe::BelowHistory
        );
        // Anvil, for a height inside the hole below its restored range.
        assert_eq!(
            classify_code_probe(&server_error("{\"message\":\"block 0x3e8 not found\"}")),
            CodeProbe::BelowHistory
        );
        // Geth, for the same class of question.
        assert_eq!(
            classify_code_probe(&server_error("{\"message\":\"header not found\"}")),
            CodeProbe::BelowHistory
        );
    }

    #[test]
    fn a_pruned_state_is_not_a_history_boundary() {
        // `missing trie node` means the node dropped the STATE at that height,
        // not that it lacks the block — and `eth_getLogs`, which is what this
        // indexer actually reads, still serves the whole range on that node.
        // Read as a boundary it makes every ordinary non-archive Base mainnet
        // endpoint converge on ~head-128 and skip every event ever emitted
        // below it, silently. Unusable aborts detection instead.
        assert_eq!(
            classify_code_probe(&server_error("{\"message\":\"missing trie node 0xabc\"}")),
            CodeProbe::Unusable
        );
    }

    #[test]
    fn unrelated_failures_are_unusable_not_below_history() {
        // A dead RPC says nothing about any height. Reading it as "below"
        // would walk the lower bound up to the head, and a floor at the head
        // misses every event.
        assert_eq!(
            classify_code_probe(&Err(RpcError::Transport("connection refused".into()))),
            CodeProbe::Unusable
        );
        assert_eq!(
            classify_code_probe(&server_error(
                "{\"code\":-32000,\"message\":\"rate limited\"}"
            )),
            CodeProbe::Unusable
        );
    }

    // ── convergence, on each chain shape ────────────────────────────────────

    /// Geth devnet: full history from 0, so the search finds the TRUE deploy
    /// block.
    #[tokio::test]
    async fn converges_to_the_true_deploy_block_on_a_full_history_chain() {
        let probes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = probes.clone();
        let found = search_lowest_code_block(10_000, move |block| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if block >= 4_200 {
                    CodeProbe::Present
                } else {
                    CodeProbe::Empty
                }
            }
        })
        .await;
        assert_eq!(found, Some(4_200));
        // Logarithmic, not linear — the whole point of a search over a scan.
        assert!(
            probes.load(std::sync::atomic::Ordering::SeqCst) <= 14,
            "10k blocks must cost ~14 probes, spent {}",
            probes.load(std::sync::atomic::Ordering::SeqCst)
        );
    }

    /// the Twin fork (an anvil lazy fork): the head is Base mainnet's, and the chain serves
    /// NOTHING between genesis and the fork point. The contract predates the
    /// fork, so the honest answer is the earliest block at which this chain can
    /// show it — not a "deploy block" it cannot see.
    #[tokio::test]
    async fn converges_to_the_earliest_servable_block_on_a_fork_state_chain() {
        const LOWEST_SERVABLE: u64 = 48_896_512;
        const HEAD: u64 = 48_898_552;
        let probes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = probes.clone();
        let found = search_lowest_code_block(HEAD, move |block| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if block < LOWEST_SERVABLE {
                    CodeProbe::BelowHistory
                } else {
                    CodeProbe::Present
                }
            }
        })
        .await;
        assert_eq!(found, Some(LOWEST_SERVABLE));
        assert!(
            probes.load(std::sync::atomic::Ordering::SeqCst) <= 26,
            "48.9M blocks must cost ~26 probes, spent {}",
            probes.load(std::sync::atomic::Ordering::SeqCst)
        );
    }

    /// All three verdicts in one search: restored fork state whose contract was
    /// deployed ABOVE the fork point, so the answer is a real deploy block and
    /// the out-of-range probes below it must move the bound exactly as the
    /// empty ones do.
    #[tokio::test]
    async fn out_of_range_and_empty_move_the_bound_the_same_way() {
        const LOWEST_SERVABLE: u64 = 48_896_512;
        const DEPLOY: u64 = 48_897_400;
        let found = search_lowest_code_block(48_898_552, |block| async move {
            if block < LOWEST_SERVABLE {
                CodeProbe::BelowHistory
            } else if block < DEPLOY {
                CodeProbe::Empty
            } else {
                CodeProbe::Present
            }
        })
        .await;
        assert_eq!(found, Some(DEPLOY));
    }

    #[tokio::test]
    async fn an_unusable_probe_aborts_the_search_instead_of_guessing() {
        let found = search_lowest_code_block(48_898_552, |_| async { CodeProbe::Unusable }).await;
        assert_eq!(found, None, "a failed probe must never produce a floor");
    }

    // ── folding the per-contract answers ────────────────────────────────────

    #[test]
    fn the_floor_is_the_minimum_over_the_watched_contracts() {
        assert_eq!(
            fold_deploy_floor(&[48_897_400, 48_896_512, 48_897_000], 0),
            Some(48_896_512)
        );
    }

    #[test]
    fn one_undetermined_contract_refuses_the_floor_rather_than_averaging() {
        // The minimum over the contracts that DID resolve can sit above the
        // unresolved one's deploy block, and everything it emitted below that
        // would be skipped silently and for ever.
        assert_eq!(fold_deploy_floor(&[48_897_400, 48_897_000], 1), None);
    }

    #[test]
    fn no_contract_with_code_yields_no_floor_not_the_head() {
        assert_eq!(fold_deploy_floor(&[], 0), None);
    }

    // ── cursor versus floor ─────────────────────────────────────────────────

    #[test]
    fn a_cursor_above_the_deploy_block_wins() {
        // The healthy Geth case: the cursor is always above the deploy block,
        // so deriving a floor changes nothing at all.
        let start = resolve_cursor_start(Some(48_897_100), 48_896_512);
        assert_eq!(start.cursor, Some(48_897_100));
        assert_eq!(start.overridden, None);
        assert_eq!(first_block(start.cursor, 48_896_512), 48_897_101);
    }

    #[test]
    fn a_cursor_below_the_deploy_block_is_overridden_and_reported() {
        // The stage case: 5999 left by a destroyed Geth run, reused chain id
        // 918453, and block 5999 does not exist on the chain now answering.
        let start = resolve_cursor_start(Some(5_999), 48_896_512);
        assert_eq!(
            start.cursor, None,
            "a dead cursor must be dropped, not handed to the reorg check"
        );
        assert_eq!(
            start.overridden,
            Some(5_999),
            "the discarded cursor must be reported so the jump can be logged"
        );
        assert_eq!(first_block(start.cursor, 48_896_512), 48_896_512);
    }

    #[test]
    fn a_failed_detection_leaves_the_cursor_exactly_as_it_was() {
        // Floor 0 is what every degradation path returns, and it must be
        // byte-for-byte the behaviour this indexer had before detection
        // existed: resume at last + 1, or genesis on a fresh database.
        let start = resolve_cursor_start(Some(5_999), 0);
        assert_eq!(start.cursor, Some(5_999));
        assert_eq!(start.overridden, None);
        assert_eq!(first_block(start.cursor, 0), 6_000);
        assert_eq!(first_block(None, 0), 0);
    }

    // ── re-checking a floor that was persisted earlier ──────────────────────

    #[test]
    fn code_at_the_remembered_block_keeps_the_persisted_floor() {
        assert_eq!(
            classify_floor_check(CodeProbe::Present),
            FloorCheck::Holds,
            "the healthy steady state: one cheap probe, nothing else happens"
        );
    }

    #[test]
    fn a_remembered_block_this_chain_cannot_show_is_stale_not_authoritative() {
        // `Empty` is the only one that proves a different chain: this chain
        // SERVED the block and the address has no code at it, so the addresses
        // being deterministic means it was deployed somewhere else.
        assert_eq!(classify_floor_check(CodeProbe::Empty), FloorCheck::Stale);
        // `BelowHistory` proves nothing about which chain is answering. The
        // live the Twin fork (an anvil lazy fork) devnet retains ~3,600 blocks, so a floor
        // this code detected correctly ages out of history within a minute
        // through nothing but time passing. Calling that "the chain is gone"
        // cleared all five contracts and re-searched on EVERY tick, and the
        // alarm was false every time it fired.
        assert_eq!(
            classify_floor_check(CodeProbe::BelowHistory),
            FloorCheck::HistoryMoved
        );
    }

    #[test]
    fn an_unusable_recheck_keeps_the_floor_it_could_not_disprove() {
        // No evidence against the stored value, so discarding it would pay for
        // a full ~26-probe search every tick on a flaky round trip.
        assert_eq!(
            classify_floor_check(CodeProbe::Unusable),
            FloorCheck::Inconclusive
        );
    }

    #[test]
    fn catch_up_splits_into_ticks_of_at_most_max_blocks_with_no_gap_or_overlap() {
        for (start, head, end, max) in [
            (100u64, 3_450u64, None, 1000u64),
            (100, 1_099, None, 1000),
            (100, 1_100, None, 1000),
            (5, 5, None, 1000),
            (100, 9_999, Some(2_500u64), 1000),
            (100, 500, None, 1),
        ] {
            let stop = end.map_or(head, |e: u64| e.min(head));
            let mut next = start;
            let mut ranges = Vec::new();
            while let Some(t) = tick_target(next, head, end, max) {
                ranges.push((next, t));
                next = t + 1;
            }
            assert_eq!(ranges.first().map(|r| r.0), Some(start));
            assert_eq!(
                ranges.last().map(|r| r.1),
                Some(stop),
                "{start} {head} {end:?}"
            );
            for (a, b) in &ranges {
                assert!(b >= a && b - a < max, "{a}..{b} over {max}");
            }
            for w in ranges.windows(2) {
                assert_eq!(w[1].0, w[0].1 + 1, "gap or overlap");
            }
        }
        assert_eq!(tick_target(101, 100, None, 1000), None, "past the head");
        assert_eq!(
            tick_target(100, 500, Some(99), 1000),
            None,
            "past end_block"
        );
        assert_eq!(tick_target(0, 10_000, None, 1000), Some(999));
    }

    // ── the set detection runs over ─────────────────────────────────────────

    #[test]
    fn a_router_that_is_also_governance_is_registered_once_under_its_first_kind() {
        let router = Address::from([0x77u8; 20]);
        let cfg = IndexerConfig {
            chain_id: 918_453,
            chain_name: "devnet".into(),
            rpc_label: "stub".into(),
            gateway: Some(Address::from([0x11u8; 20])),
            vault: Address::from([0x22u8; 20]),
            registry: None,
            router_governance: Some(router),
            portfolio_router: Some(router),
            consensus_receipt: None,
            timelock: None,
            safe: None,
            max_blocks_per_tick: 100,
            start_block: None,
            end_block: None,
            feature_flags: 0,
        };
        let contracts = cfg.configured_contracts();
        assert_eq!(contracts.len(), 3);
        assert_eq!(
            contracts[2],
            (router, "router_governance"),
            "first kind wins, which is what the upsert's ON CONFLICT already did"
        );
    }

    /// RouterGovernance's voting events are gone (issue #1698), but as a proxied
    /// core contract it emits `Upgraded` / `UpgradesFrozen` (issue 1810), so it
    /// is registered AND watched.
    #[test]
    fn router_governance_is_registered_and_watched_for_proxy_events() {
        let gov = Address::from([0x66u8; 20]);
        let mut cfg = admin_cfg();
        cfg.router_governance = Some(gov);
        assert!(cfg.watched_addresses().contains(&gov));
        assert!(cfg
            .configured_contracts()
            .contains(&(gov, "router_governance")));
    }

    #[test]
    fn configured_start_block_is_the_floor_and_first_block_honours_it() {
        let mut cfg = IndexerConfig {
            chain_id: 8453,
            chain_name: "base".into(),
            rpc_label: "t".into(),
            gateway: Some(Address::from([0x11u8; 20])),
            vault: Address::from([0x22u8; 20]),
            registry: None,
            router_governance: None,
            portfolio_router: None,
            consensus_receipt: None,
            timelock: None,
            safe: None,
            max_blocks_per_tick: 1000,
            start_block: Some(52_401_633),
            end_block: None,
            feature_flags: 0,
        };
        let floor = configured_start_floor(&cfg).expect("start block configured");
        assert_eq!(floor, 52_401_633);
        assert_eq!(
            first_block(None, floor),
            52_401_633,
            "fresh database starts at the start block"
        );
        assert_eq!(
            first_block(Some(52_500_000), floor),
            52_500_001,
            "a cursor past it resumes"
        );
        cfg.start_block = None;
        assert_eq!(
            configured_start_floor(&cfg),
            None,
            "unset keeps the getCode derivation"
        );
    }

    // ── issue 1781 (QA plan X6): which vaults a tick reads ───────────────────

    fn vault_state(total_assets: &str, caps: Option<&str>) -> VaultState {
        VaultState {
            total_assets: total_assets.into(),
            total_supply: total_assets.into(),
            exit_fee_bps: 0,
            tvl_cap: caps.map(Into::into),
            per_deposit_cap: caps.map(Into::into),
            paused: false,
            preview_redeem_total: Some(total_assets.into()),
        }
    }

    #[test]
    fn a_tick_reads_only_new_due_touched_zero_tvl_or_unknown_cap_vaults() {
        let funded = vault_state("5", Some("100"));
        let target = 2_000u64;
        let recent = 1_999i64;
        // A vault that holds value, has known caps and emitted nothing costs no read.
        assert_eq!(
            snapshot_read(Some((recent, &funded)), target, false),
            SnapshotRead::Skip
        );
        // Its own watched log reads it; only a change writes a row.
        assert_eq!(
            snapshot_read(Some((recent, &funded)), target, true),
            SnapshotRead::WriteIfChanged
        );
        // No row yet: read and write.
        assert_eq!(snapshot_read(None, target, false), SnapshotRead::Write);
        // Zero TVL and an unknown cap keep the per-tick read.
        assert_eq!(
            snapshot_read(
                Some((recent, &vault_state("0", Some("100")))),
                target,
                false
            ),
            SnapshotRead::WriteIfChanged
        );
        let mut one_unknown = funded.clone();
        one_unknown.per_deposit_cap = None;
        assert_eq!(
            snapshot_read(Some((recent, &one_unknown)), target, false),
            SnapshotRead::WriteIfChanged
        );
        assert_eq!(
            snapshot_read(Some((recent, &vault_state("5", None))), target, false),
            SnapshotRead::WriteIfChanged
        );
        // A row without an exit value (older than migration 0026, or a failed previewRedeem read) is
        // read on the next tick too, so the positions API is not left without a value (core 1795).
        let mut no_exit_value = funded.clone();
        no_exit_value.preview_redeem_total = None;
        assert_eq!(
            snapshot_read(Some((recent, &no_exit_value)), target, false),
            SnapshotRead::WriteIfChanged
        );
        // The heartbeat writes an identical row once the interval elapses, and not a block earlier.
        let heartbeat = SNAPSHOT_HEARTBEAT_BLOCKS as i64;
        assert_eq!(
            snapshot_read(Some((target as i64 - heartbeat, &funded)), target, false),
            SnapshotRead::Write
        );
        assert_eq!(
            snapshot_read(
                Some((target as i64 - heartbeat + 1, &funded)),
                target,
                false
            ),
            SnapshotRead::Skip
        );
        // A row at the target already (an event-driven snapshot in this tick) is never read again.
        assert_eq!(
            snapshot_read(Some((target as i64, &funded)), target, true),
            SnapshotRead::Skip
        );
    }

    // ── issue 1731: refusal backoff, Timelock and Safe event decoding ────────

    #[test]
    fn refusal_backoff_doubles_from_the_tick_interval_and_is_capped() {
        use std::time::Duration;
        assert_eq!(refusal_backoff(1, 12), Duration::from_secs(12));
        assert_eq!(refusal_backoff(2, 12), Duration::from_secs(24));
        assert_eq!(refusal_backoff(3, 12), Duration::from_secs(48));
        assert_eq!(refusal_backoff(6, 12), Duration::from_secs(300));
        assert_eq!(refusal_backoff(u32::MAX, 12), Duration::from_secs(300));
        assert_eq!(refusal_backoff(1, 0), Duration::from_secs(1));
    }

    fn admin_cfg() -> IndexerConfig {
        IndexerConfig {
            chain_id: 8453,
            chain_name: "base".into(),
            rpc_label: "t".into(),
            gateway: Some(Address::from([0x11; 20])),
            vault: Address::from([0x22; 20]),
            registry: None,
            router_governance: None,
            portfolio_router: None,
            consensus_receipt: None,
            timelock: Some(Address::from([0x7a; 20])),
            safe: Some(Address::from([0x5e; 20])),
            max_blocks_per_tick: 1000,
            start_block: None,
            end_block: None,
            feature_flags: 0,
        }
    }

    fn raw_log(address: Address, topics: Vec<alloy_primitives::B256>, data: Vec<u8>) -> LogEntry {
        LogEntry {
            address,
            topics,
            data: Bytes::from(data),
            block_number: 10,
            block_hash: alloy_primitives::B256::ZERO,
            tx_hash: alloy_primitives::B256::ZERO,
            tx_index: 0,
            log_index: 0,
        }
    }

    #[test]
    fn timelock_and_safe_are_watched_and_listed_as_contracts() {
        let cfg = admin_cfg();
        let watched = cfg.watched_addresses();
        assert!(watched.contains(&cfg.timelock.unwrap()));
        assert!(watched.contains(&cfg.safe.unwrap()));
        let kinds = cfg.configured_contracts();
        assert!(kinds.contains(&(cfg.timelock.unwrap(), "timelock")));
        assert!(kinds.contains(&(cfg.safe.unwrap(), "safe")));
        let mut none = admin_cfg();
        none.timelock = None;
        none.safe = None;
        assert_eq!(none.watched_addresses().len(), 2);
        assert!(none
            .configured_contracts()
            .iter()
            .all(|(_, k)| *k != "timelock" && *k != "safe"));
    }

    #[test]
    fn call_scheduled_from_the_timelock_decodes_and_from_anyone_else_is_ignored() {
        use alloy_primitives::{FixedBytes, B256};
        use alloy_sol_types::SolEvent as _;
        let cfg = admin_cfg();
        let topics = Topics::new();
        let ev = ITimelockEvents::CallScheduled {
            id: FixedBytes([0xab; 32]),
            index: U256::from(0),
            target: Address::from([0x99; 20]),
            value: U256::from(0),
            data: Bytes::from(vec![0xde, 0xad]),
            predecessor: B256::ZERO,
            delay: U256::from(172_800u64),
        };
        let ld = ev.encode_log_data();
        let log = raw_log(
            cfg.timelock.unwrap(),
            ld.topics().to_vec(),
            ld.data.to_vec(),
        );
        let got = admin_event_of(&cfg, &topics, &log)
            .unwrap()
            .expect("decoded");
        assert_eq!(got.contract_kind, "timelock");
        assert_eq!(got.event_name, "CallScheduled");
        assert_eq!(got.op_id, Some([0xab; 32]));
        assert_eq!(got.detail["delay"], "172800");
        assert_eq!(got.detail["data"], "0xdead");
        let other = raw_log(
            Address::from([0x01; 20]),
            ld.topics().to_vec(),
            ld.data.to_vec(),
        );
        assert_eq!(admin_event_of(&cfg, &topics, &other).unwrap(), None);
    }

    /// Issue 1810: a proxied core contract's `Upgraded` and `UpgradesFrozen`
    /// become `proxy` rows naming the implementation (and the frozen code
    /// hash). The same topics from the Timelock or the Safe are not recorded.
    #[test]
    fn proxy_upgrade_and_freeze_events_decode_as_proxy_rows() {
        use alloy_primitives::{FixedBytes, B256};
        use alloy_sol_types::SolEvent as _;
        let cfg = admin_cfg();
        let topics = Topics::new();
        let gateway = cfg.gateway.expect("test config has a gateway");
        let implementation = Address::from([0x1c; 20]);

        let up = IGovernedUpgradeEvents::Upgraded { implementation }.encode_log_data();
        let log = raw_log(gateway, up.topics().to_vec(), up.data.to_vec());
        let got = admin_event_of(&cfg, &topics, &log)
            .unwrap()
            .expect("decoded");
        assert_eq!((got.contract_kind, got.event_name), ("proxy", "Upgraded"));
        assert_eq!(got.op_id, None);
        assert_eq!(got.detail["implementation"], format!("{implementation:#x}"));

        let frozen = IGovernedUpgradeEvents::UpgradesFrozen {
            proxy: gateway,
            implementation,
            codeHash: FixedBytes([0x77; 32]),
        }
        .encode_log_data();
        let log = raw_log(gateway, frozen.topics().to_vec(), frozen.data.to_vec());
        let got = admin_event_of(&cfg, &topics, &log)
            .unwrap()
            .expect("decoded");
        assert_eq!(
            (got.contract_kind, got.event_name),
            ("proxy", "UpgradesFrozen")
        );
        assert_eq!(got.detail["implementation"], format!("{implementation:#x}"));
        assert_eq!(
            got.detail["code_hash"],
            format!("{:#x}", B256::from([0x77; 32]))
        );

        for not_a_proxy in [cfg.timelock.unwrap(), cfg.safe.unwrap()] {
            let log = raw_log(not_a_proxy, up.topics().to_vec(), up.data.to_vec());
            assert_eq!(admin_event_of(&cfg, &topics, &log).unwrap(), None);
        }
        assert!(topics.all_topic0().contains(&topics.proxy_upgraded));
        assert!(topics.all_topic0().contains(&topics.proxy_upgrades_frozen));
    }

    #[test]
    fn safe_execution_success_decodes_for_safe_13_and_14_layouts() {
        use alloy_primitives::B256;
        let cfg = admin_cfg();
        let topics = Topics::new();
        let safe = cfg.safe.unwrap();
        let payment = U256::from(7u64).to_be_bytes::<32>().to_vec();
        // Safe 1.4: txHash is indexed (topic 1), data is the payment.
        let v14 = raw_log(
            safe,
            vec![topics.safe_execution_success, B256::from([0xcd; 32])],
            payment.clone(),
        );
        let got = admin_event_of(&cfg, &topics, &v14).unwrap().unwrap();
        assert_eq!(
            (got.contract_kind, got.event_name),
            ("safe", "ExecutionSuccess")
        );
        assert_eq!(got.op_id, Some([0xcd; 32]));
        assert_eq!(got.detail["payment"], "7");
        // Safe 1.3: both arguments in the data.
        let mut data13 = vec![0xcd; 32];
        data13.extend_from_slice(&payment);
        let v13 = raw_log(safe, vec![topics.safe_execution_failure], data13);
        let got = admin_event_of(&cfg, &topics, &v13).unwrap().unwrap();
        assert_eq!(got.event_name, "ExecutionFailure");
        assert_eq!(got.op_id, Some([0xcd; 32]));
        assert_eq!(got.detail["payment"], "7");
    }

    #[test]
    fn safe_owner_and_threshold_events_decode() {
        let cfg = admin_cfg();
        let topics = Topics::new();
        let safe = cfg.safe.unwrap();
        let mut owner_word = vec![0u8; 12];
        owner_word.extend_from_slice(&[0x42; 20]);
        let added = raw_log(safe, vec![topics.safe_added_owner], owner_word);
        let got = admin_event_of(&cfg, &topics, &added).unwrap().unwrap();
        assert_eq!(got.event_name, "AddedOwner");
        assert_eq!(
            got.detail["owner"],
            format!("{:#x}", Address::from([0x42; 20]))
        );
        let thr = raw_log(
            safe,
            vec![topics.safe_changed_threshold],
            U256::from(3u64).to_be_bytes::<32>().to_vec(),
        );
        let got = admin_event_of(&cfg, &topics, &thr).unwrap().unwrap();
        assert_eq!(got.event_name, "ChangedThreshold");
        assert_eq!(got.detail["threshold"], "3");
        // A Safe event topic from the Timelock address is not a Timelock event.
        let wrong = raw_log(
            cfg.timelock.unwrap(),
            vec![topics.safe_changed_threshold],
            U256::from(3u64).to_be_bytes::<32>().to_vec(),
        );
        assert_eq!(admin_event_of(&cfg, &topics, &wrong).unwrap(), None);
    }
}
