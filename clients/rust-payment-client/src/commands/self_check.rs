//! Canonical: docs/implementation-plan.md §4.8 — CLI surface (self-check subcommand)
//! (See also: docs/architecture.md §8 — Signer Backends)
//! Security: docs/code-reviews/review-codex-20260518-234945.md §5 (agent-key compromise blast radius)
//!
//! `rmpc self-check` — read-only backend report (v0 §9.2 + preflight snapshot).
//!
//! Loads the operator config, decrypts the configured signer, runs the
//! full preflight against `eth_chainId`, gateway code-hash, paused, agent
//! policy, allowance, and balance with `amount = 0`, and emits a single
//! JSON document on stdout.
//!
//! The output also carries a `withdrawal_exposure` block (issue #429)
//! that reports whether the agent's policy permits withdrawals, what
//! the per-payment and per-window share caps are, the configured
//! `assetRecipient`, and the outstanding `vault.allowance(agent,
//! gateway)`. Operators use this to size the agent-key compromise
//! blast radius and to decide whether stale share allowances should
//! be revoked.
//!
//! Exit codes:
//! - 0 — every preflight rule passed.
//! - 2 — at least one hard-refusal precondition failed (chain id,
//!   code-hash, paused, agent active, etc.). The JSON body is still
//!   printed so operators can pipe it into log aggregation.
//! - 3 — config / keystore / passphrase failure (cannot even start).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;
use std::str::FromStr;

use crate::config::Config;
use crate::errors::RmpcError;
use crate::gateway::{Erc20, RobotMoneyGateway};
use crate::network_env::NetworkEnv;
use crate::policy::{Preflight, PreflightInputs, PreflightReport};
use crate::rpc::{CallRequest, RpcClient};
use crate::signer::software::{SoftwareSigner, PASSPHRASE_ENV_VAR};
use crate::signer::{backend_is_production_grade, AgentSigner, SignerBackendKind};

const EXIT_OK: i32 = 0;
const EXIT_PREFLIGHT_FAIL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// JSON shape emitted on stdout. Field order matches v0 §9.2 with a
/// trailing `checks` block carrying the preflight snapshot. Downstream
/// e2e tests (#18/#19) assert on these exact field names.
#[derive(Debug, Serialize)]
pub struct SelfCheckOutput {
    pub selected_backend: SignerBackendKind,
    pub agent_address: String,
    pub chain_id: u64,
    /// Machine-readable network environment label derived from `chain_id`.
    ///
    /// Stable values: `"local_devnet"`, `"rm_testnet"`, `"production_base"`,
    /// `"unknown"`. Consumers MUST NOT match on `chain_id` directly.
    pub network_env: NetworkEnv,
    pub gateway: String,
    pub software_fallback_allowed: bool,
    pub selected_backend_production_ready: bool,
    pub selected_backend_operator_message: &'static str,
    pub key_exportable: bool,
    pub device_bound: bool,
    pub timestamp: u64,
    pub checks: ChecksOutput,
    /// Agent-compromise blast radius for the withdrawal path (issue
    /// #429). Always emitted, even when withdrawals are disabled, so
    /// the field shape is stable for downstream tooling.
    pub withdrawal_exposure: WithdrawalExposure,
    pub ok: bool,
    /// Variant name of the [`RmpcError`] that caused the refusal, when
    /// `ok == false`. Operator tooling matches on this string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Preflight snapshot, in the same order as [`PreflightReport`]. Numeric
/// values that may exceed `u64` are serialised as decimal strings so the
/// JSON survives `JSON.parse` in JavaScript callers without precision loss.
#[derive(Debug, Serialize)]
pub struct ChecksOutput {
    pub chain_id_match: bool,
    pub gateway_code_hash_match: bool,
    pub gateway_paused: bool,
    pub agent_active: bool,
    pub agent_valid_until: u64,
    pub max_per_payment: String,
    pub max_per_window: String,
    pub window_gross: String,
    pub allowance: String,
    pub balance: String,
}

impl ChecksOutput {
    pub(crate) fn from_report(r: &PreflightReport) -> Self {
        Self {
            chain_id_match: true,
            gateway_code_hash_match: r.gateway_runtime_hash_ok,
            gateway_paused: r.paused,
            agent_active: r.agent_active,
            agent_valid_until: r.agent_valid_until,
            max_per_payment: r.max_per_payment.to_string(),
            max_per_window: r.max_per_window.to_string(),
            window_gross: r.window_gross.to_string(),
            allowance: r.allowance.to_string(),
            balance: r.balance.to_string(),
        }
    }

