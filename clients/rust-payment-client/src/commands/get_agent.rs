//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//! Security: docs/code-reviews/review-codex-20260518-234945.md §5 (agent-key compromise blast radius)
//!
//! `rmpc get-agent --agent 0x…` — direct on-chain read of an agent's
//! authorization record on the gateway, plus the current window's
//! deposit usage.
//!
//! Sub-reads (all `eth_call`, pinned to one block):
//!
//! - `agents(address)` → `(active, validUntil, maxPerPayment,
//!   maxPerWindow, shareReceiver, assetRecipient, maxWithdrawPerPayment,
//!   maxWithdrawPerWindow)` — the canonical authorization tuple. The
//!   withdrawal fields surface the agent-compromise blast radius
//!   identified in finding #5 of the 2026-05-18 coin-theft review.
//! - `eth_getBlockByNumber(blockNumber).timestamp` → used to compute
//!   `window_id = timestamp / WINDOW_SECONDS`, so the answer is
//!   reproducible against the pinned block (not the daemon's wall
//!   clock — see ADR §3.4).
//! - `agentWindowGross(agent, windowId)` → cumulative deposit value the
//!   agent has put through the current window.
//! - `vault.allowance(agent, gateway)` → outstanding share allowance the
//!   agent has granted the gateway. Together with the policy withdrawal
//!   caps, this defines the maximum value an attacker who compromises
//!   the agent key can steal via `withdraw()` (issue #429).
//!
//! Output is the §9 envelope with `data: AgentData`. `maxPerPayment`,
//! `maxPerWindow`, `max_withdraw_per_payment`, `max_withdraw_per_window`,
//! `share_allowance`, and `window_gross` are `DecimalU256` so they
//! serialize as JSON strings.
//!
//! Exit codes: 0 (envelope, possibly partial), 3 (pre-read setup fail).

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::{Erc20, RobotMoneyGateway};
use crate::network_env::NetworkEnv;
use crate::policy::WINDOW_SECONDS;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// `data` payload for `rmpc get-agent`. Field order matches the
/// operator-visible JSON; downstream snapshot tests assert on it.
#[derive(Debug, Default, Serialize)]
pub struct AgentData {
    /// Target agent address (lowercase 0x-hex).
    pub agent: String,
    /// `agents(agent).active` — false for unauthorized / revoked.
    pub active: bool,
    /// `agents(agent).validUntil` (unix seconds). `0` when the slot is
    /// unset; the contract treats `now > validUntil` as expired.
    pub valid_until: u64,
    /// `agents(agent).maxPerPayment` — `uint256` decimal string.
    pub max_per_payment: DecimalU256,
    /// `agents(agent).maxPerWindow` — `uint256` decimal string.
    pub max_per_window: DecimalU256,
    /// `agents(agent).shareReceiver` — lowercase 0x-hex.
    pub share_receiver: String,
    /// `agents(agent).assetRecipient` — lowercase 0x-hex. The USDC
    /// recipient when the agent calls `withdraw()`. Zero address
    /// signals withdrawals are disabled (issue #429).
    pub asset_recipient: String,
    /// `agents(agent).maxWithdrawPerPayment` — `uint256` decimal string.
    /// A non-zero value means the policy allows agent-initiated
    /// withdrawals; this is the per-call share cap.
    pub max_withdraw_per_payment: DecimalU256,
    /// `agents(agent).maxWithdrawPerWindow` — `uint256` decimal string.
    /// Per-window share cap; sets the agent-compromise blast radius
    /// for the current window.
    pub max_withdraw_per_window: DecimalU256,
    /// Derived: `maxWithdrawPerPayment > 0`. Operators MUST treat
    /// `true` as a security-relevant signal — an agent-key compromise
    /// can redeem shares up to the per-window cap while this is set.
    pub withdrawals_enabled: bool,
    /// `vault.allowance(agent, gateway)` — outstanding share allowance
    /// the agent has granted the gateway. Combined with
    /// `max_withdraw_per_payment`/`max_withdraw_per_window` this is
    /// the bound on what a compromised agent can withdraw without
    /// further on-chain action by the depositor (issue #429).
    pub share_allowance: DecimalU256,
    /// Window id at the pinned block: `block_timestamp / WINDOW_SECONDS`.
    pub window_id: u64,
    /// `agentWindowGross(agent, window_id)` — `uint256` decimal string.
    pub window_gross: DecimalU256,
}

