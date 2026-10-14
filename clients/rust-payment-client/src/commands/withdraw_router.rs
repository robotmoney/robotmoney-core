//! Canonical: docs/architecture.md §5 — On-Chain Gateway
//!
//! `rmpc withdraw-router` — sign and broadcast a gateway multi-vault proportional
//! redemption through the Portfolio Router (agent-initiated).
//!
//! The cross-cutting sequence — signer policy, keystore, single-flight
//! lock, replay cache, runtime, RPC, fees, nonce, sign, broadcast,
//! receipt — belongs to [`crate::write_path`] (issue #1285). What is
//! router-specific and lives here:
//!
//! 1. Argument parsing: `vaults[i]` is identity-bound to
//!    `sharesPerLeg[i]` (issue #967), and `minAssetsPerLeg` is the
//!    per-leg slippage floor (GW-5 / F-11). The floor is required: an
//!    omitted `--min-assets-per-leg` is refused with
//!    `ErrMinAssetsPerLegRequired`, and `--min-assets-per-leg 0` is the
//!    explicit way to send no floor (QA plan U6, finding DR-6).
//! 2. [`Preflight::run_withdraw_gateway`] against the summed shares, then
//!    [`Preflight::run_withdraw_vault`] per identity-bound leg (RPC-7),
//!    against the policy's `shareReceiver`: the gateway pulls each leg's
//!    shares from it, not from the agent.
//! 3. The explicit `--confirm` gate: without it the command prints a
//!    preview refusal and exits 2 without signing. The preview names every
//!    vault, its shares and floor, the share holder, the `assetRecipient`
//!    and the gas limit against the gateway's floor ([`WithdrawRouterPreview`]).
//! 4. `gateway.withdrawFromRouter(...)` calldata.
//! 5. Decoding the `AgentWithdrawalRouted` event log → stable JSON.
//!
//! Exit codes mirror `rmpc withdraw`:
//! - 0 — success.
//! - 2 — preflight refusal, missing --confirm, or on-chain failure.
//! - 3 — startup failure.

use std::path::PathBuf;
use std::str::FromStr;

use alloy_primitives::{Address, LogData, B256, U256};
use alloy_sol_types::{SolCall, SolEvent};
use serde::Serialize;

use crate::config::Config;
use crate::errors::RmpcError;
use crate::gateway::RobotMoneyGateway;
use crate::logging::AuditDecision;
use crate::output::emit;
use crate::policy::{ChecksOutput, Preflight, PreflightInputs};
use crate::replay_cache::OP_WITHDRAW;
use crate::write_path::{
    chain_deadline, open_session, Submission, WriteFailure, WriteRequest, EXIT_OK, EXIT_REFUSAL,
    EXIT_STARTUP_FAIL, MAX_DEADLINE_SKEW_SECS,
};

/// Inputs collected by `main.rs` from the CLI parser.
#[derive(Debug, Clone)]
pub struct Args {
    pub config_path: PathBuf,
    /// Comma-separated vault shares per router leg (decimal strings).
    /// Must match the `vaults` length (one share amount per vault).
    pub shares_per_leg: Vec<String>,
    /// Vault addresses to redeem from (0x-prefixed hex), one per leg,
    /// parallel to `shares_per_leg`. Identity-bound: `shares_per_leg[i]` is
    /// redeemed from `vaults[i]` (issue #967). Drives the redeem legs
    /// directly instead of the router's live weight vector.
    pub vaults: Vec<String>,
    /// Per-leg minimum USDC out (slippage floor), decimal strings, parallel to
    /// `shares_per_leg` (GW-5 / F-11). Required (QA plan U6): empty is
    /// refused with `ErrMinAssetsPerLegRequired`. A single `0` sends an
    /// all-zero floor; otherwise the length must equal `shares_per_leg`.
    /// See [`parse_min_assets_per_leg`].
    pub min_assets_per_leg: Vec<String>,
    /// 32-byte order id, 0x-prefixed hex.
    pub order_id: String,
    /// 32-byte idempotency key. Defaults to order_id when omitted.
    pub idempotency_key: Option<String>,
    pub deadline_secs: u64,
    pub receipt_timeout_secs: u64,
    /// `None` derives the limit from the gateway entry floor and the leg count.
    pub gas_limit: Option<u64>,
    /// Optional CLI override for `max_fee_per_gas_cap` in wei.
    pub fee_cap_wei: Option<u64>,
    /// Must be true to proceed past the preview. Without --confirm the
    /// command prints a preview and exits 2.
    pub confirm: bool,
    pub pretty: bool,
}

