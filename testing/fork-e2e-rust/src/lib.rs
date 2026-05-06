//! Canonical: docs/implementation-plan.md §8 — Phase 2 Forked Smart-Contract E2E.
//! Decision record: docs/technical/fork-e2e-decisions.md (issue #47).
//! Implements: issue #48.
//!
//! Forked-mainnet end-to-end harness for Robot Money. Each test boots
//! its own `anvil --fork-url $RMPC_FORK_RPC_URL --fork-block-number
//! $RMPC_FORK_BLOCK` backend (per §3.5 of the ADR, fork-restart per
//! test, no shared backend, no `evm_snapshot` orchestration), creates
//! an ephemeral secp256k1 signer, funds the resulting EOA with ETH
//! (via `anvil_setBalance`) and USDC (via `anvil_impersonateAccount`
//! against a known whale on Base), then exercises the deployed
//! Robot Money contracts plus the surrounding USDC / DEX state.
//!
//! The harness intentionally keeps a small public surface:
//!
//! - [`ForkFixture::new`] — boot anvil-fork at the configured pin
//!   and produce a wired-up RPC client. Returns
//!   [`HarnessError::SkipNoRpc`] if `RMPC_FORK_RPC_URL` is unset, so
//!   `cargo test` on a contributor laptop without an archive RPC
//!   prints a skip line rather than failing.
//! - [`ForkFixture::ephemeral`] — fresh secp256k1 keypair + funded
//!   account context, ready to sign EIP-1559 txs.
//! - [`Account`] — the ephemeral key bound to a fixture, plus
//!   [`Account::send`] / [`Account::call`] helpers that hide
//!   nonce/gas/eip-1559 plumbing.
//! - [`addresses`] module — Base-mainnet contract addresses, parsed
//!   once and re-exported.
//!
//! Reads use only JSON-RPC (per §8 outputs and §3.1 of the ADR — no
//! explorer APIs in the test path).
//!
//! See the crate README for the env-var contract and the local /
//! CI invocation matrix.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use alloy_consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy_eips::eip2718::Encodable2718;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall};
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};

pub mod addresses;
pub mod scenarios;

// -- Deployed addresses module is re-exported for ergonomic use ----

pub use addresses::BASE_ADDRESSES;

// -- Errors --------------------------------------------------------

/// All errors raised by the fork harness itself. Scenario-level
/// assertion failures bubble up as plain `anyhow!`-style messages
/// inside the scenario tests; this enum only covers infrastructure.
#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    /// `RMPC_FORK_RPC_URL` is not set. Tests treat this as a skip,
    /// not a failure, so contributors without an archive RPC can
    /// still run `cargo test`.
    #[error("RMPC_FORK_RPC_URL not set; skipping fork test")]
    SkipNoRpc,

    /// `anvil` is not on PATH.
    #[error("anvil not on PATH; install Foundry (https://getfoundry.sh)")]
    AnvilMissing,

    /// `RMPC_FORK_BLOCK` is set but does not parse as a decimal
    /// block number.
    #[error("RMPC_FORK_BLOCK={0:?} is not a valid decimal block number")]
    BadForkBlock(String),

    /// Failed to spawn or talk to the anvil child.
    #[error("anvil child error: {0}")]
    AnvilChild(String),

    /// JSON-RPC transport / decode error.
    #[error("rpc error: {0}")]
    Rpc(String),

    /// Tx reverted on-chain (status 0).
    #[error("tx reverted: {0}")]
    Reverted(String),

    /// Filesystem / tempdir error.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl HarnessError {
    /// True if this error means "no archive RPC configured; skip
    /// rather than fail". Used at the top of every scenario test.
    pub fn is_skip(&self) -> bool {
        matches!(self, HarnessError::SkipNoRpc)
    }
}

/// Boilerplate for the top of every scenario test — exits early
/// when the harness can't run on this machine.
#[macro_export]
macro_rules! skip_if_no_fork {
    () => {
        if !$crate::can_run() {
            eprintln!(
                "[fork-e2e] skipping: RMPC_FORK_RPC_URL not set or anvil missing. \
                 Set RMPC_FORK_RPC_URL to a Base archive endpoint and install Foundry to run."
            );
            return;
        }
    };
}

