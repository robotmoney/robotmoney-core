//! Canonical: docs/architecture.md §9 — Client Preflight
//! (See also: Plan tracking issue #109 §4.4 — Preflight)
//!
//! `policy` module — client-side preflight that mirrors the on-chain
//! `RobotMoneyGateway` policy.
//!
//! Per `Plan tracking issue #109` §3.4 and issue #14: every check
//! the contract enforces at execution time is replayed by `rmpc` *before*
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
//!    (eth_getCode returning empty bytecode is itself a refusal), and the
//!    gateway's live ERC-1967 implementation is the approved
//!    `config.gateway_implementation` with code hash
//!    `config.gateway_implementation_runtime_hash` (issue 1810, see
//!    [`implementation`])
//! 3. `gateway.depositsPaused() == false`
//! 4. `gateway.usdc()` matches `config.usdc_address`
//! 5. The REQUESTED vault (`PreflightInputs::vault`) is one the owner selected:
//!    in `config.allowed_destinations`, or equal to `config.vault_address` when
//!    that list is absent (`ErrDestinationNotSelected`). The gateway pins no
//!    vault, so `gateway.vault()` is never read. Then
//!    `vault.depositsPaused() == false`, and 5c: when that vault is an
//!    ERC-1967 proxy, its implementation's code hash is in
//!    `config.proxy_implementation_hashes`.
//! 6. `gateway.agents(self).active && validUntil >= now`
//!    (`ErrAgentNotAuthorized`, then `ErrPolicyExpired`); and (6b) when the
//!    config pins them, `agents(self).shareReceiver == config.share_receiver`
//!    and `agentOwner(self) == config.agent_owner` (`ErrAgentBindingMismatch`,
//!    QA plan D2: a squatter who bound this agent address first would
//!    otherwise receive its deposits' shares). The dapp's config export
//!    writes both keys once the authorizing wallet is connected (QA plan
//!    U6), so an exported config runs it.
//! 7. `amount <= agents(self).maxPerPayment` (`ErrDepositCapExceeded`)
//! 8. `effectiveDepositWindowGross(self) + amount <= maxPerWindow`
//!    (issue #497: rolling-window gross replaces per-calendar-window mapping)
//! 9. `usdc.allowance(self, gateway) >= amount`
//! 10. `usdc.balanceOf(self) >= amount`
//!
//! After the preflight, [`revert::simulate`] runs the exact calldata as an
//! `eth_call` and names the contract reverts the preflight cannot see
//! (router legs, slippage floors), QA plan U6.
//!
//! Every read runs at ONE block, pinned with `eth_blockNumber` before the
//! first check (issue 1810), so the checks describe one consistent chain
//! state. [`PreflightReport::block_number`] carries that block.
//!
//! Each rule maps onto a specific [`RmpcError`] variant. Operator tooling
//! matches on those names; renaming them is a breaking change.

use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;

use crate::config::Config;
use crate::errors::{Result, RmpcError};
use crate::gateway::{Erc20, RobotMoneyGateway};
use crate::rpc::{CallRequest, FailoverRpcClient};
use serde::Serialize;

pub mod implementation;
pub mod revert;
pub use implementation::{verify_gateway_code, verify_reached_proxy};

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
    /// The vault the deposit goes into. Its pause state and implementation
    /// are checked, and it must be one the owner selected.
    pub vault: Address,
}

/// Structured report returned on success. Callers (self-check, deposit,
/// withdraw) can introspect the on-chain state the preflight observed without
/// re-issuing the same RPCs.
#[derive(Debug, Clone)]
pub struct PreflightReport {
    pub chain_id: u64,
    /// The block every preflight read ran at.
    pub block_number: u64,
    pub gateway_runtime_hash_ok: bool,
    /// The verified implementation behind the gateway proxy; `None` for a
    /// direct gateway. The write path binds the signed transaction to it.
    pub gateway_implementation: Option<Address>,
    /// The verified implementation behind the requested vault; `None` for a
    /// direct vault. The write path re-checks it between signing and broadcast.
    pub vault_implementation: Option<Address>,
    /// `gateway.depositsPaused()`.
    pub deposits_paused: bool,
    pub agent_active: bool,
    pub agent_valid_until: u64,
    /// `agents(self).shareReceiver`: who receives a deposit's shares.
    pub share_receiver: Address,
    pub max_per_payment: U256,
    pub max_per_window: U256,
    pub window_gross: U256,
    pub allowance: U256,
    pub balance: U256,
}

