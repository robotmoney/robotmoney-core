//! Canonical: docs/architecture.md §4 — High-Level Flow
//! (See also: Plan tracking issue #109 §4.8 — CLI surface)
//!
//! `rmpc deposit` — sign and broadcast a USDC deposit through the gateway.
//!
//! Per `Plan tracking issue #109` §3.8 and issue #16. The cross-cutting
//! sequence — signer policy, keystore, single-flight lock, replay cache,
//! runtime, RPC, fees, nonce, sign, broadcast, receipt — belongs to
//! [`crate::write_path`] (issue #1285). What is deposit-specific and
//! lives here:
//!
//! 1. Argument parsing, including the router (`--destination`) branch.
//! 2. [`Preflight::run`] with the actual deposit amount. Any refusal
//!    exits non-zero with a named-error JSON body — symmetric with
//!    `self-check` so operators can correlate.
//! 3. The gas limit, from the gateway's entry floor (QA plan U3): a router
//!    deposit needs 400_000 + 2_550_000 per `getEffectiveWeights()` leg, so
//!    the default is read from the router, and a `--gas-limit` below the
//!    floor is refused (`ErrGasLimitBelowFloor`) before anything is signed.
//! 4. The router path's per-leg floors (security round 3). rmpc reads
//!    `router.previewDeposit(amount)`. A leg with weight above 0 that the
//!    router marks unavailable is refused (`ErrLegUnavailable`) unless
//!    `--allow-unavailable-legs` is passed: the router would skip it and
//!    move its whole share onto the other legs. With `--min-shares-per-leg`
//!    omitted, each funded leg's floor is its `estShares` less
//!    [`DEFAULT_FLOOR_TOLERANCE_BPS`], the dapp's `deriveMinSharesPerLeg`.
//!    A non-zero floor makes the router revert `LegSkippedWithFloor` if that
//!    leg turns unavailable before inclusion (someone fills rmUSDC's TVL
//!    cap), so its share never moves onto the basket legs. A single
//!    `--min-shares-per-leg 0` is the explicit opt-out: no floor on any leg.
//! 5. `gateway.deposit(...)` / `gateway.depositTo(...)` calldata.
//! 6. Decoding the `AgentDeposit` event log (`AgentDepositRouted` on the
//!    router path) → a stable JSON document on stdout. The shape mirrors
//!    `rmpc status` so users can correlate a deposit response with a later
//!    lookup.
//!
//! Exit codes:
//! - 0 — receipt mined with `status == 1` and an `AgentDeposit` log.
//! - 2 — preflight refusal, fee-cap refusal, lock contention, or any
//!   refusal that maps to an [`RmpcError`] variant.
//! - 3 — startup failure: config / keystore / RPC client / runtime build.

use std::path::PathBuf;
use std::str::FromStr;

use alloy_primitives::{Address, LogData, B256, U256};
use alloy_sol_types::{SolCall, SolEvent};
use serde::Serialize;

use crate::config::Config;
use crate::errors::{Result as RmpcResult, RmpcError};
use crate::floors::{default_gas_limit_for_floor, floor_from_preview, DEFAULT_FLOOR_TOLERANCE_BPS};
use crate::gateway::{PortfolioRouter, RobotMoneyGateway};
use crate::logging::AuditDecision;
use crate::output::emit;
use crate::policy::{ChecksOutput, Preflight, PreflightInputs};
use crate::rpc::{CallRequest, FailoverRpcClient};
use crate::write_path::{
    chain_deadline, open_session, Submission, WriteRequest, EXIT_OK, EXIT_STARTUP_FAIL,
    MAX_DEADLINE_SKEW_SECS,
};

/// Environment variable for the per-agent state directory.
///
/// Resolved by [`Config::resolve_state_dir`]: env override → TOML
/// `state_dir` field → fail-fast. There is **no silent `/tmp` fallback**
/// (audit finding M1).
pub const STATE_DIR_ENV_VAR: &str = "RMPC_STATE_DIR";

/// Inputs collected by `main.rs` from the CLI parser. Keeps the surface
/// stable as flags evolve.
#[derive(Debug, Clone)]
pub struct Args {
    pub config_path: PathBuf,
    pub amount: String,
    pub order_id: String,
    pub idempotency_key: Option<String>,
    pub deadline_secs: u64,
    pub receipt_timeout_secs: u64,
    /// `None` derives the limit from the gateway entry floor (see
    /// [`DepositGas`]). `Some(_)` below that floor is refused.
    pub gas_limit: Option<u64>,
    /// Optional CLI override for `max_fee_per_gas_cap` in wei (issue #93).
    /// When `Some(_)` it wins over both `[fees].max_fee_per_gas_cap` in
    /// TOML and the per-chain default table.
    pub fee_cap_wei: Option<u64>,
    /// When `Some(_)`, the deposit is routed through `gateway.depositTo()`
    /// targeting this PortfolioRouter address. When `None` the existing
    /// single-vault `gateway.deposit()` path is used.
    pub destination: Option<String>,
    /// Per-leg minimum shares forwarded to `gateway.depositTo()`.
    /// Ignored when `destination` is `None`. See [`parse_min_shares_per_leg`]:
    /// empty derives the floors from `router.previewDeposit`, a single `0`
    /// sends no floor.
    pub min_shares_per_leg: Vec<String>,
    /// Router path only: sign even when `router.previewDeposit` marks a leg
    /// with weight above 0 unavailable. Without it that is refused with
    /// `ErrLegUnavailable`.
    pub allow_unavailable_legs: bool,
    pub pretty: bool,
}

