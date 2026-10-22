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
//! 1. Argument parsing, including the requested `--vault`.
//! 2. [`Preflight::run`] with the actual deposit amount and the REQUESTED
//!    vault. It reads that vault's pause state and implementation, never
//!    `gateway.vault()` (the gateway pins no vault), and refuses a vault the
//!    owner did not select (`allowed_destinations`) before anything is signed.
//!    Any refusal exits non-zero with a named-error JSON body.
//! 3. The gas limit from the gateway's entry floor (QA plan U3): a
//!    `--gas-limit` below it is refused (`ErrGasLimitBelowFloor`).
//! 4. `gateway.depositTo(orderId, amount, deadline, idempotencyKey, vault, [])`
//!    calldata. The gateway has no other agent deposit.
//! 5. Decoding the `AgentDeposit` event log → a stable JSON document on
//!    stdout. The shape mirrors `rmpc status`.
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
use crate::gateway::RobotMoneyGateway;
use crate::logging::AuditDecision;
use crate::output::emit;
use crate::policy::{ChecksOutput, Preflight, PreflightInputs};
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
    /// The vault to deposit into (0x-prefixed). `None` uses the config's
    /// `vault_address`.
    pub vault: Option<String>,
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
    /// The vault the deposit went into.
    pub vault: String,
    /// Vault shares minted to the share receiver.
    pub shares_minted: String,
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

    // The requested vault, parsed before any I/O so a malformed flag never
    // opens a session. Default: the config's `vault_address`.
    let vault_text = args
        .vault
        .clone()
        .unwrap_or_else(|| cfg.vault_address.clone());
    let vault = match Address::from_str(&vault_text) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc deposit: the vault ({vault_text:?}) is not a valid address: {e}");
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
                vault,
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
    // The gateway checks `gasleft()` at entry (2_000_000). A limit below it
    // reverts `InsufficientGas` and burns the gas and the nonce.
    let gas_limit = match DepositGas::vault().resolve(args.gas_limit) {
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
    log::info!("deposit: depositTo vault={vault:#x} gas_limit={gas_limit}");

    // -- Calldata: the gateway's only agent deposit -----------------------
    let calldata = RobotMoneyGateway::depositToCall {
        orderId: order_id,
        amount,
        deadline,
        idempotencyKey: idempotency_key,
        destination: vault,
        minSharesPerLeg: Vec::new(),
    }
    .abi_encode();

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
            reached_vault: Some((vault, report.vault_implementation)),
        },
    ) {
        Ok(c) => c,
        Err(abort) => return abort.exit(args.pretty),
    };

    // -- Decode AgentDeposit log --------------------------------------------
    let topic0 = RobotMoneyGateway::AgentDeposit::SIGNATURE_HASH;
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
    let decoded = match RobotMoneyGateway::AgentDeposit::decode_log_data(&log_data, true) {
        Ok(d) => d,
        Err(e) => {
            log::error!("rmpc deposit: failed to decode AgentDeposit log: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let out = DepositOutput {
        status: "success",
        payment_id: format!("{:#x}", decoded.paymentId),
        order_id: format!("{:#x}", decoded.orderId),
        agent: format!("{:#x}", decoded.agent),
        share_receiver: format!("{:#x}", decoded.shareReceiver),
        amount: decoded.amount.to_string(),
        vault: format!("{vault:#x}"),
        shares_minted: decoded.sharesMinted.to_string(),
        block_number,
        tx_hash: confirmed.tx_hash_hex,
        gas_used,
        effective_gas_price,
    };
    session.audit.payment_id = Some(out.payment_id.clone());
    session.record(AuditDecision::Signed, None);
    emit(&out, args.pretty);
    EXIT_OK
}

/// Gateway entry floor for `depositTo` (`DEPOSIT_GAS_FLOOR` in
/// `RobotMoneyGateway.sol`).
pub const DEPOSIT_GAS_FLOOR: u64 = 2_000_000;
/// Default limit. A real-adapter vault deposit costs ~1.55M (issue #912), so
/// this clears the floor with room for the adapters.
pub const VAULT_DEPOSIT_DEFAULT_GAS_LIMIT: u64 = 3_000_000;

/// What the gateway requires of one deposit's gas, and the limit rmpc sends
/// when `--gas-limit` is omitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DepositGas {
    /// The gateway's entry floor. `gasleft()` below it reverts
    /// `InsufficientGas`.
    pub floor: u64,
    /// The limit sent when `--gas-limit` is omitted.
    pub default_limit: u64,
}

impl DepositGas {
    pub fn vault() -> Self {
        Self {
            floor: DEPOSIT_GAS_FLOOR,
            default_limit: VAULT_DEPOSIT_DEFAULT_GAS_LIMIT,
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

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;
    use serde_json::json;

    #[test]
    fn vault_default_is_above_its_floor() {
        let g = DepositGas::vault();
        assert_eq!(g.floor, 2_000_000);
        assert_eq!(g.resolve(None).unwrap(), 3_000_000);
    }

    #[test]
    fn explicit_gas_limit_below_the_floor_is_refused() {
        let v = DepositGas::vault();
        assert_eq!(
            v.resolve(Some(1_999_999)).unwrap_err().name(),
            "ErrGasLimitBelowFloor"
        );
        assert_eq!(v.resolve(Some(2_000_000)).unwrap(), 2_000_000);
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