/// Preflight runner — stateless façade over [`FailoverRpcClient`]. Construct once
/// per command invocation; cheap to clone.
#[derive(Debug, Clone)]
pub struct Preflight<'a> {
    rpc: &'a FailoverRpcClient,
    config: &'a Config,
}

impl<'a> Preflight<'a> {
    pub fn new(rpc: &'a FailoverRpcClient, config: &'a Config) -> Self {
        Self { rpc, config }
    }

    /// Execute every preflight rule. Returns on the first refusal. The
    /// order is: cheap chain-level checks first (chain id, code hash,
    /// deposits paused, addresses), then the requested vault, then per-agent
    /// reads, then balance/allowance. This minimises wasted RPC on the
    /// unhappy path.
    pub async fn run(&self, inputs: PreflightInputs) -> Result<PreflightReport> {
        // 1. chain id
        let chain_id = self.rpc.chain_id().await?;
        if chain_id != self.config.chain_id {
            return Err(RmpcError::ErrChainIdMismatch);
        }

        let gateway_addr = parse_addr(&self.config.gateway_address, "gateway_address")?;

        // Pin one block for every read below (issue 1810).
        let block_number = self.rpc.block_number().await?;
        let tag = block_tag(block_number);

        // 2. proxy code hash pin + live implementation check
        let gateway_implementation = verify_gateway_code(self.rpc, self.config, &tag).await?;

        // 3. depositsPaused() on the gateway.
        if self.call_view_deposits_paused(gateway_addr, &tag).await? {
            return Err(RmpcError::ErrDepositsPaused);
        }

        // 4. usdc() address pinned in config
        let usdc_addr_on_chain = self.call_view_usdc(gateway_addr, &tag).await?;
        let usdc_addr_cfg = parse_addr(&self.config.usdc_address, "usdc_address")?;
        if usdc_addr_on_chain != usdc_addr_cfg {
            return Err(RmpcError::ErrConfig(format!(
                "gateway.usdc() = {usdc_addr_on_chain:?} does not match configured usdc_address = {usdc_addr_cfg:?}"
            )));
        }

        // 5. The requested vault. The gateway pins none, so nothing is read
        //    from `gateway.vault()`. The owner's selection comes first, then
        //    the live state of the vault actually requested.
        let vault = inputs.vault;
        self.require_selected_destination(vault)?;
        // 5b. depositsPaused() on the requested vault.
        if self.call_view_deposits_paused(vault, &tag).await? {
            return Err(RmpcError::ErrDepositsPaused);
        }
        // 5c. The requested vault behind its address: when it is a proxy, its
        //     implementation must be in proxy_implementation_hashes.
        verify_reached_proxy(self.rpc, self.config, "vault", vault, &tag).await?;
        let vault_implementation =
            implementation::read_implementation(self.rpc, vault, &tag).await?;

        // 6. agents(self) — active, binding, validUntil
        let agent = self
            .check_agent(gateway_addr, inputs.signer_address, &tag)
            .await?;

        // 7. amount <= maxPerPayment
        if inputs.amount > agent.maxPerPayment {
            return Err(RmpcError::ErrDepositCapExceeded(format!(
                "amount {} exceeds agent maxPerPayment {}",
                inputs.amount, agent.maxPerPayment,
            )));
        }

        // 8. effectiveDepositWindowGross + amount <= maxPerWindow
        let window_gross = self
            .call_view_agent_deposit_window_gross(gateway_addr, inputs.signer_address, &tag)
            .await?;
        let projected = window_gross.saturating_add(inputs.amount);
        if projected > agent.maxPerWindow {
            return Err(RmpcError::ErrDepositCapExceeded(format!(
                "rollingDepositGross {} + amount {} exceeds maxPerWindow {}",
                window_gross, inputs.amount, agent.maxPerWindow,
            )));
        }

        // 9. allowance(self, gateway) >= amount
        let allowance = self
            .call_view_allowance(usdc_addr_cfg, inputs.signer_address, gateway_addr, &tag)
            .await?;
        if allowance < inputs.amount {
            return Err(RmpcError::ErrAllowanceInsufficient);
        }

        // 10. balanceOf(self) >= amount
        let balance = self
            .call_view_balance_of(usdc_addr_cfg, inputs.signer_address, &tag)
            .await?;
        if balance < inputs.amount {
            return Err(RmpcError::ErrBalanceInsufficient);
        }

        Ok(PreflightReport {
            chain_id,
            block_number,
            gateway_runtime_hash_ok: true,
            gateway_implementation,
            vault_implementation,
            deposits_paused: false,
            agent_active: agent.active,
            agent_valid_until: agent.validUntil,
            share_receiver: agent.shareReceiver,
            max_per_payment: agent.maxPerPayment,
            max_per_window: agent.maxPerWindow,
            window_gross,
            allowance,
            balance,
        })
    }

