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

use crate::abi::{
    IConsensusRecommendationReceiptEvents, IGatewayEvents, IInvestmentCommitteePolicyEvents,
    IPortfolioRouterEvents, IRouterGovernanceEvents, IVaultEvents, IVaultReads,
    IVaultRegistryEvents, Topics,
};
use crate::db::{Db, DbError, ReceiptVerification};
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
    /// Watched vault address (one per chain, legacy single-vault config).
    pub vault: Address,
    /// Optional on-chain VaultRegistry contract address.  When set, the
    /// indexer calls `listVaults()` on each tick and ingests
    /// `VaultRegistered` / `VaultStatusChanged` events from the registry.
    pub registry: Option<Address>,
    /// Optional PortfolioRouter / RouterGovernance contract address.
    /// When set, the indexer ingests `ProposalCreated`, `VoteCast`,
    /// `ProposalExecuted`, and `WeightsApplied` events.
    pub router_governance: Option<Address>,
    /// Optional PortfolioRouter contract address (may differ from
    /// `router_governance`).  When set, the indexer ingests `WeightsSet`
    /// and `DefaultWeightsSet` events emitted by direct admin calls to
    /// `setWeights()` / `setDefaultWeights()` (the demo-seed path), and
    /// watches `RouterDeposit` events to take a fresh TVL snapshot of every
    /// registered vault in any block where a router deposit is processed —
    /// ensuring deposits via the router are reflected in the TVL index without
    /// waiting for the SNAPSHOT_HEARTBEAT_BLOCKS interval.
    pub portfolio_router: Option<Address>,
    /// Optional InvestmentCommitteePolicy contract address.
    /// When set, the indexer ingests `AgentRegistered`, `AgentRevoked`, and
    /// `VoteSubmitted` events and writes to `committee_agents`,
    /// `committee_votes`, and `regime_snapshots` tables (issue #1053).
    pub investment_committee: Option<Address>,
    /// Optional ConsensusRecommendationReceipt contract address.
    /// When set, the indexer ingests `ReceiptRecorded` and `ReceiptReleased`
    /// events, fetches each receipt's `payloadUri` to recompute its keccak256
    /// digest, and writes to the `consensus_receipts` table
    /// (issue #1247, docs/architecture.md §4.9).
    pub consensus_receipt: Option<Address>,
    /// Hard cap on per-tick block range. Protects against an unbounded
    /// `eth_getLogs` request when the indexer is far behind tip.
    pub max_blocks_per_tick: u64,
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
        let mut addrs = vec![self.gateway, self.vault];
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
        if let Some(gov) = self.router_governance {
            addrs.push(gov);
        }
        if let Some(pr) = self.portfolio_router {
            // Only add if not already present (e.g. when portfolio_router == router_governance).
            if !addrs.contains(&pr) {
                addrs.push(pr);
            }
        }
        if let Some(ic) = self.investment_committee {
            if !addrs.contains(&ic) {
                addrs.push(ic);
            }
        }
        if let Some(cr) = self.consensus_receipt {
            if !addrs.contains(&cr) {
                addrs.push(cr);
            }
        }
        addrs
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
        push(self.gateway, "gateway");
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
        if let Some(ic) = self.investment_committee {
            push(ic, "investment_committee");
        }
        if let Some(cr) = self.consensus_receipt {
            push(cr, "consensus_receipt");
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
}

/// How many ticks of runway still count as "converging" for the lag warning
/// below.
///
/// The budget is in TICKS, not blocks, because that is the unit the operator
/// actually waits in: at the default cadence (`DEFAULT_TICK_SECONDS` = 12 s)
/// 300 ticks is one hour of catching up, which is a long but recoverable cold
/// start. Anything beyond it is not a slow start, it is a broken derivation —
/// the live case that produced this constant was a `from_block` of 0 against an
/// `anvil --load-state` head of ~48.9M, i.e. ~49_000 ticks (about seven days)
/// of ticks that could never have succeeded anyway, because that chain holds no
/// history below its fork point. Expressing the threshold in ticks also makes
/// it scale with `max_blocks_per_tick`: raising the per-tick cap raises the gap
/// an operator may legitimately be behind by.
pub const CONVERGENCE_TICK_BUDGET: u64 = 300;