/// Stable JSON shape on a successful deposit. Field names are part of
/// the operator-visible contract — downstream e2e tests (#18/#19) match
/// on them. Numeric values that may exceed `u64` are decimal strings so
/// JavaScript `JSON.parse` does not silently lose precision.
#[derive(Debug, Serialize)]
pub struct DepositOutput {
    pub status: &'static str, // always "success" on the happy path
    pub payment_id: String,
    pub order_id: String,
    pub agent: String,
    pub share_receiver: String,
    pub amount: String,
    /// Vault shares minted on the vault path. `null` on the router path:
    /// each leg mints a different vault's shares, so there is no single
    /// total. Those are in `shares_per_leg`.
    pub shares_minted: Option<String>,
    /// Router path only: the PortfolioRouter the deposit went through.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub router: Option<String>,
    /// Router path only: shares minted per leg, parallel to the router's
    /// effective weight vector (`AgentDepositRouted.sharesPerLeg`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shares_per_leg: Option<Vec<String>>,
    /// Router path only: the per-leg share floors the call carried, parallel
    /// to `shares_per_leg`. `"0"` is no floor for that leg. The on-chain
    /// `paymentId` binds them, so a retry that must dedupe on chain passes
    /// these back as `--min-shares-per-leg`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_shares_per_leg: Option<Vec<String>>,
    pub block_number: u64,
    pub tx_hash: String,
    pub gas_used: String,
    pub effective_gas_price: String,
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(args: Args) -> i32 {
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc deposit: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let amount = match U256::from_str_radix(args.amount.trim_start_matches("0x"), 10) {
        Ok(v) if !args.amount.starts_with("0x") => v,
        _ => match U256::from_str(&args.amount) {
            Ok(v) => v,
            Err(e) => {
                log::error!("rmpc deposit: --amount must be a decimal U256: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
    };

    let order_id = match B256::from_str(&args.order_id) {
        Ok(b) => b,
        Err(e) => {
            log::error!("rmpc deposit: --order-id is not a 32-byte hex string: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let idempotency_key = match args.idempotency_key.as_deref() {
        None => order_id,
        Some(s) => match B256::from_str(s) {
            Ok(b) => b,
            Err(e) => {
                log::error!("rmpc deposit: --idempotency-key is not a 32-byte hex string: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
    };

    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc deposit: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // Router-deposit arguments, parsed before any I/O so a malformed flag
    // never opens a session.
    let destination = match args.destination.as_deref().map(Address::from_str) {
        None => None,
        Some(Ok(a)) => Some(a),
        Some(Err(e)) => {
            log::error!("rmpc deposit: --destination is not a valid address: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    // Per-leg minimum shares (decimal U256 strings). The router path turns
    // this into one floor per leg once it has read the router.
    let min_shares_arg = match parse_min_shares_per_leg(&args.min_shares_per_leg) {
        Ok(a) => a,
        Err(s) => {
            log::error!("rmpc deposit: --min-shares-per-leg value {s:?} is not a decimal U256");
            return EXIT_STARTUP_FAIL;
        }
    };

    let deadline_secs = args.deadline_secs.min(MAX_DEADLINE_SKEW_SECS);

    // -- Shared write-path prologue ---------------------------------------
    // `replay_op: None` keeps deposit on the pre-op-prefix replay-cache key
    // shape, so caches written by older builds still match.
    let mut session = match open_session(
        &cfg,
        WriteRequest {
            command: "deposit",
            gateway: gateway_addr,
            order_id,
            idempotency_key,
            amount,
            deadline: 0,
            replay_op: None,
        },
    ) {
        Ok(s) => s,
        Err(abort) => return abort.exit(args.pretty),
    };
    let agent_address = session.agent_address;

    // -- Deadline from block timestamp ------------------------------------
    let deadline = match session
        .rt
        .block_on(chain_deadline(&session.rpc, deadline_secs))
    {
        Ok(d) => {
            session.audit.deadline = d;
            d
        }
        Err(e) => {
            log::error!("rmpc deposit: failed to fetch block timestamp for deadline: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // -- Preflight --------------------------------------------------------
    let preflight_result = session.rt.block_on(async {
        Preflight::new(&session.rpc, &cfg)
            .run(PreflightInputs {
                signer_address: agent_address,
                amount,
            })
            .await
    });
    let report = match preflight_result {
        Ok(r) => r,
        Err(err) => {
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!("{err}"))
                .checks(ChecksOutput::from_err_partial(&err))
                .emit(args.pretty);
        }
    };

    // -- Gas limit from the gateway entry floor (QA plan U3) -------------
    // The gateway checks `gasleft()` at entry: 2_000_000 for the vault
    // path, 400_000 + 2_550_000 per effective-weight leg for the router.
    // A fixed default (the old 3_000_000) reverts `InsufficientGas` on any
    // router with two or more legs and burns the gas and the nonce.
    let gas = match session
        .rt
        .block_on(read_deposit_gas(&session.rpc, gateway_addr, destination))
    {
        Ok(g) => g,
        Err(err) => {
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!(
                    "reading the router leg count for the gas floor: {err}"
                ))
                .checks(ChecksOutput::from_report(&report))
                .emit(args.pretty);
        }
    };
    let gas_limit = match gas.resolve(args.gas_limit) {
        Ok(g) => g,
        Err(err) => {
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!("{err}"))
                .checks(ChecksOutput::from_report(&report))
                .emit(args.pretty);
        }
    };
    log::info!(
        "deposit: gas_limit={gas_limit} floor={} router_legs={:?}",
        gas.floor,
        gas.router_legs
    );

    // -- The router and every leg vault it deposits into (issue 1808) -----
    // Check 5c covered the gateway's own vault. A router deposit also reaches
    // the router and each vault of its effective weight vector; each must be
    // a direct contract or a proxy whose implementation is pinned in
    // `proxy_implementation_hashes`.
    if let (Some(router), Some(_)) = (destination, gas.router_legs) {
        if let Err(err) =
            session
                .rt
                .block_on(crate::policy::implementation::verify_router_and_legs(
                    &session.rpc,
                    &cfg,
                    router,
                    &format!("0x{:x}", report.block_number),
                ))
        {
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!("{err}"))
                .checks(ChecksOutput::from_report(&report))
                .emit(args.pretty);
        }
    }

    // -- Router per-leg floors (security round 3) --------------------------
    // Read `router.previewDeposit(amount)`. Refuse a weighted leg the router
    // would skip unless the agent opted in, then derive the floors the
    // round-2 `LegSkippedWithFloor` guard needs: without a non-zero floor on
    // rmUSDC, anyone who fills its TVL cap sends the whole deposit into the
    // basket legs. A vault destination keeps the vector as given.
    let min_shares = if let (Some(router), Some(legs)) = (destination, gas.router_legs) {
        let read = session
            .rt
            .block_on(read_router_preview(&session.rpc, router, amount));
        let preview = match read {
            Ok(p) => p,
            Err(err) => {
                session.record(AuditDecision::Refused, Some(err.name().to_string()));
                return session
                    .refusal(err.name())
                    .message(format!(
                        "reading router.previewDeposit({amount}) for the per-leg floors: {err}"
                    ))
                    .checks(ChecksOutput::from_report(&report))
                    .emit(args.pretty);
            }
        };
        let allow = args.allow_unavailable_legs;
        match router_leg_floors(&preview, legs, &min_shares_arg, allow) {
            Ok(floors) => {
                if min_shares_arg == MinSharesArg::FromPreview {
                    log::info!(
                        "deposit: per-leg floors are previewDeposit estShares less \
                         {DEFAULT_FLOOR_TOLERANCE_BPS} bps"
                    );
                }
                floors
            }
            Err(LegFloorError::Length { got, legs }) => {
                log::error!(
                    "rmpc deposit: --min-shares-per-leg has {got} values; the router has \
                     {legs} legs. Pass one floor per leg, a single 0, or omit the flag"
                );
                return EXIT_STARTUP_FAIL;
            }
            Err(e) => {
                let err = RmpcError::ErrLegUnavailable;
                session.record(AuditDecision::Refused, Some(err.name().to_string()));
                return session
                    .refusal(err.name())
                    .message(format!("{err}: {e}"))
                    .checks(ChecksOutput::from_report(&report))
                    .emit(args.pretty);
            }
        }
    } else {
        min_shares_arg.as_given()
    };

    // The router path prints the floors it signed.
    let signed_floors: Option<Vec<String>> = gas
        .router_legs
        .map(|_| min_shares.iter().map(|s| s.to_string()).collect());

    // -- Calldata: router-deposit (depositTo) vs. single-vault deposit ----
    let calldata = if let Some(destination) = destination {
        log::info!(
            "deposit: depositTo: destination={destination:#x} min_shares_per_leg={:?}",
            min_shares.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
        RobotMoneyGateway::depositToCall {
            orderId: order_id,
            amount,
            deadline,
            idempotencyKey: idempotency_key,
            destination,
            minSharesPerLeg: min_shares,
        }
        .abi_encode()
    } else {
        RobotMoneyGateway::depositCall {
            orderId: order_id,
            amount,
            deadline,
            idempotencyKey: idempotency_key,
        }
        .abi_encode()
    };

    // -- Fees, nonce, sign, broadcast, receipt ----------------------------
    let confirmed = match session.submit(
        &cfg,
        Submission {
            calldata,
            gas_limit,
            fee_cap_wei: args.fee_cap_wei,
            receipt_timeout_secs: args.receipt_timeout_secs,
            replay_deadline: deadline,
            checks: &|| ChecksOutput::from_report(&report),
            gateway_implementation: report.gateway_implementation,
        },
    ) {
        Ok(c) => c,
        Err(abort) => return abort.exit(args.pretty),
    };

    // -- Decode AgentDeposit / AgentDepositRouted log ---------------------
    // The gateway emits `AgentDepositRouted` (not `AgentDeposit`) when the
    // destination is its router, so the router path decodes that event.
    let topic0 = if gas.router_legs.is_some() {
        RobotMoneyGateway::AgentDepositRouted::SIGNATURE_HASH
    } else {
        RobotMoneyGateway::AgentDeposit::SIGNATURE_HASH
    };
    let log = confirmed
        .receipt
        .inner
        .logs()
        .iter()
        .find(|l| l.address() == gateway_addr && l.topics().first() == Some(&topic0));
    let log = match log {
        Some(l) => l,
        None => {
            let err = RmpcError::ErrAgentDepositLogMissing {
                tx_hash: confirmed.tx_hash_hex.clone(),
            };
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!("{err}"))
                .tx_hash(confirmed.tx_hash_hex.clone())
                .emit(args.pretty);
        }
    };
    let log_data = LogData::new_unchecked(log.topics().to_vec(), log.data().data.clone());
    let block_number = confirmed.receipt.block_number.unwrap_or(0);
    let gas_used = confirmed.receipt.gas_used.to_string();
    let effective_gas_price = confirmed.receipt.effective_gas_price.to_string();
    let out = if gas.router_legs.is_some() {
        let decoded = match RobotMoneyGateway::AgentDepositRouted::decode_log_data(&log_data, true)
        {
            Ok(d) => d,
            Err(e) => {
                log::error!("rmpc deposit: failed to decode AgentDepositRouted log: {e}");
                return EXIT_STARTUP_FAIL;
            }
        };
        DepositOutput {
            status: "success",
            payment_id: format!("{:#x}", decoded.paymentId),
            order_id: format!("{:#x}", decoded.orderId),
            agent: format!("{:#x}", decoded.agent),
            share_receiver: format!("{:#x}", decoded.shareReceiver),
            amount: decoded.amount.to_string(),
            shares_minted: None,
            router: Some(format!("{:#x}", decoded.router)),
            shares_per_leg: Some(decoded.sharesPerLeg.iter().map(|s| s.to_string()).collect()),
            min_shares_per_leg: signed_floors,
            block_number,
            tx_hash: confirmed.tx_hash_hex,
            gas_used,
            effective_gas_price,
        }
    } else {
        let decoded = match RobotMoneyGateway::AgentDeposit::decode_log_data(&log_data, true) {
            Ok(d) => d,
            Err(e) => {
                log::error!("rmpc deposit: failed to decode AgentDeposit log: {e}");
                return EXIT_STARTUP_FAIL;
            }
        };
        DepositOutput {
            status: "success",
            payment_id: format!("{:#x}", decoded.paymentId),
            order_id: format!("{:#x}", decoded.orderId),
            agent: format!("{:#x}", decoded.agent),
            share_receiver: format!("{:#x}", decoded.shareReceiver),
            amount: decoded.amount.to_string(),
            shares_minted: Some(decoded.sharesMinted.to_string()),
            router: None,
            shares_per_leg: None,
            min_shares_per_leg: None,
            block_number,
            tx_hash: confirmed.tx_hash_hex,
            gas_used,
            effective_gas_price,
        }
    };
    session.audit.payment_id = Some(out.payment_id.clone());
    session.record(AuditDecision::Signed, None);
    emit(&out, args.pretty);
    EXIT_OK
}

/// Gateway entry floor for `deposit` and a vault-destination `depositTo`
/// (`DEPOSIT_GAS_FLOOR` in `RobotMoneyGateway.sol`).
pub const DEPOSIT_GAS_FLOOR: u64 = 2_000_000;
/// Default vault-path limit. A real-adapter vault deposit costs ~1.55M
/// (issue #912), so this clears the floor with room for the adapters.
pub const VAULT_DEPOSIT_DEFAULT_GAS_LIMIT: u64 = 3_000_000;
/// Router-destination `depositTo` floor, fixed part
/// (`ROUTER_DEPOSIT_BASE_GAS`).
pub const ROUTER_DEPOSIT_BASE_GAS: u64 = 400_000;
/// Router-destination `depositTo` floor per effective-weight leg
/// (`ROUTER_DEPOSIT_GAS_PER_LEG`). Zero-weight legs count: the gateway
/// multiplies by `getEffectiveWeights().length`.
pub const ROUTER_DEPOSIT_GAS_PER_LEG: u64 = 2_550_000;

/// Gateway entry floor for a router-destination `depositTo` over `legs`
/// effective-weight legs.
pub fn router_deposit_gas_floor(legs: usize) -> u64 {
    ROUTER_DEPOSIT_BASE_GAS.saturating_add(ROUTER_DEPOSIT_GAS_PER_LEG.saturating_mul(legs as u64))
}

/// What the gateway requires of one deposit's gas, and the limit rmpc sends
/// when `--gas-limit` is omitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DepositGas {
    /// `Some(n)` when the destination is the gateway's router, with `n`
    /// effective-weight legs. `None` for the vault path.
    pub router_legs: Option<usize>,
    /// The gateway's entry floor. `gasleft()` below it reverts
    /// `InsufficientGas`.
    pub floor: u64,
    /// The limit sent when `--gas-limit` is omitted.
    pub default_limit: u64,
}

impl DepositGas {
    /// `gateway.deposit` or a vault-destination `depositTo`.
    pub fn vault() -> Self {
        Self {
            router_legs: None,
            floor: DEPOSIT_GAS_FLOOR,
            default_limit: VAULT_DEPOSIT_DEFAULT_GAS_LIMIT,
        }
    }

    /// A router-destination `depositTo` over `legs` effective-weight legs.
    pub fn router(legs: usize) -> Self {
        let floor = router_deposit_gas_floor(legs);
        Self {
            router_legs: Some(legs),
            floor,
            default_limit: default_gas_limit_for_floor(floor),
        }
    }

    /// The limit to sign with: the derived default when `explicit` is
    /// `None`, else `explicit` unless it is below the floor.
    pub fn resolve(&self, explicit: Option<u64>) -> RmpcResult<u64> {
        match explicit {
            None => Ok(self.default_limit),
            Some(gas_limit) if gas_limit < self.floor => Err(RmpcError::ErrGasLimitBelowFloor {
                gas_limit,
                floor: self.floor,
            }),
            Some(gas_limit) => Ok(gas_limit),
        }
    }
}

/// Read what this deposit's gas must clear. Mirrors the gateway's own
/// branch (`_validateDestination` then `_requireDepositGas`): only a
/// destination equal to `gateway.router()` takes the per-leg floor, and its
/// leg count is `router.getEffectiveWeights().length`. Any other
/// destination is the vault path; the gateway rejects an unknown one with
/// `InvalidDestination` on its own.
pub async fn read_deposit_gas(
    rpc: &FailoverRpcClient,
    gateway: Address,
    destination: Option<Address>,
) -> RmpcResult<DepositGas> {
    let Some(destination) = destination else {
        return Ok(DepositGas::vault());
    };
    let out = rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: RobotMoneyGateway::routerCall {}.abi_encode().into(),
            },
            None,
        )
        .await?;
    let router = RobotMoneyGateway::routerCall::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("router() decode: {e}")))?
        ._0;
    if router == Address::ZERO || destination != router {
        return Ok(DepositGas::vault());
    }
    let out = rpc
        .eth_call(
            &CallRequest {
                to: router,
                from: None,
                data: PortfolioRouter::getEffectiveWeightsCall {}
                    .abi_encode()
                    .into(),
            },
            None,
        )
        .await?;
    let weights = PortfolioRouter::getEffectiveWeightsCall::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("getEffectiveWeights() decode: {e}")))?;
    Ok(DepositGas::router(weights.vaults.len()))
}

/// `--min-shares-per-leg` as given on the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MinSharesArg {
    /// Omitted. On the router path each funded leg's floor is its
    /// `previewDeposit` `estShares` less [`DEFAULT_FLOOR_TOLERANCE_BPS`].
    FromPreview,
    /// A single `0`: no floor on any leg, the explicit opt-out.
    NoFloor,
    /// One floor per leg, `0` allowed per leg.
    Explicit(Vec<U256>),
}

impl MinSharesArg {
    /// The vector exactly as given: empty, `[0]`, or the explicit values. A
    /// vault-destination `depositTo` ignores it, and this is what rmpc sent
    /// before security round 3, so that call's `paymentId` is unchanged.
    pub fn as_given(&self) -> Vec<U256> {
        match self {
            MinSharesArg::FromPreview => Vec::new(),
            MinSharesArg::NoFloor => vec![U256::ZERO],
            MinSharesArg::Explicit(v) => v.clone(),
        }
    }
}

/// Parse `--min-shares-per-leg`, the way `withdraw-router` parses
/// `--min-assets-per-leg`: omitted is [`MinSharesArg::FromPreview`], a
/// single `0` is [`MinSharesArg::NoFloor`], anything else must be decimal
/// U256 values (one per leg, checked once the router is read). The error is
/// the offending text.
pub fn parse_min_shares_per_leg(raw: &[String]) -> Result<MinSharesArg, String> {
    match raw {
        [] => Ok(MinSharesArg::FromPreview),
        [only] if only.trim() == "0" => Ok(MinSharesArg::NoFloor),
        _ => raw
            .iter()
            .map(|s| U256::from_str(s.trim()).map_err(|_| s.clone()))
            .collect::<Result<Vec<_>, _>>()
            .map(MinSharesArg::Explicit),
    }
}

/// One leg of `router.previewDeposit(amount)`, in effective-weight order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterLegPreview {
    pub vault: Address,
    pub weight_bps: U256,
    /// Shares the leg's vault quotes for its renormalised amount. 0 for an
    /// unavailable leg and for a leg whose amount rounds to 0.
    pub est_shares: U256,
    /// The router skips this leg: not Active, not router-eligible, its own
    /// `maxDeposit` is 0 (paused, full TVL cap, open exclusion), or its
    /// `previewDeposit` reverts (a basket outside its ORA-4 band).
    pub unavailable: bool,
}

/// Why the router path cannot turn the preview into per-leg floors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegFloorError {
    /// Legs with weight above 0 that the router marks unavailable, as
    /// `(vault, weight_bps)`, and `--allow-unavailable-legs` was not passed.
    Unavailable(Vec<(Address, U256)>),
    /// `previewDeposit` returned a different leg count than the
    /// `getEffectiveWeights()` read the gas floor came from: the weight
    /// vector changed between the two reads.
    LegCountChanged { preview: usize, weights: usize },
    /// `--min-shares-per-leg` is neither one value per leg nor a single `0`.
    Length { got: usize, legs: usize },
}

impl std::fmt::Display for LegFloorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LegFloorError::Unavailable(legs) => {
                let named: Vec<String> = legs
                    .iter()
                    .map(|(vault, bps)| format!("{vault:#x} ({bps} bps)"))
                    .collect();
                write!(
                    f,
                    "router.previewDeposit marks {} unavailable. The router would skip it and \
                     deposit its share into the other legs, so the split would not be the \
                     governed weights. Nothing was signed. Pass --allow-unavailable-legs only \
                     if the user accepts that split",
                    named.join(", ")
                )
            }
            LegFloorError::LegCountChanged { preview, weights } => write!(
                f,
                "the router's weight vector changed while rmpc read it ({weights} legs, then \
                 {preview}). Nothing was signed. Run the deposit again"
            ),
            LegFloorError::Length { got, legs } => write!(
                f,
                "--min-shares-per-leg has {got} values and the router has {legs} legs"
            ),
        }
    }
}