    /// The owner selects deposit vaults offline; the gateway checks only
    /// membership in the policy list. rmpc mirrors that with the config's
    /// `allowed_destinations` (else `vault_address` alone) and refuses any other
    /// vault before signing. The gateway policy list itself is not readable
    /// (the `agents` getter omits array members), so the pre-sign simulation
    /// (`InvalidDestination`) covers a config that is wider than the policy.
    fn require_selected_destination(&self, vault: Address) -> Result<()> {
        let selected = selected_destinations(self.config)?;
        if selected.contains(&vault) {
            return Ok(());
        }
        Err(RmpcError::ErrDestinationNotSelected(format!(
            "vault {vault:#x} is not one the owner selected; the config selects {}. Nothing was signed",
            selected
                .iter()
                .map(|a| format!("{a:#x}"))
                .collect::<Vec<_>>()
                .join(", ")
        )))
    }

    /// Check 6 and 6b, shared by the deposit and withdraw preflights.
    ///
    /// Order: an inactive record is `ErrAgentNotAuthorized`. Then the
    /// binding: when the config pins `share_receiver` or `agent_owner`, the
    /// chain must agree (`ErrAgentBindingMismatch`, QA plan D2). An agent
    /// address someone else bound first is refused here, before the expiry
    /// and caps of a policy the operator never set. Last, `validUntil` in the
    /// past is `ErrPolicyExpired` (QA plan U6; it printed
    /// `ErrAgentNotAuthorized` before).
    ///
    /// `agentOwner(self)` is read only when `agent_owner` is configured.
    async fn check_agent(
        &self,
        gateway: Address,
        agent_addr: Address,
        tag: &str,
    ) -> Result<RobotMoneyGateway::agentsReturn> {
        let agent = self.call_view_agents(gateway, agent_addr, tag).await?;
        if !agent.active {
            return Err(RmpcError::ErrAgentNotAuthorized);
        }
        if let Some(cfg_receiver) = self.config.share_receiver.as_deref() {
            let configured = parse_addr(cfg_receiver, "share_receiver")?;
            if agent.shareReceiver != configured {
                return Err(RmpcError::ErrAgentBindingMismatch {
                    field: "agents(self).shareReceiver",
                    on_chain: format!("{:#x}", agent.shareReceiver),
                    configured: format!("{configured:#x}"),
                });
            }
        }
        if let Some(cfg_owner) = self.config.agent_owner.as_deref() {
            let configured = parse_addr(cfg_owner, "agent_owner")?;
            let on_chain = self.call_view_agent_owner(gateway, agent_addr, tag).await?;
            if on_chain != configured {
                return Err(RmpcError::ErrAgentBindingMismatch {
                    field: "agentOwner(self)",
                    on_chain: format!("{on_chain:#x}"),
                    configured: format!("{configured:#x}"),
                });
            }
        }
        if agent.validUntil < now_unix() {
            return Err(RmpcError::ErrPolicyExpired);
        }
        Ok(agent)
    }

    // --- typed view helpers ---------------------------------------------

