//! `rmpd deposit` — sign and broadcast a USDC deposit through the gateway.
//!
//! Per `docs/implementation-plan-mvp.md` §3.8 and issue #16. This is the
//! keystone command; it ties together every other module:
//!
//! 1. Load config + signer (software keystore decrypted in-process).
//! 2. Acquire the per-agent file lock (single-flight CLI; §3.6).
//! 3. Run [`Preflight`] with the actual deposit amount. Any refusal exits
//!    non-zero with a named-error JSON body — symmetric with `self-check`
//!    so operators can correlate.
//! 4. Compute fees from `eth_feeHistory` ([`compute_fees`]). Fee-cap
//!    refusal → `ErrFeeCapExceeded`.
//! 5. Build the EIP-1559 envelope, sign it via
//!    [`AgentSigner::sign_eip1559_hash`], broadcast, poll for the receipt.
//! 6. Decode the `AgentDeposit` event log → emit a stable JSON document
//!    on stdout. The shape mirrors `rmpd status` so users can correlate
//!    a deposit response with a later lookup.
//!
//! Exit codes:
//! - 0 — receipt mined with `status == 1` and an `AgentDeposit` log.
//! - 2 — preflight refusal, fee-cap refusal, lock contention, or any
//!   refusal that maps to an [`RmpdError`] variant.
//! - 3 — startup failure: config / keystore / RPC client / runtime build.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, Bytes, LogData, B256, U256};
use alloy_sol_types::{SolCall, SolEvent};
use serde::Serialize;

use crate::commands::self_check::ChecksOutput;
use crate::config::Config;
use crate::errors::RmpdError;
use crate::fees::compute_fees;
use crate::gateway::RobotMoneyGateway;
use crate::nonce::AgentLock;
use crate::policy::{Preflight, PreflightInputs};
use crate::rpc::RpcClient;
use crate::signer::software::{SoftwareSigner, PASSPHRASE_ENV_VAR};
use crate::signer::AgentSigner;
use crate::tx::{
    broadcast, build_eip1559, encode_signed, signing_hash, wait_for_receipt_with, Eip1559Inputs,
};

const EXIT_OK: i32 = 0;
const EXIT_REFUSAL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Gateway-side maximum deadline skew, mirrored client-side so the daemon
/// never builds a transaction the contract is guaranteed to reject. Keep
/// in sync with `RobotMoneyGateway.MAX_DEADLINE_SKEW`.
pub const MAX_DEADLINE_SKEW_SECS: u64 = 600;

/// Environment variable for the per-agent state directory (lock files).
/// Falls back to a process-local default under the OS temp dir; operators
/// in production set this to `/var/lib/rmpd`.
pub const STATE_DIR_ENV_VAR: &str = "RMPD_STATE_DIR";

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
    pub gas_limit: u64,
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
    pub shares_minted: String,
    pub block_number: u64,
    pub tx_hash: String,
    pub gas_used: String,
    pub effective_gas_price: String,
}

/// Stable JSON shape on a refusal (preflight, fee cap, lock contention,
/// receipt timeout, on-chain revert, ...). `error` is the variant name
/// of the underlying [`RmpdError`]; `checks` is populated when the
/// refusal came from preflight so operators get the same snapshot they
/// would get from `rmpd self-check`.
#[derive(Debug, Serialize)]
pub struct DepositFailure {
    pub status: &'static str, // always "refused"
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<ChecksOutput>,
}