    /// Best-effort partial snapshot when only the [`RmpcError`] is
    /// available. Mirrors the per-error logic that `self-check`'s `run`
    /// uses for the same purpose.
    pub(crate) fn from_err_partial(err: &RmpcError) -> Self {
        let mut c = Self::unknown();
        match err {
            RmpcError::ErrChainIdMismatch => {}
            RmpcError::ErrCodeHashMismatch => {
                c.chain_id_match = true;
            }
            RmpcError::ErrGatewayPaused => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
                c.gateway_paused = true;
            }
            _ => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
            }
        }
        c
    }

    pub(crate) fn unknown() -> Self {
        Self {
            chain_id_match: false,
            gateway_code_hash_match: false,
            gateway_paused: false,
            agent_active: false,
            agent_valid_until: 0,
            max_per_payment: "0".into(),
            max_per_window: "0".into(),
            window_gross: "0".into(),
            allowance: "0".into(),
            balance: "0".into(),
        }
    }
}

/// Agent-key compromise blast radius for the withdrawal path. Mirrors
/// finding #5 of the 2026-05-18 coin-theft review: even with agent
/// policy caps, a stolen agent key can redeem shares up to
/// `min(share_allowance, max_withdraw_per_window)` to `asset_recipient`.
///
/// Decimal strings are used for any `uint256` so JavaScript callers do
/// not lose precision (same contract as `ChecksOutput`).
#[derive(Debug, Serialize)]
pub struct WithdrawalExposure {
    /// Derived from `maxWithdrawPerPayment > 0`. The gateway's
    /// `withdraw()` reverts with `WithdrawalNotEnabled` when this is
    /// false (`contracts/gateway/RobotMoneyGateway.sol:582`).
    pub withdrawals_enabled: bool,
    /// `agents(self).assetRecipient` — USDC recipient on withdrawal.
    /// Zero address while withdrawals are disabled.
    pub asset_recipient: String,
    /// `agents(self).maxWithdrawPerPayment`, decimal string.
    pub max_withdraw_per_payment: String,
    /// `agents(self).maxWithdrawPerWindow`, decimal string.
    pub max_withdraw_per_window: String,
    /// `vault.allowance(self, gateway)`, decimal string. Read even
    /// when withdrawals are disabled — a leftover non-zero allowance
    /// is a hygiene issue that operators should revoke (issue #429
    /// scope: "stale gateway share allowances").
    pub share_allowance: String,
    /// `true` when `withdrawals_enabled = false` and
    /// `share_allowance > 0`. A stale allowance does nothing until
    /// withdrawals are re-enabled, but the residual approval is part
    /// of the blast radius for any future re-authorization.
    pub stale_share_allowance: bool,
}

impl WithdrawalExposure {
    /// Fallback used when the on-chain read could not complete — keeps
    /// the JSON shape stable but flags everything as unknown.
    pub(crate) fn unknown() -> Self {
        Self {
            withdrawals_enabled: false,
            asset_recipient: "0x0000000000000000000000000000000000000000".into(),
            max_withdraw_per_payment: "0".into(),
            max_withdraw_per_window: "0".into(),
            share_allowance: "0".into(),
            stale_share_allowance: false,
        }
    }
}