    /// `agentOwner(agent)` on the gateway: the address that bound the agent.
    async fn call_view_agent_owner(
        &self,
        gateway: Address,
        agent: Address,
        tag: &str,
    ) -> Result<Address> {
        let data = RobotMoneyGateway::agentOwnerCall { _0: agent }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                Some(tag),
            )
            .await?;
        let decoded = RobotMoneyGateway::agentOwnerCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("agentOwner() decode: {e}")))?;
        Ok(decoded._0)
    }

    /// `depositsPaused()` on the gateway or a vault. Both expose the same
    /// `depositsPaused() returns (bool)` view, so one selector serves both.
    async fn call_view_deposits_paused(&self, target: Address, tag: &str) -> Result<bool> {
        let data = RobotMoneyGateway::depositsPausedCall {}.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: target,
                    from: None,
                    data: data.into(),
                },
                Some(tag),
            )
            .await?;
        let decoded = RobotMoneyGateway::depositsPausedCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("depositsPaused() decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_usdc(&self, gateway: Address, tag: &str) -> Result<Address> {
        let data = RobotMoneyGateway::usdcCall {}.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                Some(tag),
            )
            .await?;
        let decoded = RobotMoneyGateway::usdcCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("usdc() decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_agents(
        &self,
        gateway: Address,
        agent: Address,
        tag: &str,
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
                Some(tag),
            )
            .await?;
        RobotMoneyGateway::agentsCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("agents() decode: {e}")))
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
            .map_err(|e| RmpcError::ErrRpcDecode(format!("agentWindowGross decode: {e}")))?;
        Ok(decoded._0)
    }

    /// Read the agent's rolling-window deposit gross from the gateway
    /// via `effectiveDepositWindowGross(agent)`. Issue #497 replaced the
    /// fixed `agentWindowGross(agent, windowId)` mapping with a
    /// rolling-window accumulator anchored on the agent's first deposit
    /// of each window — the view returns the cumulative USDC deposited
    /// against the current rolling cap (zero when the anchor has aged out).
    async fn call_view_agent_deposit_window_gross(
        &self,
        gateway: Address,
        agent: Address,
        tag: &str,
    ) -> Result<U256> {
        let data = RobotMoneyGateway::effectiveDepositWindowGrossCall { agent }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: gateway,
                    from: None,
                    data: data.into(),
                },
                Some(tag),
            )
            .await?;
        let decoded =
            RobotMoneyGateway::effectiveDepositWindowGrossCall::abi_decode_returns(&out, true)
                .map_err(|e| {
                    RmpcError::ErrRpcDecode(format!("effectiveDepositWindowGross decode: {e}"))
                })?;
        Ok(decoded._0)
    }

    async fn call_view_allowance(
        &self,
        token: Address,
        owner: Address,
        spender: Address,
        tag: &str,
    ) -> Result<U256> {
        let data = Erc20::allowanceCall { owner, spender }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: token,
                    from: None,
                    data: data.into(),
                },
                Some(tag),
            )
            .await?;
        let decoded = Erc20::allowanceCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("allowance decode: {e}")))?;
        Ok(decoded._0)
    }

    async fn call_view_balance_of(&self, token: Address, who: Address, tag: &str) -> Result<U256> {
        let data = Erc20::balanceOfCall { account: who }.abi_encode();
        let out = self
            .rpc
            .eth_call(
                &CallRequest {
                    to: token,
                    from: None,
                    data: data.into(),
                },
                Some(tag),
            )
            .await?;
        let decoded = Erc20::balanceOfCall::abi_decode_returns(&out, true)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("balanceOf decode: {e}")))?;
        Ok(decoded._0)
    }
}

/// Preflight snapshot, in the same order as [`PreflightReport`]. Numeric
/// values that may exceed `u64` are serialised as decimal strings so the
/// JSON survives `JSON.parse` in JavaScript callers without precision loss.
#[derive(Debug, Serialize)]
pub struct ChecksOutput {
    pub chain_id_match: bool,
    pub gateway_code_hash_match: bool,
    /// The gateway's live ERC-1967 implementation is the approved one (or
    /// the gateway is a direct deployment and none is configured).
    pub gateway_implementation_match: bool,
    /// The verified implementation behind the gateway proxy; `null` for a
    /// direct gateway or when it was not verified.
    pub gateway_implementation: Option<String>,
    /// `depositsPaused()` was observed true.
    pub deposits_paused: bool,
    pub agent_active: bool,
    pub agent_valid_until: u64,
    pub max_per_payment: String,
    pub max_per_window: String,
    pub window_gross: String,
    pub allowance: String,
    pub balance: String,
}