/// The `minSharesPerLeg` vector a router deposit signs (security round 3).
///
/// `preview` is `router.previewDeposit(amount)` and `legs` the
/// `getEffectiveWeights()` count the gas floor used. A leg with weight above
/// 0 that the router marks unavailable is refused unless `allow_unavailable`:
/// the router would skip it and renormalise its whole share onto the other
/// legs. The floors are then:
///
/// - [`MinSharesArg::FromPreview`]: each available leg's `estShares` less
///   [`DEFAULT_FLOOR_TOLERANCE_BPS`] (the dapp's `deriveMinSharesPerLeg`), and
///   0 for a skipped or unfunded leg. A funded leg's floor is therefore
///   non-zero, so if it turns unavailable before inclusion the router reverts
///   `LegSkippedWithFloor` instead of moving its share onto the other legs;
/// - [`MinSharesArg::NoFloor`]: 0 on every leg;
/// - [`MinSharesArg::Explicit`]: the values as given, one per leg.
pub fn router_leg_floors(
    preview: &[RouterLegPreview],
    legs: usize,
    arg: &MinSharesArg,
    allow_unavailable: bool,
) -> Result<Vec<U256>, LegFloorError> {
    if preview.len() != legs {
        return Err(LegFloorError::LegCountChanged {
            preview: preview.len(),
            weights: legs,
        });
    }
    if let MinSharesArg::Explicit(v) = arg {
        if v.len() != legs {
            return Err(LegFloorError::Length { got: v.len(), legs });
        }
    }
    let skipped: Vec<(Address, U256)> = preview
        .iter()
        .filter(|l| l.unavailable && !l.weight_bps.is_zero())
        .map(|l| (l.vault, l.weight_bps))
        .collect();
    if !skipped.is_empty() && !allow_unavailable {
        return Err(LegFloorError::Unavailable(skipped));
    }
    Ok(match arg {
        MinSharesArg::FromPreview => preview
            .iter()
            .map(|l| {
                if l.unavailable {
                    U256::ZERO
                } else {
                    floor_from_preview(l.est_shares)
                }
            })
            .collect(),
        MinSharesArg::NoFloor => vec![U256::ZERO; legs],
        MinSharesArg::Explicit(v) => v.clone(),
    })
}

