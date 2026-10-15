//! Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (agent consent)
//! Implements: issue #1791 — an rmpc agent consents to a depositor's binding
//!
//! `rmpc agent-consent` — sign the gateway's EIP-712 `AgentConsent` with the
//! agent key and print the 65-byte signature the depositor passes to
//! `RobotMoneyGateway.revealAuthorization(agent, salt, policy, agentConsent)`.
//!
//! Why it exists: since issue #1791 a depositor without `ADMIN_ROLE` binds an
//! agent other than itself only with that agent's signature. rmpc holds the
//! agent key, so rmpc is where the signature comes from; without this command
//! a depositor could not bind an rmpc agent at all.
//!
//! What it does, in order:
//! 1. load the config and parse `--owner` (the depositor that will reveal)
//!    and `--share-receiver` (default: the owner; the gateway requires the
//!    two to be equal for a caller without `ADMIN_ROLE`);
//! 2. print the production warning on Base mainnet, then decrypt the agent
//!    keystore (passphrase from `RMPC_KEYSTORE_PASSPHRASE`; never prompted);
//! 3. read `eth_chainId` (must equal `chain_id`, else `ErrChainIdMismatch`),
//!    then `agentConsentNonce(agent)` and `agentOwner(agent)` at one block;
//! 4. sign `AgentConsent(agent, owner, shareReceiver, nonce)` in the domain
//!    (`RobotMoneyGateway`, `1`, chain id, gateway) and print it.
//!
//! It sends no transaction and takes no nonce lock. The signature authorizes
//! one reveal: the gateway advances `agentConsentNonce(agent)` on use, and a
//! consent for another owner, share receiver, chain or gateway never
//! verifies. When the agent is already bound (`current_owner` is set) the
//! reveal reverts `AgentAlreadyOwned` until that binding is revoked, or
//! released with `releaseAgent` if it was made without consent.
//!
//! Exit codes:
//! - 0 — signature printed.
//! - 2 — refusal (`ErrChainIdMismatch`, `ErrSoftwareSignerDisallowed`).
//! - 3 — startup failure (config, flag parse, keystore, RPC).

use std::path::PathBuf;
use std::str::FromStr;

