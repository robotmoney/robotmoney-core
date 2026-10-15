//! Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3
//! Implements: issue #1044 — Investment Committee v0
//!
//! `rmpc committee` — submit a signed allocation vote through
//! `RobotMoneyGateway.committeeVoteSubmit`, which forwards it to the
//! `InvestmentCommitteePolicy` contract.
//!
//! Subcommands:
//! - `vote-submit` — submit a signed allocation vote. The caller needs
//!   `AGENT_ROLE` on the gateway and `COMMITTEE_AGENT_ROLE` on the IC policy.
//! - `check-agent` — read-only preflight for `vote-submit`: reads
//!   `hasRole(COMMITTEE_AGENT_ROLE(), agent)` on the IC policy. The swarm
//!   skill's `plugins/robotmoney-swarm/scripts/check-preflight.sh` runs it
//!   before the write (review finding DR-1: the guard it replaces called a
//!   `--dry-run` flag that never existed and grepped an error name rmpc never
//!   prints, so it passed for every agent).
//!
//! rmpc is not a governance signer. Registering a committee agent
//! (`gateway.committeeRegister`) is an `onlyRole(ADMIN_ROLE)` call, and
//! ADMIN_ROLE belongs to the Safe and timelock after handover, so rmpc has no
//! `register` command. Register agents through the Safe and the timelock's
//! schedule → delay → execute path, as described in
//! `docs/technical/consensus-receipt-submitter-runbook.md` §3.
//!
//! `vote-submit` encodes `committeeVoteSubmit(VoteParams)` against the gateway
//! ABI and sends it to `cfg.gateway_address`. It never calls the policy
//! directly: the policy's `submitVote` is `onlyGateway` and reverts with
//! `CallerNotGateway` for any other sender (issue #1511). The transaction
//! sender is the allowlisted committee agent; the agent role is an operating
//! role, not a governance role. `ic_policy_address` is still required so the
//! command fails closed before signing when the committee is not configured.
//!
//! Before it signs, `vote-submit` verifies the gateway proxy code and its
//! live implementation at one pinned block (issue 1810,
//! `policy::implementation::verify_gateway_code_now`): the gateway's code
//! hashes to `gateway_runtime_hash`, and a proxied gateway runs the approved
//! `gateway_implementation` with code hash
//! `gateway_implementation_runtime_hash`. A mismatch or a failed read exits 2;
//! neither signs.
//!
//! Exit codes:
//! - 0 — success (`check-agent`: the agent holds `COMMITTEE_AGENT_ROLE`).
//! - 2 — refusal (unauthorized, non-allowlisted agent, bad input;
//!   `check-agent`: `ErrNotAllowlisted`, the read succeeded and says no).
//! - 3 — startup failure (missing config, keystore, RPC, etc.;
//!   `check-agent`: the role could not be read, so the answer is unknown).

use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::errors::RmpcError;
use crate::fees::{compute_fees, FeeBid};
use crate::gateway::{GatewayVoteParams, InvestmentCommitteePolicy, RobotMoneyGateway};
use crate::network_env::NetworkEnv;
use crate::nonce::AgentLock;
use crate::output::emit;
use crate::policy::implementation::{check_executed_under, verify_gateway_code_now};
use crate::rpc::{CallRequest, FailoverRpcClient};
use crate::signer::software::{Keystore, SoftwareSigner, PASSPHRASE_ENV_VAR};
use crate::signer::AgentSigner;
use crate::tx::{
    broadcast, build_eip1559, encode_signed, signing_hash, wait_for_successful_receipt,
    Eip1559Inputs,
};

const EXIT_OK: i32 = 0;
const EXIT_REFUSAL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Allocation stance supplied by the caller.
/// ABI encoding: Overweight=0, Neutral=1, Underweight=2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stance {
    Overweight,
    Neutral,
    Underweight,
}

impl Stance {
    /// Parse from a string; case-insensitive.
    pub fn from_str_ci(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "overweight" => Some(Stance::Overweight),
            "neutral" => Some(Stance::Neutral),
            "underweight" => Some(Stance::Underweight),
            _ => None,
        }
    }

    /// Wire string for JSON output.
    pub fn as_str(self) -> &'static str {
        match self {
            Stance::Overweight => "overweight",
            Stance::Neutral => "neutral",
            Stance::Underweight => "underweight",
        }
    }

    /// ABI-encoded u8: Overweight=0, Neutral=1, Underweight=2.
    pub fn to_abi_u8(self) -> u8 {
        match self {
            Stance::Overweight => 0,
            Stance::Neutral => 1,
            Stance::Underweight => 2,
        }
    }
}