/// One `eth_getCode` probe, classified.
///
/// The point of this enum is that an ERROR is information. Below the earliest
/// block an `anvil --load-state` chain can serve, `eth_getCode` does not answer
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
///  * `BlockOutOfRangeError` — `anvil --load-state` below the fork point,
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
/// one extra round trip on exactly the probes that move `lo` on a fork-state
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
/// valid to the `anvil --load-state` chain that replaced it. That is the same
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
    /// `anvil --load-state` devnet: it retains a rolling window of roughly
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
/// `anvil --load-state` on the same Postgres, and every later tick takes floor
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

    // T12: drain a bounded batch of the unverified-receipt backlog every tick.
    // Deliberately BEFORE `run_inner`, so it runs on a tick whose log scan later
    // fails: repairing a stale `verified = false` must not depend on the chain
    // being reachable, and the payload host and the RPC fail independently.
    let repaired = sweep_unverified_receipts(db, cfg).await;
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
    )
    .await
    {
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
            // Persist the post-rollback cursor, not the pre-reorg one.  Note
            // this run row is `error IS NOT NULL` so it is excluded from the
            // `last_indexed_block()` MAX; the durable cursor reconciliation
            // happens inside `delete_above_block`, which caps any successful
            // run's cursor down to root.  Recording `rollback_cursor` here
            // keeps the failed run's audit row internally consistent with the
            // rollback.
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
    deploy_floor: u64,
    rollback_cursor: &mut Option<i64>,
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
             a fork-state chain the blocks below the fork point do not exist, so \
             every historical read of them fails"
        );
    }

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

    // Static watched set (gateway, pinned vault, registry, router) plus every
    // registry-discovered active vault. Without the latter, ERC-4626
    // `Deposit`/`Withdraw` logs emitted by vaults learned from `VaultRegistered`
    // are never fetched, so their burn volume is invisible to the watchdog
    // (scan finding IDX-6). `get_logs` filters server-side on the address set, so
    // a registered vault that emits a withdrawal in a block where the gateway is
    // idle would otherwise be dropped entirely.
    let mut watched = cfg.watched_addresses();
    let registered_vaults: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT vault_address FROM vaults WHERE chain_id = $1 AND status = 0 ORDER BY vault_address",
    )
    .bind(cfg.chain_id)
    .fetch_all(db.pool())
    .await
    .map_err(DbError::from)?;
    for vault in &registered_vaults {
        if let Ok(bytes) = <[u8; 20]>::try_from(vault.as_slice()) {
            let address = Address::from(bytes);
            if !watched.contains(&address) {
                watched.push(address);
            }
        }
    }
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

    // Reuse the registered-vault set gathered above for the watched-address
    // union; it drives both the event-driven snapshot (router-deposit path) and
    // the heartbeat.
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
        if *contract == cfg.vault {
            rows_inserted += snapshot_vault_or_skip(db, rpc, cfg.chain_id, cfg.vault, *bn).await;
        }
    }
    // Snapshot all registered vaults for every block where the router processed deposits.
    for bn in &router_event_blocks {
        for vault in &heartbeat_vaults {
            rows_inserted += snapshot_vault_or_skip(db, rpc, cfg.chain_id, *vault, *bn).await;
        }
    }

    // Heartbeat snapshots — cover the legacy configured vault and every
    // active vault learned from VaultRegistry events. The PK on
    // (chain_id, contract, block_number) deduplicates against event-driven
    // snapshots.

    for vault in heartbeat_vaults {
        // Fetch both the last snapshot block and whether its total_assets was
        // zero so we can force a re-snapshot for vaults that were registered
        // before deposits arrived (e.g. extra demo vaults seeded via the
        // PortfolioRouter after an indexer that didn't watch it).
        let last_snap: Option<(i64, String)> = sqlx::query_as(
            "SELECT block_number, CAST(total_assets AS text) FROM vault_snapshots \
             WHERE chain_id = $1 AND contract = $2 \
             ORDER BY block_number DESC LIMIT 1",
        )
        .bind(cfg.chain_id)
        .bind(&vault.into_array()[..])
        .fetch_optional(db.pool())
        .await
        .map_err(DbError::from)?;
        let needs_heartbeat = match &last_snap {
            Some((prev, total_assets)) => {
                let behind = (target as i64 - prev) >= SNAPSHOT_HEARTBEAT_BLOCKS as i64;
                // Re-snapshot more aggressively when TVL shows zero — the
                // vault may have received deposits since the last snapshot.
                let zero_tvl = total_assets == "0" || total_assets.is_empty();
                behind || zero_tvl
            }
            None => true,
        };
        if needs_heartbeat {
            rows_inserted += snapshot_vault_or_skip(db, rpc, cfg.chain_id, vault, target).await;
        }
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
/// the descent finite in the case this floor exists for: on a fork-state chain
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
pub async fn handle_log(
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

    // AgentDepositRouted — multi-leg router deposit (IGateway.sol:119).
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

    // AgentWithdrawal — gateway-level withdrawal (IGateway.sol:139).
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

    // Paused / Unpaused — only drive state snapshots; no dedicated table row.
    if topic0 == topics.paused || topic0 == topics.unpaused {
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
                risk_label_from_vault_name(&decoded.name),
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

    // ProposalCreated — insert a new governance proposal row.
    // New signature: (uint256 indexed proposalId, address indexed proposer,
    //                  address[] vaults, uint256[] bps, uint64 votingDeadline).
    // Fields description/createdAt/deadlineBlock removed; use empty-string/
    // block_number/votingDeadline-as-deadline as DB defaults.
    if topic0 == topics.proposal_created {
        let decoded =
            IRouterGovernanceEvents::ProposalCreated::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("ProposalCreated: {e}")))?;
        let r = db
            .insert_proposal(
                cfg.chain_id,
                decoded.proposalId.try_into().unwrap_or(i64::MAX),
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.proposer.into_array(),
                "", // description removed from ProposalCreated (RouterGovernance.sol:106)
                log.block_number as i64, // createdAt removed; use block_number
                decoded.votingDeadline as i64,
            )
            .await?;
        return Ok(r);
    }

    // VoteCast — insert a per-voter vote row and update running tally.
    // New signature: (uint256 indexed proposalId, address indexed voter,
    //                  uint256 power, uint256 totalFor).
    // `support` bool removed (all votes are FOR); `weight` renamed to `power`.
    if topic0 == topics.vote_cast {
        let decoded = IRouterGovernanceEvents::VoteCast::decode_log(&into_alloy_log(log), true)
            .map_err(|e| IndexerError::Decode(format!("VoteCast: {e}")))?;
        let mut r = db
            .insert_vote(
                cfg.chain_id,
                decoded.proposalId.try_into().unwrap_or(i64::MAX),
                decoded.voter.into_array(),
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                true, // support bool removed; governance only records FOR votes
                decoded.power,
            )
            .await?;
        // Store governance_vote in account history for the voter.
        r += db
            .insert_history_event(
                cfg.chain_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                decoded.voter.into_array(),
                "governance_vote",
                None,
                None,
                None,
            )
            .await?;
        return Ok(r);
    }

    // ProposalExecuted — mark proposal status = 2 (executed).
    // New signature: (uint256 indexed proposalId, address indexed executor).
    if topic0 == topics.proposal_executed {
        let decoded =
            IRouterGovernanceEvents::ProposalExecuted::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("ProposalExecuted: {e}")))?;
        let r = db
            .execute_proposal(
                cfg.chain_id,
                decoded.proposalId.try_into().unwrap_or(i64::MAX),
                log.block_number as i64,
            )
            .await?;
        return Ok(r);
    }

    // WeightsApplied — record a router weight snapshot.
    // New signature: (uint256 indexed proposalId, address[] vaults, uint256[] bps).
    if topic0 == topics.weights_applied {
        let decoded =
            IRouterGovernanceEvents::WeightsApplied::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("WeightsApplied: {e}")))?;
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

    // WeightsSet — direct admin call to PortfolioRouter.setWeights().
    // Signature: WeightsSet(address[] vaults, uint256[] bps).
    // This is the path taken by the demo seed script (not governance execution).
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

    // ─── InvestmentCommitteePolicy event handlers ─────────────────────────────
    // Canonical: docs/architecture.md §5.4 — issue #1053.
    //
    // Three events: AgentRegistered, AgentRevoked (IC-specific), VoteSubmitted.
    // Note: IC AgentRevoked has signature `AgentRevoked(address)` — one indexed
    // field — which is distinct from IGateway AgentRevoked `AgentRevoked(address,address)`
    // (two indexed fields).  They have different topic-0 hashes and are dispatched
    // independently.

    if topic0 == topics.ic_agent_registered {
        let decoded = IInvestmentCommitteePolicyEvents::AgentRegistered::decode_log(
            &into_alloy_log(log),
            true,
        )
        .map_err(|e| IndexerError::Decode(format!("IC AgentRegistered: {e}")))?;
        let r = db
            .upsert_committee_agent(
                cfg.chain_id,
                decoded.agent.into_array(),
                &decoded.agentId,
                log.block_number as i64,
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.ic_agent_revoked {
        let decoded =
            IInvestmentCommitteePolicyEvents::AgentRevoked::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("IC AgentRevoked: {e}")))?;
        let r = db
            .revoke_committee_agent(
                cfg.chain_id,
                decoded.agent.into_array(),
                log.block_number as i64,
            )
            .await?;
        return Ok(r);
    }

    if topic0 == topics.ic_vote_submitted {
        let decoded =
            IInvestmentCommitteePolicyEvents::VoteSubmitted::decode_log(&into_alloy_log(log), true)
                .map_err(|e| IndexerError::Decode(format!("IC VoteSubmitted: {e}")))?;
        let vote_id: i64 = decoded.voteId.try_into().unwrap_or(i64::MAX);
        let agent = decoded.agent.into_array();
        let vault = decoded.vault.into_array();
        let vote_json_hash: [u8; 32] = decoded.voteJsonHash.0;

        // Memo fetch + keccak256 verification.
        // If rationaleUri is empty or the fetch fails, store with verified=false.
        // If the memo's keccak256 matches voteJsonHash, store with verified=true.
        let verified = if decoded.rationaleUri.is_empty() {
            false
        } else {
            match fetch_and_verify_memo(&decoded.rationaleUri, vote_json_hash).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(
                        vote_id,
                        rationale_uri = %decoded.rationaleUri,
                        error = %e,
                        "memo fetch/verify failed; storing vote with verified=false"
                    );
                    false
                }
            }
        };

        let mut r = db
            .insert_committee_vote(
                cfg.chain_id,
                vote_id,
                log.block_number as i64,
                log.log_index as i32,
                log.tx_hash.0,
                agent,
                vault,
                decoded.stance as i16,
                decoded.targetWeightBps as i16,
                decoded.confidence as i16,
                &decoded.rationaleUri,
                vote_json_hash,
                decoded.timestamp as i64,
                verified,
            )
            .await?;

        // Refresh the regime snapshot for this vault (verified votes only).
        if verified {
            r += db
                .refresh_regime_snapshot(cfg.chain_id, vault, log.block_number as i64)
                .await?;
        }

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
    // also carries the gateway, the vaults, the registry, the router, governance
    // and the IC policy. `ReceiptRecorded`'s topic0 is just a hash: ANY watched
    // contract that emits an event with that signature lands in the branches
    // below. Only the configured ConsensusRecommendationReceipt deployment may
    // write the receipt register, so check the address before decoding rather
    // than trusting the topic.
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
        } else {
            let outcome = fetch_and_verify_payload(&decoded.payloadUri, payload_digest).await;
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
/// and the next tick tries again.
async fn sweep_unverified_receipts(db: &Db, cfg: &IndexerConfig) -> u64 {
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

        let outcome = fetch_and_verify_payload(&row.payload_uri, digest).await;
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

/// One HTTP attempt at the payload. Transport-level errors only.
async fn fetch_payload_once(payload_uri: &str) -> Result<Vec<u8>, String> {
    // 1 MiB body cap, as `fetch_and_verify_memo`.
    const MAX_BODY: usize = 1024 * 1024;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PAYLOAD_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("build client: {e}"))?;

    let resp = client
        .get(payload_uri)
        .send()
        .await
        .map_err(|e| format!("GET {payload_uri}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GET {payload_uri} returned {}", resp.status()));
    }

    let body = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    if body.len() > MAX_BODY {
        return Err(format!(
            "receipt payload too large: {} bytes (max {MAX_BODY})",
            body.len()
        ));
    }
    Ok(body.to_vec())
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

/// Fetch the JSON memo from `rationale_uri` and verify its keccak256 against
/// `expected_hash`.  Returns `true` if the hash matches, `false` otherwise.
/// Errors on network failure, non-200 HTTP, or response body too large.
async fn fetch_and_verify_memo(
    rationale_uri: &str,
    expected_hash: [u8; 32],
) -> Result<bool, String> {
    // Use a one-off reqwest client — the indexer is single-tick so no pool needed.
    // Limit body to 1 MiB to prevent runaway allocations on malicious URIs.
    const MAX_BODY: usize = 1024 * 1024;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build client: {e}"))?;

    let resp = client
        .get(rationale_uri)
        .send()
        .await
        .map_err(|e| format!("GET {rationale_uri}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GET {rationale_uri} returned {}", resp.status()));
    }

    let body = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    if body.len() > MAX_BODY {
        return Err(format!(
            "memo body too large: {} bytes (max {MAX_BODY})",
            body.len()
        ));
    }

    let actual = alloy_primitives::keccak256(&body);
    Ok(actual.0 == expected_hash)
}

