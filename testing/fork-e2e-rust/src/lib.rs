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
use alloy_primitives::{keccak256, Address, Bytes, TxKind, B256, U256};
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
                "[fork-e2e] skipping: anvil not on PATH and no checked-in fixture found. \
                 Install Foundry (https://getfoundry.sh) to run fork tests."
            );
            return;
        }
    };
}

/// Skip the test unless a live mainnet fork RPC is available via
/// `RMPC_FORK_RPC_URL`. Use this for tests that read storage from
/// production Base mainnet contracts (e.g. `abi_address_sanity`),
/// which require a real fork rather than the checked-in fixture
/// (the fixture has bytecode but not full storage for mainnet contracts).
#[macro_export]
macro_rules! skip_if_no_mainnet_fork {
    () => {
        if which::which("anvil").is_err()
            || !std::env::var("RMPC_FORK_RPC_URL")
                .map(|v| !v.is_empty())
                .unwrap_or(false)
        {
            eprintln!(
                "[fork-e2e] skipping: RMPC_FORK_RPC_URL not set. \
                 This test requires a live Base mainnet archive RPC."
            );
            return;
        }
    };
}

/// Path to the checked-in Anvil state snapshot relative to the workspace root.
const FIXTURE_STATE_REL: &str = "testing/fixtures/fork-state/CURRENT.anvil-state";
const FIXTURE_META_REL: &str = "testing/fixtures/fork-state/CURRENT.json";

fn workspace_root() -> Option<std::path::PathBuf> {
    test_utils::find_workspace_root()
}

/// Returns the path to `CURRENT.anvil-state` if it exists on disk.
pub fn fixture_state_path() -> Option<std::path::PathBuf> {
    workspace_root()
        .map(|r| r.join(FIXTURE_STATE_REL))
        .filter(|p| p.exists())
}

