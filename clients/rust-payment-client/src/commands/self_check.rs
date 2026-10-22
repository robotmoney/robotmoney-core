//! Canonical: Plan tracking issue #109 §4.8 — CLI surface (self-check subcommand)
//! (See also: docs/architecture.md §5.1 — `rmpc` (signing path); §9 — Vendor Selections)
//! Security: docs/code-review/20260518-code-review-internal-codex.md §5 (agent-key compromise blast radius)
//!
//! `rmpc self-check` — read-only backend report (v0 §9.2 + preflight snapshot).
//!
//! Loads the operator config, decrypts the configured signer, runs the
//! full deposit preflight against `eth_chainId`, gateway code-hash,
//! `depositsPaused()` (gateway and the configured `vault_address`), agent
//! policy, allowance, and balance with `amount = 0`, and emits a single JSON
//! document on stdout. The gateway has no withdrawal path, so the output
//! carries no withdrawal exposure block.
//!
//! Exit codes:
//! - 0 — every preflight rule passed.
//! - 2 — at least one hard-refusal precondition failed (chain id,
//!   code-hash, deposits paused, agent active, etc.). The JSON body is still
//!   printed so operators can pipe it into log aggregation.
//! - 3 — config / keystore / passphrase failure (cannot even start).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, U256};
use serde::Serialize;
use std::str::FromStr;

use crate::config::Config;
use crate::network_env::NetworkEnv;
use crate::policy::{ChecksOutput, Preflight, PreflightInputs};
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
    /// Stable values: `"local_devnet"`, `"production_base"`, `"unknown"`.
    /// Consumers MUST NOT match on `chain_id` directly.
    pub network_env: NetworkEnv,
    pub gateway: String,
    pub software_fallback_allowed: bool,
    pub selected_backend_production_ready: bool,
    pub selected_backend_operator_message: &'static str,
    pub key_exportable: bool,
    pub device_bound: bool,
    pub timestamp: u64,
    pub checks: ChecksOutput,
    pub ok: bool,
    /// Variant name of the [`RmpcError`] that caused the refusal, when
    /// `ok == false`. Operator tooling matches on this string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc self-check: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let vault = match Address::from_str(&cfg.vault_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc self-check: vault_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let preflight_result = rt.block_on(async {
        let pf = Preflight::new(&rpc, &cfg);
        pf.run(PreflightInputs {
            signer_address: agent_address,
            amount: U256::ZERO,
            vault,
        })
        .await
    });

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
            // we don't have an authoritative value). Which checks passed
            // depends on which step tripped; `from_err_partial` is the one
            // owner of that per-error table, shared with the write commands.
            let checks = ChecksOutput::from_err_partial(&err);
            (false, checks, cfg.chain_id, Some(err.name().to_string()))
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

/// The message states the signer decisions (QA plan U7, finding DR-12):
/// every rmpc write signs with the software keystore on every chain (owner
/// decision 2026-10-06 for depositor writes), and hardware is optional,
/// never required (owner decision 2026-10-14, QA plan Decision D12 for
/// `committee` and `receipt`).
fn backend_operator_message(backend: SignerBackendKind) -> &'static str {
    match backend {
        SignerBackendKind::Software => {
            "software keystore: every rmpc write signs with it on every chain; a hardware wallet, HSM or KMS is optional, never required"
        }
        SignerBackendKind::Hsm | SignerBackendKind::Kms => {
            "production-grade signer backend selected"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PreflightReport;
    use alloy_primitives::U256;

    fn sample_report() -> PreflightReport {
        PreflightReport {
            chain_id: 31337,
            block_number: 1,
            gateway_runtime_hash_ok: true,
            gateway_implementation: None,
            vault_implementation: None,
            deposits_paused: false,
            agent_active: true,
            agent_valid_until: 9_999_999_999,
            share_receiver: alloy_primitives::Address::repeat_byte(0xee),
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
        assert!(c.gateway_implementation_match);
        assert!(
            c.gateway_implementation.is_none(),
            "a direct gateway has none"
        );
        assert!(!c.deposits_paused);
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
            ok: false,
            error: None,
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["network_env"], "production_base");
    }
}
