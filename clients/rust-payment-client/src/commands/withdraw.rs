//! Canonical: docs/architecture.md §4 — High-Level Flow
//! (See also: docs/technical/rmpc-read-output-contract.md)
//!
//! `rmpc withdraw` — sign and broadcast a gateway redemption from one vault
//! (agent-initiated).
//!
//! Per issue #312. The cross-cutting sequence — signer policy, keystore,
//! single-flight lock, replay cache, runtime, RPC, fees, nonce, sign,
//! broadcast, receipt — belongs to [`crate::write_path`] (issue #1285).
//! What is withdraw-specific and lives here:
//!
//! 1. Argument parsing, including `--min-assets` ([`parse_min_assets`]).
//! 2. The withdraw preflight: [`Preflight::run_withdraw_gateway`] (chain
//!    id, code-hash pin, agent policy active + not
//!    expired, `shares <= maxWithdrawPerPayment`, and
//!    `effectiveWithdrawWindowGross + shares <= maxWithdrawPerWindow` —
//!    issue #449's rolling-window cap), then
//!    [`Preflight::run_withdraw_vault`] for the source vault's share
//!    allowance and share balance. A deposit pause on the gateway or the
//!    vault never refuses a withdrawal (core 1494); the gateway's
//!    `depositsPaused()` is only reported in `checks.deposits_paused`.
//! 3. The route ([`Route`], QA plan D9, finding E8, SR-M16).
//!    `gateway.withdraw` calls `vault.redeem`, which has no minimum-out: the
//!    redemption paid whatever the vault paid at inclusion. So on a gateway
//!    with a Portfolio Router the redemption is the one-leg
//!    `gateway.withdrawFromRouter(orderId, [sourceVault], [shares],
//!    [minAssets], deadline, idempotencyKey)`, and the router reverts
//!    `SlippageExceeded` below `minAssets`. The floor is `--min-assets`, or
//!    `previewRedeem(shares)` less [`DEFAULT_FLOOR_TOLERANCE_BPS`] when the
//!    flag is omitted; `--min-assets 0` sends no floor. That path pulls the
//!    shares from the policy's `shareReceiver`, as `withdraw-router` does.
//!    The router is a proxy (issue 1808): before it signs, the command reads
//!    the router's ERC-1967 implementation and refuses with
//!    `ErrImplementationNotApproved` unless its code hash is in
//!    `proxy_implementation_hashes`
//!    (`policy::implementation::verify_reached_proxy`).
//!    A gateway deployed without a router (single-vault mode) has only
//!    `gateway.withdraw`, which pulls the shares from the agent. rmpc uses it
//!    only for an explicit `--min-assets 0` and refuses otherwise, so a
//!    redemption is never sent without a floor nobody asked for.
//! 4. Decoding the `AgentWithdrawalRouted` (router) or `AgentWithdrawal`
//!    (`gateway.withdraw`) event log → one stable JSON shape on stdout.
//!
//! Exit codes mirror `rmpc deposit`:
//! - 0 — success.
//! - 2 — preflight refusal or on-chain failure.
//! - 3 — startup failure.

use std::path::PathBuf;
use std::str::FromStr;

use alloy_primitives::{Address, LogData, B256, U256};
use alloy_sol_types::{SolCall, SolEvent};
use serde::Serialize;

use crate::commands::withdraw_router::gas_floor as router_withdraw_gas_floor;
use crate::config::Config;
use crate::errors::{Result as RmpcResult, RmpcError};
use crate::gateway::RobotMoneyGateway;
use crate::logging::AuditDecision;
use crate::output::emit;
use crate::policy::{ChecksOutput, Preflight, PreflightInputs};
use crate::replay_cache::OP_WITHDRAW;
use crate::rpc::{CallRequest, FailoverRpcClient};
use crate::write_path::{
    chain_deadline, open_session, Submission, WriteRequest, EXIT_OK, EXIT_STARTUP_FAIL,
    MAX_DEADLINE_SKEW_SECS,
};

