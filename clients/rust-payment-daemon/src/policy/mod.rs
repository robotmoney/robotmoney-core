//! `policy` module — client-side preflight that mirrors the on-chain
//! `RobotMoneyGateway` policy.
//!
//! Per `docs/implementation-plan-mvp.md` §3.4 and issue #14: every check
//! the contract enforces at execution time is replayed by `rmpd` *before*
//! any signature is produced. A failure is a **hard refusal** — the daemon
//! exits non-zero, emits a high-severity log line, and never broadcasts.
//!
//! The contract being authoritative does not justify shipping a
//! transaction the client cannot prove is going to the audited bytecode;
//! the `keccak256(eth_getCode(gateway))` pin is therefore a non-negotiable
//! gate that runs before every send.
//!
//! Checks performed (issue #14, doc §3.4):
//!
//! 1. `eth_chainId` matches `config.chain_id`
//! 2. `keccak256(eth_getCode(gateway))` matches `config.gateway_runtime_hash`
//!    (eth_getCode returning empty bytecode is itself a refusal)
//! 3. `gateway.paused() == false`
//! 4. `gateway.usdc()` matches `config.usdc_address`
//! 5. `gateway.vault()` matches `config.vault_address`
//! 6. `gateway.agents(self).active && validUntil >= now`
//! 7. `amount <= agents(self).maxPerPayment`
//! 8. `agentWindowGross(self, currentWindow) + amount <= maxPerWindow`
//! 9. `usdc.allowance(self, gateway) >= amount`
//! 10. `usdc.balanceOf(self) >= amount`
//!
//! Each rule maps onto a specific [`RmpdError`] variant. Operator tooling
//! matches on those names; renaming them is a breaking change.

use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{keccak256, Address, U256};
use alloy_sol_types::SolCall;

use crate::config::Config;
use crate::errors::{Result, RmpdError};
use crate::gateway::{MockUsdc, RobotMoneyGateway};
use crate::rpc::{CallRequest, RpcClient};

/// Window length in seconds. Mirrors `RobotMoneyGateway.WINDOW_SECONDS`
/// (constant on-chain, baked into the contract). Re-reading it on every
/// preflight would be a wasted RPC; if the contract redeploys with a
/// different constant the pinned `gateway_runtime_hash` will already
/// reject before we get this far.
pub const WINDOW_SECONDS: u64 = 86_400;

/// Inputs that vary per-invocation. `signer_address` is the EOA the
/// software signer will sign with; `amount` is the deposit value in USDC's
/// smallest unit (6 decimals).
#[derive(Debug, Clone, Copy)]
pub struct PreflightInputs {
    pub signer_address: Address,
    pub amount: U256,
}

/// Structured report returned on success. Callers (self-check, deposit)
/// can introspect the on-chain state the preflight observed without
/// re-issuing the same RPCs.
#[derive(Debug, Clone)]
pub struct PreflightReport {
    pub chain_id: u64,
    pub gateway_runtime_hash_ok: bool,
    pub paused: bool,
    pub agent_active: bool,
    pub agent_valid_until: u64,
    pub max_per_payment: U256,
    pub max_per_window: U256,
    pub window_gross: U256,
    pub allowance: U256,
    pub balance: U256,
}

/// Preflight runner — stateless façade over [`RpcClient`]. Construct once
/// per command invocation; cheap to clone.
#[derive(Debug, Clone)]
pub struct Preflight<'a> {
    rpc: &'a RpcClient,
    config: &'a Config,
}

impl<'a> Preflight<'a> {
    pub fn new(rpc: &'a RpcClient, config: &'a Config) -> Self {
        Self { rpc, config }
    }