/// Returns true iff the harness can boot an Anvil backend — either via
/// `RMPC_FORK_RPC_URL` (live upstream) or via the checked-in fork-state
/// fixture (`testing/fixtures/fork-state/CURRENT.anvil-state`).
pub fn can_run() -> bool {
    if which::which("anvil").is_err() {
        return false;
    }
    let has_rpc = std::env::var("RMPC_FORK_RPC_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    has_rpc || fixture_state_path().is_some()
}

// -- Configuration -------------------------------------------------

/// Default block lag for "latest minus N" mode when
/// `RMPC_FORK_BLOCK` is unset. Matches §3.2 of the ADR.
const LOCAL_LAG_BLOCKS: u64 = 50;

/// Base mainnet chain id. Hard-coded — Phase 2 only targets Base
/// per §3.1 of the ADR.
pub const BASE_CHAIN_ID: u64 = 8453;

/// Storage slot used by the Base USDC `FiatTokenProxy` to record
/// the proxy admin. Equal to `keccak256("org.zeppelinos.proxy.admin")`
/// (see Centre's `AdminUpgradeabilityProxy` source). Used by
/// [`ForkFixture::apply_usdc_storage_seed`] to verify the
/// `address(0)` admin / `address(0)` caller collision documented
/// in issue #249 is resolved after the seed is applied.
pub const USDC_PROXY_ADMIN_SLOT: B256 =
    alloy_primitives::b256!("10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b");

/// Path (relative to workspace root) of the committed USDC storage
/// seed: proxy storage slots + implementation address and bytecode
/// captured from Base mainnet. Applied by
/// [`ForkFixture::apply_usdc_storage_seed`] on every boot so the
/// checked-in `--load-state` snapshot — which only carries the
/// proxy's runtime bytecode, not its admin/impl storage — becomes
/// a fully-functional USDC at the canonical address.
///
/// Authored offline by `scripts/devnet/snapshot-fork.sh` and
/// consumed both here (fork-e2e harness) and by
/// `testing/smoke-test/src/genesis_alloc.rs`.
const USDC_STORAGE_SEED_REL: &str = "testing/fixtures/fork-state/usdc-storage-seed.json";

/// Typed view over the committed USDC storage seed JSON. Kept
/// minimal — we only consume `proxy.storage` and `implementation.*`;
/// any other top-level fields (`fork_block`, `chain`, ...) are
/// metadata for humans and are ignored here.
#[derive(Debug, Clone, Deserialize)]
struct UsdcStorageSeed {
    proxy: UsdcProxySeed,
    implementation: UsdcImplSeed,
}

#[derive(Debug, Clone, Deserialize)]
struct UsdcProxySeed {
    /// 0x-hex address of the proxy. Sanity-checked against
    /// [`addresses::USDC`] at load time.
    address: String,
    /// `slot_hex -> value_hex`. Preserves insertion order from the
    /// authored JSON so admin/impl slots are written before the
    /// implementation bytecode is installed.
    storage: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct UsdcImplSeed {
    /// 0x-hex address that the proxy's impl slot points to. We
    /// `anvil_setCode` the bytecode here so delegatecalls resolve.
    address: String,
    /// 0x-prefixed runtime bytecode for the implementation.
    code: String,
}

/// Compute the storage slot of `balances[holder]` for a Solidity
/// `mapping(address => uint256) balances` declared at base slot
/// `mapping_slot`. Per Solidity layout: `slot =
/// keccak256(abi.encode(key, base_slot))`, where key (address) is
/// left-padded to 32 bytes and base_slot is a uint256.
///
/// FiatTokenV1 / FiatTokenV2_x declare `balances` at slot 9 on the
/// Base USDC proxy — kept as the caller's responsibility so this
/// helper is reusable for any USDC-shaped ERC20 storage layout.
fn balances_mapping_slot(holder: Address, mapping_slot: u64) -> B256 {
    let mut buf = [0u8; 64];
    buf[12..32].copy_from_slice(holder.as_slice());
    buf[63] = mapping_slot as u8;
    // u64 mapping_slot fits in the low byte for all in-use slots
    // (1..32); cover the remaining bytes for safety.
    let slot_be = mapping_slot.to_be_bytes();
    buf[56..64].copy_from_slice(&slot_be);
    B256::from(keccak256(buf))
}

/// Pack a [`U256`] into a 32-byte storage word (big-endian).
fn u256_to_b256(v: U256) -> B256 {
    B256::from(v.to_be_bytes::<32>())
}

impl UsdcStorageSeed {
    /// Read + parse the seed at the canonical workspace-relative
    /// path. Returns a clear `HarnessError::Rpc` (carrying the path)
    /// if the file is missing or malformed — the fork-e2e suite has
    /// no other way of working around this so a hard failure here
    /// is the right outcome.
    fn load_default() -> Result<Self, HarnessError> {
        let path = workspace_root()
            .map(|r| r.join(USDC_STORAGE_SEED_REL))
            .ok_or_else(|| {
                HarnessError::Rpc(format!(
                    "usdc-storage-seed: workspace root not found while resolving {USDC_STORAGE_SEED_REL}"
                ))
            })?;
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            HarnessError::Rpc(format!("usdc-storage-seed: read {}: {e}", path.display()))
        })?;
        let seed: UsdcStorageSeed = serde_json::from_str(&raw).map_err(|e| {
            HarnessError::Rpc(format!("usdc-storage-seed: parse {}: {e}", path.display()))
        })?;
        // Sanity: the seed must describe the canonical Base USDC
        // proxy, otherwise we would silently corrupt a different
        // account's storage on the fork.
        let got: Address =
            seed.proxy.address.parse().map_err(|e| {
                HarnessError::Rpc(format!("usdc-storage-seed: bad proxy address: {e}"))
            })?;
        if got != addresses::USDC {
            return Err(HarnessError::Rpc(format!(
                "usdc-storage-seed: proxy address mismatch: seed {got:#x} vs canonical USDC {:#x}",
                addresses::USDC
            )));
        }
        Ok(seed)
    }
}

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
    /// Boot a fresh Anvil backend.
    ///
    /// Prefers `RMPC_FORK_RPC_URL` (live upstream fork) when set. Falls back to
    /// `testing/fixtures/fork-state/CURRENT.anvil-state` (checked-in snapshot) so
    /// CI never needs the secret. Returns [`HarnessError::SkipNoRpc`] only when
    /// neither is available.
    pub fn new() -> Result<Self, HarnessError> {
        if which::which("anvil").is_err() {
            return Err(HarnessError::AnvilMissing);
        }

        let upstream = std::env::var("RMPC_FORK_RPC_URL")
            .ok()
            .filter(|v| !v.is_empty());

        let port = pick_free_port()?;
        let rpc_url = format!("http://127.0.0.1:{port}");

        let (mut cmd, pin, rpc_label) = if let Some(ref url) = upstream {
            // Live fork path: --fork-url + --fork-block-number
            let pin = resolve_fork_pin(url)?;
            let mut c = Command::new("anvil");
            c.arg("--port")
                .arg(port.to_string())
                .arg("--fork-url")
                .arg(url)
                .arg("--fork-block-number")
                .arg(pin.block.to_string())
                .arg("--chain-id")
                .arg(BASE_CHAIN_ID.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let label = sanitize_rpc_label(url);
            (c, pin, label)
        } else {
            // Fixture path: --load-state from checked-in snapshot
            let state = fixture_state_path().ok_or(HarnessError::SkipNoRpc)?;
            let meta_path = workspace_root()
                .map(|r| r.join(FIXTURE_META_REL))
                .filter(|p| p.exists());
            let meta_json = meta_path
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            let block = meta_json
                .as_ref()
                .and_then(|v| v["fork_block"].as_u64())
                .unwrap_or(0);
            let chain_id = meta_json
                .as_ref()
                .and_then(|v| v["chain_id"].as_u64())
                .unwrap_or(BASE_CHAIN_ID);
            let pin = ForkPin {
                block,
                source: PinSource::Pinned,
            };
            let mut c = Command::new("anvil");
            c.arg("--port")
                .arg(port.to_string())
                .arg("--load-state")
                .arg(&state)
                .arg("--chain-id")
                .arg(chain_id.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            (c, pin, "fixture".to_string())
        };

        let child = cmd
            .spawn()
            .map_err(|e| HarnessError::AnvilChild(format!("spawn anvil: {e}")))?;

        let rpc = Rpc::new(&rpc_url);
        let mut backend = Some(child);

        if let Err(e) = wait_for_rpc_url(&rpc_url, Duration::from_secs(20)) {
            if let Some(mut c) = backend.take() {
                let _ = c.kill();
            }
            return Err(e);
        }

        let cid: u64 = rpc.chain_id()?;
        if cid != BASE_CHAIN_ID {
            if let Some(mut c) = backend.take() {
                let _ = c.kill();
            }
            return Err(HarnessError::Rpc(format!(
                "fork chain id {cid} != BASE_CHAIN_ID {BASE_CHAIN_ID}"
            )));
        }

        let fx = ForkFixture {
            backend,
            rpc_url,
            rpc_label,
            pin,
            rpc,
            tx_hashes: Mutex::new(Vec::new()),
        };
        fx.apply_usdc_storage_seed()?;
        Ok(fx)
    }

    /// Apply the canonical Base USDC storage seed to the proxy on the
    /// running anvil backend so the forked USDC behaves like the
    /// production token.
    ///
    /// Background (issue #249): the checked-in `--load-state` fixture
    /// captures the USDC `FiatTokenProxy` runtime bytecode but NOT its
    /// admin / implementation / token-config storage (those slots are
    /// lazy-fetched on demand against the live upstream, and `anvil
    /// --dump-state` only persists *modified* accounts). On the
    /// fixture, the admin slot, implementation slot, name/symbol
    /// slots, and balances are all `address(0)` / empty. Two
    /// symptoms follow:
    ///   1. `ifAdmin` collision — `eth_call` with the default
    ///      `from = address(0)` matches the empty admin slot, and the
    ///      proxy reverts non-admin selectors with `"Cannot call
    ///      fallback function from the proxy admin"` before reaching
    ///      any implementation.
    ///   2. Empty delegatecall target — even after the admin slot is
    ///      repaired, the `DELEGATECALL` resolves to `address(0)` and
    ///      returns `0x` (no revert), which downstream callers decode
    ///      as a buffer overrun.
    ///
    /// rmpc is the production client and must never spoof `from` or
    /// branch on environment — so the fix is fully inside the fork
    /// fixture: load `testing/fixtures/fork-state/usdc-storage-seed.json`
    /// (the same artifact consumed by `testing/smoke-test` for its
    /// genesis-alloc devnet) and replay each slot with
    /// `anvil_setStorageAt`, plus `anvil_setCode` for the
    /// implementation contract pointed to by the proxy's impl slot.
    ///
    /// Idempotent / safe on live forks: if the proxy admin slot is
    /// already non-zero (e.g. a live `RMPC_FORK_RPC_URL` upstream
    /// where the real admin is set), the seed is skipped entirely.
    fn apply_usdc_storage_seed(&self) -> Result<(), HarnessError> {
        // If the upstream has already populated the admin slot, the
        // forked USDC is real; do nothing.
        let admin_before = self
            .rpc
            .get_storage_at(addresses::USDC, USDC_PROXY_ADMIN_SLOT)?;
        if admin_before != B256::ZERO {
            return Ok(());
        }

        let seed = UsdcStorageSeed::load_default()?;

        // 1. Apply proxy storage slots (admin, impl, owner, name,
        //    symbol, decimals, totalSupply, ...). The admin and impl
        //    slots together break both symptoms above.
        for (slot_hex, value_hex) in &seed.proxy.storage {
            let slot = parse_b256(slot_hex)?;
            let value = parse_b256(value_hex)?;
            self.rpc.set_storage_at(addresses::USDC, slot, value)?;
        }

        // 2. Install the implementation contract bytecode at the
        //    address recorded in the proxy's impl slot so the
        //    `DELEGATECALL` from the proxy resolves to real code.
        let impl_addr: Address = seed
            .implementation
            .address
            .parse()
            .map_err(|e| HarnessError::Rpc(format!("seed: bad impl address: {e}")))?;
        let impl_code = decode_hex_bytes(&seed.implementation.code)?;
        self.rpc.set_code(impl_addr, impl_code)?;

        // 3. Seed the whale with a large USDC balance so the
        //    existing `fund_usdc` helper (which impersonates
        //    [`addresses::USDC_WHALE`] and runs `transfer`) keeps
        //    working unchanged. The seed's storage replay does NOT
        //    include any balances (the upstream fixture only holds
        //    token-config slots), so without this step every
        //    whale-funded test would observe `balanceOf(whale) == 0`
        //    and fail with `transfer: insufficient balance`.
        //
        //    `balances` lives at FiatTokenV1 storage slot 9; the slot
        //    holding `balances[holder]` is
        //    `keccak256(abi.encode(holder, 9))`. We grant the whale
        //    `u128::MAX` units (≈ 3.4e20 USDC) — far above any
        //    per-test funding amount, and well below `u256::MAX` so
        //    `totalSupply` increments don't wrap.
        let whale_balance_slot = balances_mapping_slot(addresses::USDC_WHALE, 9);
        let whale_grant = U256::from(u128::MAX);
        self.rpc.set_storage_at(
            addresses::USDC,
            whale_balance_slot,
            u256_to_b256(whale_grant),
        )?;

        // 4. Regression guard: after replay the admin slot MUST be
        //    non-zero. If it isn't, the proxy admin collision will
        //    silently come back — fail loudly here instead of
        //    surfacing as an opaque ABI-decode error in rmpc.
        let admin_after = self
            .rpc
            .get_storage_at(addresses::USDC, USDC_PROXY_ADMIN_SLOT)?;
        if admin_after == B256::ZERO {
            return Err(HarnessError::Rpc(format!(
                "USDC proxy admin slot at {:?} still resolves to address(0) after applying usdc-storage-seed.json — fork-fixture repair failed (issue #249)",
                USDC_PROXY_ADMIN_SLOT
            )));
        }
        Ok(())
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

    /// Deploy a contract. `initcode` = constructor bytecode + ABI-encoded
    /// constructor arguments concatenated. Returns the deployed contract address
    /// from the receipt's `contractAddress` field.
    pub fn deploy(&self, initcode: Bytes, gas_limit: u64) -> Result<Address, HarnessError> {
        let nonce = self.rpc.tx_count(self.address)?;
        let (max_fee, max_prio) = self.rpc.fees()?;

        let tx = TxEip1559 {
            chain_id: self.chain_id,
            nonce,
            gas_limit,
            max_fee_per_gas: max_fee,
            max_priority_fee_per_gas: max_prio,
            to: TxKind::Create,
            value: U256::ZERO,
            access_list: Default::default(),
            input: initcode,
        };

        let sig = sign_eip1559(&tx, &self.signer);
        let envelope = TxEnvelope::Eip1559(tx.into_signed(sig));
        let mut buf = Vec::with_capacity(4096);
        envelope.encode_2718(&mut buf);
        let raw_hex = format!("0x{}", hex::encode(&buf));

        let hash = self.rpc.send_raw(&raw_hex)?;
        self.tx_hashes.lock().unwrap().push(hash);
        let r = self.rpc.wait_for_receipt(hash, Duration::from_secs(20))?;
        if r.status != 1 {
            return Err(HarnessError::Reverted(format!(
                "deploy tx {hash:?} reverted (gasUsed={})",
                r.gas_used
            )));
        }
        r.contract_address.ok_or_else(|| {
            HarnessError::Rpc(format!(
                "deploy tx {hash:?} succeeded but contractAddress is missing in receipt"
            ))
        })
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

    /// On-chain `VaultRegistry` interface (contracts/VaultRegistry.sol).
    /// Used by the registry fork-e2e scenarios to call registerVault,
    /// setVaultStatus, listVaults, and getVault directly via JSON-RPC
    /// without going through the rmpc binary's separate ABI binding.
    #[allow(missing_docs)]
    interface IOnchainVaultRegistry {
        enum VaultStatus { Active, Paused, Retired }

        struct VaultMetadata {
            string name;
            address asset;
            uint256 registeredAt;
        }

        /// Register a new vault. Caller must hold ADMIN_ROLE.
        function registerVault(address vault, VaultMetadata calldata metadata) external;

        /// Update a vault's lifecycle status. Caller must hold ADMIN_ROLE.
        function setVaultStatus(address vault, VaultStatus newStatus) external;

        /// Return all registered vault addresses in registration order.
        function listVaults() external view returns (address[] memory);

        /// Return full metadata and current status for a registered vault.
        function getVault(address vault)
            external view
            returns (VaultMetadata memory metadata, VaultStatus status);

        /// Number of registered vaults.
        function vaultCount() external view returns (uint256);
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
        function activeAdapterCount() external view returns (uint256);
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

/// One entry in a transaction's event log.
#[derive(Debug, Clone)]
pub struct Log {
    /// The emitting contract address.
    pub address: Address,
    /// Indexed topics (topic0 = event signature hash).
    pub topics: Vec<B256>,
    /// Non-indexed ABI-encoded data.
    pub data: Bytes,
}

#[derive(Debug, Clone)]
pub struct Receipt {
    pub status: u64,
    pub gas_used: u64,
    pub tx_hash: B256,
    /// Address of the newly deployed contract (only set for CREATE transactions).
    pub contract_address: Option<Address>,
    /// Event logs emitted by this transaction.
    pub logs: Vec<Log>,
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
        let _: serde_json::Value = self.rpc(
            "anvil_setBalance",
            serde_json::json!([fmt_addr(addr), format!("0x{:x}", wei)]),
        )?;
        Ok(())
    }

    /// Write a 32-byte word into `addr`'s storage at `slot`.
    /// Thin wrapper over `anvil_setStorageAt`. Used by the fixture
    /// to repair transparent-proxy admin slots that resolve to
    /// `address(0)` on the forked state (see #249).
    pub fn set_storage_at(
        &self,
        addr: Address,
        slot: B256,
        value: B256,
    ) -> Result<(), HarnessError> {
        let _: serde_json::Value = self.rpc(
            "anvil_setStorageAt",
            serde_json::json!([
                fmt_addr(addr),
                format!("{:#x}", slot),
                format!("{:#x}", value),
            ]),
        )?;
        Ok(())
    }

    /// Install runtime `code` at `addr`. Thin wrapper over
    /// `anvil_setCode`. Used by the fixture to materialise the
    /// USDC implementation contract that the proxy delegates to
    /// (see [`ForkFixture::apply_usdc_storage_seed`], issue #249).
    pub fn set_code(&self, addr: Address, code: Bytes) -> Result<(), HarnessError> {
        let _: serde_json::Value = self.rpc(
            "anvil_setCode",
            serde_json::json!([fmt_addr(addr), format!("0x{}", hex::encode(&code))]),
        )?;
        Ok(())
    }

    /// Read a 32-byte word from `addr`'s storage at `slot`.
    /// Thin wrapper over `eth_getStorageAt`. Used by the fixture
    /// to verify proxy-admin repair stuck (see #249).
    pub fn get_storage_at(&self, addr: Address, slot: B256) -> Result<B256, HarnessError> {
        let s: String = self.rpc(
            "eth_getStorageAt",
            serde_json::json!([fmt_addr(addr), format!("{:#x}", slot), "latest"]),
        )?;
        parse_b256(&s)
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

                // Parse optional contractAddress (only present for CREATE txs).
                let contract_address = resp
                    .get("contractAddress")
                    .and_then(|v| v.as_str())
                    .filter(|s| *s != "null" && !s.is_empty())
                    .and_then(|s| s.parse::<Address>().ok());

                // Parse logs array.
                let logs = resp
                    .get("logs")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|entry| {
                                let address = entry
                                    .get("address")
                                    .and_then(|v| v.as_str())
                                    .and_then(|s| s.parse::<Address>().ok())?;
                                let topics = entry
                                    .get("topics")
                                    .and_then(|v| v.as_array())
                                    .map(|ts| {
                                        ts.iter()
                                            .filter_map(|t| {
                                                t.as_str().and_then(|s| parse_b256(s).ok())
                                            })
                                            .collect::<Vec<_>>()
                                    })
                                    .unwrap_or_default();
                                let data = entry
                                    .get("data")
                                    .and_then(|v| v.as_str())
                                    .and_then(|s| decode_hex_bytes(s).ok())
                                    .unwrap_or_default();
                                Some(Log {
                                    address,
                                    topics,
                                    data,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                return Ok(Receipt {
                    status: u64::from_str_radix(status.trim_start_matches("0x"), 16).unwrap_or(0),
                    gas_used: u64::from_str_radix(gas_used.trim_start_matches("0x"), 16)
                        .unwrap_or(0),
                    tx_hash: hash,
                    contract_address,
                    logs,
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

    /// Advance the EVM clock by `seconds` seconds and produce a new block.
    /// Thin wrappers over `evm_increaseTime` + `evm_mine` — the standard
    /// Hardhat/Anvil time-travel pattern.
    pub fn evm_increase_time(&self, seconds: u64) -> Result<(), HarnessError> {
        let _: serde_json::Value = self.rpc("evm_increaseTime", serde_json::json!([seconds]))?;
        let _: serde_json::Value = self.rpc("evm_mine", serde_json::json!([]))?;
        Ok(())
    }

    /// Raw JSON-RPC call — exposed for test helpers that need methods not
    /// wrapped by named helpers (e.g. `evm_increaseTime`). The `T` bound
    /// lets callers assert on the return type; use `serde_json::Value` to
    /// accept any JSON.
    pub fn rpc_raw<T: for<'de> serde::Deserialize<'de>>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, HarnessError> {
        self.rpc(method, params)
    }

    /// Take an EVM state snapshot. Returns the snapshot ID.
    pub fn evm_snapshot(&self) -> Result<B256, HarnessError> {
        let s: String = self.rpc("evm_snapshot", serde_json::json!([]))?;
        parse_b256(&format!("0x{:0>64}", s.trim_start_matches("0x")))
    }

    /// Revert the EVM to the snapshot identified by `snapshot_id`.
    pub fn evm_revert(&self, snapshot_id: B256) -> Result<bool, HarnessError> {
        let r: bool = self.rpc(
            "evm_revert",
            serde_json::json!([format!("{:#x}", snapshot_id)]),
        )?;
        Ok(r)
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
    test_utils::pick_free_port().map_err(|e| HarnessError::AnvilChild(format!("pick port: {e}")))
}

fn wait_for_rpc_url(url: &str, timeout: Duration) -> Result<(), HarnessError> {
    test_utils::wait_for_rpc(url, timeout).map_err(HarnessError::AnvilChild)
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