/// Returns true iff `RMPC_FORK_RPC_URL` is set to a non-empty
/// value and `anvil` is on PATH. Used by the [`skip_if_no_fork!`]
/// macro. The non-empty check matters for CI: GitHub Actions
/// passes a missing-secret value through as the literal empty
/// string, not as an unset env var, so a plain `env::var().is_ok()`
/// check would happily try to fork against an empty URL.
pub fn can_run() -> bool {
    std::env::var("RMPC_FORK_RPC_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        && which::which("anvil").is_ok()
}

// -- Configuration -------------------------------------------------

/// Default block lag for "latest minus N" mode when
/// `RMPC_FORK_BLOCK` is unset. Matches §3.2 of the ADR.
const LOCAL_LAG_BLOCKS: u64 = 50;

/// Base mainnet chain id. Hard-coded — Phase 2 only targets Base
/// per §3.1 of the ADR.
pub const BASE_CHAIN_ID: u64 = 8453;

/// Effective fork pin resolved from environment.
#[derive(Debug, Clone)]
pub struct ForkPin {
    pub block: u64,
    /// `Pinned` = read from `RMPC_FORK_BLOCK`, `LatestMinusN` =
    /// read from chain tip at fixture startup.
    pub source: PinSource,
}

#[derive(Debug, Clone, Copy)]
pub enum PinSource {
    Pinned,
    LatestMinusN,
}

// -- The fixture ---------------------------------------------------

/// One forked anvil backend, owned for the lifetime of a single
/// test. Drop tears the child down.
pub struct ForkFixture {
    backend: Option<Child>,
    pub rpc_url: String,
    /// Sanitized hostname of the upstream archive endpoint (no
    /// API key). Used in test output.
    pub rpc_label: String,
    pub pin: ForkPin,
    rpc: Rpc,
    /// Captured tx hashes for output; kept under a Mutex so
    /// scenarios can append from any helper.
    tx_hashes: Mutex<Vec<B256>>,
}

impl ForkFixture {
    /// Boot a fresh anvil fork backend. Skips with [`HarnessError::SkipNoRpc`]
    /// if `RMPC_FORK_RPC_URL` is unset.
    pub fn new() -> Result<Self, HarnessError> {
        let upstream = std::env::var("RMPC_FORK_RPC_URL").map_err(|_| HarnessError::SkipNoRpc)?;
        if upstream.is_empty() {
            // CI passes a missing secret through as the empty
            // string; treat it as "no RPC configured" so the test
            // skips cleanly rather than hanging on `anvil --fork-url ""`.
            return Err(HarnessError::SkipNoRpc);
        }
        if which::which("anvil").is_err() {
            return Err(HarnessError::AnvilMissing);
        }

        // Resolve fork block.
        let pin = resolve_fork_pin(&upstream)?;

        // Pick an ephemeral port and boot anvil.
        let port = pick_free_port()?;
        let rpc_url = format!("http://127.0.0.1:{port}");

        let mut cmd = Command::new("anvil");
        cmd.arg("--port")
            .arg(port.to_string())
            .arg("--fork-url")
            .arg(&upstream)
            .arg("--fork-block-number")
            .arg(pin.block.to_string())
            .arg("--chain-id")
            .arg(BASE_CHAIN_ID.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd
            .spawn()
            .map_err(|e| HarnessError::AnvilChild(format!("spawn anvil: {e}")))?;

        let rpc = Rpc::new(&rpc_url);
        let mut backend = Some(child);

        // If anvil never comes up, kill the child before propagating.
        if let Err(e) = wait_for_rpc(&rpc, Duration::from_secs(20)) {
            if let Some(mut c) = backend.take() {
                let _ = c.kill();
            }
            return Err(e);
        }

        // Sanity-check chain id matches what we asked anvil to claim.
        let cid: u64 = rpc.chain_id()?;
        if cid != BASE_CHAIN_ID {
            if let Some(mut c) = backend.take() {
                let _ = c.kill();
            }
            return Err(HarnessError::Rpc(format!(
                "fork chain id {cid} != BASE_CHAIN_ID {BASE_CHAIN_ID}"
            )));
        }

        let rpc_label = sanitize_rpc_label(&upstream);
        Ok(ForkFixture {
            backend,
            rpc_url,
            rpc_label,
            pin,
            rpc,
            tx_hashes: Mutex::new(Vec::new()),
        })
    }

    /// Build a fresh ephemeral account funded with ETH and (optionally)
    /// USDC by impersonating the configured whale.
    pub fn ephemeral(&self, eth_wei: U256, usdc_units: U256) -> Result<Account<'_>, HarnessError> {
        let signer = SigningKey::random(&mut rand_core::OsRng);
        let addr = derive_address(&signer);
        // Fund ETH.
        self.rpc.set_balance(addr, eth_wei)?;
        // Fund USDC via whale impersonation if requested.
        if usdc_units > U256::ZERO {
            self.fund_usdc(addr, usdc_units)?;
        }
        Ok(Account {
            signer,
            address: addr,
            fixture_rpc_url: self.rpc_url.clone(),
            chain_id: BASE_CHAIN_ID,
            rpc: self.rpc.clone(),
            tx_hashes: &self.tx_hashes,
        })
    }

    /// Read RPC handle.
    pub fn rpc(&self) -> &Rpc {
        &self.rpc
    }

    /// All tx hashes recorded by scenarios that ran against this
    /// fixture. Useful when emitting structured test output.
    pub fn tx_hashes(&self) -> Vec<B256> {
        self.tx_hashes.lock().unwrap().clone()
    }

    /// `(chain_id, fork_block, rpc_label, address_set_hash)` summary
    /// line — printed at the top of every scenario per §3.2 of the
    /// ADR.
    pub fn summary_line(&self) -> String {
        let h = addresses::address_set_hash();
        format!(
            "chain_id={} fork_block={} rpc_label={} address_set_hash={}",
            BASE_CHAIN_ID,
            self.pin.block,
            self.rpc_label,
            hex::encode(h)
        )
    }

    /// Top up `addr` with `amount` USDC by impersonating a
    /// configured whale, transferring, then stopping impersonation.
    pub fn fund_usdc(&self, addr: Address, amount: U256) -> Result<(), HarnessError> {
        let whale = addresses::USDC_WHALE;
        // Make sure the whale has gas to broadcast.
        self.rpc
            .set_balance(whale, U256::from(10u64).pow(U256::from(18u64)))?;
        self.rpc.impersonate(whale)?;

        let calldata = IERC20::transferCall { to: addr, amount }.abi_encode();

        let tx = serde_json::json!({
            "from": fmt_addr(whale),
            "to": fmt_addr(addresses::USDC),
            "data": format!("0x{}", hex::encode(&calldata)),
        });
        let hash: B256 = self.rpc.send_unsigned(tx)?;
        let _ = self.rpc.wait_for_receipt(hash, Duration::from_secs(15))?;
        self.rpc.stop_impersonate(whale)?;
        Ok(())
    }
}

impl Drop for ForkFixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.backend.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// -- Account / signing --------------------------------------------

/// One ephemeral signer pinned to a fixture. Cheap to create —
/// callers can ask the fixture for many of these in a single test
/// if needed.
pub struct Account<'a> {
    signer: SigningKey,
    pub address: Address,
    pub fixture_rpc_url: String,
    pub chain_id: u64,
    rpc: Rpc,
    tx_hashes: &'a Mutex<Vec<B256>>,
}