pub fn run(config_path: &Path, agent_hex: &str, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-agent: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let agent = match Address::from_str(agent_hex) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-agent: --agent parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-agent: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let vault_addr = match Address::from_str(&cfg.vault_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-agent: vault_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-agent: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-agent: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-agent: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );
    let env = match rt.block_on(read_agent(&rpc, gateway_addr, vault_addr, agent)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-agent: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

async fn read_agent(
    rpc: &RpcClient,
    gateway: Address,
    vault: Address,
    agent: Address,
) -> crate::errors::Result<Envelope<AgentData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let data = AgentData {
        agent: format!("{agent:#x}"),
        ..Default::default()
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    // agents() tuple — now an 8-field record including the withdrawal
    // policy fields (assetRecipient + maxWithdrawPerPayment +
    // maxWithdrawPerWindow). Issue #429: surface this so operators
    // can see withdrawal-enabled policies in `rmpc get-agent`.
    match call_agents(rpc, gateway, &block_tag, agent).await {
        Ok(t) => {
            b.data_mut().active = t.active;
            b.data_mut().valid_until = t.valid_until;
            b.data_mut().max_per_payment = DecimalU256(t.max_per_payment);
            b.data_mut().max_per_window = DecimalU256(t.max_per_window);
            b.data_mut().share_receiver = format!("{:#x}", t.share_receiver);
            b.data_mut().asset_recipient = format!("{:#x}", t.asset_recipient);
            b.data_mut().max_withdraw_per_payment = DecimalU256(t.max_withdraw_per_payment);
            b.data_mut().max_withdraw_per_window = DecimalU256(t.max_withdraw_per_window);
            // `withdrawals_enabled` mirrors the on-chain gateway guard
            // (`if (p.maxWithdrawPerPayment == 0) revert
            // WithdrawalNotEnabled()`). Derived rather than stored so
            // it can never drift from the canonical field.
            b.data_mut().withdrawals_enabled = !t.max_withdraw_per_payment.is_zero();
        }
        Err(e) => b.record_err("agents", e),
    }

    // share allowance(agent, gateway) on the pinned vault. Read even
    // when withdrawals are disabled — a leftover non-zero allowance
    // with a future re-enable is still part of the blast radius
    // operators need to see (issue #429: "revoke stale gateway share
    // allowances").
    match call_share_allowance(rpc, vault, &block_tag, agent, gateway).await {
        Ok(v) => b.data_mut().share_allowance = DecimalU256(v),
        Err(e) => b.record_err("share_allowance", e),
    }

    // window id from chain timestamp
    let window_id = match rpc.block_timestamp(block_number).await {
        Ok(ts) => {
            let id = ts / WINDOW_SECONDS;
            b.data_mut().window_id = id;
            Some(id)
        }
        Err(e) => {
            b.record_err("window_id", format!("eth_getBlockByNumber failed: {e}"));
            None
        }
    };

    // window gross — only meaningful when we have a window id
    if let Some(id) = window_id {
        match call_window_gross(rpc, gateway, &block_tag, agent, id).await {
            Ok(v) => b.data_mut().window_gross = DecimalU256(v),
            Err(e) => b.record_err("window_gross", e),
        }
    }

    Ok(b.finish())
}

struct AgentTuple {
    active: bool,
    valid_until: u64,
    max_per_payment: U256,
    max_per_window: U256,
    share_receiver: Address,
    asset_recipient: Address,
    max_withdraw_per_payment: U256,
    max_withdraw_per_window: U256,
}

async fn call_agents(
    rpc: &RpcClient,
    gateway: Address,
    block_tag: &str,
    agent: Address,
) -> std::result::Result<AgentTuple, String> {
    let data = RobotMoneyGateway::agentsCall { _0: agent }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = RobotMoneyGateway::agentsCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(AgentTuple {
        active: r.active,
        valid_until: r.validUntil,
        max_per_payment: r.maxPerPayment,
        max_per_window: r.maxPerWindow,
        share_receiver: r.shareReceiver,
        asset_recipient: r.assetRecipient,
        max_withdraw_per_payment: r.maxWithdrawPerPayment,
        max_withdraw_per_window: r.maxWithdrawPerWindow,
    })
}

/// `vault.allowance(agent, gateway)` — the outstanding share allowance
/// the agent has granted the gateway. Issue #429: surfacing this
/// quantifies the agent-compromise blast radius for the withdrawal
/// path (a stolen agent key can redeem up to
/// `min(share_allowance, max_withdraw_per_window)` shares).
async fn call_share_allowance(
    rpc: &RpcClient,
    vault: Address,
    block_tag: &str,
    owner: Address,
    spender: Address,
) -> std::result::Result<U256, String> {
    let data = Erc20::allowanceCall { owner, spender }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: vault,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = Erc20::allowanceCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

async fn call_window_gross(
    rpc: &RpcClient,
    gateway: Address,
    block_tag: &str,
    agent: Address,
    window_id: u64,
) -> std::result::Result<U256, String> {
    let data = RobotMoneyGateway::agentWindowGrossCall {
        _0: agent,
        _1: window_id,
    }
    .abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = RobotMoneyGateway::agentWindowGrossCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-agent output serialises");
    println!("{json}");
}
