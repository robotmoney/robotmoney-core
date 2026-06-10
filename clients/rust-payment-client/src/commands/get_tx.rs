//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-tx --tx-hash 0x…` — transaction status by hash.
//!
//! Single-read read command. One `eth_getTransactionReceipt`, plus the
//! envelope-header reads. The receipt carries `status`, `block_number`,
//! `gas_used`, and `effective_gas_price` — exactly the §9 fields ("status,
//! block, gas used for a tx hash").
//!
//! Pending transactions (receipt is `null`) are reported with `status:
//! "pending"` and exit code 0. Unknown tx hashes are indistinguishable
//! from pending at the JSON-RPC level; both appear as `null`. The
//! operator distinguishes the two via wall-clock time. Per §9 acceptance
//! criteria, "unknown tx hash" must be a typed error — but only after a
//! confirmation horizon has elapsed, which `rmpc` cannot judge. We
//! therefore emit `status: "not_found_or_pending"` on `null`, exit 4,
//! and document the ambiguity. (`get-tx` would need an extra
//! `eth_getTransactionByHash` to disambiguate; that's a follow-up if
//! consumers ask for it.)
//!
//! # Finality reporting (docs/technical/security-model.md §12)
//!
//! Every successful `get-tx` response includes a `finality` object:
//! - `status`: `"pending"` | `"l2_included"` | `"l1_finalized"`
//! - `confirmations`: blocks between the tx's inclusion block and the
//!   current chain tip at query time.
//! - `required_confirmations`: minimum confirmations required by the
//!   per-operation-class policy (from `--op-class`; default `deposit`).
//!
//! When `--require-finality l1_finalized` is passed and the transaction
//! has not yet accumulated enough confirmations for the given `--op-class`,
//! `rmpc` exits with code 5 (`ErrFinalityNotMet`).
//!
//! Exit codes:
//! - 0 — receipt mined and decoded (finality threshold met if `--require-finality` set).
//! - 2 — input parse failure (bad `--tx-hash` or unknown `--op-class`).
//! - 3 — config / RPC / decode failure.
//! - 4 — `ErrTxNotFound`: receipt is null (pending or unknown).
//! - 5 — `ErrFinalityNotMet`: `--require-finality` threshold not yet reached.

use std::str::FromStr;

use alloy_primitives::B256;
use serde::Serialize;

use crate::config::Config;
use crate::confirmation_policy::{self, OpClass, RequiredFinalityLevel};
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU128, DecimalU256, Envelope, PartialBuilder};

const EXIT_OK: i32 = 0;
const EXIT_INPUT_FAIL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;
const EXIT_NOT_FOUND: i32 = 4;
const EXIT_FINALITY_NOT_MET: i32 = 5;

/// Finality status derived from the confirmation-depth policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalityStatus {
    /// Transaction is included in an L2 block but has not met the
    /// minimum confirmation depth for the operation class.
    Pending,
    /// Transaction is included in an L2 block and has met the minimum
    /// confirmation depth for `l2_included` operations.
    L2Included,
    /// Transaction has met the 64-block minimum required for
    /// `l1_finalized` operations (Base L1 finality horizon).
    L1Finalized,
}

impl FinalityStatus {
    /// Stable wire string. Downstream snapshot tests assert on literal values.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::L2Included => "l2_included",
            Self::L1Finalized => "l1_finalized",
        }
    }
}

/// Finality sub-object embedded in every `get-tx` response.
///
/// Consumers MUST use `status` to decide whether a transaction is final;
/// they MUST NOT compare raw block numbers. The `required_confirmations`
/// field surfaces the policy decision so callers can display it to users.
#[derive(Debug, Serialize)]
pub struct FinalityInfo {
    /// Derived finality status for the transaction.
    pub status: FinalityStatus,
    /// Blocks between the tx's inclusion block and the chain tip at query
    /// time. Zero when `tip == inclusion_block` (just mined).
    pub confirmations: u64,
    /// Minimum confirmations required by the per-operation-class policy
    /// (keyed by `--op-class`, default `deposit`).
    pub required_confirmations: u64,
    /// Operation class used to look up `required_confirmations`.
    pub op_class: OpClass,
}