/// The ERC-4626 view the default floor is read from. The `IVault` binding
/// does not carry it.
mod erc4626 {
    alloy_sol_types::sol! {
        function previewRedeem(uint256 shares) external view returns (uint256 assets);
    }
}

/// The default floor sits this far under `previewRedeem(shares)`, in basis
/// points (0.50%): the tolerance the dapp's router deposit and router redeem
/// use. ERC-4626 has `redeem` pay at least `previewRedeem` in the same block,
/// so the floor binds only on a move between the preflight read and
/// inclusion, such as a dragged TWAP on a basket leg (core 1793).
pub const DEFAULT_FLOOR_TOLERANCE_BPS: u64 = 50;

/// `RobotMoneyGateway.WITHDRAW_GAS_FLOOR`: `gateway.withdraw` checks
/// `gasleft()` against it at entry.
pub const GATEWAY_WITHDRAW_GAS_FLOOR: u64 = 2_000_000;

/// Inputs collected by `main.rs` from the CLI parser.
#[derive(Debug, Clone)]
pub struct Args {
    pub config_path: PathBuf,
    /// Vault shares to redeem (in share units).
    pub shares: String,
    /// Source vault address (0x-prefixed hex).
    pub source_vault: String,
    /// Minimum USDC (6-decimal base units) the redemption must pay, or the
    /// call reverts. `None` derives it from `previewRedeem`; `Some("0")`
    /// sends no floor. See [`parse_min_assets`].
    pub min_assets: Option<String>,
    /// 32-byte order id, 0x-prefixed hex.
    pub order_id: String,
    /// 32-byte idempotency key. Defaults to order_id when omitted.
    pub idempotency_key: Option<String>,
    pub deadline_secs: u64,
    pub receipt_timeout_secs: u64,
    pub gas_limit: u64,
    /// Optional CLI override for `max_fee_per_gas_cap` in wei.
    pub fee_cap_wei: Option<u64>,
    pub pretty: bool,
}

/// Stable JSON shape emitted on a successful withdrawal, whichever gateway
/// entry point signed it.
#[derive(Debug, Serialize)]
pub struct WithdrawOutput {
    pub status: &'static str,
    pub payment_id: String,
    pub order_id: String,
    pub agent: String,
    pub asset_recipient: String,
    pub source_vault: String,
    pub shares: String,
    pub assets_out: String,
    /// `"router"` (`withdrawFromRouter`, with a floor) or `"vault"`
    /// (`gateway.withdraw`, no floor). QA plan D9.
    pub route: &'static str,
    /// The floor the call carried, in USDC base units. `"0"` is no floor.
    pub min_assets: String,
    /// Whose shares were redeemed: the policy's `shareReceiver` on the
    /// router route, the agent on the vault route.
    pub share_holder: String,
    pub block_number: u64,
    pub tx_hash: String,
    pub gas_used: String,
    pub effective_gas_price: String,
}

/// `--min-assets` as given on the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MinAssetsArg {
    /// Omitted: the floor is the source vault's `previewRedeem(shares)`, read
    /// by this run, less [`DEFAULT_FLOOR_TOLERANCE_BPS`].
    FromPreview,
    /// Given: the floor in USDC base units. `0` sends no floor.
    Explicit(U256),
}

/// Parse `--min-assets`. Omitted is [`MinAssetsArg::FromPreview`]; anything
/// else must be a decimal U256. The error is the offending text.
pub fn parse_min_assets(raw: Option<&str>) -> Result<MinAssetsArg, String> {
    match raw {
        None => Ok(MinAssetsArg::FromPreview),
        Some(s) => U256::from_str(s.trim())
            .map(MinAssetsArg::Explicit)
            .map_err(|_| s.to_string()),
    }
}

/// The default floor for a redemption whose `previewRedeem(shares)` is
/// `preview`: the preview less [`DEFAULT_FLOOR_TOLERANCE_BPS`], rounded
/// down. Split into quotient and remainder so no product can overflow.
pub fn floor_from_preview(preview: U256) -> U256 {
    let denom = U256::from(10_000u64);
    let keep = U256::from(10_000u64 - DEFAULT_FLOOR_TOLERANCE_BPS);
    (preview / denom) * keep + (preview % denom) * keep / denom
}