impl<'a> Account<'a> {
    /// Sign and broadcast a typed call. Waits for the receipt and
    /// returns it; callers assert on `status`, `gasUsed`, etc.
    pub fn send<C: SolCall>(
        &self,
        to: Address,
        call: &C,
        value: U256,
        gas_limit: u64,
    ) -> Result<Receipt, HarnessError> {
        let calldata = call.abi_encode();
        self.send_raw(to, calldata.into(), value, gas_limit)
    }

    /// Like [`Self::send`] but takes already-encoded calldata.
    pub fn send_raw(
        &self,
        to: Address,
        data: Bytes,
        value: U256,
        gas_limit: u64,
    ) -> Result<Receipt, HarnessError> {
        let nonce = self.rpc.tx_count(self.address)?;
        let (max_fee, max_prio) = self.rpc.fees()?;

        let tx = TxEip1559 {
            chain_id: self.chain_id,
            nonce,
            gas_limit,
            max_fee_per_gas: max_fee,
            max_priority_fee_per_gas: max_prio,
            to: to.into(),
            value,
            access_list: Default::default(),
            input: data,
        };

        let sig = sign_eip1559(&tx, &self.signer);
        let envelope = TxEnvelope::Eip1559(tx.into_signed(sig));
        // Encode as an EIP-2718 typed-transaction blob suitable for
        // `eth_sendRawTransaction` (no RLP-list framing wrapping).
        let mut buf = Vec::with_capacity(256);
        envelope.encode_2718(&mut buf);
        let raw_hex = format!("0x{}", hex::encode(&buf));

        let hash = self.rpc.send_raw(&raw_hex)?;
        self.tx_hashes.lock().unwrap().push(hash);
        let r = self.rpc.wait_for_receipt(hash, Duration::from_secs(20))?;
        if r.status != 1 {
            return Err(HarnessError::Reverted(format!(
                "tx {hash:?} reverted (gasUsed={})",
                r.gas_used
            )));
        }
        Ok(r)
    }