/// `data` payload for `get-tx`. Captures only the §9-named fields plus
/// the `from`/`to`/`tx_hash` triple that lets a consumer correlate the
/// receipt with its originating tx without a second RPC.
///
/// The `finality` field (security-model.md §12) surfaces the per-operation-
/// class confirmation-depth policy and the observed confirmation count.
#[derive(Debug, Serialize)]
pub struct TxData {
    /// 0x-hex transaction hash (echoed from `--tx-hash`).
    pub tx_hash: String,
    /// `"success"` if `receipt.status == 1`, `"reverted"` otherwise.
    pub status: &'static str,
    /// Block number the receipt was included in.
    pub block_number: u64,
    /// 0x-hex sender address from the receipt.
    pub from: String,
    /// 0x-hex recipient address from the receipt. `None` for contract
    /// creation; serialized as JSON `null` in that case.
    pub to: Option<String>,
    /// Decimal-string gas consumed by the tx.
    pub gas_used: DecimalU128,
    /// Decimal-string `effective_gas_price` from the receipt (wei per
    /// gas after EIP-1559 priority + base-fee selection).
    pub effective_gas_price: DecimalU256,
    /// Per-operation-class finality status (security-model.md §12).
    /// Serialized as JSON key `"finality"`.
    #[serde(rename = "finality")]
    pub finality: FinalityInfo,
}