use alloy_primitives::{hex, Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::errors::RmpcError;
use crate::gateway::RobotMoneyGateway;
use crate::network_env::NetworkEnv;
use crate::output::emit;
use crate::rpc::{CallRequest, FailoverRpcClient};
use crate::signer::consent::encode_rsv;
use crate::signer::software::{SoftwareSigner, PASSPHRASE_ENV_VAR};
use crate::signer::{AgentConsent, AgentSigner};

const EXIT_OK: i32 = 0;
const EXIT_REFUSAL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Args for `rmpc agent-consent`.
#[derive(Debug, Clone)]
pub struct Args {
    /// Path to the operator config TOML.
    pub config_path: PathBuf,
    /// The depositor that will call `revealAuthorization`.
    pub owner: String,
    /// The policy's share receiver. Defaults to `owner`.
    pub share_receiver: Option<String>,
    /// Pretty-print the JSON output.
    pub pretty: bool,
}

/// Successful `rmpc agent-consent` output.
#[derive(Debug, Serialize)]
pub struct AgentConsentOutput {
    /// Always true.
    pub ok: bool,
    /// Always `"agent-consent"`.
    pub action: String,
    /// The agent: the keystore's address, the signer of the consent.
    pub agent: String,
    /// The depositor the consent names (the revealer).
    pub owner: String,
    /// The share receiver the consent names.
    pub share_receiver: String,
    /// `agentConsentNonce(agent)` the consent was signed at (decimal).
    pub nonce: String,
    /// The domain's chain id.
    pub chain_id: u64,
    /// The domain's verifying contract (the configured gateway).
    pub gateway: String,
    /// The block the nonce and owner were read at.
    pub block_number: u64,
    /// `agentOwner(agent)` at that block; `null` when the agent is unbound.
    pub current_owner: Option<String>,
    /// The EIP-712 digest that was signed.
    pub digest: String,
    /// `r ‖ s ‖ v` (65 bytes, 0x-prefixed): the `agentConsent` argument.
    pub signature: String,
}

/// Failed `rmpc agent-consent` output.
#[derive(Debug, Serialize)]
pub struct AgentConsentFailure {
    pub ok: bool,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Run `rmpc agent-consent`. Returns the process exit code.
pub fn run(args: Args) -> i32 {
    let pretty = args.pretty;
    let cfg = match Config::from_path(&args.config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc agent-consent: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let gateway = match parse_address(&cfg.gateway_address, "gateway_address") {
        Ok(a) => a,
        Err(code) => return code,
    };
    let owner = match parse_address(&args.owner, "--owner") {
        Ok(a) => a,
        Err(code) => return code,
    };
    let share_receiver = match args.share_receiver.as_deref() {
        Some(s) => match parse_address(s, "--share-receiver") {
            Ok(a) => a,
            Err(code) => return code,
        },
        None => owner,
    };
    if share_receiver != owner {
        // Not a refusal: an ADMIN_ROLE revealer may name another receiver,
        // but it takes no consent. Any other revealer reverts
        // ShareReceiverNotAuthorized before the consent is read.
        log::warn!(
            "rmpc agent-consent: --share-receiver {share_receiver:#x} differs from --owner \
             {owner:#x}; a reveal by an account without ADMIN_ROLE reverts \
             ShareReceiverNotAuthorized"
        );
    }

    // A software keystore signs on every chain (owner decision 2026-10-14).
    if let Some(warn) = NetworkEnv::from_chain_id(cfg.chain_id).production_warning() {
        log::warn!("rmpc agent-consent: {warn}");
    }
    let signer = match load_signer(&cfg, pretty) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let agent = signer.public_address();

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc agent-consent: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc agent-consent: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    // The domain binds the chain id. A consent signed for the config's chain
    // while the RPC serves another would verify nowhere the operator meant.
    let chain_id = match rt.block_on(rpc.chain_id()) {
        Ok(id) => id,
        Err(e) => {
            log::error!("rmpc agent-consent: eth_chainId failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    if chain_id != cfg.chain_id {
        let err = RmpcError::ErrChainIdMismatch;
        let message = format!(
            "{err} (RPC eth_chainId = {chain_id}, config chain_id = {})",
            cfg.chain_id
        );
        log::error!("rmpc agent-consent: {message}");
        emit(
            &AgentConsentFailure {
                ok: false,
                error: err.name().to_string(),
                message: Some(message),
            },
            pretty,
        );
        return EXIT_REFUSAL;
    }

    let (block_number, nonce, current_owner) =
        match rt.block_on(read_consent_state(&rpc, gateway, agent)) {
            Ok(r) => r,
            Err(e) => {
                log::error!("rmpc agent-consent: gateway read failed: {e}");
                return EXIT_STARTUP_FAIL;
            }
        };
    if current_owner != Address::ZERO {
        log::warn!(
            "rmpc agent-consent: agent {agent:#x} is already bound to {current_owner:#x}; \
             a reveal reverts AgentAlreadyOwned until that binding is revoked or released"
        );
    }

    let consent = AgentConsent {
        owner,
        share_receiver,
        nonce,
        chain_id,
        gateway,
    };
    let signature = match signer.sign_agent_consent(&consent) {
        Ok(s) => s,
        Err(e) => {
            log::error!("rmpc agent-consent: signing failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let digest = consent.digest(agent);
    log::info!(
        "rmpc agent-consent: agent={agent:#x} owner={owner:#x} share_receiver={share_receiver:#x} \
         nonce={nonce} chain_id={chain_id} gateway={gateway:#x} block={block_number}"
    );

    emit(
        &AgentConsentOutput {
            ok: true,
            action: "agent-consent".to_string(),
            agent: format!("{agent:#x}"),
            owner: format!("{owner:#x}"),
            share_receiver: format!("{share_receiver:#x}"),
            nonce: nonce.to_string(),
            chain_id,
            gateway: format!("{gateway:#x}"),
            block_number,
            current_owner: (current_owner != Address::ZERO).then(|| format!("{current_owner:#x}")),
            digest: format!("{digest:#x}"),
            signature: format!("0x{}", hex::encode(encode_rsv(&signature))),
        },
        pretty,
    );
    EXIT_OK
}

/// `agentConsentNonce(agent)` and `agentOwner(agent)`, both at one block.
async fn read_consent_state(
    rpc: &FailoverRpcClient,
    gateway: Address,
    agent: Address,
) -> crate::errors::Result<(u64, U256, Address)> {
    let block_number = rpc.block_number().await?;
    let tag = format!("0x{block_number:x}");

    let out = rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: RobotMoneyGateway::agentConsentNonceCall { _0: agent }
                    .abi_encode()
                    .into(),
            },
            Some(&tag),
        )
        .await?;
    let nonce = RobotMoneyGateway::agentConsentNonceCall::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("agentConsentNonce() decode: {e}")))?
        ._0;

    let out = rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: RobotMoneyGateway::agentOwnerCall { _0: agent }
                    .abi_encode()
                    .into(),
            },
            Some(&tag),
        )
        .await?;
    let owner = RobotMoneyGateway::agentOwnerCall::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("agentOwner() decode: {e}")))?
        ._0;

    Ok((block_number, nonce, owner))
}

fn parse_address(s: &str, flag: &str) -> Result<Address, i32> {
    Address::from_str(s).map_err(|e| {
        log::error!("rmpc agent-consent: {flag} parse error: {e}");
        EXIT_STARTUP_FAIL
    })
}

/// Decrypt the agent keystore with the passphrase from the environment. The
/// command never prompts: it is run by agent runtimes, not at a terminal.
fn load_signer(cfg: &Config, pretty: bool) -> Result<SoftwareSigner, i32> {
    let passphrase = match std::env::var(PASSPHRASE_ENV_VAR) {
        Ok(s) => s,
        Err(_) => {
            log::error!(
                "rmpc agent-consent: ${PASSPHRASE_ENV_VAR} is unset; \
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
            emit(
                &AgentConsentFailure {
                    ok: false,
                    error: "ErrSoftwareSignerDisallowed".to_string(),
                    message: Some(
                        "[signer].allow_software_fallback must be true to use the software keystore"
                            .to_string(),
                    ),
                },
                pretty,
            );
            EXIT_REFUSAL
        } else {
            log::error!("rmpc agent-consent: signer load failed: {e}");
            EXIT_STARTUP_FAIL
        }
    })
}