/// Read the gateway agent policy + outstanding vault share allowance to
/// produce a [`WithdrawalExposure`] block. Errors fall back to
/// `WithdrawalExposure::unknown()` because self-check must not refuse
/// just because the withdrawal-surfacing read failed.
async fn read_withdrawal_exposure(
    rpc: &RpcClient,
    cfg: &Config,
    agent: Address,
) -> WithdrawalExposure {
    let gateway = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(_) => return WithdrawalExposure::unknown(),
    };
    let vault = match Address::from_str(&cfg.vault_address) {
        Ok(a) => a,
        Err(_) => return WithdrawalExposure::unknown(),
    };

    let agents_data = RobotMoneyGateway::agentsCall { _0: agent }.abi_encode();
    let agents_out = match rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: agents_data.into(),
            },
            None,
        )
        .await
    {
        Ok(b) => b,
        Err(_) => return WithdrawalExposure::unknown(),
    };
    let agents_ret = match RobotMoneyGateway::agentsCall::abi_decode_returns(&agents_out, true) {
        Ok(r) => r,
        Err(_) => return WithdrawalExposure::unknown(),
    };

    let allowance_data = Erc20::allowanceCall {
        owner: agent,
        spender: gateway,
    }
    .abi_encode();
    let share_allowance = match rpc
        .eth_call(
            &CallRequest {
                to: vault,
                from: None,
                data: allowance_data.into(),
            },
            None,
        )
        .await
        .and_then(|out| {
            Erc20::allowanceCall::abi_decode_returns(&out, true)
                .map(|r| r._0)
                .map_err(|e| RmpcError::ErrRpcDecode(format!("allowance decode: {e}")))
        }) {
        Ok(v) => v,
        Err(_) => U256::ZERO,
    };

    let withdrawals_enabled = !agents_ret.maxWithdrawPerPayment.is_zero();
    let stale_share_allowance = !withdrawals_enabled && !share_allowance.is_zero();

    WithdrawalExposure {
        withdrawals_enabled,
        asset_recipient: format!("{:#x}", agents_ret.assetRecipient),
        max_withdraw_per_payment: agents_ret.maxWithdrawPerPayment.to_string(),
        max_withdraw_per_window: agents_ret.maxWithdrawPerWindow.to_string(),
        share_allowance: share_allowance.to_string(),
        stale_share_allowance,
    }
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(config_path: &Path, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc self-check: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // Decrypt the keystore. Self-check is the load-bearing place where
    // operators learn that the keystore + passphrase actually work; no
    // shortcut around `load`.
    let passphrase = match std::env::var(PASSPHRASE_ENV_VAR) {
        Ok(s) => s,
        Err(_) => {
            log::error!(
                "rmpc self-check: ${PASSPHRASE_ENV_VAR} is unset; refusing to prompt on stdin from a non-interactive command"
            );
            return EXIT_STARTUP_FAIL;
        }
    };
    let signer = match SoftwareSigner::load_with_passphrase(
        &cfg.signer.keystore_path,
        passphrase.as_bytes(),
        cfg.signer.allow_software_fallback,
    ) {
        Ok(s) => s,
        Err(e) => {
            log::error!("rmpc self-check: signer load failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let agent_address = signer.public_address();
    let backend = signer.backend_kind();

    // Build the runtime; std requires an explicit current_thread runtime
    // because the rest of the daemon stays sync.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc self-check: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc self-check: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let preflight_result = rt.block_on(async {
        let pf = Preflight::new(&rpc, &cfg);
        pf.run(PreflightInputs {
            signer_address: agent_address,
            amount: U256::ZERO,
        })
        .await
    });

    // Withdrawal-exposure read is independent of the preflight outcome:
    // surfacing the agent-key compromise blast radius is the whole
    // point of issue #429, and we want it even when the deposit-side
    // preflight refused (e.g. ErrAllowanceInsufficient on the USDC
    // approval). Errors here downgrade to `unknown()` rather than
    // failing the command.
    let withdrawal_exposure = rt.block_on(read_withdrawal_exposure(&rpc, &cfg, agent_address));

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let (ok, checks, chain_id, error) = match preflight_result {
        Ok(report) => {
            let cid = report.chain_id;
            (true, ChecksOutput::from_report(&report), cid, None)
        }
        Err(err) => {
            // Salvage what we can: chain_id from config (since on mismatch
            // we don't have an authoritative value). gateway_code_hash_match
            // depends on which step tripped — we conservatively report
            // false across the board on any failure.
            let mut checks = ChecksOutput::unknown();
            // ErrChainIdMismatch is the only case where we know the others
            // weren't even attempted; for everything else the earlier
            // checks did pass, but we have no `report` to read from. Keep
            // it simple: emit the variant name and let operators inspect
            // logs for the rest. Set `chain_id_match` and
            // `gateway_code_hash_match` based on the specific error.
            match &err {
                RmpcError::ErrChainIdMismatch => {}
                RmpcError::ErrCodeHashMismatch => {
                    checks.chain_id_match = true;
                }
                RmpcError::ErrGatewayPaused => {
                    checks.chain_id_match = true;
                    checks.gateway_code_hash_match = true;
                    checks.gateway_paused = true;
                }
                _ => {
                    checks.chain_id_match = true;
                    checks.gateway_code_hash_match = true;
                }
            }
            (
                false,
                checks,
                cfg.chain_id,
                Some(error_name(&err).to_string()),
            )
        }
    };

    let network_env = NetworkEnv::from_chain_id(chain_id);
    log::info!(
        "rmpc self-check: network environment: {} (chain_id={})",
        network_env.human_label(),
        chain_id
    );
    if let Some(warn) = network_env.production_warning() {
        log::warn!("rmpc self-check: {warn}");
    }

    let out = SelfCheckOutput {
        selected_backend: backend,
        agent_address: format!("{agent_address:#x}"),
        chain_id,
        network_env,
        gateway: cfg.gateway_address.clone(),
        software_fallback_allowed: cfg.signer.allow_software_fallback,
        selected_backend_production_ready: backend_is_production_grade(backend),
        selected_backend_operator_message: backend_operator_message(backend),
        // The MVP only ships the software backend; capability flags below
        // mirror v0 §9.2/§9.3 — software keys are exportable, not device-bound.
        key_exportable: matches!(backend, SignerBackendKind::Software),
        device_bound: false,
        timestamp,
        checks,
        withdrawal_exposure,
        ok,
        error,
    };

    let json = if pretty {
        serde_json::to_string_pretty(&out)
    } else {
        serde_json::to_string(&out)
    }
    .expect("self-check output serialises");
    println!("{json}");

    if ok {
        EXIT_OK
    } else {
        EXIT_PREFLIGHT_FAIL
    }
}

/// Map an [`RmpcError`] to its variant name (the stable operator-visible
/// string). Unknown variants fall back to the `Display` prefix.
fn error_name(err: &RmpcError) -> &'static str {
    match err {
        RmpcError::ErrAgentNotAuthorized => "ErrAgentNotAuthorized",
        RmpcError::ErrFeeCapExceeded => "ErrFeeCapExceeded",
        RmpcError::ErrConcurrentInvocation => "ErrConcurrentInvocation",
        RmpcError::ErrCodeHashMismatch => "ErrCodeHashMismatch",
        RmpcError::ErrChainIdMismatch => "ErrChainIdMismatch",
        RmpcError::ErrGatewayPaused => "ErrGatewayPaused",
        RmpcError::ErrAllowanceInsufficient => "ErrAllowanceInsufficient",
        RmpcError::ErrBalanceInsufficient => "ErrBalanceInsufficient",
        RmpcError::ErrSoftwareSignerDisallowed => "ErrSoftwareSignerDisallowed",
        RmpcError::ErrProductionSignerRequired => "ErrProductionSignerRequired",
        RmpcError::ErrConfig(_) => "ErrConfig",
        RmpcError::ErrIo(_) => "ErrIo",
        RmpcError::ErrTomlParse(_) => "ErrTomlParse",
        RmpcError::ErrRpcTransport(_) => "ErrRpcTransport",
        RmpcError::ErrRpcServer { .. } => "ErrRpcServer",
        RmpcError::ErrRpcDecode(_) => "ErrRpcDecode",
        RmpcError::ErrTxReverted { .. } => "ErrTxReverted",
        RmpcError::ErrAgentDepositLogMissing { .. } => "ErrAgentDepositLogMissing",
        RmpcError::ErrOrderIdAlreadySubmitted { .. } => "ErrOrderIdAlreadySubmitted",
        RmpcError::ErrVaultPaused => "ErrVaultPaused",
        RmpcError::ErrWithdrawCapExceeded => "ErrWithdrawCapExceeded",
        RmpcError::ErrShareBalanceInsufficient => "ErrShareBalanceInsufficient",
        RmpcError::ErrShareAllowanceInsufficient => "ErrShareAllowanceInsufficient",
        RmpcError::ErrAgentWithdrawLogMissing { .. } => "ErrAgentWithdrawLogMissing",
    }
}

