//! Canonical: Plan tracking issue #109 §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//! Security: docs/code-review/20260518-code-review-internal-codex.md §5 (agent-key compromise blast radius)
//!
//! `rmpc get-agent --agent 0x…` — direct on-chain read of an agent's
//! authorization record on the gateway, plus the current window's
//! deposit usage.
//!
//! Sub-reads (all `eth_call`, pinned to one block):
//!
//! - `agents(address)` → `(active, validUntil, maxPerPayment,
//!   maxPerWindow, shareReceiver, ...)`. The getter also returns the retired
//!   withdraw members, which the gateway requires to be zero. They are not
//!   reported (the gateway has no withdraw path, architecture 5.2).
//! - `eth_getBlockByNumber(blockNumber).timestamp` → used to compute the
//!   calendar `window_id = timestamp / WINDOW_SECONDS`, surfaced for
//!   operator context and reproducibility against the pinned block (not the
//!   daemon's wall clock — see ADR §3.4). It is **not** the source of
//!   `window_gross` (RPC-1, #1024).
//! - `effectiveDepositWindowGross(agent)` → cumulative deposit value the
//!   agent has put through the current **rolling** deposit window — the
//!   exposure the gateway enforces the deposit cap on.
//!
//! Output is the §9 envelope with `data: AgentData`. `maxPerPayment`,
//! `maxPerWindow` and `window_gross` are `DecimalU256` so they serialize as
//! JSON strings.
//!
//! A failed sub-read renders its fields as JSON `null`, never as `"0"`,
//! `false` or the zero address (read-output contract §3.6, QA plan U6,
//! finding DR-8).
//!
//! Exit codes: 0 (envelope, possibly partial), 3 (pre-read setup fail).

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::RobotMoneyGateway;
use crate::network_env::NetworkEnv;
use crate::output::emit;
use crate::policy::WINDOW_SECONDS;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, FailoverRpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// `data` payload for `rmpc get-agent`. Field order matches the
/// operator-visible JSON; downstream snapshot tests assert on it.
///
/// Every field a sub-read fills is an `Option`: `None` serializes as JSON
/// `null` when that read failed, so a failed read is never mistaken for an
/// inactive or zero-cap agent (contract §3.6).
#[derive(Debug, Default, Serialize)]
pub struct AgentData {
    /// Target agent address (lowercase 0x-hex).
    pub agent: String,
    /// `agents(agent).active` — false for unauthorized / revoked. `null`
    /// when the `agents()` read failed.
    pub active: Option<bool>,
    /// `agents(agent).validUntil` (unix seconds). `0` when the slot is
    /// unset; the contract treats `now > validUntil` as expired. `null`
    /// when the `agents()` read failed.
    pub valid_until: Option<u64>,
    /// `agents(agent).maxPerPayment` — `uint256` decimal string.
    pub max_per_payment: Option<DecimalU256>,
    /// `agents(agent).maxPerWindow` — `uint256` decimal string.
    pub max_per_window: Option<DecimalU256>,
    /// `agents(agent).shareReceiver` — lowercase 0x-hex.
    pub share_receiver: Option<String>,
    /// Calendar window id at the pinned block:
    /// `block_timestamp / WINDOW_SECONDS`. Retained for operator context
    /// only; it is **not** the source of `window_gross` (RPC-1, #1024).
    pub window_id: Option<u64>,
    /// `effectiveDepositWindowGross(agent)` — the agent's cumulative
    /// deposit gross against the current **rolling** window (the value the
    /// gateway enforces the deposit cap on), as a `uint256` decimal string.
    /// Issue #1024 (RPC-1) switched this from the deprecated calendar-window
    /// mapping `agentWindowGross(agent, window_id)` to the rolling-window
    /// effective view already used by the preflight (`policy/mod.rs`), so the
    /// reported figure matches the gateway's actual admit/deny exposure.
    pub window_gross: Option<DecimalU256>,
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
    let rpc = match cfg.rpc_client() {
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
    rpc: &FailoverRpcClient,
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

    match call_agents(rpc, gateway, &block_tag, agent).await {
        Ok(t) => {
            let d = b.data_mut();
            d.active = Some(t.active);
            d.valid_until = Some(t.valid_until);
            d.max_per_payment = Some(DecimalU256(t.max_per_payment));
            d.max_per_window = Some(DecimalU256(t.max_per_window));
            d.share_receiver = Some(format!("{:#x}", t.share_receiver));
        }
        // agents() call failed — every field it fills stays `None` (JSON `null`).
        Err(e) => b.record_err("agents", e),
    }

    // Calendar window id from the chain timestamp. Retained for operator
    // context (RPC-1, #1024): the on-chain deposit cap is enforced on a
    // rolling window, so this calendar bucket is no longer the source of
    // `window_gross` — it is surfaced for reproducibility against the pinned
    // block only.
    match rpc.block_timestamp(block_number).await {
        Ok(ts) => b.data_mut().window_id = Some(ts / WINDOW_SECONDS),
        Err(e) => b.record_err("window_id", format!("eth_getBlockByNumber failed: {e}")),
    }

    // Rolling-window deposit gross — the value the gateway actually enforces
    // the deposit cap against (RPC-1, #1024). Read from the parameterless
    // `effectiveDepositWindowGross(agent)` view (the deposit analogue of the
    // withdraw rolling read migrated under #449), not the deprecated
    // per-calendar-window `agentWindowGross(agent, window_id)` mapping. The
    // read is independent of `window_id`, so it runs unconditionally.
    match call_effective_deposit_window_gross(rpc, gateway, &block_tag, agent).await {
        Ok(v) => b.data_mut().window_gross = Some(DecimalU256(v)),
        Err(e) => b.record_err("window_gross", e),
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
    rpc: &FailoverRpcClient,
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

/// `effectiveDepositWindowGross(agent)` — the agent's cumulative deposit
/// gross against the current **rolling** deposit window. Issue #1024 (RPC-1)
/// replaced the deprecated calendar-window mapping
/// `agentWindowGross(agent, window_id)` with this parameterless rolling-window
/// view (the deposit analogue of the withdraw read migrated under #449), so
/// the reported `window_gross` matches the exposure the gateway actually
/// enforces the deposit cap on — the same view the preflight uses
/// (`policy/mod.rs`).
async fn call_effective_deposit_window_gross(
    rpc: &FailoverRpcClient,
    gateway: Address,
    block_tag: &str,
    agent: Address,
) -> std::result::Result<U256, String> {
    let data = RobotMoneyGateway::effectiveDepositWindowGrossCall { agent }.abi_encode();
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
    let r = RobotMoneyGateway::effectiveDepositWindowGrossCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, hex};
    use mockito::Matcher;
    use serde_json::{json, Value};

    const GATEWAY: Address = address!("0000000000000000000000000000000000000b00");
    const AGENT: Address = address!("00000000000000000000000000000000000000aa");

    fn eth_call_of<C: SolCall>() -> Matcher {
        Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_call"})),
            Matcher::Regex(format!(r#""data":"0x{}"#, hex::encode(C::SELECTOR))),
        ])
    }

    async fn mock(server: &mut mockito::ServerGuard, m: Matcher, body: String) {
        server
            .mock("POST", "/")
            .match_body(m)
            .with_status(200)
            .with_body(body)
            .expect_at_least(0)
            .create_async()
            .await;
    }

    fn word(v: u64) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","id":1,"result":"0x{}"}}"#,
            hex::encode(U256::from(v).to_be_bytes::<32>())
        )
    }