/// Stable JSON shape emitted on a successful router withdrawal.
#[derive(Debug, Serialize)]
pub struct WithdrawRouterOutput {
    pub status: &'static str,
    pub payment_id: String,
    pub order_id: String,
    pub agent: String,
    pub asset_recipient: String,
    pub router: String,
    pub share_holder: String,
    pub shares_per_leg: Vec<String>,
    pub assets_per_leg: Vec<String>,
    pub block_number: u64,
    pub tx_hash: String,
    pub gas_used: String,
    pub effective_gas_price: String,
}

/// What `--confirm` would sign, printed on the preview refusal
/// (`ErrConfirmNotProvided`) and logged before a confirmed run signs (QA plan
/// U6, finding DR-6). Each field comes from the arguments or from this run's
/// live preflight reads, never from cached or explorer data.
#[derive(Debug, Serialize)]
pub struct WithdrawRouterPreview {
    /// The transaction's `to`: `gateway.withdrawFromRouter(...)`.
    pub gateway: String,
    /// `agents(self).shareReceiver`: the gateway pulls every leg's shares
    /// from this address.
    pub share_holder: String,
    /// `agents(self).assetRecipient`: every leg's USDC lands here.
    pub asset_recipient: String,
    /// One entry per identity-bound leg, in calldata order.
    pub legs: Vec<PreviewLeg>,
    /// Sum of the legs' shares, checked against the withdraw caps.
    pub total_shares: String,
    /// True when every floor is zero (`--min-assets-per-leg 0`): no leg is
    /// protected against slippage.
    pub no_slippage_floor: bool,
    /// The gas limit the transaction will carry.
    pub gas_limit: u64,
    /// The gateway's entry floor for these legs: 400_000 + 1_850_000 per
    /// non-zero leg. Below it the call reverts `InsufficientGas`.
    pub gas_floor: u64,
    /// Block-time deadline the call carries.
    pub deadline: u64,
}

/// One leg of a [`WithdrawRouterPreview`].
#[derive(Debug, Serialize)]
pub struct PreviewLeg {
    pub vault: String,
    pub shares: String,
    /// Minimum USDC this leg must return or the whole call reverts.
    pub min_assets: String,
}

/// Why `--min-assets-per-leg` could not become a floor vector.
#[derive(Debug, PartialEq, Eq)]
pub enum FloorArgError {
    /// The flag was omitted (or given no values). Refused: the zero floor
    /// must be asked for (QA plan U6).
    Missing,
    /// Neither a single `0` nor one value per leg.
    Length { got: usize, legs: usize },
    /// A value is not a decimal U256.
    NotDecimal(String),
}