/// Which gateway entry point signs the redemption (QA plan D9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// `withdrawFromRouter` with one leg: the router reverts
    /// `SlippageExceeded` when the vault pays less than `min_assets`.
    Router { min_assets: U256 },
    /// `gateway.withdraw` → `vault.redeem`, which has no minimum-out. Used
    /// only on a gateway without a router, and only for `--min-assets 0`.
    Vault,
}

impl Route {
    /// The `route` field of the output.
    pub fn name(&self) -> &'static str {
        match self {
            Route::Router { .. } => "router",
            Route::Vault => "vault",
        }
    }

    /// The floor the call carries; zero on the vault route.
    pub fn min_assets(&self) -> U256 {
        match self {
            Route::Router { min_assets } => *min_assets,
            Route::Vault => U256::ZERO,
        }
    }

    /// The gateway's entry gas floor for this call. Below it the gateway
    /// reverts `InsufficientGas` and burns the gas.
    pub fn gas_floor(&self) -> u64 {
        match self {
            Route::Router { .. } => router_withdraw_gas_floor(1),
            Route::Vault => GATEWAY_WITHDRAW_GAS_FLOOR,
        }
    }
}

/// True when a gateway without a router may redeem through
/// `gateway.withdraw`: only for an explicit `--min-assets 0`, because that
/// call cannot carry a floor.
pub fn single_vault_mode_allows(arg: MinAssetsArg) -> bool {
    matches!(arg, MinAssetsArg::Explicit(floor) if floor.is_zero())
}

/// The calldata `rmpc withdraw` simulates and signs for `route`.
pub fn withdraw_calldata(
    route: Route,
    order_id: B256,
    source_vault: Address,
    shares: U256,
    deadline: u64,
    idempotency_key: B256,
) -> Vec<u8> {
    match route {
        Route::Router { min_assets } => RobotMoneyGateway::withdrawFromRouterCall {
            orderId: order_id,
            vaults: vec![source_vault],
            sharesPerLeg: vec![shares],
            minAssetsPerLeg: vec![min_assets],
            deadline,
            idempotencyKey: idempotency_key,
        }
        .abi_encode(),
        Route::Vault => RobotMoneyGateway::withdrawCall {
            orderId: order_id,
            shares,
            sourceVault: source_vault,
            deadline,
            idempotencyKey: idempotency_key,
        }
        .abi_encode(),
    }
}

/// `gateway.router()`: the zero address on a single-vault-mode gateway.
async fn read_router(rpc: &FailoverRpcClient, gateway: Address) -> RmpcResult<Address> {
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
    Ok(
        RobotMoneyGateway::routerCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("router() decode: {e}")))?
            ._0,
    )
}

