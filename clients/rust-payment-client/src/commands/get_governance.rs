//! Canonical: docs/implementation-plan.md §5.1 — Router-weight governance reads
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-governance` — direct on-chain read of the configured
//! `RouterGovernance` contract's observable state.
//!
//! Sub-reads (all `eth_call`, pinned to a single `eth_blockNumber` snapshot):
//!
//! - `RouterGovernance.activeProposal()` → active proposal id, proposed
//!   weight bps vector, vote tallies, and expiry timestamp. When no proposal
//!   is active the contract returns a zero-id sentinel and `active_proposal`
//!   is `null` in the output.
//! - `RouterGovernance.cadenceParams()` → quorum threshold, execution delay,
//!   and minimum cadence between proposals.
//! - `RouterGovernance.currentWeights()` → last applied weight vector (vault
//!   addresses + bps), equivalent to `PortfolioRouter.getWeights()` but
//!   sourced from governance.
//!
//! The config field `governance_address` must be set or the command exits
//! `EXIT_STARTUP_FAIL`. No signer key is required.
//!
//! Exit codes:
//! - 0 — envelope emitted (including `partial: true` envelopes).
//! - 3 — config / RPC connectivity / address-parse failure.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::Address;
use alloy_sol_types::{sol, SolCall};
use serde::Serialize;

use crate::config::Config;
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

// ── RouterGovernance interface (inline bindings — contract not yet deployed) ──
//
// The `RouterGovernance.sol` contract is a future phase item
// (`docs/implementation-plan.md` §5.1). These bindings define the read
// surface the command will call once the contract ships. Until then the
// command is functional — calls against a non-existent address return errors
// captured in the partial envelope.

sol! {
    #[allow(missing_docs)]
    interface IRouterGovernance {
        /// Active proposal descriptor. Returns a zero `id` when no proposal
        /// is pending — callers check `id != bytes32(0)` to decide
        /// whether `active_proposal` should be shown.
        struct ProposalDescriptor {
            bytes32 id;
            address[] vaults;
            uint256[] proposedBps;
            uint256 votesFor;
            uint256 votesAgainst;
            uint64 expiresAt;
        }

        /// Cadence and threshold parameters for governance.
        struct CadenceParams {
            uint256 quorumThreshold;
            uint64 executionDelay;
            uint64 minCadence;
        }

        /// Current weight vector as last applied by governance.
        struct WeightVector {
            address[] vaults;
            uint256[] bps;
        }

        function activeProposal() external view returns (ProposalDescriptor memory);
        function cadenceParams() external view returns (CadenceParams memory);
        function currentWeights() external view returns (WeightVector memory);
    }
}

// ── Output types ─────────────────────────────────────────────────────────────

/// Active proposal state; `null` when no proposal is pending.
#[derive(Debug, Serialize)]
pub struct ActiveProposal {
    /// 32-byte proposal id (0x-prefixed hex).
    pub id: String,
    /// Proposed vault addresses.
    pub vaults: Vec<String>,
    /// Proposed weight bps per vault (decimal strings).
    pub proposed_bps: Vec<DecimalU256>,
    /// Total votes cast in favour (decimal string).
    pub votes_for: DecimalU256,
    /// Total votes cast against (decimal string).
    pub votes_against: DecimalU256,
    /// Unix timestamp when the proposal expires.
    pub expires_at: u64,
}

/// One vault leg in the last-applied weight vector.
#[derive(Debug, Serialize)]
pub struct AppliedWeight {
    /// Vault address (lowercase 0x-hex).
    pub vault: String,
    /// Weight in basis points (decimal string).
    pub weight_bps: DecimalU256,
}

/// Cadence and quorum parameters.
#[derive(Debug, Default, Serialize)]
pub struct GovernanceCadence {
    /// Minimum token-weighted votes required for a proposal to pass
    /// (decimal string).
    pub quorum_threshold: DecimalU256,
    /// Seconds between proposal execution and weight application.
    pub execution_delay_secs: u64,
    /// Minimum seconds between successive proposals.
    pub min_cadence_secs: u64,
}

/// `data` payload for `rmpc get-governance`.
#[derive(Debug, Default, Serialize)]
pub struct GetGovernanceData {
    /// Governance contract address (from operator config).
    pub governance: String,
    /// Active proposal, or `null` when no proposal is pending.
    pub active_proposal: Option<ActiveProposal>,
    /// Cadence and quorum parameters.
    pub cadence: GovernanceCadence,
    /// Last applied weight vector (vault addresses + bps). Empty when
    /// governance has never applied weights.
    pub current_weights: Vec<AppliedWeight>,
}

/// Entry point invoked from `main.rs`. Returns the process exit code.
pub fn run(config_path: &Path, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-governance: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let governance_addr = match cfg.governance_address.as_deref() {
        Some(s) => match Address::from_str(s) {
            Ok(a) => a,
            Err(e) => {
                log::error!("rmpc get-governance: governance_address parse error: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
        None => {
            log::error!(
                "rmpc get-governance: governance_address not set in config; \
                 add `governance_address = \"0x...\"` to the operator TOML"
            );
            return EXIT_STARTUP_FAIL;
        }
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-governance: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-governance: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-governance: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );

    let env = match rt.block_on(read_governance(&rpc, governance_addr)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-governance: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

/// Drive the governance sub-reads against a pinned block. Pre-read setup
/// failures (chain id, block number) propagate as `Err`; per-field
/// sub-read failures are captured via `record_err` on the builder.
async fn read_governance(
    rpc: &RpcClient,
    governance: Address,
) -> crate::errors::Result<Envelope<GetGovernanceData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let data = GetGovernanceData {
        governance: format!("{governance:#x}"),
        ..Default::default()
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    // activeProposal()
    match call_active_proposal(rpc, governance, &block_tag).await {
        Ok(proposal) => {
            b.data_mut().active_proposal = proposal;
        }
        Err(e) => b.record_err("active_proposal", e.to_string()),
    }

    // cadenceParams()
    match call_cadence_params(rpc, governance, &block_tag).await {
        Ok(cadence) => {
            b.data_mut().cadence = cadence;
        }
        Err(e) => b.record_err("cadence", e.to_string()),
    }

    // currentWeights()
    match call_current_weights(rpc, governance, &block_tag).await {
        Ok(weights) => {
            b.data_mut().current_weights = weights;
        }
        Err(e) => b.record_err("current_weights", e.to_string()),
    }

    Ok(b.finish())
}

// ── typed view helpers ────────────────────────────────────────────────────────

/// Call `RouterGovernance.activeProposal()`. Returns `None` when the contract
/// signals no active proposal (id is zero bytes32).
async fn call_active_proposal(
    rpc: &RpcClient,
    governance: Address,
    block_tag: &str,
) -> crate::errors::Result<Option<ActiveProposal>> {
    let data = IRouterGovernance::activeProposalCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: governance,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = IRouterGovernance::activeProposalCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("activeProposal abi decode: {e}"))
    })?;
    let desc = r._0;

    // Zero id signals "no active proposal".
    if desc.id == alloy_primitives::B256::ZERO {
        return Ok(None);
    }

    let proposed_bps = desc.proposedBps.iter().map(|&b| DecimalU256(b)).collect();
    let vaults = desc.vaults.iter().map(|a| format!("{a:#x}")).collect();

    Ok(Some(ActiveProposal {
        id: format!("0x{}", hex::encode(desc.id.as_slice())),
        vaults,
        proposed_bps,
        votes_for: DecimalU256(desc.votesFor),
        votes_against: DecimalU256(desc.votesAgainst),
        expires_at: desc.expiresAt,
    }))
}