/// Parse `--min-assets-per-leg` for `legs` legs.
///
/// - omitted → [`FloorArgError::Missing`]. Before U6 this silently sent an
///   all-zero floor, so a router withdrawal signed with no slippage
///   protection whenever the operator forgot the flag (DR-6);
/// - a single `0` → an all-zero floor of `legs` entries, the explicit opt-out;
/// - otherwise exactly one decimal floor per leg, `0` allowed per leg.
pub fn parse_min_assets_per_leg(raw: &[String], legs: usize) -> Result<Vec<U256>, FloorArgError> {
    match raw {
        [] => Err(FloorArgError::Missing),
        [only] if only.trim() == "0" => Ok(vec![U256::ZERO; legs]),
        _ if raw.len() != legs => Err(FloorArgError::Length {
            got: raw.len(),
            legs,
        }),
        _ => raw
            .iter()
            .map(|s| U256::from_str(s.trim()).map_err(|_| FloorArgError::NotDecimal(s.clone())))
            .collect(),
    }
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(args: Args) -> i32 {
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc withdraw-router: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // Parse shares_per_leg.
    let shares_per_leg: Vec<U256> = {
        let mut out = Vec::with_capacity(args.shares_per_leg.len());
        for s in &args.shares_per_leg {
            match U256::from_str(s) {
                Ok(v) => out.push(v),
                Err(e) => {
                    log::error!("rmpc withdraw-router: --shares-per-leg entry {s:?} is not a valid decimal U256: {e}");
                    return EXIT_STARTUP_FAIL;
                }
            }
        }
        out
    };

    let total_shares: U256 = shares_per_leg.iter().fold(U256::ZERO, |a, &b| a + b);
    if total_shares == U256::ZERO {
        log::error!("rmpc withdraw-router: --shares-per-leg must have at least one non-zero entry");
        return EXIT_STARTUP_FAIL;
    }

    // Parse --vaults. The redeem legs are driven by the caller-supplied
    // vaults[] (issue #967): vaults[i] is identity-bound to
    // sharesPerLeg[i], so the two arrays must be the same non-empty length.
    let vaults: Vec<Address> = {
        let mut out = Vec::with_capacity(args.vaults.len());
        for v in &args.vaults {
            match Address::from_str(v) {
                Ok(a) => out.push(a),
                Err(e) => {
                    log::error!(
                        "rmpc withdraw-router: --vaults entry {v:?} is not a valid 0x address: {e}"
                    );
                    return EXIT_REFUSAL;
                }
            }
        }
        out
    };
    if vaults.is_empty() {
        log::error!(
            "rmpc withdraw-router: --vaults must list at least one vault address, one per leg"
        );
        return EXIT_REFUSAL;
    }
    if vaults.len() != shares_per_leg.len() {
        log::error!(
            "rmpc withdraw-router: --vaults length ({}) must equal --shares-per-leg length ({}); \
             vaults[i] is identity-bound to shares_per_leg[i] (issue #967)",
            vaults.len(),
            shares_per_leg.len()
        );
        return EXIT_REFUSAL;
    }

    // Parse the per-leg slippage floor (GW-5 / F-11). Required (QA plan U6):
    // an omitted flag is a named refusal on stdout, not a silent zero floor.
    let min_assets_per_leg: Vec<U256> = match parse_min_assets_per_leg(
        &args.min_assets_per_leg,
        shares_per_leg.len(),
    ) {
        Ok(v) => v,
        Err(FloorArgError::Missing) => {
            let err = RmpcError::ErrMinAssetsPerLegRequired;
            log::error!("rmpc withdraw-router: {err}");
            return WriteFailure::new(err.name())
                .message(format!("{err}"))
                .emit(args.pretty);
        }
        Err(FloorArgError::Length { got, legs }) => {
            log::error!(
                "rmpc withdraw-router: --min-assets-per-leg length ({got}) must equal --shares-per-leg length ({legs}), or be a single 0"
            );
            return EXIT_STARTUP_FAIL;
        }
        Err(FloorArgError::NotDecimal(s)) => {
            log::error!(
                "rmpc withdraw-router: --min-assets-per-leg entry {s:?} is not a valid decimal U256"
            );
            return EXIT_STARTUP_FAIL;
        }
    };
    let gas_floor = gas_floor_for(&shares_per_leg);
    let gas_limit = args
        .gas_limit
        .unwrap_or_else(|| default_gas_limit(vaults.len()));

    let order_id = match B256::from_str(&args.order_id) {
        Ok(b) => b,
        Err(e) => {
            log::error!("rmpc withdraw-router: --order-id is not a 32-byte hex string: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let idempotency_key = match args.idempotency_key.as_deref() {
        None => order_id,
        Some(s) => match B256::from_str(s) {
            Ok(b) => b,
            Err(e) => {
                log::error!(
                    "rmpc withdraw-router: --idempotency-key is not a 32-byte hex string: {e}"
                );
                return EXIT_STARTUP_FAIL;
            }
        },
    };

    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc withdraw-router: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let deadline_secs = args.deadline_secs.min(MAX_DEADLINE_SKEW_SECS);

    // -- Shared write-path prologue ---------------------------------------
    // total_shares is the replay-cache amount field, and OP_WITHDRAW keeps
    // router-withdraw entries disjoint from deposit entries (PAYMENTID-001).
    let mut session = match open_session(
        &cfg,
        WriteRequest {
            command: "withdraw-router",
            gateway: gateway_addr,
            order_id,
            idempotency_key,
            amount: total_shares,
            deadline: 0,
            replay_op: Some(OP_WITHDRAW),
        },
    ) {
        Ok(s) => s,
        Err(abort) => return abort.exit(args.pretty),
    };
    let agent_address = session.agent_address;

    // -- Deadline from block timestamp ------------------------------------
    // Block time, never wall clock (issue #1432): the gateway checks the
    // deadline against `block.timestamp`, so a skewed host clock would
    // otherwise build a transaction that reverts `DeadlineTooFar`.
    let deadline = match session
        .rt
        .block_on(chain_deadline(&session.rpc, deadline_secs))
    {
        Ok(d) => {
            session.audit.deadline = d;
            d
        }
        Err(e) => {
            log::error!("rmpc withdraw-router: failed to fetch block timestamp for deadline: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // -- Preflight --------------------------------------------------------
    // The withdrawal-specific gateway preflight (chain id, code hash,
    // agent active+expiry, withdrawal window cap) with totalShares as the
    // amount. A deposit pause never refuses it (core 1494).
    let preflight_result = session.rt.block_on(async {
        Preflight::new(&session.rpc, &cfg)
            .run_withdraw_gateway(PreflightInputs {
                signer_address: agent_address,
                amount: total_shares,
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

    // -- Per-leg vault share preflight (RPC-7) ----------------------------
    // The gateway preflight above intentionally leaves USDC allowance/balance
    // at zero (N/A for withdrawals). The redeem burns *vault shares*, which
    // the gateway pulls from each source vault, so the share holder must
    // (a) hold enough shares in each vault and (b) have approved the gateway
    // to spend them. Run the same per-vault share allowance/balance check the
    // single-vault `withdraw` path uses, once per identity-bound leg.
    //
    // The share holder is the policy's `shareReceiver`: `withdrawFromRouter`
    // pulls each leg's shares from it (`args.shareHolder = p.shareReceiver`).
    // Checking the agent's own shares would pass or refuse the wrong account
    // whenever the two differ (AZ-GW-2).
    let share_holder = report.share_receiver;
    for (vault, leg_shares) in vaults.iter().zip(shares_per_leg.iter()) {
        let leg_result = session.rt.block_on(async {
            Preflight::new(&session.rpc, &cfg)
                .run_withdraw_vault(*vault, gateway_addr, share_holder, *leg_shares)
                .await
        });
        if let Err(err) = leg_result {
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!("vault {vault:#x}: {err}"))
                .checks(ChecksOutput::from_report(&report))
                .emit(args.pretty);
        }
    }

    // -- Gas floor (QA plan U6) -------------------------------------------
    // The gateway checks `gasleft()` against 400_000 + 1_850_000 per non-zero
    // leg at entry and reverts `InsufficientGas` below it, burning the gas.
    if gas_limit < gas_floor {
        let err = RmpcError::ErrGasLimitBelowFloor {
            gas_limit,
            floor: gas_floor,
        };
        session.record(AuditDecision::Refused, Some(err.name().to_string()));
        return session
            .refusal(err.name())
            .message(format!("{err}"))
            .checks(ChecksOutput::from_report(&report))
            .emit(args.pretty);
    }

    // -- Preview (QA plan U6, finding DR-6) --------------------------------
    let preview = WithdrawRouterPreview {
        gateway: format!("{gateway_addr:#x}"),
        share_holder: format!("{share_holder:#x}"),
        asset_recipient: format!("{:#x}", report.asset_recipient),
        legs: vaults
            .iter()
            .zip(shares_per_leg.iter())
            .zip(min_assets_per_leg.iter())
            .map(|((v, s), m)| PreviewLeg {
                vault: format!("{v:#x}"),
                shares: s.to_string(),
                min_assets: m.to_string(),
            })
            .collect(),
        total_shares: total_shares.to_string(),
        no_slippage_floor: min_assets_per_leg.iter().all(|m| m.is_zero()),
        gas_limit,
        gas_floor,
        deadline,
    };
    let preview_json = serde_json::to_value(&preview).unwrap_or(serde_json::Value::Null);
    log::info!("withdraw-router: preview {preview_json}");

    // -- Explicit confirmation required -----------------------------------
    if !args.confirm {
        eprintln!(
            "rmpc withdraw-router: preview — gateway {gateway_addr:#x} redeems {} legs \
             (total_shares={total_shares}) from share holder {share_holder:#x}; \
             USDC goes to assetRecipient {:#x}; gas_limit={gas_limit} (floor {gas_floor}).",
            shares_per_leg.len(),
            report.asset_recipient,
        );
        for leg in &preview.legs {
            eprintln!(
                "  vault {} shares={} min_assets={}",
                leg.vault, leg.shares, leg.min_assets
            );
        }
        if preview.no_slippage_floor {
            eprintln!("  WARNING: --min-assets-per-leg 0: no leg has a slippage floor.");
        }
        eprintln!("Re-run with --confirm to sign exactly this.");
        session.record(
            AuditDecision::Refused,
            Some("ErrConfirmNotProvided".to_string()),
        );
        return session
            .refusal("ErrConfirmNotProvided")
            .message(
                "Pass --confirm to sign exactly the preview. Run `rmpc get-router` first to \
                 check the router's vaults and decide the per-leg shares and floors.",
            )
            .checks(ChecksOutput::from_report(&report))
            .preview(preview_json)
            .emit(args.pretty);
    }

    // -- Fees, nonce, sign, broadcast, receipt ----------------------------
    let calldata = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: order_id,
        vaults: vaults.clone(),
        sharesPerLeg: shares_per_leg.clone(),
        minAssetsPerLeg: min_assets_per_leg.clone(),
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();

    let confirmed = match session.submit(
        &cfg,
        Submission {
            calldata,
            gas_limit,
            fee_cap_wei: args.fee_cap_wei,
            receipt_timeout_secs: args.receipt_timeout_secs,
            replay_deadline: deadline,
            checks: &|| ChecksOutput::from_report(&report),
        },
    ) {
        Ok(c) => c,
        Err(abort) => return abort.exit(args.pretty),
    };

    // -- Decode AgentWithdrawalRouted log ---------------------------------
    let topic0 = RobotMoneyGateway::AgentWithdrawalRouted::SIGNATURE_HASH;
    let log = confirmed
        .receipt
        .inner
        .logs()
        .iter()
        .find(|l| l.address() == gateway_addr && l.topics().first() == Some(&topic0));
    let log = match log {
        Some(l) => l,
        None => {
            log::error!("rmpc withdraw-router: AgentWithdrawalRouted event not found in receipt");
            session.record(
                AuditDecision::Refused,
                Some("ErrRouterWithdrawLogMissing".to_string()),
            );
            return session
                .refusal("ErrRouterWithdrawLogMissing")
                .message("AgentWithdrawalRouted event not found in receipt")
                .tx_hash(confirmed.tx_hash_hex.clone())
                .emit(args.pretty);
        }
    };
    let log_data = LogData::new_unchecked(log.topics().to_vec(), log.data().data.clone());
    let decoded = match RobotMoneyGateway::AgentWithdrawalRouted::decode_log_data(&log_data, true) {
        Ok(d) => d,
        Err(e) => {
            log::error!("rmpc withdraw-router: failed to decode AgentWithdrawalRouted log: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let block_number = confirmed.receipt.block_number.unwrap_or(0);
    session.audit.payment_id = Some(format!("{:#x}", decoded.paymentId));
    session.record(AuditDecision::Signed, None);
    let out = WithdrawRouterOutput {
        status: "success",
        payment_id: format!("{:#x}", decoded.paymentId),
        order_id: format!("{:#x}", decoded.orderId),
        agent: format!("{:#x}", decoded.agent),
        asset_recipient: format!("{:#x}", decoded.assetRecipient),
        router: format!("{:#x}", decoded.router),
        share_holder: format!("{:#x}", decoded.shareHolder),
        shares_per_leg: decoded.sharesPerLeg.iter().map(|s| s.to_string()).collect(),
        assets_per_leg: decoded.assetsPerLeg.iter().map(|a| a.to_string()).collect(),
        block_number,
        tx_hash: confirmed.tx_hash_hex,
        gas_used: confirmed.receipt.gas_used.to_string(),
        effective_gas_price: confirmed.receipt.effective_gas_price.to_string(),
    };
    emit(&out, args.pretty);
    EXIT_OK
}

/// Gateway `withdrawFromRouter` entry floor: fixed part
/// (`ROUTER_WITHDRAW_BASE_GAS`) in gas.
pub const ROUTER_WITHDRAW_BASE_GAS: u64 = 400_000;
/// Gateway entry floor per non-zero leg (`ROUTER_WITHDRAW_GAS_PER_LEG`).
pub const ROUTER_WITHDRAW_GAS_PER_LEG: u64 = 1_850_000;
/// Headroom above the floor for intrinsic tx gas and calldata, which the
/// entry check does not see.
const GAS_MARGIN: u64 = 150_000;

/// Gateway entry floor for a `withdrawFromRouter` with `legs` legs.
pub fn gas_floor(legs: usize) -> u64 {
    ROUTER_WITHDRAW_BASE_GAS.saturating_add(ROUTER_WITHDRAW_GAS_PER_LEG.saturating_mul(legs as u64))
}

/// The gateway's entry floor for these shares: it counts only the non-zero
/// legs (`RobotMoneyGateway.withdrawFromRouter`, core 1482).
pub fn gas_floor_for(shares_per_leg: &[U256]) -> u64 {
    gas_floor(shares_per_leg.iter().filter(|s| !s.is_zero()).count())
}

/// Default tx gas limit: the entry floor for every leg plus a margin.
pub fn default_gas_limit(legs: usize) -> u64 {
    gas_floor(legs).saturating_add(GAS_MARGIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::keccak256;

    #[test]
    fn withdraw_from_router_selector_matches_canonical_signature() {
        let canonical = "withdrawFromRouter(bytes32,address[],uint256[],uint256[],uint64,bytes32)";
        let expected = &keccak256(canonical.as_bytes())[..4];
        let actual = RobotMoneyGateway::withdrawFromRouterCall::SELECTOR;
        assert_eq!(&actual, expected, "withdrawFromRouter selector drift");
    }

    #[test]
    fn agent_withdrawal_routed_event_topic0_matches() {
        let canonical =
            b"AgentWithdrawalRouted(bytes32,bytes32,address,address,address,uint256[],uint256[],address,uint64)";
        let expected = keccak256(canonical);
        let actual = RobotMoneyGateway::AgentWithdrawalRouted::SIGNATURE_HASH;
        assert_eq!(actual, expected, "AgentWithdrawalRouted topic0 drift");
    }

    #[test]
    fn shares_per_leg_encodes_correctly() {
        // Verify the ABI encoding is stable for a two-leg call.
        let legs = vec![U256::from(60_000_000u64), U256::from(40_000_000u64)];
        let vaults = vec![Address::repeat_byte(1), Address::repeat_byte(2)];
        let floors = vec![U256::from(59_700_000u64), U256::from(39_800_000u64)];
        let call = RobotMoneyGateway::withdrawFromRouterCall {
            orderId: B256::ZERO,
            vaults,
            sharesPerLeg: legs,
            minAssetsPerLeg: floors,
            deadline: 0u64,
            idempotencyKey: B256::ZERO,
        };
        let encoded = call.abi_encode();
        // Must start with the 4-byte selector.
        assert_eq!(
            &encoded[..4],
            RobotMoneyGateway::withdrawFromRouterCall::SELECTOR
        );
        assert!(encoded.len() > 4, "encoded call must have non-trivial body");
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// QA plan U6, finding DR-6: an omitted floor is refused, a single `0`
    /// is the explicit all-zero floor, and anything else is one per leg.
    #[test]
    fn min_assets_per_leg_requires_a_floor_or_an_explicit_zero() {
        assert_eq!(
            parse_min_assets_per_leg(&[], 2),
            Err(FloorArgError::Missing)
        );
        assert_eq!(
            parse_min_assets_per_leg(&strs(&["0"]), 3).unwrap(),
            vec![U256::ZERO; 3]
        );
        assert_eq!(
            parse_min_assets_per_leg(&strs(&["5", "0"]), 2).unwrap(),
            vec![U256::from(5u64), U256::ZERO]
        );
        assert_eq!(
            parse_min_assets_per_leg(&strs(&["5"]), 2),
            Err(FloorArgError::Length { got: 1, legs: 2 })
        );
        assert_eq!(
            parse_min_assets_per_leg(&strs(&["5", "x"]), 2),
            Err(FloorArgError::NotDecimal("x".into()))
        );
    }

    #[test]
    fn gas_floor_counts_only_non_zero_legs() {
        let shares = [U256::from(1u64), U256::ZERO, U256::from(2u64)];
        assert_eq!(gas_floor_for(&shares), gas_floor(2));
        assert_eq!(gas_floor_for(&[U256::ZERO]), ROUTER_WITHDRAW_BASE_GAS);
    }

    #[test]
    fn default_gas_limit_is_at_or_above_gateway_floor() {
        for legs in 1..=8usize {
            assert!(default_gas_limit(legs) >= gas_floor(legs));
        }
        assert_eq!(gas_floor(2), 4_100_000);
        assert!(default_gas_limit(1) > 750_000);
    }
}