    /// Eth-call (read-only) with encoded calldata.
    pub fn call<C: SolCall>(&self, to: Address, call: &C) -> Result<Bytes, HarnessError> {
        let calldata = call.abi_encode();
        self.rpc.eth_call(self.address, to, calldata.into())
    }
}

// -- Solidity interfaces -------------------------------------------

sol! {
    /// Subset of ERC-20 we call. Names match OpenZeppelin's IERC20.
    #[allow(missing_docs)]
    interface IERC20 {
        function balanceOf(address account) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
        function approve(address spender, uint256 amount) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
        function decimals() external view returns (uint8);
        function symbol() external view returns (string memory);
    }

    /// Subset of `RobotMoneyVault` (ERC-4626 + the vault-specific
    /// reads we exercise). Source: contracts/RobotMoneyVault.sol on
    /// `dev`.
    #[allow(missing_docs)]
    interface IRobotMoneyVault {
        function deposit(uint256 assets, address receiver) external returns (uint256);
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
        function balanceOf(address account) external view returns (uint256);
        function totalAssets() external view returns (uint256);
        function totalSupply() external view returns (uint256);
        function maxDeposit(address receiver) external view returns (uint256);
        function maxRedeem(address owner) external view returns (uint256);
        function previewDeposit(uint256 assets) external view returns (uint256);
        function previewRedeem(uint256 shares) external view returns (uint256);
        function asset() external view returns (address);
        function exitFeeBps() external view returns (uint256);
        function tvlCap() external view returns (uint256);
        function perDepositCap() external view returns (uint256);
        function paused() external view returns (bool);
        function symbol() external view returns (string memory);
        function decimals() external view returns (uint8);
    }
}

// -- JSON-RPC client ----------------------------------------------

/// Minimal blocking JSON-RPC client. Cloneable so scenarios can
/// share it freely; reqwest keeps a connection pool internally.
#[derive(Clone)]
pub struct Rpc {
    url: String,
    http: reqwest::blocking::Client,
}

