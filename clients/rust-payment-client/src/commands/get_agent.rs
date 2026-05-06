//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-agent --agent 0x…` — direct on-chain read of an agent's
//! authorization record on the gateway, plus the current window's
//! deposit usage.
//!
//! Sub-reads (all `eth_call`, pinned to one block):
//!
//! - `agents(address)` → `(active, validUntil, maxPerPayment,
//!   maxPerWindow, shareReceiver)` — the canonical authorization tuple.
//! - `eth_getBlockByNumber(blockNumber).timestamp` → used to compute
//!   `window_id = timestamp / WINDOW_SECONDS`, so the answer is
//!   reproducible against the pinned block (not the daemon's wall
//!   clock — see ADR §3.4).
//! - `agentWindowGross(agent, windowId)` → cumulative deposit value the
//!   agent has put through the current window.
//!
//! Output is the §9 envelope with `data: AgentData`. `maxPerPayment`,
//! `maxPerWindow`, and `window_gross` are `DecimalU256` so they
//! serialize as JSON strings.
//!
//! Exit codes: 0 (envelope, possibly partial), 3 (pre-read setup fail).

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::RobotMoneyGateway;
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

    let env = match rt.block_on(read_agent(&rpc, gateway_addr, agent)) {
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

    // agents() tuple
    match call_agents(rpc, gateway, &block_tag, agent).await {
        Ok(t) => {
            b.data_mut().active = t.active;
            b.data_mut().valid_until = t.valid_until;
            b.data_mut().max_per_payment = DecimalU256(t.max_per_payment);
            b.data_mut().max_per_window = DecimalU256(t.max_per_window);
            b.data_mut().share_receiver = format!("{:#x}", t.share_receiver);
        }
        Err(e) => b.record_err("agents", e),
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
    })
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