fn backend_operator_message(backend: SignerBackendKind) -> &'static str {
    match backend {
        SignerBackendKind::Software => {
            "software keystore is non-production; use an HSM/KMS/device-bound signer for Base mainnet writes"
        }
        SignerBackendKind::Hsm | SignerBackendKind::Kms => {
            "production-grade signer backend selected"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;

    fn sample_report() -> PreflightReport {
        PreflightReport {
            chain_id: 31337,
            gateway_runtime_hash_ok: true,
            paused: false,
            agent_active: true,
            agent_valid_until: 9_999_999_999,
            max_per_payment: U256::from(1_000_000u64),
            max_per_window: U256::from(100_000_000u64),
            window_gross: U256::from(0u64),
            allowance: U256::from(u128::MAX),
            balance: U256::from(u128::MAX),
        }
    }

    #[test]
    fn checks_output_renders_u256_as_decimal_strings() {
        let c = ChecksOutput::from_report(&sample_report());
        assert_eq!(c.max_per_payment, "1000000");
        assert_eq!(c.max_per_window, "100000000");
        assert_eq!(c.window_gross, "0");
        assert!(c.chain_id_match);
        assert!(c.gateway_code_hash_match);
        assert!(!c.gateway_paused);
        assert!(c.agent_active);
    }

    #[test]
    fn self_check_output_includes_network_env_field() {
        use crate::network_env::NetworkEnv;
        use crate::signer::SignerBackendKind;

        let out = SelfCheckOutput {
            selected_backend: SignerBackendKind::Software,
            agent_address: "0xabcd".into(),
            chain_id: 31337,
            network_env: NetworkEnv::from_chain_id(31337),
            gateway: "0x0001".into(),
            software_fallback_allowed: true,
            selected_backend_production_ready: false,
            selected_backend_operator_message: backend_operator_message(
                SignerBackendKind::Software,
            ),
            key_exportable: true,
            device_bound: false,
            timestamp: 0,
            checks: ChecksOutput::unknown(),
            withdrawal_exposure: WithdrawalExposure::unknown(),
            ok: false,
            error: None,
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["network_env"], "local_devnet");
        assert_eq!(v["chain_id"], 31337u64);
    }

    #[test]
    fn production_base_self_check_output_has_production_label() {
        use crate::network_env::NetworkEnv;
        use crate::signer::SignerBackendKind;

        let out = SelfCheckOutput {
            selected_backend: SignerBackendKind::Software,
            agent_address: "0xabcd".into(),
            chain_id: 8453,
            network_env: NetworkEnv::from_chain_id(8453),
            gateway: "0x0001".into(),
            software_fallback_allowed: true,
            selected_backend_production_ready: false,
            selected_backend_operator_message: backend_operator_message(
                SignerBackendKind::Software,
            ),
            key_exportable: true,
            device_bound: false,
            timestamp: 0,
            checks: ChecksOutput::unknown(),
            withdrawal_exposure: WithdrawalExposure::unknown(),
            ok: false,
            error: None,
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["network_env"], "production_base");
    }

    #[test]
    fn error_name_covers_every_preflight_refusal() {
        // Every preflight-emitted variant must be in the match arm so the
        // self-check JSON always reports a stable name.
        assert_eq!(
            error_name(&RmpcError::ErrChainIdMismatch),
            "ErrChainIdMismatch"
        );
        assert_eq!(
            error_name(&RmpcError::ErrCodeHashMismatch),
            "ErrCodeHashMismatch"
        );
        assert_eq!(error_name(&RmpcError::ErrGatewayPaused), "ErrGatewayPaused");
        assert_eq!(
            error_name(&RmpcError::ErrAgentNotAuthorized),
            "ErrAgentNotAuthorized"
        );
        assert_eq!(
            error_name(&RmpcError::ErrAllowanceInsufficient),
            "ErrAllowanceInsufficient"
        );
        assert_eq!(
            error_name(&RmpcError::ErrBalanceInsufficient),
            "ErrBalanceInsufficient"
        );
    }
}