#[derive(Debug, Clone)]
pub struct Receipt {
    pub status: u64,
    pub gas_used: u64,
    pub tx_hash: B256,
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            http: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
        }
    }

    fn rpc<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, HarnessError> {
        #[derive(Serialize)]
        struct Req<'a> {
            jsonrpc: &'a str,
            id: u64,
            method: &'a str,
            params: serde_json::Value,
        }
        let body = Req {
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
        };
        let resp: serde_json::Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| HarnessError::Rpc(format!("{method}: {e}")))?;
        if let Some(err) = resp.get("error") {
            return Err(HarnessError::Rpc(format!("{method}: {err}")));
        }
        let result = resp
            .get("result")
            .ok_or_else(|| HarnessError::Rpc(format!("{method}: no result field")))?
            .clone();
        serde_json::from_value(result)
            .map_err(|e| HarnessError::Rpc(format!("{method}: decode: {e}")))
    }

    pub fn block_number(&self) -> Result<u64, HarnessError> {
        let s: String = self.rpc("eth_blockNumber", serde_json::json!([]))?;
        u64::from_str_radix(s.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::Rpc(format!("eth_blockNumber decode: {e}")))
    }

    pub fn chain_id(&self) -> Result<u64, HarnessError> {
        let s: String = self.rpc("eth_chainId", serde_json::json!([]))?;
        u64::from_str_radix(s.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::Rpc(format!("eth_chainId decode: {e}")))
    }

    pub fn tx_count(&self, addr: Address) -> Result<u64, HarnessError> {
        let s: String = self.rpc(
            "eth_getTransactionCount",
            serde_json::json!([fmt_addr(addr), "pending"]),
        )?;
        u64::from_str_radix(s.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::Rpc(format!("eth_getTransactionCount decode: {e}")))
    }

    pub fn get_code(&self, addr: Address) -> Result<Bytes, HarnessError> {
        let s: String = self.rpc("eth_getCode", serde_json::json!([fmt_addr(addr), "latest"]))?;
        decode_hex_bytes(&s)
    }

    pub fn eth_call(&self, from: Address, to: Address, data: Bytes) -> Result<Bytes, HarnessError> {
        let params = serde_json::json!([
            {"from": fmt_addr(from), "to": fmt_addr(to), "data": format!("0x{}", hex::encode(&data))},
            "latest"
        ]);
        let s: String = self.rpc("eth_call", params)?;
        decode_hex_bytes(&s)
    }

    /// Returns `(maxFeePerGas, maxPriorityFeePerGas)` derived from
    /// the latest block's base fee. Mirrors the simple policy in
    /// `rmpc::fees`.
    pub fn fees(&self) -> Result<(u128, u128), HarnessError> {
        let block: serde_json::Value =
            self.rpc("eth_getBlockByNumber", serde_json::json!(["latest", false]))?;
        let base_fee_hex = block
            .get("baseFeePerGas")
            .and_then(|x| x.as_str())
            .unwrap_or("0x0");
        let base = u128::from_str_radix(base_fee_hex.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::Rpc(format!("baseFeePerGas decode: {e}")))?;
        let prio = 1_000_000_000u128; // 1 gwei
        let max = base.saturating_mul(2).saturating_add(prio);
        Ok((max, prio))
    }

    pub fn send_raw(&self, raw_hex: &str) -> Result<B256, HarnessError> {
        let s: String = self.rpc("eth_sendRawTransaction", serde_json::json!([raw_hex]))?;
        parse_b256(&s)
    }

    /// Send an unsigned tx via the impersonation route — caller
    /// must have called [`Self::impersonate`] first for `from`.
    pub fn send_unsigned(&self, mut tx: serde_json::Value) -> Result<B256, HarnessError> {
        // Ensure gas/value defaults so anvil accepts the tx.
        if tx.get("gas").is_none() {
            tx["gas"] = serde_json::Value::String("0x100000".into()); // 1M gas
        }
        let s: String = self.rpc("eth_sendTransaction", serde_json::json!([tx]))?;
        parse_b256(&s)
    }

    pub fn set_balance(&self, addr: Address, wei: U256) -> Result<(), HarnessError> {
        let _: bool = self.rpc(
            "anvil_setBalance",
            serde_json::json!([fmt_addr(addr), format!("0x{:x}", wei)]),
        )?;
        Ok(())
    }

    pub fn impersonate(&self, addr: Address) -> Result<(), HarnessError> {
        let _: serde_json::Value = self.rpc(
            "anvil_impersonateAccount",
            serde_json::json!([fmt_addr(addr)]),
        )?;
        Ok(())
    }

    pub fn stop_impersonate(&self, addr: Address) -> Result<(), HarnessError> {
        let _: serde_json::Value = self.rpc(
            "anvil_stopImpersonatingAccount",
            serde_json::json!([fmt_addr(addr)]),
        )?;
        Ok(())
    }

    pub fn wait_for_receipt(&self, hash: B256, timeout: Duration) -> Result<Receipt, HarnessError> {
        let start = Instant::now();
        loop {
            let resp: serde_json::Value = self.rpc(
                "eth_getTransactionReceipt",
                serde_json::json!([format!("{:#x}", hash)]),
            )?;
            if !resp.is_null() {
                let status = resp.get("status").and_then(|s| s.as_str()).unwrap_or("0x0");
                let gas_used = resp
                    .get("gasUsed")
                    .and_then(|s| s.as_str())
                    .unwrap_or("0x0");
                return Ok(Receipt {
                    status: u64::from_str_radix(status.trim_start_matches("0x"), 16).unwrap_or(0),
                    gas_used: u64::from_str_radix(gas_used.trim_start_matches("0x"), 16)
                        .unwrap_or(0),
                    tx_hash: hash,
                });
            }
            if start.elapsed() > timeout {
                return Err(HarnessError::Rpc(format!(
                    "receipt for {hash:?} not seen within {timeout:?}"
                )));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

// -- Helpers -------------------------------------------------------

fn resolve_fork_pin(upstream: &str) -> Result<ForkPin, HarnessError> {
    if let Ok(v) = std::env::var("RMPC_FORK_BLOCK") {
        let block: u64 = v
            .parse()
            .map_err(|_| HarnessError::BadForkBlock(v.clone()))?;
        return Ok(ForkPin {
            block,
            source: PinSource::Pinned,
        });
    }
    // Latest minus N.
    let probe = Rpc::new(upstream);
    let tip = probe.block_number()?;
    Ok(ForkPin {
        block: tip.saturating_sub(LOCAL_LAG_BLOCKS),
        source: PinSource::LatestMinusN,
    })
}

fn pick_free_port() -> Result<u16, HarnessError> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

fn wait_for_rpc(rpc: &Rpc, timeout: Duration) -> Result<(), HarnessError> {
    let start = Instant::now();
    let mut last = String::new();
    while start.elapsed() < timeout {
        match rpc.chain_id() {
            Ok(_) => return Ok(()),
            Err(e) => last = format!("{e}"),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(HarnessError::AnvilChild(format!(
        "anvil RPC not reachable after {timeout:?}: {last}"
    )))
}

/// Strip credentials and path so an API key never lands in test
/// output. Best-effort — falls through to "unknown" on a malformed
/// URL. Avoids pulling in the full `url` crate to stay dep-light.
fn sanitize_rpc_label(s: &str) -> String {
    let after = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let after = after.split_once('@').map(|(_, r)| r).unwrap_or(after);
    let host_end = after.find(['/', ':', '?']).unwrap_or(after.len());
    let host = &after[..host_end];
    if host.is_empty() {
        "unknown".to_string()
    } else {
        host.to_string()
    }
}

fn fmt_addr(a: Address) -> String {
    format!("{a:#x}")
}

fn decode_hex_bytes(s: &str) -> Result<Bytes, HarnessError> {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).map_err(|e| HarnessError::Rpc(format!("hex decode: {e}")))?;
    Ok(Bytes::from(bytes))
}

fn parse_b256(s: &str) -> Result<B256, HarnessError> {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).map_err(|e| HarnessError::Rpc(format!("hex decode: {e}")))?;
    if bytes.len() != 32 {
        return Err(HarnessError::Rpc(format!(
            "b256 wrong length {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(B256::from(out))
}

/// Derive a 20-byte address from a k256 SigningKey by keccak256 of
/// the SEC1-uncompressed public key (less the 0x04 prefix), keeping
/// the last 20 bytes. Matches what `alloy-signer-local` would do.
fn derive_address(sk: &SigningKey) -> Address {
    let vk = sk.verifying_key();
    let pubkey = vk.to_encoded_point(false);
    let h = keccak256(&pubkey.as_bytes()[1..]);
    Address::from_slice(&h[12..])
}

/// Sign the EIP-1559 envelope hash using the ephemeral signer.
/// Uses the legacy `alloy_primitives::Signature` shape because
/// alloy-consensus 0.5 (the version pinned to match the Phase 1
/// e2e crate) still consumes that type. When alloy bumps to a
/// release where consensus accepts `PrimitiveSignature` directly,
/// drop the deprecated import.
#[allow(deprecated)]
fn sign_eip1559(tx: &TxEip1559, sk: &SigningKey) -> alloy_primitives::Signature {
    let hash = tx.signature_hash();
    let (sig, recid): (k256::ecdsa::Signature, k256::ecdsa::RecoveryId) =
        sk.sign_prehash_recoverable(hash.as_slice()).unwrap();
    let r = U256::from_be_slice(&sig.r().to_bytes());
    let s = U256::from_be_slice(&sig.s().to_bytes());
    let v: bool = matches!(recid.to_byte(), 1);
    alloy_primitives::Signature::from_rs_and_parity(r, s, v).unwrap()
}