// ─── Args ────────────────────────────────────────────────────────────────────

/// Args for `rmpc committee vote-submit`.
#[derive(Debug, Clone)]
pub struct VoteSubmitArgs {
    pub config_path: PathBuf,
    pub vault: String,
    pub stance: Stance,
    pub target_weight_bps: u16,
    pub confidence: u8,
    pub rationale_uri: String,
    pub vote_json_hash: String,
    pub prompt_hash: String,
    pub inputs_digest: String,
    pub schema_version: String,
    pub timestamp: u64,
    pub order_id: String,
    pub deadline_secs: u64,
    pub receipt_timeout_secs: u64,
    pub gas_limit: u64,
    pub fee_cap_wei: Option<u64>,
    pub pretty: bool,
}

/// Args for `rmpc committee check-agent`.
#[derive(Debug, Clone)]
pub struct CheckAgentArgs {
    pub config_path: PathBuf,
    /// Address to check. `None` reads the cleartext `address` field of the
    /// configured keystore, the address `vote-submit` signs as.
    pub agent: Option<String>,
    pub pretty: bool,
}

// ─── Output types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CommitteeOutput {
    pub ok: bool,
    pub action: String,
    pub tx_hash: String,
    pub block_number: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vote_id: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CommitteeFailure {
    pub ok: bool,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The broadcast transaction, present on every refusal raised AFTER the
    /// envelope reached the chain. An operator handed `ErrTxReverted` with no
    /// hash cannot tell which transaction to inspect, and these two commands
    /// are role-gated: a revert is the expected shape of "you are not an
    /// allowlisted committee agent", not a rare fault.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
}