impl ChecksOutput {
    pub(crate) fn from_report(r: &PreflightReport) -> Self {
        Self {
            chain_id_match: true,
            gateway_code_hash_match: r.gateway_runtime_hash_ok,
            gateway_implementation_match: r.gateway_runtime_hash_ok,
            gateway_implementation: r.gateway_implementation.map(|a| format!("{a:#x}")),
            deposits_paused: r.deposits_paused,
            agent_active: r.agent_active,
            agent_valid_until: r.agent_valid_until,
            max_per_payment: r.max_per_payment.to_string(),
            max_per_window: r.max_per_window.to_string(),
            window_gross: r.window_gross.to_string(),
            allowance: r.allowance.to_string(),
            balance: r.balance.to_string(),
        }
    }

    /// Best-effort partial snapshot when only the [`RmpcError`] is
    /// available. The one per-error table: `self-check` and every write
    /// command call it.
    pub(crate) fn from_err_partial(err: &RmpcError) -> Self {
        let mut c = Self::unknown();
        match err {
            RmpcError::ErrChainIdMismatch => {}
            RmpcError::ErrCodeHashMismatch => {
                c.chain_id_match = true;
            }
            // The gateway implementation check (check 2) or the requested
            // vault's proxy (check 5c) refused. The detail
            // names which; the snapshot cannot, so it never claims check 2's
            // implementation half passed.
            RmpcError::ErrImplementationNotApproved(_)
            | RmpcError::ErrImplementationUnverified(_)
            | RmpcError::ErrImplementationChanged(_) => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
            }
            RmpcError::ErrDepositsPaused => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
                c.gateway_implementation_match = true;
                c.deposits_paused = true;
            }
            // Raised after `agents(self)` read an active record.
            RmpcError::ErrPolicyExpired
            | RmpcError::ErrAgentBindingMismatch { .. }
            | RmpcError::ErrDepositCapExceeded(_) => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
                c.gateway_implementation_match = true;
                c.agent_active = true;
            }
            // Raised only after check 2 passed: the agent read, the USDC and
            // share checks.
            RmpcError::ErrAgentNotAuthorized
            | RmpcError::ErrAllowanceInsufficient
            | RmpcError::ErrBalanceInsufficient
            | RmpcError::ErrDestinationNotSelected(_) => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
                c.gateway_implementation_match = true;
            }
            _ => {
                c.chain_id_match = true;
                c.gateway_code_hash_match = true;
                c.gateway_implementation_match = true;
            }
        }
        c
    }

    pub(crate) fn unknown() -> Self {
        Self {
            chain_id_match: false,
            gateway_code_hash_match: false,
            gateway_implementation_match: false,
            gateway_implementation: None,
            deposits_paused: false,
            agent_active: false,
            agent_valid_until: 0,
            max_per_payment: "0".into(),
            max_per_window: "0".into(),
            window_gross: "0".into(),
            allowance: "0".into(),
            balance: "0".into(),
        }
    }
}

// --- helpers ------------------------------------------------------------

/// The vaults the owner selected for this agent: the config's
/// `allowed_destinations` when set and non-empty, else `vault_address` alone.
pub fn selected_destinations(config: &Config) -> Result<Vec<Address>> {
    match config.allowed_destinations.as_deref() {
        Some(list) if !list.is_empty() => list
            .iter()
            .enumerate()
            .map(|(i, a)| parse_addr(a, &format!("allowed_destinations[{i}]")))
            .collect(),
        _ => Ok(vec![parse_addr(&config.vault_address, "vault_address")?]),
    }
}

fn parse_addr(s: &str, field: &str) -> Result<Address> {
    Address::from_str(s).map_err(|e| RmpcError::ErrConfig(format!("{field}: {e}")))
}

/// `eth_*` block tag for a pinned block number.
fn block_tag(block_number: u64) -> String {
    format!("0x{block_number:x}")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