    /// Execute every preflight rule. Returns on the first refusal. The
    /// order is: cheap chain-level checks first (chain id, code hash,
    /// paused, addresses), then per-agent reads, then balance/allowance.
    /// This minimises wasted RPC on the unhappy path.
    pub async fn run(&self, inputs: PreflightInputs) -> Result<PreflightReport> {
        // 1. chain id
        let chain_id = self.rpc.chain_id().await?;
        if chain_id != self.config.chain_id {
            return Err(RmpdError::ErrChainIdMismatch);
        }

        let gateway_addr = parse_addr(&self.config.gateway_address, "gateway_address")?;

        // 2. code hash pin
        let code = self.rpc.get_code(gateway_addr, None).await?;
        if code.is_empty() {
            return Err(RmpdError::ErrCodeHashMismatch);
        }
        let observed_hash = keccak256(code.as_ref());
        let expected_hash = parse_b256_hex(&self.config.gateway_runtime_hash)?;
        if observed_hash.as_slice() != expected_hash.as_slice() {
            return Err(RmpdError::ErrCodeHashMismatch);
        }

        // 3. paused()
        let paused = self.call_view_paused(gateway_addr).await?;
        if paused {
            return Err(RmpdError::ErrGatewayPaused);
        }

        // 4-5. usdc()/vault() addresses pinned in config
        let usdc_addr_on_chain = self.call_view_usdc(gateway_addr).await?;
        let usdc_addr_cfg = parse_addr(&self.config.usdc_address, "usdc_address")?;
        if usdc_addr_on_chain != usdc_addr_cfg {
            return Err(RmpdError::ErrConfig(format!(
                "gateway.usdc() = {usdc_addr_on_chain:?} does not match configured usdc_address = {usdc_addr_cfg:?}"
            )));
        }
        let vault_addr_on_chain = self.call_view_vault(gateway_addr).await?;
        let vault_addr_cfg = parse_addr(&self.config.vault_address, "vault_address")?;
        if vault_addr_on_chain != vault_addr_cfg {
            return Err(RmpdError::ErrConfig(format!(
                "gateway.vault() = {vault_addr_on_chain:?} does not match configured vault_address = {vault_addr_cfg:?}"
            )));
        }

        // 6. agents(self) — active + validUntil
        let agent = self
            .call_view_agents(gateway_addr, inputs.signer_address)
            .await?;
        if !agent.active {
            return Err(RmpdError::ErrAgentNotAuthorized);
        }
        let now = now_unix();
        if (agent.validUntil as u64) < now {
            return Err(RmpdError::ErrAgentNotAuthorized);
        }

        // 7. amount <= maxPerPayment
        if inputs.amount > agent.maxPerPayment {
            return Err(RmpdError::ErrConfig(format!(
                "amount {} exceeds agent maxPerPayment {}",
                inputs.amount, agent.maxPerPayment,
            )));
        }

        // 8. agentWindowGross + amount <= maxPerWindow
        let window_id = now / WINDOW_SECONDS;
        let window_gross = self
            .call_view_agent_window_gross(gateway_addr, inputs.signer_address, window_id)
            .await?;
        let projected = window_gross.saturating_add(inputs.amount);
        if projected > agent.maxPerWindow {
            return Err(RmpdError::ErrConfig(format!(
                "windowGross {} + amount {} exceeds maxPerWindow {}",
                window_gross, inputs.amount, agent.maxPerWindow,
            )));
        }

        // 9. allowance(self, gateway) >= amount
        let allowance = self
            .call_view_allowance(usdc_addr_cfg, inputs.signer_address, gateway_addr)
            .await?;
        if allowance < inputs.amount {
            return Err(RmpdError::ErrAllowanceInsufficient);
        }

        // 10. balanceOf(self) >= amount
        let balance = self
            .call_view_balance_of(usdc_addr_cfg, inputs.signer_address)
            .await?;
        if balance < inputs.amount {
            return Err(RmpdError::ErrBalanceInsufficient);
        }

        Ok(PreflightReport {
            chain_id,
            gateway_runtime_hash_ok: true,
            paused: false,
            agent_active: agent.active,
            agent_valid_until: agent.validUntil,
            max_per_payment: agent.maxPerPayment,
            max_per_window: agent.maxPerWindow,
            window_gross,
            allowance,
            balance,
        })
    }

    // --- typed view helpers ---------------------------------------------

    async fn call_view_paused(&self, gateway: Address) -> Result<bool> {
        let data = RobotMoneyGateway::pausedCall {}.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        let decoded = RobotMoneyGateway::pausedCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("paused() decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_usdc(&self, gateway: Address) -> Result<Address> {
        let data = RobotMoneyGateway::usdcCall {}.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        let decoded = RobotMoneyGateway::usdcCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("usdc() decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_vault(&self, gateway: Address) -> Result<Address> {
        let data = RobotMoneyGateway::vaultCall {}.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        let decoded = RobotMoneyGateway::vaultCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("vault() decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_agents(
        &self,
        gateway: Address,
        agent: Address,
    ) -> Result<RobotMoneyGateway::agentsReturn> {
        let data = RobotMoneyGateway::agentsCall { _0: agent }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        RobotMoneyGateway::agentsCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("agents() decode: {e}")))
    }

    async fn call_view_agent_window_gross(
        &self,
        gateway: Address,
        agent: Address,
        window_id: u64,
    ) -> Result<U256> {
        let data = RobotMoneyGateway::agentWindowGrossCall {
            _0: agent,
            _1: window_id,
        }
        .abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        let decoded = RobotMoneyGateway::agentWindowGrossCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("agentWindowGross decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_allowance(
        &self,
        token: Address,
        owner: Address,
        spender: Address,
    ) -> Result<U256> {
        let data = MockUsdc::allowanceCall { owner, spender }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: token,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        let decoded = MockUsdc::allowanceCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("allowance decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_balance_of(&self, token: Address, who: Address) -> Result<U256> {
        let data = MockUsdc::balanceOfCall { account: who }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: token,
                    from: None,
                    data: data.into(),
                },
                None,
            )
            .await?;
        let decoded = MockUsdc::balanceOfCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpdError::ErrRpcDecode(format!("balanceOf decode: {e}")))?;
        Ok(decoded._0)
    }
}

// --- helpers ------------------------------------------------------------

fn parse_addr(s: &str, field: &str) -> Result<Address> {
    Address::from_str(s).map_err(|e| RmpdError::ErrConfig(format!("{field}: {e}")))
}

fn parse_b256_hex(s: &str) -> Result<[u8; 32]> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(stripped)
        .map_err(|e| RmpdError::ErrConfig(format!("gateway_runtime_hash: {e}")))?;
    if bytes.len() != 32 {
        return Err(RmpdError::ErrConfig(format!(
            "gateway_runtime_hash: expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