/// `rmpc committee check-agent` result: one role read, pinned to one block.
/// Printed for both answers. `ok` and `has_role` agree; a "no" also carries
/// `error: "ErrNotAllowlisted"` so a caller can match the same name
/// `vote-submit` refuses with. A read that could not run prints a
/// [`CommitteeFailure`] instead, never this shape with `has_role: false`.
#[derive(Debug, Serialize)]
pub struct CheckAgentOutput {
    pub ok: bool,
    pub action: String,
    pub agent: String,
    pub ic_policy: String,
    /// `COMMITTEE_AGENT_ROLE()` as the deployed policy returns it.
    pub committee_agent_role: String,
    pub has_role: bool,
    pub chain_id: u64,
    pub block_number: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// ─── Public entry points ─────────────────────────────────────────────────────

/// Run `rmpc committee vote-submit`. Returns the process exit code.
pub fn run_vote_submit(args: VoteSubmitArgs) -> i32 {
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc committee vote-submit: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // Fail closed before signing when the committee is not configured.
    let ic_addr = match resolve_ic_address(&cfg, "vote-submit", args.pretty) {
        Ok(a) => a,
        Err(code) => return code,
    };
    // The vote goes to the GATEWAY (issue #1511): the policy is onlyGateway.
    let gateway_addr = match parse_address(
        &cfg.gateway_address,
        "rmpc committee vote-submit",
        "gateway_address",
    ) {
        Ok(a) => a,
        Err(code) => return code,
    };

    let vault_addr = match parse_address(&args.vault, "rmpc committee vote-submit", "--vault") {
        Ok(a) => a,
        Err(code) => return code,
    };

    let vote_json_hash = match parse_b256(&args.vote_json_hash, "--vote-json-hash") {
        Ok(h) => h,
        Err(code) => return code,
    };
    let prompt_hash = match parse_b256(&args.prompt_hash, "--prompt-hash") {
        Ok(h) => h,
        Err(code) => return code,
    };
    let inputs_digest = match parse_b256(&args.inputs_digest, "--inputs-digest") {
        Ok(h) => h,
        Err(code) => return code,
    };

    // A software keystore signs on every chain, Base mainnet included; a
    // hardware wallet, HSM or KMS is optional, never required (owner decision
    // 2026-10-14, QA plan Decision D12). Base mainnet only adds the warning,
    // as for the depositor writes (`write_path::open_session`).
    if let Some(warn) = NetworkEnv::from_chain_id(cfg.chain_id).production_warning() {
        log::warn!("rmpc committee vote-submit: {warn}");
    }

    let signer = match load_signer(&cfg, "vote-submit", args.pretty) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let caller = signer.public_address();

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc committee vote-submit: caller={caller:#x} gateway={gateway_addr:#x} ic={ic_addr:#x} vault={vault_addr:#x} stance={} chain_id={} env={}",
        args.stance.as_str(),
        cfg.chain_id,
        network_env.as_str()
    );

    let state_dir = match cfg.resolve_state_dir() {
        Ok(p) => p,
        Err(e) => {
            log::error!("rmpc committee vote-submit: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let _lock = match AgentLock::acquire(&state_dir, &caller) {
        Ok(l) => l,
        Err(RmpcError::ErrConcurrentInvocation) => {
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: "ErrConcurrentInvocation".to_string(),
                    message: Some(format!(
                        "another rmpc invocation already holds the lock for {caller:#x}"
                    )),
                    tx_hash: None,
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
        Err(e) => {
            log::error!("rmpc committee vote-submit: lock acquire failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rt = match build_rt("vote-submit") {
        Ok(rt) => rt,
        Err(code) => return code,
    };
    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc committee vote-submit: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // The gateway proxy and its live implementation must be the approved
    // ones before anything is signed (issue 1810).
    let gateway_implementation = match rt.block_on(verify_gateway_code_now(&rpc, &cfg)) {
        Ok(i) => i,
        Err(e) => {
            log::error!("rmpc committee vote-submit: {e}");
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: e.name().to_string(),
                    message: Some(format!("{e}")),
                    tx_hash: None,
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };

    let fees = match fetch_fees(
        &rt,
        &rpc,
        &cfg,
        args.fee_cap_wei,
        args.pretty,
        "vote-submit",
    ) {
        Ok(f) => f,
        Err(code) => return code,
    };

    let nonce =
        match rt.block_on(async { rpc.get_transaction_count(caller, Some("pending")).await }) {
            Ok(n) => n,
            Err(e) => {
                log::error!("rmpc committee vote-submit: eth_getTransactionCount failed: {e}");
                return EXIT_STARTUP_FAIL;
            }
        };

    // Build VoteParams struct. The `stance` field is ABI-encoded as uint8.
    let params = GatewayVoteParams {
        agent: caller,
        vault: vault_addr,
        stance: args.stance.to_abi_u8(),
        targetWeightBps: args.target_weight_bps,
        confidence: args.confidence,
        rationaleUri: args.rationale_uri.clone(),
        voteJsonHash: vote_json_hash,
        promptHash: prompt_hash,
        inputsDigest: inputs_digest,
        schemaVersion: args.schema_version.clone(),
        timestamp: args.timestamp,
    };

    let calldata = RobotMoneyGateway::committeeVoteSubmitCall { p: params }.abi_encode();

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
            log::error!("rmpc committee vote-submit: envelope signing failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let raw = encode_signed(tx, alloy_sig);

    let tx_hash = match rt.block_on(async { broadcast(&rpc, &raw).await }) {
        Ok(h) => h,
        Err(e) => {
            log::error!("rmpc committee vote-submit: broadcast failed: {e}");
            // When the RPC node simulates the tx and finds the agent is not on
            // the allowlist, it returns `execution reverted` (with or without
            // the ABI-encoded AgentNotAllowlisted selector). Surface this as
            // the named ErrNotAllowlisted variant so callers can match on it.
            let err_str = format!("{e}");
            let (error_name, message) = if err_str.contains("revert") {
                (
                    "ErrNotAllowlisted",
                    Some(format!(
                    "transaction reverted — caller is not an allowlisted committee agent: {err_str}"
                )),
                )
            } else {
                ("ErrBroadcastFailed", Some(err_str))
            };
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: error_name.to_string(),
                    message,
                    tx_hash: None,
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };

    let max_attempts = args.receipt_timeout_secs.min(u32::MAX as u64) as u32;
    // T23 / R9: THE TWO WRITE PATHS THAT HAD NO STATUS CHECK AT ALL. §E.4
    // recorded this file as the symptom — `register` and `vote-submit` both
    // printed `{"ok":true, tx_hash, block_number}` and exited 0 for a
    // transaction the node mined and the EVM reverted, which is precisely what
    // an agent without `COMMITTEE_AGENT_ROLE` produces. Both now go through the
    // shared write seam, so the refusal is `ErrTxReverted` with the tx_hash an
    // operator has to inspect, and a genuine receipt-poll timeout keeps its own
    // `ErrReceiptTimeout` code: they are different facts and the agent-visible
    // contract distinguishes them.
    let receipt = match rt.block_on(async {
        wait_for_successful_receipt(&rpc, tx_hash, Duration::from_secs(1), max_attempts.max(1))
            .await
    }) {
        Ok(r) => r,
        Err(err @ RmpcError::ErrTxReverted { .. }) => {
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: err.name().to_string(),
                    message: Some(format!("{err}")),
                    tx_hash: Some(format!("{tx_hash:#x}")),
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
        Err(e) => {
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: "ErrReceiptTimeout".to_string(),
                    message: Some(format!("{e}")),
                    tx_hash: Some(format!("{tx_hash:#x}")),
                },
                args.pretty,
            );
            return EXIT_REFUSAL;
        }
    };

    // The vote is a success only if it executed under the implementation it
    // was signed against (issue 1810).
    if let Err(e) = rt.block_on(check_executed_under(
        &rpc,
        gateway_addr,
        gateway_implementation,
        receipt.block_number,
        &format!("{tx_hash:#x}"),
    )) {
        log::error!("rmpc committee vote-submit: {e}");
        emit_failure(
            &CommitteeFailure {
                ok: false,
                error: e.name().to_string(),
                message: Some(format!("{e}")),
                tx_hash: Some(format!("{tx_hash:#x}")),
            },
            args.pretty,
        );
        return EXIT_REFUSAL;
    }

    let block_number = receipt.block_number.unwrap_or(0);
    log::info!("rmpc committee vote-submit: ok tx_hash={tx_hash:#x} block={block_number}");
    emit_output(
        &CommitteeOutput {
            ok: true,
            action: "vote-submit".to_string(),
            tx_hash: format!("{tx_hash:#x}"),
            block_number,
            vote_id: None, // populated by event parsing in a future issue
        },
        args.pretty,
    );
    EXIT_OK
}

/// Run `rmpc committee check-agent`. Returns the process exit code.
///
/// Answers the one question `vote-submit` cannot answer before it signs: will
/// `InvestmentCommitteePolicy.submitVote` refuse this agent with
/// `AgentNotAllowlisted`? It reads `COMMITTEE_AGENT_ROLE()` off the deployed
/// policy (never a baked-in hash) and `hasRole(role, agent)`, both at the same
/// block, after checking the RPC serves the configured `chain_id`.
///
/// Every outcome prints JSON on stdout, because this command's caller is a
/// script and rmpc's error log is file-only: 0 with `has_role: true`; 2 with
/// `has_role: false` and `error: "ErrNotAllowlisted"`; 3 with a
/// [`CommitteeFailure`] naming why the read did not run. The 3 path exists so
/// an unreachable RPC can never read as "registered".
pub fn run_check_agent(args: CheckAgentArgs) -> i32 {
    let pretty = args.pretty;
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc committee check-agent: failed to load config: {e}");
            return check_agent_unknown(e.name(), format!("{e}"), pretty);
        }
    };

    let ic_addr = match resolve_ic_address(&cfg, "check-agent", pretty) {
        Ok(a) => a,
        Err(code) => return code,
    };

    let agent = match resolve_check_agent_address(&cfg, args.agent.as_deref()) {
        Ok(a) => a,
        Err((error, message)) => {
            log::error!("rmpc committee check-agent: {message}");
            return check_agent_unknown(error, message, pretty);
        }
    };

    let rt = match build_rt("check-agent") {
        Ok(rt) => rt,
        Err(code) => return code,
    };
    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc committee check-agent: rpc client init failed: {e}");
            return check_agent_unknown(e.name(), format!("{e}"), pretty);
        }
    };

    // A role read against the wrong chain answers a different question.
    let chain_id = match rt.block_on(async { rpc.chain_id().await }) {
        Ok(id) => id,
        Err(e) => {
            log::error!("rmpc committee check-agent: eth_chainId failed: {e}");
            return check_agent_unknown(e.name(), format!("{e}"), pretty);
        }
    };
    if chain_id != cfg.chain_id {
        let err = RmpcError::ErrChainIdMismatch;
        let message = format!(
            "{err} (RPC eth_chainId = {chain_id}, config chain_id = {})",
            cfg.chain_id
        );
        log::error!("rmpc committee check-agent: {message}");
        return check_agent_unknown(err.name(), message, pretty);
    }

    let read = rt.block_on(async { read_committee_agent_role(&rpc, ic_addr, agent).await });
    let (block_number, role, has_role) = match read {
        Ok(r) => r,
        Err(e) => {
            log::error!("rmpc committee check-agent: role read failed: {e}");
            return check_agent_unknown(e.name(), format!("{e}"), pretty);
        }
    };

    log::info!(
        "rmpc committee check-agent: agent={agent:#x} ic={ic_addr:#x} block={block_number} has_role={has_role}"
    );
    let (error, message) = if has_role {
        (None, None)
    } else {
        (
            Some(RmpcError::ErrNotAllowlisted.name().to_string()),
            Some(format!(
                "{agent:#x} does not hold COMMITTEE_AGENT_ROLE on the IC policy {ic_addr:#x} at \
                 block {block_number}; vote-submit from it would revert with AgentNotAllowlisted. \
                 Registration is a Safe action (gateway.committeeRegister through the timelock), \
                 not an rmpc command"
            )),
        )
    };
    emit(
        &CheckAgentOutput {
            ok: has_role,
            action: "check-agent".to_string(),
            agent: format!("{agent:#x}"),
            ic_policy: format!("{ic_addr:#x}"),
            committee_agent_role: format!("{role:#x}"),
            has_role,
            chain_id,
            block_number,
            error,
            message,
        },
        pretty,
    );
    if has_role {
        EXIT_OK
    } else {
        EXIT_REFUSAL
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Print a `check-agent` failure whose answer is unknown and return
/// `EXIT_STARTUP_FAIL`. `error` is a variant name rmpc already defines.
fn check_agent_unknown(error: &str, message: String, pretty: bool) -> i32 {
    emit_failure(
        &CommitteeFailure {
            ok: false,
            error: error.to_string(),
            message: Some(message),
            tx_hash: None,
        },
        pretty,
    );
    EXIT_STARTUP_FAIL
}

/// The address `check-agent` reads. `--agent` wins; otherwise the cleartext
/// `address` field of `[signer].keystore_path`. That field is the one
/// `SoftwareSigner` checks the decrypted key against before `vote-submit`
/// signs, so it names the sender without asking for the passphrase.
///
/// Errors carry the variant name to print: `ErrConfig` for a bad `--agent`,
/// the signer's `ErrKeystoreIo` / `ErrKeystoreFormat` for the keystore.
fn resolve_check_agent_address(
    cfg: &Config,
    flag: Option<&str>,
) -> Result<Address, (&'static str, String)> {
    if let Some(s) = flag {
        return Address::from_str(s)
            .map_err(|e| ("ErrConfig", format!("--agent is not an address: {e}")));
    }
    let path = &cfg.signer.keystore_path;
    let raw = std::fs::read(path).map_err(|e| {
        (
            "ErrKeystoreIo",
            format!(
                "cannot read [signer].keystore_path {} for the agent address: {e}; \
                 pass --agent to name it",
                path.display()
            ),
        )
    })?;
    let keystore: Keystore = serde_json::from_slice(&raw).map_err(|e| {
        (
            "ErrKeystoreFormat",
            format!("{} is not an rmpc keystore: {e}", path.display()),
        )
    })?;
    Address::from_str(&keystore.address).map_err(|e| {
        (
            "ErrKeystoreFormat",
            format!(
                "{} has an `address` field that is not an address: {e}",
                path.display()
            ),
        )
    })
}

/// `COMMITTEE_AGENT_ROLE()` then `hasRole(role, agent)` on the IC policy, both
/// at the same block. Returns `(block_number, role, has_role)`.
async fn read_committee_agent_role(
    rpc: &FailoverRpcClient,
    ic_policy: Address,
    agent: Address,
) -> crate::errors::Result<(u64, B256, bool)> {
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let role_out = rpc
        .eth_call(
            &CallRequest {
                to: ic_policy,
                from: None,
                data: InvestmentCommitteePolicy::COMMITTEE_AGENT_ROLECall {}
                    .abi_encode()
                    .into(),
            },
            Some(&block_tag),
        )
        .await?;
    let role =
        InvestmentCommitteePolicy::COMMITTEE_AGENT_ROLECall::abi_decode_returns(&role_out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("COMMITTEE_AGENT_ROLE() return: {e}")))?
            ._0;

    let has_out = rpc
        .eth_call(
            &CallRequest {
                to: ic_policy,
                from: None,
                data: InvestmentCommitteePolicy::hasRoleCall {
                    role,
                    account: agent,
                }
                .abi_encode()
                .into(),
            },
            Some(&block_tag),
        )
        .await?;
    let has_role = InvestmentCommitteePolicy::hasRoleCall::abi_decode_returns(&has_out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("hasRole() return: {e}")))?
        ._0;

    Ok((block_number, role, has_role))
}

fn resolve_ic_address(cfg: &Config, subcommand: &str, pretty: bool) -> Result<Address, i32> {
    match cfg.ic_policy_address.as_deref() {
        Some(s) => Address::from_str(s).map_err(|e| {
            log::error!("rmpc committee {subcommand}: ic_policy_address parse error: {e}");
            EXIT_STARTUP_FAIL
        }),
        None => {
            log::error!(
                "rmpc committee {subcommand}: ic_policy_address not set in config; \
                 add `ic_policy_address = \"0x...\"` to the operator TOML"
            );
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: "ErrIcContractNotConfigured".to_string(),
                    message: Some(
                        "ic_policy_address is not set in the operator config; \
                         add `ic_policy_address = \"0x...\"` to the TOML"
                            .to_string(),
                    ),
                    tx_hash: None,
                },
                pretty,
            );
            Err(EXIT_STARTUP_FAIL)
        }
    }
}

fn parse_address(s: &str, cmd: &str, flag: &str) -> Result<Address, i32> {
    Address::from_str(s).map_err(|e| {
        log::error!("{cmd}: {flag} parse error: {e}");
        EXIT_STARTUP_FAIL
    })
}

fn parse_b256(s: &str, flag: &str) -> Result<B256, i32> {
    // Strip 0x prefix if present.
    let hex = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(hex).map_err(|e| {
        log::error!("rmpc committee: {flag} hex decode error: {e}");
        EXIT_STARTUP_FAIL
    })?;
    if bytes.len() != 32 {
        log::error!(
            "rmpc committee: {flag} must be exactly 32 bytes (64 hex chars), got {}",
            bytes.len()
        );
        return Err(EXIT_STARTUP_FAIL);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(B256::from(arr))
}

fn load_signer(cfg: &Config, subcommand: &str, pretty: bool) -> Result<SoftwareSigner, i32> {
    let passphrase = match std::env::var(PASSPHRASE_ENV_VAR) {
        Ok(s) => s,
        Err(_) => {
            log::error!(
                "rmpc committee {subcommand}: ${PASSPHRASE_ENV_VAR} is unset; \
                 refusing to prompt on stdin from a non-interactive command"
            );
            return Err(EXIT_STARTUP_FAIL);
        }
    };
    SoftwareSigner::load_with_passphrase(
        &cfg.signer.keystore_path,
        passphrase.as_bytes(),
        cfg.signer.allow_software_fallback,
    )
    .map_err(|e| {
        use crate::signer::SignerError;
        if let SignerError::ErrSoftwareSignerDisallowed = e {
            emit_failure(
                &CommitteeFailure {
                    ok: false,
                    error: "ErrSoftwareSignerDisallowed".to_string(),
                    message: Some(
                        "[signer].allow_software_fallback must be true to use the software keystore"
                            .to_string(),
                    ),
                    tx_hash: None,
                },
                pretty,
            );
            EXIT_REFUSAL
        } else {
            log::error!("rmpc committee {subcommand}: signer load failed: {e}");
            EXIT_STARTUP_FAIL
        }
    })
}

fn build_rt(subcommand: &str) -> Result<tokio::runtime::Runtime, i32> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| {
            log::error!("rmpc committee {subcommand}: tokio runtime build failed: {e}");
            EXIT_STARTUP_FAIL
        })
}

fn fetch_fees(
    rt: &tokio::runtime::Runtime,
    rpc: &FailoverRpcClient,
    cfg: &Config,
    fee_cap_wei: Option<u64>,
    pretty: bool,
    subcommand: &str,
) -> Result<FeeBid, i32> {
    let fh = rt
        .block_on(async { rpc.fee_history(5, "latest", &[50.0]).await })
        .map_err(|e| {
            log::error!("rmpc committee {subcommand}: eth_feeHistory failed: {e}");
            EXIT_STARTUP_FAIL
        })?;

    compute_fees(
        &fh,
        cfg.effective_max_fee_per_gas_cap(fee_cap_wei) as u128,
        cfg.max_priority_fee_per_gas_cap
            .map_or(u128::MAX, |v| v as u128),
    )
    .map_err(|e| {
        emit_failure(
            &CommitteeFailure {
                ok: false,
                error: e.name().to_string(),
                message: Some(format!("{e}")),
                tx_hash: None,
            },
            pretty,
        );
        EXIT_REFUSAL
    })
}

fn emit_output(out: &CommitteeOutput, pretty: bool) {
    emit(out, pretty);
}

fn emit_failure(out: &CommitteeFailure, pretty: bool) {
    emit(out, pretty);
}