/// Entry point invoked from `main.rs`. Returns the desired process exit
/// code. The function is deliberately monolithic: each fallible step
/// runs through a small `?`-on-`Result` helper and the failure-path
/// JSON shape is built in one place at the end.
pub fn run(args: Args) -> i32 {
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("rmpd deposit: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let amount = match U256::from_str_radix(args.amount.trim_start_matches("0x"), 10) {
        Ok(v) if !args.amount.starts_with("0x") => v,
        _ => match U256::from_str(&args.amount) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("rmpd deposit: --amount must be a decimal U256: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
    };

    let order_id = match B256::from_str(&args.order_id) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("rmpd deposit: --order-id is not a 32-byte hex string: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let idempotency_key = match args.idempotency_key.as_deref() {
        None => order_id,
        Some(s) => match B256::from_str(s) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("rmpd deposit: --idempotency-key is not a 32-byte hex string: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
    };

    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rmpd deposit: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let deadline_secs = args.deadline_secs.min(MAX_DEADLINE_SKEW_SECS);
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => 0,
    };
    let deadline = now.saturating_add(deadline_secs);

    // Decrypt keystore.
    let passphrase = match std::env::var(PASSPHRASE_ENV_VAR) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "rmpd deposit: ${PASSPHRASE_ENV_VAR} is unset; refusing to prompt on stdin from a non-interactive command"
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
            eprintln!("rmpd deposit: signer load failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let agent_address = signer.public_address();

    // State dir for the per-agent lock. The doc references
    // `$RMPD_STATE_DIR`; default to a per-user temp path so unit
    // invocations don't fail on a fresh box.
    let state_dir = match std::env::var(STATE_DIR_ENV_VAR) {
        Ok(s) => PathBuf::from(s),
        Err(_) => std::env::temp_dir().join("rmpd-state"),
    };

    let _lock = match AgentLock::acquire(&state_dir, &agent_address) {
        Ok(l) => l,
        Err(RmpdError::ErrConcurrentInvocation) => {
            emit_refusal(
                &DepositFailure {
                    status: "refused",
                    error: "ErrConcurrentInvocation".to_string(),
                    message: Some(format!(
                        "another rmpd invocation already holds the lock for agent {agent_address:#x}"
                    )),
                    agent: Some(format!("{agent_address:#x}")),
                    order_id: Some(format!("{order_id:#x}")),
                    tx_hash: None,
                    checks: None,
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
        Err(e) => {
            eprintln!("rmpd deposit: lock acquire failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // Build the runtime; sync rest of the daemon stays sync.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("rmpd deposit: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("rmpd deposit: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // -- Preflight --------------------------------------------------------
    let preflight_result = rt.block_on(async {
        let pf = Preflight::new(&rpc, &cfg);
        pf.run(PreflightInputs {
            signer_address: agent_address,
            amount,
        })
        .await
    });
    let report = match preflight_result {
        Ok(r) => r,
        Err(err) => {
            let checks = ChecksOutput::from_err_partial(&err);
            emit_refusal(
                &DepositFailure {
                    status: "refused",
                    error: error_name(&err).to_string(),
                    message: Some(format!("{err}")),
                    agent: Some(format!("{agent_address:#x}")),
                    order_id: Some(format!("{order_id:#x}")),
                    tx_hash: None,
                    checks: Some(checks),
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };

    // -- Fees -------------------------------------------------------------
    let fee_history_res = rt.block_on(async { rpc.fee_history(5, "latest", &[50.0]).await });
    let fees = match fee_history_res {
        Ok(fh) => match compute_fees(&fh, cfg.max_fee_per_gas_cap as u128) {
            Ok(b) => b,
            Err(e) => {
                emit_refusal(
                    &DepositFailure {
                        status: "refused",
                        error: error_name(&e).to_string(),
                        message: Some(format!("{e}")),
                        agent: Some(format!("{agent_address:#x}")),
                        order_id: Some(format!("{order_id:#x}")),
                        tx_hash: None,
                        checks: Some(ChecksOutput::from_report(&report)),
                    },
                    args.pretty,
                );
                return EXIT_REFUSAL;
            }
        },
        Err(e) => {
            eprintln!("rmpd deposit: eth_feeHistory failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // -- Nonce ------------------------------------------------------------
    let nonce_res = rt.block_on(async {
        rpc.get_transaction_count(agent_address, Some("pending"))
            .await
    });
    let nonce = match nonce_res {
        Ok(n) => n,
        Err(e) => {
            eprintln!("rmpd deposit: eth_getTransactionCount failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // -- Build + sign envelope -------------------------------------------
    let calldata = RobotMoneyGateway::depositCall {
        orderId: order_id,
        amount,
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();

    let tx = build_eip1559(Eip1559Inputs {
        chain_id: cfg.chain_id,
        nonce,
        to: gateway_addr,
        gas_limit: args.gas_limit,
        fees,
        value: U256::ZERO,
        input: Bytes::from(calldata),
    });
    let hash = signing_hash(&tx);
    let mut hash_bytes = [0u8; 32];
    hash_bytes.copy_from_slice(hash.as_slice());
    let alloy_sig = match signer.sign_eip1559_hash(&hash_bytes) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("rmpd deposit: envelope signing failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let raw = encode_signed(tx, alloy_sig);

    // -- Broadcast --------------------------------------------------------
    let tx_hash = match rt.block_on(async { broadcast(&rpc, &raw).await }) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("rmpd deposit: eth_sendRawTransaction failed: {e}");
            // Treat broadcast failure as a refusal — operator-visible
            // failure with a stable name. Most likely cause is a contract
            // revert simulated by the node ahead of inclusion.
            emit_refusal(
                &DepositFailure {
                    status: "refused",
                    error: error_name(&e).to_string(),
                    message: Some(format!("{e}")),
                    agent: Some(format!("{agent_address:#x}")),
                    order_id: Some(format!("{order_id:#x}")),
                    tx_hash: None,
                    checks: Some(ChecksOutput::from_report(&report)),
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };

    // -- Receipt ----------------------------------------------------------
    // 1s polling cadence (RECEIPT_POLL_INTERVAL_MS) × the operator's
    // attempt budget. Issue #19 e2e harness sets this short on Anvil.
    let max_attempts = args.receipt_timeout_secs.min(u32::MAX as u64) as u32;
    let receipt_res = rt.block_on(async {
        wait_for_receipt_with(&rpc, tx_hash, Duration::from_secs(1), max_attempts.max(1)).await
    });
    let receipt = match receipt_res {
        Ok(r) => r,
        Err(e) => {
            emit_refusal(
                &DepositFailure {
                    status: "refused",
                    error: error_name(&e).to_string(),
                    message: Some(format!("{e}")),
                    agent: Some(format!("{agent_address:#x}")),
                    order_id: Some(format!("{order_id:#x}")),
                    tx_hash: Some(format!("{tx_hash:#x}")),
                    checks: None,
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };

    if !receipt.inner.status() {
        let err = RmpdError::ErrTxReverted {
            tx_hash: format!("{tx_hash:#x}"),
        };
        emit_refusal(
            &DepositFailure {
                status: "refused",
                error: "ErrTxReverted".to_string(),
                message: Some(format!("{err}")),
                agent: Some(format!("{agent_address:#x}")),
                order_id: Some(format!("{order_id:#x}")),
                tx_hash: Some(format!("{tx_hash:#x}")),
                checks: None,
            },
            args.pretty,
        );
        return EXIT_REFUSAL;
    }

    // -- Decode AgentDeposit log ------------------------------------------
    let topic0 = RobotMoneyGateway::AgentDeposit::SIGNATURE_HASH;
    let log = receipt
        .inner
        .logs()
        .iter()
        .find(|l| l.address() == gateway_addr && l.topics().first() == Some(&topic0));
    let log = match log {
        Some(l) => l,
        None => {
            let err = RmpdError::ErrAgentDepositLogMissing {
                tx_hash: format!("{tx_hash:#x}"),
            };
            emit_refusal(
                &DepositFailure {
                    status: "refused",
                    error: "ErrAgentDepositLogMissing".to_string(),
                    message: Some(format!("{err}")),
                    agent: Some(format!("{agent_address:#x}")),
                    order_id: Some(format!("{order_id:#x}")),
                    tx_hash: Some(format!("{tx_hash:#x}")),
                    checks: None,
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };
    let log_data = LogData::new_unchecked(log.topics().to_vec(), log.data().data.clone());
    let decoded = match RobotMoneyGateway::AgentDeposit::decode_log_data(&log_data, true) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("rmpd deposit: failed to decode AgentDeposit log: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let block_number = receipt.block_number.unwrap_or(0);
    let out = DepositOutput {
        status: "success",
        payment_id: format!("{:#x}", decoded.paymentId),
        order_id: format!("{:#x}", decoded.orderId),
        agent: format!("{:#x}", decoded.agent),
        share_receiver: format!("{:#x}", decoded.shareReceiver),
        amount: decoded.amount.to_string(),
        shares_minted: decoded.sharesMinted.to_string(),
        block_number,
        tx_hash: format!("{tx_hash:#x}"),
        gas_used: receipt.gas_used.to_string(),
        effective_gas_price: receipt.effective_gas_price.to_string(),
    };
    emit(&out, args.pretty);
    EXIT_OK
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("deposit output serialises");
    println!("{json}");
}

fn emit_refusal(out: &DepositFailure, pretty: bool) {
    emit(out, pretty);
}

/// Map an [`RmpdError`] to its variant name (the stable operator-visible
/// string). Mirrors the table in `commands::self_check`; kept duplicated
/// rather than re-exported because the two commands have different
/// failure modes (deposit can hit `ErrTxReverted`,
/// `ErrAgentDepositLogMissing`, etc.) and the lists should not silently
/// drift through a shared helper.
fn error_name(err: &RmpdError) -> &'static str {
    match err {
        RmpdError::ErrAgentNotAuthorized => "ErrAgentNotAuthorized",
        RmpdError::ErrFeeCapExceeded => "ErrFeeCapExceeded",
        RmpdError::ErrConcurrentInvocation => "ErrConcurrentInvocation",
        RmpdError::ErrCodeHashMismatch => "ErrCodeHashMismatch",
        RmpdError::ErrChainIdMismatch => "ErrChainIdMismatch",
        RmpdError::ErrGatewayPaused => "ErrGatewayPaused",
        RmpdError::ErrAllowanceInsufficient => "ErrAllowanceInsufficient",
        RmpdError::ErrBalanceInsufficient => "ErrBalanceInsufficient",
        RmpdError::ErrSoftwareSignerDisallowed => "ErrSoftwareSignerDisallowed",
        RmpdError::ErrTxReverted { .. } => "ErrTxReverted",
        RmpdError::ErrAgentDepositLogMissing { .. } => "ErrAgentDepositLogMissing",
        RmpdError::ErrConfig(_) => "ErrConfig",
        RmpdError::ErrIo(_) => "ErrIo",
        RmpdError::ErrTomlParse(_) => "ErrTomlParse",
        RmpdError::ErrRpcTransport(_) => "ErrRpcTransport",
        RmpdError::ErrRpcServer { .. } => "ErrRpcServer",
        RmpdError::ErrRpcDecode(_) => "ErrRpcDecode",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_is_capped_at_max_skew() {
        // Sanity: the capping logic is straightforward but load-bearing —
        // the contract rejects deadlines beyond `MAX_DEADLINE_SKEW`.
        let cap = MAX_DEADLINE_SKEW_SECS;
        let too_big = cap + 100;
        assert_eq!(too_big.min(cap), cap);
    }

    #[test]
    fn error_name_covers_new_variants() {
        assert_eq!(
            error_name(&RmpdError::ErrTxReverted {
                tx_hash: "0x00".into()
            }),
            "ErrTxReverted"
        );
        assert_eq!(
            error_name(&RmpdError::ErrAgentDepositLogMissing {
                tx_hash: "0x00".into()
            }),
            "ErrAgentDepositLogMissing"
        );
    }
}