/// Call `RouterGovernance.cadenceParams()` and return decoded `GovernanceCadence`.
async fn call_cadence_params(
    rpc: &RpcClient,
    governance: Address,
    block_tag: &str,
) -> crate::errors::Result<GovernanceCadence> {
    let data = IRouterGovernance::cadenceParamsCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: governance,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = IRouterGovernance::cadenceParamsCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("cadenceParams abi decode: {e}"))
    })?;
    Ok(GovernanceCadence {
        quorum_threshold: DecimalU256(r._0.quorumThreshold),
        execution_delay_secs: r._0.executionDelay,
        min_cadence_secs: r._0.minCadence,
    })
}

/// Call `RouterGovernance.currentWeights()` and return decoded weight vector.
async fn call_current_weights(
    rpc: &RpcClient,
    governance: Address,
    block_tag: &str,
) -> crate::errors::Result<Vec<AppliedWeight>> {
    let data = IRouterGovernance::currentWeightsCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: governance,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = IRouterGovernance::currentWeightsCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("currentWeights abi decode: {e}"))
    })?;
    let weights =
        r._0.vaults
            .into_iter()
            .zip(r._0.bps)
            .map(|(vault, bps)| AppliedWeight {
                vault: format!("{vault:#x}"),
                weight_bps: DecimalU256(bps),
            })
            .collect();
    Ok(weights)
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-governance output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;
    use serde_json::Value;

    #[test]
    fn get_governance_data_defaults_serialise() {
        let data = GetGovernanceData {
            governance: "0x0000000000000000000000000000000000000001".to_string(),
            active_proposal: None,
            cadence: GovernanceCadence::default(),
            current_weights: vec![],
        };
        let v: Value = serde_json::to_value(&data).unwrap();
        assert!(v["active_proposal"].is_null());
        assert!(v["current_weights"].as_array().unwrap().is_empty());
        assert_eq!(v["cadence"]["quorum_threshold"].as_str().unwrap(), "0");
        assert_eq!(v["cadence"]["execution_delay_secs"], 0u64);
        assert_eq!(v["cadence"]["min_cadence_secs"], 0u64);
    }

    #[test]
    fn active_proposal_bps_are_decimal_strings() {
        let proposal = ActiveProposal {
            id: "0x0101010101010101010101010101010101010101010101010101010101010101".to_string(),
            vaults: vec!["0x0000000000000000000000000000000000000001".to_string()],
            proposed_bps: vec![DecimalU256(U256::from(10_000u64))],
            votes_for: DecimalU256(U256::from(1_000u64)),
            votes_against: DecimalU256(U256::ZERO),
            expires_at: 1_800_000_000,
        };
        let v: Value = serde_json::to_value(&proposal).unwrap();
        assert!(v["proposed_bps"][0].is_string());
        assert_eq!(v["proposed_bps"][0].as_str().unwrap(), "10000");
        assert_eq!(v["votes_for"].as_str().unwrap(), "1000");
        assert_eq!(v["votes_against"].as_str().unwrap(), "0");
    }

    #[test]
    fn applied_weight_bps_is_decimal_string() {
        let w = AppliedWeight {
            vault: "0x0000000000000000000000000000000000000001".to_string(),
            weight_bps: DecimalU256(U256::from(4000u64)),
        };
        let v: Value = serde_json::to_value(&w).unwrap();
        assert!(v["weight_bps"].is_string());
        assert_eq!(v["weight_bps"].as_str().unwrap(), "4000");
    }

    /// When governance_address is absent from config, run() must return
    /// EXIT_STARTUP_FAIL without touching the network.
    #[test]
    fn run_fails_fast_without_governance_address() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let keystore = tmp.path().join("keystore.json");
        let cfg_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = 31337
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "0x000000000000000000000000000000000000dEaD"
usdc_address          = "0x{usdc}"
vault_address         = "0x{vault}"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            usdc = "00".repeat(20),
            vault = "00".repeat(20),
            zeros = "0".repeat(64),
            ks = keystore.display(),
        );
        std::fs::write(&cfg_path, &toml).expect("write rmpc.toml");
        let code = run(&cfg_path, false);
        assert_eq!(code, EXIT_STARTUP_FAIL);
    }
}