/// `router.previewDeposit(amount)`: per leg, whether the router would skip
/// it and the shares it quotes for its renormalised amount.
pub async fn read_router_preview(
    rpc: &FailoverRpcClient,
    router: Address,
    amount: U256,
) -> RmpcResult<Vec<RouterLegPreview>> {
    let out = rpc
        .eth_call(
            &CallRequest {
                to: router,
                from: None,
                data: PortfolioRouter::previewDepositCall { amount }
                    .abi_encode()
                    .into(),
            },
            None,
        )
        .await?;
    let legs = PortfolioRouter::previewDepositCall::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("previewDeposit() decode: {e}")))?
        .legs;
    Ok(legs
        .into_iter()
        .map(|l| RouterLegPreview {
            vault: l.vault,
            weight_bps: l.weightBps,
            est_shares: l.estShares,
            unavailable: l.unavailable,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;
    use serde_json::json;

    #[test]
    fn router_floor_matches_the_gateway_constants() {
        // RobotMoneyGateway.sol: ROUTER_DEPOSIT_BASE_GAS + legs * ROUTER_DEPOSIT_GAS_PER_LEG.
        assert_eq!(router_deposit_gas_floor(1), 2_950_000);
        assert_eq!(router_deposit_gas_floor(4), 10_600_000);
        assert_eq!(router_deposit_gas_floor(5), 13_150_000);
    }

    #[test]
    fn router_default_clears_the_floor_for_every_leg_count() {
        for legs in 1..=8usize {
            let g = DepositGas::router(legs);
            assert_eq!(g.router_legs, Some(legs));
            assert!(
                g.default_limit > g.floor,
                "{legs} legs: default must sit above the floor"
            );
            assert_eq!(g.resolve(None).unwrap(), g.default_limit);
        }
        // The old fixed 3_000_000 default is below the floor from two legs up.
        assert!(router_deposit_gas_floor(2) > 3_000_000);
    }

    #[test]
    fn vault_default_is_unchanged_and_above_its_floor() {
        let g = DepositGas::vault();
        assert_eq!(g.router_legs, None);
        assert_eq!(g.floor, 2_000_000);
        assert_eq!(g.resolve(None).unwrap(), 3_000_000);
    }

    #[test]
    fn explicit_gas_limit_below_the_floor_is_refused() {
        let g = DepositGas::router(4);
        let err = g.resolve(Some(3_000_000)).unwrap_err();
        assert_eq!(err.name(), "ErrGasLimitBelowFloor");
        assert!(format!("{err}").contains("10600000"), "{err}");
        assert_eq!(g.resolve(Some(10_600_000)).unwrap(), 10_600_000);
        assert_eq!(g.resolve(Some(12_000_000)).unwrap(), 12_000_000);
        let v = DepositGas::vault();
        assert_eq!(
            v.resolve(Some(1_999_999)).unwrap_err().name(),
            "ErrGasLimitBelowFloor"
        );
        assert_eq!(v.resolve(Some(2_000_000)).unwrap(), 2_000_000);
    }

    fn leg(last: u8, bps: u64, est: u64, unavailable: bool) -> RouterLegPreview {
        RouterLegPreview {
            vault: Address::with_last_byte(last),
            weight_bps: U256::from(bps),
            est_shares: U256::from(est),
            unavailable,
        }
    }

    #[test]
    fn min_shares_flag_parses_omitted_zero_and_explicit() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_min_shares_per_leg(&[]).unwrap(),
            MinSharesArg::FromPreview
        );
        assert_eq!(
            parse_min_shares_per_leg(&s(&["0"])).unwrap(),
            MinSharesArg::NoFloor
        );
        assert_eq!(
            parse_min_shares_per_leg(&s(&["10", "0"])).unwrap(),
            MinSharesArg::Explicit(vec![U256::from(10u64), U256::ZERO])
        );
        assert_eq!(parse_min_shares_per_leg(&s(&["1", "x"])).unwrap_err(), "x");
        // A vault destination keeps the vector exactly as given.
        assert!(MinSharesArg::FromPreview.as_given().is_empty());
        assert_eq!(MinSharesArg::NoFloor.as_given(), vec![U256::ZERO]);
    }

    /// Security round 3: with the flag omitted, each funded leg's floor is
    /// its `estShares` less 0.50%, the dapp's `deriveMinSharesPerLeg`. A
    /// 0 bps leg the router skips gets 0 and is not refused.
    #[test]
    fn derived_floors_are_est_shares_less_the_tolerance() {
        assert_eq!(DEFAULT_FLOOR_TOLERANCE_BPS, 50);
        let preview = [
            leg(0x10, 9_500, 950_000_000, false),
            leg(0x11, 500, 49_000_000_000_000, false),
            leg(0x12, 0, 0, true),
        ];
        let floors = router_leg_floors(&preview, 3, &MinSharesArg::FromPreview, false).unwrap();
        assert_eq!(
            floors,
            vec![
                // 950_000_000 * 9_950 / 10_000
                U256::from(945_250_000u64),
                // 49e12 * 9_950 / 10_000
                U256::from(48_755_000_000_000u64),
                U256::ZERO,
            ]
        );
        assert!(floors[0] > U256::ZERO && floors[1] > U256::ZERO);
    }

    /// Security round 3 (the finding's scenario): rmUSDC (9_500 bps) is at
    /// its TVL cap, so the router marks it unavailable and would send the
    /// whole deposit into the basket legs. Refused unless the agent opts in,
    /// whatever floors were given.
    #[test]
    fn weighted_unavailable_leg_is_refused_without_the_opt_in() {
        let preview = [leg(0x10, 9_500, 0, true), leg(0x11, 500, 1_000_000, false)];
        for arg in [
            MinSharesArg::FromPreview,
            MinSharesArg::NoFloor,
            MinSharesArg::Explicit(vec![U256::ZERO, U256::from(1u64)]),
        ] {
            match router_leg_floors(&preview, 2, &arg, false) {
                Err(LegFloorError::Unavailable(legs)) => {
                    assert_eq!(
                        legs,
                        vec![(Address::with_last_byte(0x10), U256::from(9_500u64))]
                    );
                }
                other => panic!("{arg:?}: expected Unavailable, got {other:?}"),
            }
        }
        let msg = router_leg_floors(&preview, 2, &MinSharesArg::FromPreview, false)
            .unwrap_err()
            .to_string();
        assert!(msg.contains("--allow-unavailable-legs"), "{msg}");
        assert!(msg.contains("9500 bps"), "{msg}");

        // Opted in: the skipped leg's floor is 0, the funded leg keeps one.
        let floors = router_leg_floors(&preview, 2, &MinSharesArg::FromPreview, true).unwrap();
        assert_eq!(floors, vec![U256::ZERO, U256::from(995_000u64)]);
    }

    #[test]
    fn explicit_floors_need_one_value_per_leg_and_the_leg_counts_must_agree() {
        let preview = [leg(0x10, 5_000, 10, false), leg(0x11, 5_000, 10, false)];
        assert_eq!(
            router_leg_floors(
                &preview,
                2,
                &MinSharesArg::Explicit(vec![U256::from(7u64), U256::from(8u64)]),
                false
            )
            .unwrap(),
            vec![U256::from(7u64), U256::from(8u64)]
        );
        assert_eq!(
            router_leg_floors(
                &preview,
                2,
                &MinSharesArg::Explicit(vec![U256::from(7u64)]),
                false
            ),
            Err(LegFloorError::Length { got: 1, legs: 2 })
        );
        assert_eq!(
            router_leg_floors(&preview, 2, &MinSharesArg::NoFloor, false).unwrap(),
            vec![U256::ZERO; 2]
        );
        assert_eq!(
            router_leg_floors(&preview, 3, &MinSharesArg::FromPreview, false),
            Err(LegFloorError::LegCountChanged {
                preview: 2,
                weights: 3
            })
        );
    }

    #[tokio::test]
    async fn deadline_is_capped_at_max_skew() {
        // Sanity: the deadline uses the block timestamp, not the wall
        // clock. Mock a block with a known timestamp and verify the
        // deadline is that timestamp plus the capped deadline_secs.
        let mut server = mockito::Server::new_async().await;

        // Mock eth_blockNumber → 0x100 (256)
        let _block_mock = server
            .mock("POST", "/")
            .match_body(Matcher::AllOf(vec![Matcher::PartialJson(
                json!({"method": "eth_blockNumber"}),
            )]))
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x100"}"#)
            .expect(1)
            .create_async()
            .await;

        // Mock eth_getBlockByNumber for 0x100 → timestamp 0x64a9f4c0
        let _ts_mock = server
            .mock("POST", "/")
            .match_body(Matcher::AllOf(vec![Matcher::PartialJson(
                json!({"method": "eth_getBlockByNumber"}),
            )]))
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":{"timestamp":"0x64a9f4c0"}}"#)
            .expect(1)
            .create_async()
            .await;

        let rpc = crate::rpc::FailoverRpcClient::new(vec![server.url()]).unwrap();
        let deadline_secs = 300u64;
        let deadline = chain_deadline(&rpc, deadline_secs.min(MAX_DEADLINE_SKEW_SECS))
            .await
            .unwrap();
        // 0x64a9f4c0 = 1_688_859_840 → + 300 deadline_secs → 1_688_860_140
        assert_eq!(deadline, 1_688_860_140);
    }
}