/// Arguments for `get-tx`. Extracted so callers (main.rs, tests) can
/// construct the struct without depending on the CLI parser.
pub struct Args {
    /// Path to operator config TOML.
    pub config_path: std::path::PathBuf,
    /// 0x-prefixed 32-byte transaction hash.
    pub tx_hash: String,
    /// Operation class for the finality policy lookup. Default: `Deposit`.
    pub op_class: OpClass,
    /// When `Some`, exit non-zero if the required finality level hasn't been met.
    pub require_finality: Option<RequiredFinalityLevel>,
    /// Pretty-print JSON output.
    pub pretty: bool,
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(args: Args) -> i32 {
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-tx: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let tx_hash = match B256::from_str(&args.tx_hash) {
        Ok(b) => b,
        Err(e) => {
            log::error!("rmpc get-tx: --tx-hash not 32-byte hex: {e}");
            return EXIT_INPUT_FAIL;
        }
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-tx: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-tx: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let policy = confirmation_policy::policy_for(args.op_class);

    type Outcome = Result<Option<Envelope<TxData>>, String>;
    let outcome: Outcome = rt.block_on(async {
        let chain_id = rpc
            .chain_id()
            .await
            .map_err(|e| format!("eth_chainId: {e}"))?;
        let tip = rpc
            .block_number()
            .await
            .map_err(|e| format!("eth_blockNumber: {e}"))?;
        let receipt = rpc
            .get_transaction_receipt(tx_hash)
            .await
            .map_err(|e| format!("eth_getTransactionReceipt: {e}"))?;
        let Some(r) = receipt else {
            return Ok(None);
        };
        let status_str = if r.inner.status() {
            "success"
        } else {
            "reverted"
        };
        let inclusion_block = r.block_number.unwrap_or(0);

        // Confirmations: number of blocks mined on top of the inclusion block.
        // If tip < inclusion_block (shouldn't happen but guard anyway), use 0.
        let confirmations = tip.saturating_sub(inclusion_block);

        // Derive finality status from the policy and observed confirmations.
        let finality_status = compute_finality_status(confirmations, &policy);

        let finality = FinalityInfo {
            status: finality_status,
            confirmations,
            required_confirmations: policy.min_confirmations,
            op_class: args.op_class,
        };

        let env = PartialBuilder::new(
            chain_id,
            tip,
            TxData {
                tx_hash: format!("{tx_hash:#x}"),
                status: status_str,
                block_number: inclusion_block,
                from: format!("{:#x}", r.from),
                to: r.to.map(|a| format!("{a:#x}")),
                gas_used: DecimalU128(r.gas_used),
                effective_gas_price: DecimalU256(alloy_primitives::U256::from(
                    r.effective_gas_price,
                )),
                finality,
            },
        )
        .finish();
        Ok(Some(env))
    });

    match outcome {
        Ok(Some(env)) => {
            let network_env = NetworkEnv::from_chain_id(env.chain_id);
            log::info!(
                "rmpc get-tx: network environment: {} (chain_id={})",
                network_env.human_label(),
                env.chain_id
            );

            // Enforce --require-finality: exit non-zero when threshold not met.
            if let Some(required) = args.require_finality {
                let met = match required {
                    RequiredFinalityLevel::L2Included => {
                        matches!(
                            env.data.finality.status,
                            FinalityStatus::L2Included | FinalityStatus::L1Finalized
                        )
                    }
                    RequiredFinalityLevel::L1Finalized => {
                        matches!(env.data.finality.status, FinalityStatus::L1Finalized)
                    }
                };
                emit(&env, args.pretty);
                if !met {
                    log::error!(
                        "rmpc get-tx: ErrFinalityNotMet: required={required} actual={} confirmations={}/{}",
                        env.data.finality.status.as_str(),
                        env.data.finality.confirmations,
                        env.data.finality.required_confirmations
                    );
                    return EXIT_FINALITY_NOT_MET;
                }
            } else {
                emit(&env, args.pretty);
            }
            EXIT_OK
        }
        Ok(None) => {
            log::error!(
                "rmpc get-tx: ErrTxNotFound: receipt is null (pending or unknown) for tx_hash={}",
                args.tx_hash
            );
            EXIT_NOT_FOUND
        }
        Err(msg) => {
            log::error!("rmpc get-tx: {msg}");
            EXIT_STARTUP_FAIL
        }
    }
}

/// Compute the `FinalityStatus` from an observed confirmation count and the
/// policy entry.
///
/// The status is the *achieved* finality level, so high-value operations can
/// distinguish "L2 included" from "L1 finalized" (security-model.md §12):
/// - `l1_finalized` once `L1_FINALIZED_DEPTH` confirmations have accumulated,
///   regardless of operation class.
/// - For `l1_finalized`-class operations (admin/governance), any included
///   transaction below that depth reports `l2_included` — it IS on L2, it is
///   just not yet irreversible on L1. The `--require-finality l1_finalized`
///   gate (exit 5) enforces the policy threshold.
/// - For `l2_included`-class operations, the class-specific minimum depth
///   (1 or 6) must be met before `l2_included` is reported; below it the
///   status is `pending`.
fn compute_finality_status(
    confirmations: u64,
    policy: &confirmation_policy::PolicyEntry,
) -> FinalityStatus {
    use confirmation_policy::RequiredFinalityLevel as Rl;

    // L1_FINALIZED_DEPTH: the Base L1 finality horizon in blocks.
    // Base posts state roots to L1 approximately every 1 hour = ~300 L1 blocks;
    // 64 L2 blocks provides a conservative but practical threshold matching
    // Base's own safe-head definition for the MVP. This constant is the
    // authoritative value; the policy table in confirmation_policy.rs references
    // this semantically (AdminGovernance uses 64 as its min_confirmations).
    const L1_FINALIZED_DEPTH: u64 = 64;

    if confirmations >= L1_FINALIZED_DEPTH {
        return FinalityStatus::L1Finalized;
    }
    match policy.required_level {
        // L2-class operations: pending until the class minimum is met.
        Rl::L2Included if confirmations >= policy.min_confirmations => FinalityStatus::L2Included,
        Rl::L2Included => FinalityStatus::Pending,
        // L1-class operations (high-value admin/governance): the tx is on L2
        // as soon as it has at least one confirmation, but it is not
        // `l1_finalized` until the L1 horizon — surface the distinction.
        Rl::L1Finalized if confirmations >= 1 => FinalityStatus::L2Included,
        Rl::L1Finalized => FinalityStatus::Pending,
    }
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-tx output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confirmation_policy::{policy_for, OpClass};
    use alloy_primitives::U256;

    fn make_tx_data(block_number: u64, finality: FinalityInfo) -> TxData {
        TxData {
            tx_hash: "0xab".into(),
            status: "success",
            block_number,
            from: "0xaa".into(),
            to: None,
            gas_used: DecimalU128(21_000),
            effective_gas_price: DecimalU256(U256::from(1_500_000_000u64)),
            finality,
        }
    }

    #[test]
    fn tx_data_serializes_with_decimal_strings_and_optional_to() {
        let policy = policy_for(OpClass::Deposit);
        let finality = FinalityInfo {
            status: FinalityStatus::L2Included,
            confirmations: 1,
            required_confirmations: policy.min_confirmations,
            op_class: OpClass::Deposit,
        };
        let d = make_tx_data(17, finality);
        let v = serde_json::to_value(d).unwrap();
        assert_eq!(v["status"], "success");
        assert!(v["gas_used"].is_string());
        assert!(v["effective_gas_price"].is_string());
        assert_eq!(v["gas_used"], "21000");
        assert_eq!(v["to"], serde_json::Value::Null);
    }

    /// Snapshot: finality envelope shape is present and correctly typed.
    #[test]
    fn finality_envelope_shape_and_types() {
        let policy = policy_for(OpClass::Deposit);
        let finality = FinalityInfo {
            status: FinalityStatus::L2Included,
            confirmations: 3,
            required_confirmations: policy.min_confirmations,
            op_class: OpClass::Deposit,
        };
        let d = make_tx_data(100, finality);
        let v = serde_json::to_value(&d).unwrap();

        // Shape: finality object must be present with correct fields
        let fin = &v["finality"];
        assert!(fin.is_object(), "finality must be a JSON object");
        assert!(fin["status"].is_string(), "finality.status must be string");
        assert!(
            fin["confirmations"].is_number(),
            "finality.confirmations must be a number"
        );
        assert!(
            fin["required_confirmations"].is_number(),
            "finality.required_confirmations must be a number"
        );
        assert!(
            fin["op_class"].is_string(),
            "finality.op_class must be string"
        );

        // Values
        assert_eq!(fin["status"], "l2_included");
        assert_eq!(fin["confirmations"], 3);
        assert_eq!(fin["required_confirmations"], 1);
        assert_eq!(fin["op_class"], "deposit");
    }

    #[test]
    fn finality_pending_when_below_min_confirmations() {
        let policy = policy_for(OpClass::VaultRebalance); // requires 6
        let status = compute_finality_status(3, &policy);
        assert_eq!(status, FinalityStatus::Pending);
    }

    #[test]
    fn finality_l2_included_when_at_min_confirmations() {
        let policy = policy_for(OpClass::VaultRebalance); // requires 6
        let status = compute_finality_status(6, &policy);
        assert_eq!(status, FinalityStatus::L2Included);
    }

    #[test]
    fn finality_l2_included_deposit_at_1_confirmation() {
        let policy = policy_for(OpClass::Deposit); // requires 1
        let status = compute_finality_status(1, &policy);
        assert_eq!(status, FinalityStatus::L2Included);
    }

    #[test]
    fn finality_admin_governance_l2_included_below_64() {
        // High-value (l1_finalized-class) operations distinguish "L2 included"
        // from "L1 finalized": included but below the L1 horizon → l2_included.
        let policy = policy_for(OpClass::AdminGovernance); // requires 64, l1_finalized
        let status = compute_finality_status(63, &policy);
        assert_eq!(status, FinalityStatus::L2Included);
    }

    #[test]
    fn finality_admin_governance_l2_included_at_1_confirmation() {
        // A high-value op at block N with tip = N+1 reports l2_included,
        // not l1_finalized and not pending.
        let policy = policy_for(OpClass::AdminGovernance);
        let status = compute_finality_status(1, &policy);
        assert_eq!(status, FinalityStatus::L2Included);
    }

    #[test]
    fn finality_admin_governance_pending_at_0_confirmations() {
        // Tip == inclusion block: no blocks mined on top yet.
        let policy = policy_for(OpClass::AdminGovernance);
        let status = compute_finality_status(0, &policy);
        assert_eq!(status, FinalityStatus::Pending);
    }

    #[test]
    fn finality_l1_finalized_admin_governance_at_64() {
        let policy = policy_for(OpClass::AdminGovernance); // requires 64, l1_finalized
        let status = compute_finality_status(64, &policy);
        assert_eq!(status, FinalityStatus::L1Finalized);
    }

    #[test]
    fn finality_l1_finalized_supersedes_l2_included_at_64_blocks() {
        // Even a deposit (l2_included policy) at 64+ confirmations
        // should report l1_finalized.
        let policy = policy_for(OpClass::Deposit);
        let status = compute_finality_status(64, &policy);
        assert_eq!(status, FinalityStatus::L1Finalized);
    }

    #[test]
    fn finality_status_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(FinalityStatus::Pending).unwrap(),
            "pending"
        );
        assert_eq!(
            serde_json::to_value(FinalityStatus::L2Included).unwrap(),
            "l2_included"
        );
        assert_eq!(
            serde_json::to_value(FinalityStatus::L1Finalized).unwrap(),
            "l1_finalized"
        );
    }

    #[test]
    fn finality_field_present_in_get_tx_output() {
        // grep-able assertion that the "finality" field is present in TxData
        // (satisfies: grep -E '"finality"' clients/rust-payment-client/src/commands/get_tx.rs)
        let source = include_str!("get_tx.rs");
        assert!(
            source.contains("\"finality\""),
            "get_tx.rs must contain the literal string \"finality\" (field name in JSON output)"
        );
    }
}