/// IDX-3: persist the owner's resulting `wallet_positions` share balance after
/// an ERC-4626 mint/burn event.  Reads the owner's prior balance for this
/// vault (`contract = log.address`), applies the `shares` delta (`add = true`
/// for a deposit/mint, `false` for a withdraw/burn, saturating at zero), and
/// writes the new block-numbered balance snapshot.  Returns the number of rows
/// inserted (0 when the row already exists, via the writer's `ON CONFLICT`).
async fn persist_wallet_position(
    db: &Db,
    cfg: &IndexerConfig,
    log: &LogEntry,
    owner: [u8; 20],
    shares: U256,
    add: bool,
) -> Result<u64, IndexerError> {
    let contract = log.address.into_array();
    let block = log.block_number as i64;
    let prior = db
        .latest_wallet_position(cfg.chain_id, contract, owner, block)
        .await?
        .unwrap_or(U256::ZERO);
    let new_balance = if add {
        prior.saturating_add(shares)
    } else {
        prior.saturating_sub(shares)
    };
    let r = db
        .insert_wallet_position(cfg.chain_id, contract, owner, block, new_balance)
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

/// Read totalAssets / totalSupply / exitFeeBps / tvlCap / paused from a
/// vault at `block` and write a `vault_snapshots` row.
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
) -> i64 {
    match snapshot_vault_address(db, rpc, chain_id, vault, block).await {
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
    let exit_fee_bps = call_u256(
        rpc,
        vault,
        IVaultReads::exitFeeBpsCall {}.abi_encode(),
        block,
    )
    .await
    .unwrap_or(U256::ZERO);
    let tvl_cap = call_u256(rpc, vault, IVaultReads::tvlCapCall {}.abi_encode(), block)
        .await
        .unwrap_or(U256::ZERO);
    let paused = call_bool(rpc, vault, IVaultReads::pausedCall {}.abi_encode(), block)
        .await
        .unwrap_or(false);

    db.insert_vault_snapshot(
        chain_id,
        vault.into_array(),
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

/// Map vault name to risk label per PRD §11.
/// The VaultRegistered event carries only name and asset; risk_label was
/// removed from VaultMetadata to avoid contract changes. The indexer derives
/// it from the registration name as a stopgap — a contract-level risk_label
/// field is a future improvement.
fn risk_label_from_vault_name(name: &str) -> &'static str {
    match name {
        "RM USDC" => "STABLE_YIELD",
        "RM Protocol" => "VOLATILE",
        "RM Agent Tokens" | "RM RWA / Thematic" => "SPECULATIVE",
        _ => "STABLE_YIELD",
    }
}

/// Unit coverage for the deploy-block derivation (the start-block bug).
///
/// These are in-crate and chain-free on purpose: the search, the probe
/// classification and the cursor reconciliation are the parts that have to be
/// right on THREE different chain shapes, and none of those shapes is
/// reproducible from a single live backend. The end-to-end behaviour against a
/// simulated `anvil --load-state` chain is in
/// `tests/deploy_block_detection.rs`.
#[cfg(test)]
mod tests {
    use super::*;

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
        // Verbatim from the live stage host's `anvil --load-state` chain.
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

    /// `anvil --load-state`: the head is Base mainnet's, and the chain serves
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
        // live `anvil --load-state` devnet retains ~3,600 blocks, so a floor
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

    // ── the set detection runs over ─────────────────────────────────────────

    #[test]
    fn a_router_that_is_also_governance_is_registered_once_under_its_first_kind() {
        let router = Address::from([0x77u8; 20]);
        let cfg = IndexerConfig {
            chain_id: 918_453,
            chain_name: "devnet".into(),
            rpc_label: "stub".into(),
            gateway: Address::from([0x11u8; 20]),
            vault: Address::from([0x22u8; 20]),
            registry: None,
            router_governance: Some(router),
            portfolio_router: Some(router),
            investment_committee: None,
            consensus_receipt: None,
            max_blocks_per_tick: 100,
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
}