    /// QA plan U6, finding DR-8: a failed `agents()` read renders every
    /// field it fills as JSON `null` (contract §3.6), never as an inactive,
    /// zero-cap, withdrawals-disabled agent. Reads that succeeded keep their
    /// values, and a real zero stays the string `"0"`.
    #[tokio::test]
    async fn get_agent_failed_agents_read_renders_null() {
        let mut server = mockito::Server::new_async().await;
        mock(
            &mut server,
            Matcher::PartialJson(json!({"method": "eth_chainId"})),
            r#"{"jsonrpc":"2.0","id":1,"result":"0x7a69"}"#.into(),
        )
        .await;
        mock(
            &mut server,
            Matcher::PartialJson(json!({"method": "eth_blockNumber"})),
            r#"{"jsonrpc":"2.0","id":1,"result":"0x100"}"#.into(),
        )
        .await;
        mock(
            &mut server,
            Matcher::PartialJson(json!({"method": "eth_getBlockByNumber"})),
            r#"{"jsonrpc":"2.0","id":1,"result":{"timestamp":"0x15180"}}"#.into(),
        )
        .await;
        mock(
            &mut server,
            eth_call_of::<RobotMoneyGateway::agentsCall>(),
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"header not found"}}"#
                .into(),
        )
        .await;
        mock(
            &mut server,
            eth_call_of::<RobotMoneyGateway::effectiveDepositWindowGrossCall>(),
            word(0),
        )
        .await;

        let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
        let env = read_agent(&rpc, GATEWAY, AGENT).await.expect("envelope");
        let v: Value = serde_json::to_value(&env).unwrap();

        assert_eq!(v["partial"], true);
        assert_eq!(v["errors"][0]["field"], "agents");
        let d = &v["data"];
        for field in [
            "active",
            "valid_until",
            "max_per_payment",
            "max_per_window",
            "share_receiver",
        ] {
            assert!(
                d.get(field).is_some_and(Value::is_null),
                "{field} must be null after a failed agents() read; data = {d}"
            );
        }
        for retired in [
            "asset_recipient",
            "max_withdraw_per_payment",
            "max_withdraw_per_window",
            "withdrawals_enabled",
            "share_allowance",
        ] {
            assert!(d.get(retired).is_none(), "{retired} is retired");
        }
        // A successful zero is "0", distinguishable from a failed read.
        assert_eq!(d["window_gross"], "0");
        assert_eq!(d["window_id"], 1);
    }
}