/// `vault.previewRedeem(shares)`: what the redemption pays at least, now.
async fn read_preview_redeem(
    rpc: &FailoverRpcClient,
    vault: Address,
    shares: U256,
) -> RmpcResult<U256> {
    let out = rpc
        .eth_call(
            &CallRequest {
                to: vault,
                from: None,
                data: erc4626::previewRedeemCall { shares }.abi_encode().into(),
            },
            None,
        )
        .await?;
    Ok(erc4626::previewRedeemCall::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("previewRedeem() decode: {e}")))?
        .assets)
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(args: Args) -> i32 {
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc withdraw: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let shares = match U256::from_str(&args.shares) {
        Ok(v) => v,
        Err(e) => {
            log::error!("rmpc withdraw: --shares must be a decimal U256: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let source_vault = match Address::from_str(&args.source_vault) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc withdraw: --source-vault is not a valid address: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let min_assets_arg = match parse_min_assets(args.min_assets.as_deref()) {
        Ok(m) => m,
        Err(s) => {
            log::error!("rmpc withdraw: --min-assets {s:?} is not a valid decimal U256");
            return EXIT_STARTUP_FAIL;
        }
    };

    let order_id = match B256::from_str(&args.order_id) {
        Ok(b) => b,
        Err(e) => {
            log::error!("rmpc withdraw: --order-id is not a 32-byte hex string: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let idempotency_key = match args.idempotency_key.as_deref() {
        None => order_id,
        Some(s) => match B256::from_str(s) {
            Ok(b) => b,
            Err(e) => {
                log::error!("rmpc withdraw: --idempotency-key is not a 32-byte hex string: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
    };

    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc withdraw: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let deadline_secs = args.deadline_secs.min(MAX_DEADLINE_SKEW_SECS);

    // -- Shared write-path prologue ---------------------------------------
    let mut session = match open_session(
        &cfg,
        WriteRequest {
            command: "withdraw",
            gateway: gateway_addr,
            order_id,
            idempotency_key,
            // `shares` is the replay-cache amount field, mirroring the
            // on-chain paymentId formula. OP_WITHDRAW keeps withdraw
            // entries disjoint from deposit entries (PAYMENTID-001).
            amount: shares,
            deadline: 0,
            replay_op: Some(OP_WITHDRAW),
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
            log::error!("rmpc withdraw: failed to fetch block timestamp for deadline: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // -- Preflight --------------------------------------------------------
    // The withdrawal-specific gateway preflight checks maxWithdrawPerPayment,
    // maxWithdrawPerWindow, and effectiveWithdrawWindowGross — not the
    // deposit caps — so valid withdrawals are not refused and out-of-policy
    // withdrawals are caught before signing (issue #371, #449).
    let preflight_result = session.rt.block_on(async {
        Preflight::new(&session.rpc, &cfg)
            .run_withdraw_gateway(PreflightInputs {
                signer_address: agent_address,
                amount: shares,
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

    // -- Route (QA plan D9) -----------------------------------------------
    // A gateway with a router redeems through `withdrawFromRouter`, which
    // carries the floor. Without one only `gateway.withdraw` exists, and it
    // cannot carry a floor, so it is used only when the operator asked for
    // no floor.
    let router = match session.rt.block_on(read_router(&session.rpc, gateway_addr)) {
        Ok(r) => r,
        Err(err) => {
            session.record(AuditDecision::Refused, Some(err.name().to_string()));
            return session
                .refusal(err.name())
                .message(format!("gateway.router() read failed: {err}"))
                .checks(ChecksOutput::from_report(&report))
                .emit(args.pretty);
        }
    };
    let via_router = router != Address::ZERO;
    // The router the gateway redeems through is a proxy too (issue 1808). Its
    // `redeemFor` receives the share allowance the gateway grants it, so
    // refuse unless its implementation is pinned in
    // `proxy_implementation_hashes`, as `withdraw-router` and a router
    // deposit do. `run_withdraw_vault` below checks the source vault.
    if via_router {
        if let Err(err) = session
            .rt
            .block_on(crate::policy::implementation::verify_reached_proxy(
                &session.rpc,
                &cfg,
                "router",
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
    if !via_router && !single_vault_mode_allows(min_assets_arg) {
        let err = RmpcError::ErrConfig(
            "gateway.router() is the zero address (single-vault mode), so the only redemption \
             is gateway.withdraw, which has no minimum-out floor. Pass --min-assets 0 to redeem \
             through it without one (QA plan D9)."
                .to_string(),
        );
        session.record(AuditDecision::Refused, Some(err.name().to_string()));
        return session
            .refusal(err.name())
            .message(format!("{err}"))
            .checks(ChecksOutput::from_report(&report))
            .emit(args.pretty);
    }

    // -- Withdraw-specific preflight: vault checks -------------------------
    // `withdrawFromRouter` pulls the shares from the policy's
    // `shareReceiver`; `gateway.withdraw` pulls them from the agent. Check
    // the account the chosen call pulls from (AZ-GW-2).
    let share_holder = if via_router {
        report.share_receiver
    } else {
        agent_address
    };
    let vault_preflight_result = session.rt.block_on(async {
        Preflight::new(&session.rpc, &cfg)
            .run_withdraw_vault(
                source_vault,
                gateway_addr,
                share_holder,
                shares,
                report.block_number,
            )
            .await
    });
    if let Err(err) = vault_preflight_result {
        session.record(AuditDecision::Refused, Some(err.name().to_string()));
        return session
            .refusal(err.name())
            .message(format!("{err}"))
            .checks(ChecksOutput::from_report(&report))
            .emit(args.pretty);
    }

    // -- Floor ---------------------------------------------------------------
    let route = if !via_router {
        Route::Vault
    } else {
        let min_assets = match min_assets_arg {
            MinAssetsArg::Explicit(floor) => floor,
            MinAssetsArg::FromPreview => {
                match session
                    .rt
                    .block_on(read_preview_redeem(&session.rpc, source_vault, shares))
                {
                    Ok(preview) => floor_from_preview(preview),
                    Err(err) => {
                        session.record(AuditDecision::Refused, Some(err.name().to_string()));
                        return session
                            .refusal(err.name())
                            .message(format!(
                                "previewRedeem({shares}) on {source_vault:#x} failed, so no \
                                 default floor could be derived: {err}. Pass --min-assets to \
                                 set the floor."
                            ))
                            .checks(ChecksOutput::from_report(&report))
                            .emit(args.pretty);
                    }
                }
            }
        };
        Route::Router { min_assets }
    };

    // -- Gas floor ----------------------------------------------------------
    // The gateway checks `gasleft()` against its entry floor and reverts
    // `InsufficientGas` below it, burning the gas.
    if args.gas_limit < route.gas_floor() {
        let err = RmpcError::ErrGasLimitBelowFloor {
            gas_limit: args.gas_limit,
            floor: route.gas_floor(),
        };
        session.record(AuditDecision::Refused, Some(err.name().to_string()));
        return session
            .refusal(err.name())
            .message(format!("{err}"))
            .checks(ChecksOutput::from_report(&report))
            .emit(args.pretty);
    }
    if route.min_assets().is_zero() {
        log::warn!(
            "rmpc withdraw: --min-assets 0: the redemption of {shares} shares from \
             {source_vault:#x} carries no minimum-out floor"
        );
    }
    log::info!(
        "withdraw: route={} min_assets={} share_holder={share_holder:#x} source_vault={source_vault:#x}",
        route.name(),
        route.min_assets()
    );

    // -- Fees, nonce, sign, broadcast, receipt ----------------------------
    let calldata = withdraw_calldata(
        route,
        order_id,
        source_vault,
        shares,
        deadline,
        idempotency_key,
    );

    // The replay entry stores deadline 0: the withdraw deadline is derived
    // from the block timestamp inside the runtime, and the on-chain
    // paymentId formula excludes the deadline anyway.
    let confirmed = match session.submit(
        &cfg,
        Submission {
            calldata,
            gas_limit: args.gas_limit,
            fee_cap_wei: args.fee_cap_wei,
            receipt_timeout_secs: args.receipt_timeout_secs,
            replay_deadline: 0,
            checks: &|| ChecksOutput::from_report(&report),
            gateway_implementation: report.gateway_implementation,
        },
    ) {
        Ok(c) => c,
        Err(abort) => return abort.exit(args.pretty),
    };

    // -- Decode the gateway's withdrawal log ---------------------------------
    let topic0 = match route {
        Route::Router { .. } => RobotMoneyGateway::AgentWithdrawalRouted::SIGNATURE_HASH,
        Route::Vault => RobotMoneyGateway::AgentWithdrawal::SIGNATURE_HASH,
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
            let err = RmpcError::ErrAgentWithdrawLogMissing {
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

    // (paymentId, orderId, agent, assetRecipient, shareHolder, shares, assetsOut)
    let decoded = match route {
        Route::Router { .. } => {
            RobotMoneyGateway::AgentWithdrawalRouted::decode_log_data(&log_data, true).map(|d| {
                (
                    d.paymentId,
                    d.orderId,
                    d.agent,
                    d.assetRecipient,
                    d.shareHolder,
                    d.sharesPerLeg.first().copied().unwrap_or_default(),
                    d.assetsPerLeg.first().copied().unwrap_or_default(),
                )
            })
        }
        Route::Vault => {
            RobotMoneyGateway::AgentWithdrawal::decode_log_data(&log_data, true).map(|d| {
                (
                    d.paymentId,
                    d.orderId,
                    d.agent,
                    d.assetRecipient,
                    d.agent,
                    d.shares,
                    d.assetsOut,
                )
            })
        }
    };
    let (payment_id, decoded_order_id, agent, asset_recipient, holder, out_shares, assets_out) =
        match decoded {
            Ok(d) => d,
            Err(e) => {
                log::error!("rmpc withdraw: failed to decode the withdrawal log: {e}");
                return EXIT_STARTUP_FAIL;
            }
        };

    let block_number = confirmed.receipt.block_number.unwrap_or(0);
    session.audit.payment_id = Some(format!("{payment_id:#x}"));
    session.record(AuditDecision::Signed, None);
    let out = WithdrawOutput {
        status: "success",
        payment_id: format!("{payment_id:#x}"),
        order_id: format!("{decoded_order_id:#x}"),
        agent: format!("{agent:#x}"),
        asset_recipient: format!("{asset_recipient:#x}"),
        // The routed event carries no vault list; the leg is the one named.
        source_vault: format!("{source_vault:#x}"),
        shares: out_shares.to_string(),
        assets_out: assets_out.to_string(),
        route: route.name(),
        min_assets: route.min_assets().to_string(),
        share_holder: format!("{holder:#x}"),
        block_number,
        tx_hash: confirmed.tx_hash_hex,
        gas_used: confirmed.receipt.gas_used.to_string(),
        effective_gas_price: confirmed.receipt.effective_gas_price.to_string(),
    };
    emit(&out, args.pretty);
    EXIT_OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, keccak256};

    #[test]
    fn withdraw_selector_matches_canonical_signature() {
        let canonical = "withdraw(bytes32,uint256,address,uint64,bytes32)";
        let expected = &keccak256(canonical.as_bytes())[..4];
        let actual = RobotMoneyGateway::withdrawCall::SELECTOR;
        assert_eq!(&actual, expected, "withdraw selector drift");
    }

    #[test]
    fn agent_withdraw_event_topic0_matches() {
        // Canonical signature from contracts/gateway/RobotMoneyGateway.sol (AgentWithdrawal).
        // Field order: paymentId, orderId, agent(indexed), sourceVault, shares, assetsOut,
        // assetRecipient, windowId — matches the Foundry artifact ABI.
        let canonical =
            b"AgentWithdrawal(bytes32,bytes32,address,address,uint256,uint256,address,uint64)";
        let expected = keccak256(canonical);
        let actual = RobotMoneyGateway::AgentWithdrawal::SIGNATURE_HASH;
        assert_eq!(actual, expected, "AgentWithdrawal topic0 drift");
    }

    #[test]
    fn preview_redeem_selector_matches_erc4626() {
        let expected = &keccak256(b"previewRedeem(uint256)")[..4];
        assert_eq!(&erc4626::previewRedeemCall::SELECTOR, expected);
    }

    const VAULT: Address = address!("0000000000000000000000000000000000000d00");
    const ORDER: B256 = b256!("1111111111111111111111111111111111111111111111111111111111111111");
    const KEY: B256 = b256!("2222222222222222222222222222222222222222222222222222222222222222");

    /// QA plan D9 (finding E8, SR-M16): with a router on the gateway, the
    /// single-vault withdrawal signs a one-leg `withdrawFromRouter` whose
    /// `minAssetsPerLeg` is the floor. `gateway.withdraw` (→ `vault.redeem`,
    /// no min-out) is not what gets signed.
    #[test]
    fn withdraw_signs_one_leg_withdraw_from_router_with_floor() {
        let shares = U256::from(500_000u64);
        let floor = U256::from(496_505u64);
        let calldata = withdraw_calldata(
            Route::Router { min_assets: floor },
            ORDER,
            VAULT,
            shares,
            1_700_000_300,
            KEY,
        );
        assert_eq!(
            &calldata[..4],
            RobotMoneyGateway::withdrawFromRouterCall::SELECTOR
        );
        assert_ne!(&calldata[..4], RobotMoneyGateway::withdrawCall::SELECTOR);
        let call = RobotMoneyGateway::withdrawFromRouterCall::abi_decode(&calldata, true)
            .expect("decodes as withdrawFromRouter");
        assert_eq!(call.orderId, ORDER);
        assert_eq!(call.vaults, vec![VAULT]);
        assert_eq!(call.sharesPerLeg, vec![shares]);
        assert_eq!(call.minAssetsPerLeg, vec![floor]);
        assert_eq!(call.deadline, 1_700_000_300);
        assert_eq!(call.idempotencyKey, KEY);
    }

    /// Only the single-vault-mode route signs `gateway.withdraw`, and it
    /// carries no floor.
    #[test]
    fn vault_route_signs_gateway_withdraw_without_a_floor() {
        let calldata = withdraw_calldata(Route::Vault, ORDER, VAULT, U256::from(7u64), 9, KEY);
        let call = RobotMoneyGateway::withdrawCall::abi_decode(&calldata, true)
            .expect("decodes as withdraw");
        assert_eq!(call.sourceVault, VAULT);
        assert_eq!(call.shares, U256::from(7u64));
        assert_eq!(Route::Vault.min_assets(), U256::ZERO);
        assert_eq!(Route::Vault.name(), "vault");
    }

    #[test]
    fn default_floor_is_preview_redeem_less_half_a_percent() {
        // 499_000 * 9_950 / 10_000 = 496_505.
        assert_eq!(
            floor_from_preview(U256::from(499_000u64)),
            U256::from(496_505u64)
        );
        assert_eq!(
            floor_from_preview(U256::from(1_000_000u64)),
            U256::from(995_000u64)
        );
        assert_eq!(floor_from_preview(U256::ZERO), U256::ZERO);
        // Rounds down, and never overflows on the largest preview.
        assert_eq!(floor_from_preview(U256::from(1u64)), U256::ZERO);
        assert!(floor_from_preview(U256::MAX) < U256::MAX);
    }

    #[test]
    fn min_assets_flag_parses_omitted_explicit_and_zero() {
        assert_eq!(parse_min_assets(None), Ok(MinAssetsArg::FromPreview));
        assert_eq!(
            parse_min_assets(Some("496505")),
            Ok(MinAssetsArg::Explicit(U256::from(496_505u64)))
        );
        assert_eq!(
            parse_min_assets(Some("0")),
            Ok(MinAssetsArg::Explicit(U256::ZERO))
        );
        assert_eq!(parse_min_assets(Some("1.5")), Err("1.5".to_string()));
    }

    /// A gateway without a router can only sign `gateway.withdraw`, which has
    /// no floor, so it is allowed for an explicit `--min-assets 0` only.
    #[test]
    fn single_vault_mode_needs_an_explicit_zero_floor() {
        assert!(single_vault_mode_allows(MinAssetsArg::Explicit(U256::ZERO)));
        assert!(!single_vault_mode_allows(MinAssetsArg::FromPreview));
        assert!(!single_vault_mode_allows(MinAssetsArg::Explicit(
            U256::from(1u64)
        )));
    }

    #[test]
    fn each_route_refuses_gas_under_its_gateway_floor() {
        let router = Route::Router {
            min_assets: U256::from(1u64),
        };
        assert_eq!(router.gas_floor(), 2_250_000);
        assert_eq!(Route::Vault.gas_floor(), 2_000_000);
        // The CLI default of 3_000_000 clears both.
        assert!(3_000_000 >= router.gas_floor());
    }
}
