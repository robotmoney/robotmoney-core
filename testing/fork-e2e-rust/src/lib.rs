//! Canonical: Plan tracking issue #109 §8 — Phase 2 Forked Smart-Contract E2E.
//! Decision record: docs/technical/fork-e2e-decisions.md (issue #47).
//! Implements: issue #48.
//!
//! Forked-Base end-to-end harness for Robot Money. Each test boots
//! its own `anvil --fork-url $RMPC_FORK_RPC_URL --fork-block-number
//! $RMPC_FORK_BLOCK` backend (per §3.5 of the ADR, fork-restart per
//! test, no shared backend), creates an ephemeral secp256k1 signer,
//! funds the resulting EOA with ETH (via `anvil_setBalance`) and USDC
//! (via direct storage-slot writes), then exercises the deployed
//! Robot Money contracts plus the surrounding USDC / DEX state.
//!
//! `RMPC_FORK_RPC_URL` may be a real archive endpoint or the Twin fork (core 1498): the Twin chain
//! is a pinned lazy fork of real Base state, and anvil can fork it again. `RMPC_TESTNET_RPC_URL`
//! connects straight to a running Twin fork instead. There is no saved state fixture.
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
//! - [`addresses`] module — Base contract addresses, parsed
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
/// Dev-scout module for Base testnet e2e infrastructure (issue #842).
/// Multi-network parameter configuration and integration seams for issue #839.
pub mod base_testnet;
/// Deployed contract addresses for Base's public testnet (currently Sepolia, chain 84532).
/// Mirror of [`addresses`] for the parameterized multi-network e2e tests
/// (issue #839).
pub mod base_testnet_addresses;
/// The vault a test deploys for itself through the stage scripts (clean room rule, core 1498).
pub mod deployed;
pub mod scenarios;

// -- Deployed addresses module is re-exported for ergonomic use ----

pub use addresses::BASE_ADDRESSES;
pub use base_testnet::{Network, TestnetFundingConfig};

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
            // Issue 1643: a skip is a pass with zero assertions. In CI the fork is always wired
            // in, so its absence is a broken job and must be red. Locally (CI unset) it still
            // skips so a contributor without a fork can run the crate.
            if $crate::skip_is_fatal() {
                panic!(
                    "[fork-e2e] CI is set but no fork is available (no RMPC_TESTNET_RPC_URL and no \
                     usable RMPC_FORK_RPC_URL with anvil). Refusing to skip: a skipped fork test \
                     is a false green."
                );
            }
            eprintln!(
                "[fork-e2e] skipping: no RMPC_TESTNET_RPC_URL and no RMPC_FORK_RPC_URL. \
                 Point RMPC_TESTNET_RPC_URL at a running Twin fork (anvil on real Base state), \
                 or RMPC_FORK_RPC_URL at an upstream for a fresh local fork \
                 (install Foundry: https://getfoundry.sh)."
            );
            return;
        }
    };
}

/// Skip the test when it runs directly on the shared Twin fork (`RMPC_TESTNET_RPC_URL` is set).
/// Use this for tests that move time or rewind state: warping the shared Twin would leak into
/// every other test. The test still runs against its own `RMPC_FORK_RPC_URL` fork.
#[macro_export]
macro_rules! skip_in_testnet_mode {
    () => {
        if std::env::var("RMPC_TESTNET_RPC_URL")
            .map(|v| !v.is_empty())
            .unwrap_or(false)
        {
            eprintln!(
                "[fork-e2e] skipping: RMPC_TESTNET_RPC_URL is set (testnet mode). \
                 This test moves chain time, which must not leak into the shared Twin fork. \
                 Run it against its own fork (RMPC_FORK_RPC_URL) to exercise it."
            );
            return;
        }
    };
}

/// Skip the test unless a live forked-Base RPC is available via
/// `RMPC_FORK_RPC_URL`. Use this for tests that read storage from
/// production Base contracts (e.g. `abi_address_sanity`),
/// which require real Base state (the Twin fork or any upstream archive).
#[macro_export]
macro_rules! skip_if_no_devnet_fork {
    () => {
        // Issue 1656: like `skip_if_no_fork!`, a missing fork is a panic when CI is set (a skip is
        // a pass with zero assertions) and a quiet skip locally.
        if !$crate::devnet_fork_available_or_skip() {
            return;
        }
    };
}

/// Run a single e2e test body once per [`Network`] (issue #839, decision D3:
/// comprehensive coverage across networks "using parameterized fixtures and
/// shared test templates to avoid code duplication"). The body receives a
/// `network: Network` binding and a booted [`ForkFixture`] bound to that
/// network; it is invoked once for [`Network::RobotMoneyDevnet`] and once for
/// [`Network::BaseTestnet`].
///
/// A network whose RPC endpoint is unavailable
/// ([`HarnessError::SkipNoRpc`]) is skipped with an `eprintln!` line rather
/// than failing — so `cargo test` on a contributor laptop (no testnet secret)
/// still passes, and CI that *does* set `BASE_TESTNET_RPC_URL` exercises the
/// live path. At least one network must successfully boot, otherwise the test
/// is a no-op skip (the same graceful-skip contract every fork-e2e test
/// honours).
///
/// # Example
/// ```ignore
/// parameterized_e2e!(dex_route, |network, fx| {
///     // single body runs once per network; `fx` is bound to `network`.
///     assert_eq!(fx.chain_id, network.chain_id());
/// });
/// ```
#[macro_export]
macro_rules! parameterized_e2e {
    ($name:ident, $body:expr) => {
        #[test]
        fn $name() {
            let run = |network: $crate::Network, fx: $crate::ForkFixture| {
                let f: &dyn Fn($crate::Network, $crate::ForkFixture) = &$body;
                f(network, fx);
            };
            let mut ran = 0usize;
            for &network in $crate::Network::ALL {
                match $crate::ForkFixture::for_network(network) {
                    Ok(fx) => {
                        eprintln!(
                            "[{}] running on {} (chain_id={})",
                            stringify!($name),
                            network.name(),
                            fx.chain_id
                        );
                        run(network, fx);
                        ran += 1;
                    }
                    Err(e) if e.is_skip() => {
                        eprintln!(
                            "[{}] skipping {}: RPC endpoint not configured",
                            stringify!($name),
                            network.name()
                        );
                    }
                    Err(e) => panic!(
                        "[{}] {} boot failed: {e}",
                        stringify!($name),
                        network.name()
                    ),
                }
            }
            if ran == 0 {
                eprintln!(
                    "[{}] no network RPC configured; set RMPC_FORK_RPC_URL / \
                     RMPC_TESTNET_RPC_URL (devnet) or BASE_TESTNET_RPC_URL (testnet) to run.",
                    stringify!($name)
                );
            }
        }
    };
}

/// True when `ci` (the value of the `CI` env var) marks a CI run: set and non-empty, and not a
/// literal false. GitHub Actions sets `CI=true`.
pub fn ci_value_is_ci(ci: Option<&str>) -> bool {
    match ci {
        Some(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "false" || v == "0")
        }
        None => false,
    }
}

/// True when an unavailable fork must fail the test instead of skipping it (issue 1643).
pub fn skip_is_fatal() -> bool {
    ci_value_is_ci(std::env::var("CI").ok().as_deref())
}

/// Decision core of [`skip_if_no_devnet_fork!`] (issue 1656), split from the environment reads so
/// it is unit-testable. `true` means run, `false` means skip, and a missing fork under CI panics.
pub fn devnet_fork_gate(ci: Option<&str>, anvil_on_path: bool, fork_url: Option<&str>) -> bool {
    let have_url = fork_url.map(|v| !v.is_empty()).unwrap_or(false);
    if anvil_on_path && have_url {
        return true;
    }
    if ci_value_is_ci(ci) {
        panic!(
            "[fork-e2e] CI is set but no devnet fork is available (needs anvil on PATH and \
             RMPC_FORK_RPC_URL). Refusing to skip: a skipped fork test is a false green."
        );
    }
    eprintln!(
        "[fork-e2e] skipping: RMPC_FORK_RPC_URL not set. \
         This test requires a live Base archive RPC."
    );
    false
}

/// Environment-reading wrapper over [`devnet_fork_gate`] used by [`skip_if_no_devnet_fork!`].
pub fn devnet_fork_available_or_skip() -> bool {
    devnet_fork_gate(
        std::env::var("CI").ok().as_deref(),
        which::which("anvil").is_ok(),
        std::env::var("RMPC_FORK_RPC_URL").ok().as_deref(),
    )
}

/// Returns true iff the harness can run fork-e2e tests: `RMPC_TESTNET_RPC_URL` (the shared Twin
/// fork, no second anvil) or `RMPC_FORK_RPC_URL` (an upstream for a fresh local anvil fork, the
/// Twin fork included).
pub fn can_run() -> bool {
    if std::env::var("RMPC_TESTNET_RPC_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    which::which("anvil").is_ok()
        && std::env::var("RMPC_FORK_RPC_URL")
            .map(|v| !v.is_empty())
            .unwrap_or(false)
}

// -- Configuration -------------------------------------------------

/// Default block lag for "latest minus N" mode when
/// `RMPC_FORK_BLOCK` is unset. Matches §3.2 of the ADR.
const LOCAL_LAG_BLOCKS: u64 = 50;

/// Base chain id. Hard-coded — Phase 2 only targets Base
/// per §3.1 of the ADR.
pub const BASE_CHAIN_ID: u64 = 8453;

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
    /// Actual chain_id returned by the connected backend. For anvil forks this
    /// is the Twin chain id (918453), for the child fork and the shared Twin fork alike.
    /// All transactions signed against this fixture MUST use this chain_id.
    pub chain_id: u64,
    rpc: Rpc,
    /// Captured tx hashes for output; kept under a Mutex so
    /// scenarios can append from any helper.
    tx_hashes: Mutex<Vec<B256>>,
    /// This fixture's own vault, deployed on first use through the vault stage (or read from the
    /// publish contracts manifest). Never a production address.
    deployed: std::sync::OnceLock<Result<deployed::DeployedVault, String>>,
}

impl ForkFixture {
    /// Boot a fresh fixture backend.
    ///
    /// Mode selection (in priority order):
    /// 1. `RMPC_TESTNET_RPC_URL` — connect directly to the shared Twin fork (anvil on real Base
    ///    state, chain id 918453). No second anvil. Accounts are funded with the anvil admin RPCs.
    /// 2. `RMPC_FORK_RPC_URL` — a fresh local `anvil --fork-url` of that upstream (a real archive
    ///    endpoint, or the Twin fork itself) at a pinned block, chain id 918453 (the Twin chain id: the
    ///    clean-room vault deploy refuses 8453, so the child fork always carries the Twin id).
    ///
    /// Returns [`HarnessError::SkipNoRpc`] when neither is set. There is no saved state fixture.
    pub fn new() -> Result<Self, HarnessError> {
        // Shared Twin fork: no anvil child.
        if let Ok(url) = std::env::var("RMPC_TESTNET_RPC_URL") {
            if !url.is_empty() {
                return Self::new_testnet(&url);
            }
        }

        if which::which("anvil").is_err() {
            return Err(HarnessError::AnvilMissing);
        }

        let url = std::env::var("RMPC_FORK_RPC_URL")
            .ok()
            .filter(|v| !v.is_empty())
            .ok_or(HarnessError::SkipNoRpc)?;

        let port = pick_free_port()?;
        let rpc_url = format!("http://127.0.0.1:{port}");

        let pin = resolve_fork_pin(&url)?;
        let mut cmd = Command::new("anvil");
        cmd.arg("--port")
            .arg(port.to_string())
            .arg("--fork-url")
            .arg(&url)
            .arg("--fork-block-number")
            .arg(pin.block.to_string())
            .arg("--chain-id")
            .arg(deployed::TWIN_CHAIN_ID.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let rpc_label = sanitize_rpc_label(&url);

        let child = cmd
            .spawn()
            .map_err(|e| HarnessError::AnvilChild(format!("spawn anvil: {e}")))?;

        let rpc = Rpc::new(&rpc_url);
        let mut backend = Some(child);

        if let Err(e) = wait_for_rpc_url(&rpc_url, Duration::from_secs(60)) {
            if let Some(mut c) = backend.take() {
                let _ = c.kill();
            }
            return Err(e);
        }

        let cid: u64 = rpc.chain_id()?;
        if cid != deployed::TWIN_CHAIN_ID {
            if let Some(mut c) = backend.take() {
                let _ = c.kill();
            }
            return Err(HarnessError::Rpc(format!(
                "fork chain id {cid} != Twin chain id {}",
                deployed::TWIN_CHAIN_ID
            )));
        }

        Ok(ForkFixture {
            backend,
            rpc_url,
            rpc_label,
            pin,
            chain_id: deployed::TWIN_CHAIN_ID,
            rpc,
            tx_hashes: Mutex::new(Vec::new()),
            deployed: std::sync::OnceLock::new(),
        })
    }

    /// Boot a fixture for a specific [`Network`] (issue #839 multi-network e2e).
    ///
    /// - [`Network::RobotMoneyDevnet`] delegates to [`Self::new`] — anvil-fork or the
    ///   checked-in fixture, exactly as the existing Phase 2 scenarios use.
    /// - [`Network::BaseTestnet`] connects **directly** to the live Base
    ///   public testnet (currently Sepolia) RPC named by `BASE_TESTNET_RPC_URL`
    ///   (no anvil, no fork). The connected
    ///   endpoint's chain id is verified to equal [`Network::chain_id`] so a
    ///   mis-pointed RPC fails loudly.
    ///
    /// Returns [`HarnessError::SkipNoRpc`] when the network's RPC endpoint is
    /// unset — callers (and the [`crate::parameterized_e2e`] macro) treat that
    /// as a graceful skip, never a failure.
    pub fn for_network(network: Network) -> Result<Self, HarnessError> {
        match network {
            Network::RobotMoneyDevnet => {
                // Live third-party service tests (Aave, Uniswap, Curve pools) need real Base state:
                // the Twin fork (RMPC_TESTNET_RPC_URL) or an upstream (RMPC_FORK_RPC_URL).
                // `new` returns SkipNoRpc when neither is set.
                Self::new()
            }
            Network::BaseTestnet => {
                let url = network.rpc_url().ok_or(HarnessError::SkipNoRpc)?;
                let fx = Self::new_live(&url)?;
                if fx.chain_id != network.chain_id() {
                    return Err(HarnessError::Rpc(format!(
                        "BASE_TESTNET_RPC_URL reports chain id {} but {} expects {} — \
                         endpoint points at the wrong chain",
                        fx.chain_id,
                        network.name(),
                        network.chain_id()
                    )));
                }
                Ok(fx)
            }
        }
    }

    /// Connect to a live external chain at `url` (e.g. Base's public testnet). No anvil
    /// is spawned and no admin RPCs (`anvil_*`) are used — only standard
    /// JSON-RPC. Account funding on such a chain must go through a pre-funded
    /// EOA / faucet (see [`Self::ephemeral_testnet`]); the `anvil_setBalance`
    /// path is unavailable. Shares the read/transport plumbing with
    /// [`Self::new_testnet`].
    fn new_live(url: &str) -> Result<Self, HarnessError> {
        Self::new_testnet(url)
    }

    /// Connect directly to a running chain at `url` (the shared Twin fork, or Base's public
    /// testnet through [`Self::new_live`]). No anvil child is spawned. USDC is the real token on
    /// real Base state, so nothing is seeded.
    fn new_testnet(url: &str) -> Result<Self, HarnessError> {
        let rpc = Rpc::new(url);
        let block = rpc.block_number()?;
        let chain_id = rpc.chain_id()?;
        let pin = ForkPin {
            block,
            source: PinSource::LatestMinusN,
        };
        Ok(ForkFixture {
            backend: None,
            rpc_url: url.to_string(),
            rpc_label: sanitize_rpc_label(url),
            pin,
            chain_id,
            rpc,
            tx_hashes: Mutex::new(Vec::new()),
            deployed: std::sync::OnceLock::new(),
        })
    }

    /// Build a fresh ephemeral account funded with ETH and (optionally) USDC.
    ///
    /// Uses the anvil admin RPCs (`anvil_setBalance`, `anvil_setStorageAt` on the real USDC
    /// balance slot). Both the shared Twin fork and a local fork are anvil. These are the Twin
    /// chain environment steps (fund gas, fund USDC). A live external chain has no admin RPCs:
    /// use [`Self::ephemeral_testnet`] there.
    pub fn ephemeral(&self, eth_wei: U256, usdc_units: U256) -> Result<Account<'_>, HarnessError> {
        let signer = SigningKey::random(&mut rand_core::OsRng);
        let addr = derive_address(&signer);
        self.rpc.set_balance(addr, eth_wei)?;
        if usdc_units > U256::ZERO {
            self.fund_usdc(addr, usdc_units)?;
        }
        Ok(Account {
            signer,
            address: addr,
            fixture_rpc_url: self.rpc_url.clone(),
            chain_id: self.chain_id,
            rpc: self.rpc.clone(),
            tx_hashes: &self.tx_hashes,
        })
    }

    /// Build a fresh ephemeral account on a **live external chain** (Base's
    /// public testnet), funded by seeded transfers from a pre-funded funder EOA.
    ///
    /// On Base's public testnet there are no anvil admin RPCs, so the funder key is supplied via
    /// the `BASE_TESTNET_FUNDER_KEY` env var (a faucet-funded testnet EOA's
    /// private key). The funder sends `eth_wei` native ETH and, when
    /// `usdc_units > 0`, `usdc_units` of `usdc_token` to the new account.
    ///
    /// Returns [`HarnessError::SkipNoRpc`] when `BASE_TESTNET_FUNDER_KEY` is
    /// unset — without a funder we cannot seed an account on a real chain, so
    /// the dependent test skips gracefully rather than failing. (A deployed CI
    /// environment provides this secret alongside `BASE_TESTNET_RPC_URL`.)
    pub fn ephemeral_testnet(
        &self,
        usdc_token: Address,
        eth_wei: U256,
        usdc_units: U256,
    ) -> Result<Account<'_>, HarnessError> {
        let funder_key = std::env::var("BASE_TESTNET_FUNDER_KEY")
            .ok()
            .filter(|v| !v.is_empty())
            .ok_or(HarnessError::SkipNoRpc)?;

        let signer = SigningKey::random(&mut rand_core::OsRng);
        let addr = derive_address(&signer);
        self.fund_from_external_funder(&funder_key, usdc_token, addr, eth_wei, usdc_units)?;

        Ok(Account {
            signer,
            address: addr,
            fixture_rpc_url: self.rpc_url.clone(),
            chain_id: self.chain_id,
            rpc: self.rpc.clone(),
            tx_hashes: &self.tx_hashes,
        })
    }

    /// Seed `to` with native ETH and USDC by signing transfers from the
    /// `BASE_TESTNET_FUNDER_KEY` EOA. Uses only standard JSON-RPC.
    fn fund_from_external_funder(
        &self,
        funder_key_hex: &str,
        usdc_token: Address,
        to: Address,
        eth_wei: U256,
        usdc_units: U256,
    ) -> Result<(), HarnessError> {
        let key_hex = funder_key_hex.trim_start_matches("0x");
        let key_bytes = hex::decode(key_hex)
            .map_err(|e| HarnessError::Rpc(format!("BASE_TESTNET_FUNDER_KEY hex: {e}")))?;
        let key_arr: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| HarnessError::Rpc("BASE_TESTNET_FUNDER_KEY wrong length".into()))?;
        let funder_signer = SigningKey::from_bytes((&key_arr).into())
            .map_err(|e| HarnessError::Rpc(format!("funder signer: {e}")))?;
        let funder_addr = derive_address(&funder_signer);

        let funder_tx_hashes = Mutex::new(Vec::<B256>::new());
        let funder = Account {
            signer: funder_signer,
            address: funder_addr,
            fixture_rpc_url: self.rpc_url.clone(),
            chain_id: self.chain_id,
            rpc: self.rpc.clone(),
            tx_hashes: &funder_tx_hashes,
        };

        if eth_wei > U256::ZERO {
            funder.send_raw(to, alloy_primitives::Bytes::new(), eth_wei, 21_000)?;
        }
        if usdc_units > U256::ZERO {
            let call = IERC20::transferCall {
                to,
                amount: usdc_units,
            };
            funder.send(usdc_token, &call, U256::ZERO, 200_000)?;
        }
        Ok(())
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
            self.chain_id,
            self.pin.block,
            self.rpc_label,
            hex::encode(h)
        )
    }

    /// The vault this fixture's tests run against: deployed through the real vault stage on first
    /// call (or read from `RMPC_DEPLOY_MANIFEST`), then cached. Clean room rule (core 1498).
    pub fn deployed(&self) -> Result<&deployed::DeployedVault, HarnessError> {
        self.deployed
            .get_or_init(|| deployed::resolve(self).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| HarnessError::Rpc(e.clone()))
    }

    /// The chain's own clock (latest block timestamp). Build every deadline and policy expiry from
    /// this, never from the host wall clock: see [`Rpc::chain_now`].
    pub fn chain_now(&self) -> Result<u64, HarnessError> {
        self.rpc.chain_now()
    }

    /// Address of this fixture's own vault. Panics with the deploy error when the stage fails.
    pub fn vault(&self) -> Address {
        self.deployed().expect("deploy own vault").vault
    }

    /// Top up `addr` with `amount` USDC by writing directly to the
    /// FiatToken `balances` mapping slot (slot 9). This is the Twin chain
    /// environment step "fund USDC": robust to whale-balance drift, and the
    /// real token's own code then reads and spends the balance.
    pub fn fund_usdc(&self, addr: Address, amount: U256) -> Result<(), HarnessError> {
        let balance_slot = balances_mapping_slot(addr, 9);
        self.rpc
            .set_storage_at(addresses::USDC, balance_slot, u256_to_b256(amount))?;
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
        enum VaultStatus { Active, DepositsPaused, Retired }

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
        function depositsPaused() external view returns (bool);
        function symbol() external view returns (string memory);
        function decimals() external view returns (uint8);
        function activeAdapterCount() external view returns (uint256);
    }

    /// Basket vault interface — shared ERC-4626 surface of
    /// `ProtocolAssetVault` and `AgentTokenVault` that the fork-e2e
    /// round-trip test exercises. Selectors match `BasketVault` (the
    /// common base) and the two thin subclasses.
    ///
    /// Source: contracts/vaults/BasketVault.sol,
    ///         contracts/vaults/ProtocolAssetVault.sol,
    ///         contracts/vaults/AgentTokenVault.sol
    #[allow(missing_docs)]
    interface IBasketVault {
        /// ERC-4626 deposit: pull `assets` USDC from caller, mint shares to
        /// `receiver`. The vault swaps the USDC into the basket during deposit.
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        /// ERC-4626 redeem: burn `shares` owned by `owner` and deliver USDC to
        /// `receiver` after selling the proportional basket back to USDC.
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
        /// ERC-20 share balance.
        function balanceOf(address account) external view returns (uint256);
        /// Total USDC-denominated NAV of all held assets (TWAP-priced).
        function totalAssets() external view returns (uint256);
        /// Worst-case USDC floor for redeeming `shares` (TWAP × slippage × exit-fee).
        function previewRedeem(uint256 shares) external view returns (uint256);
        /// Maximum shares `owner` can redeem (returns `balanceOf(owner)` for
        /// BasketVault — a deposit pause never lowers it, core 1494).
        function maxRedeem(address owner) external view returns (uint256);
        /// ERC-4626 asset = USDC.
        function asset() external view returns (address);
        /// Exit fee in basis points (≤ 100, i.e. ≤ 1%).
        function exitFeeBps() external view returns (uint256);
        /// Maximum slippage in basis points applied to every swap leg.
        function maxSlippageBps() external view returns (uint256);
        /// Number of active basket assets.
        function activeAssetCount() external view returns (uint256);
        /// Register a new basket asset. ADMIN_ROLE only.
        /// `venue_` = 0 for Uniswap V3 (the only venue used in fork-e2e tests).
        function addAsset(address token_, address pool_, uint24 swapFee_, address adapter_, uint8 venue_) external;
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

    pub fn eth_get_balance(&self, addr: Address) -> Result<U256, HarnessError> {
        let s: String = self.rpc(
            "eth_getBalance",
            serde_json::json!([fmt_addr(addr), "latest"]),
        )?;
        U256::from_str_radix(s.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::Rpc(format!("eth_getBalance decode: {e}")))
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

    /// Send an unsigned tx as `from` — requires the node to have the account unlocked.
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
    /// (real USDC funded through its balance slot).
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

    pub fn wait_for_receipt(&self, hash: B256, timeout: Duration) -> Result<Receipt, HarnessError> {
        let start = Instant::now();
        loop {
            let resp: serde_json::Value = match self.rpc(
                "eth_getTransactionReceipt",
                serde_json::json!([format!("{:#x}", hash)]),
            ) {
                Ok(resp) => resp,
                // Geth has a brief window right after a block is mined
                // (especially just after devnet boot) where a tx is mined but
                // not yet indexed, so eth_getTransactionReceipt transiently
                // returns JSON-RPC error -32000 "transaction indexing is in
                // progress". Treat it exactly like a null/pending receipt:
                // honour the timeout, back off, and poll again. All other RPC
                // errors propagate immediately.
                Err(e) if is_indexing_transient(&e) => {
                    if start.elapsed() > timeout {
                        return Err(HarnessError::Rpc(format!(
                            "receipt for {hash:?} not seen within {timeout:?}"
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(150));
                    continue;
                }
                Err(e) => return Err(e),
            };
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

    /// The chain's own clock: the latest block timestamp, in seconds. Every deadline and policy
    /// expiry a test signs must be built from this, never from the host wall clock. The Twin fork
    /// continues time from the pin block's timestamp, so it trails the wall clock by the minutes
    /// between choosing the pin and starting the chain (more than the gateway's 600 s deadline
    /// skew on a busy runner).
    pub fn chain_now(&self) -> Result<u64, HarnessError> {
        let block: serde_json::Value =
            self.rpc("eth_getBlockByNumber", serde_json::json!(["latest", false]))?;
        let ts = block
            .get("timestamp")
            .and_then(|v| v.as_str())
            .ok_or_else(|| HarnessError::Rpc("latest block has no timestamp".into()))?;
        u64::from_str_radix(ts.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::Rpc(format!("bad block timestamp {ts}: {e}")))
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
}

// -- Helpers -------------------------------------------------------

/// Returns `true` iff `err` is Geth's transient "transaction indexing is in
/// progress" error (JSON-RPC code -32000). Right after a block is mined —
/// especially just after devnet boot — Geth reports a mined transaction as
/// not-yet-indexed for a brief window, so `eth_getTransactionReceipt`
/// transiently fails. [`Rpc::wait_for_receipt`] treats this like a pending
/// receipt instead of a hard failure. Matched narrowly on the stable
/// indexing-progress message substring so unrelated RPC errors still
/// propagate. The harness `rpc()` helper stringifies the full JSON-RPC error
/// object (code + message + data) into `HarnessError::Rpc`, so matching on the
/// substring covers both the message and `data` placements Geth uses.
fn is_indexing_transient(err: &HarnessError) -> bool {
    matches!(err, HarnessError::Rpc(msg) if msg.contains("indexing is in progress"))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Issue 1643: `CI=true` makes a missing fork fatal, an unset or false `CI` keeps the
    /// local skip.
    #[test]
    fn ci_value_decides_whether_a_missing_fork_is_fatal() {
        assert!(ci_value_is_ci(Some("true")));
        assert!(ci_value_is_ci(Some("1")));
        assert!(!ci_value_is_ci(Some("")));
        assert!(!ci_value_is_ci(Some("false")));
        assert!(!ci_value_is_ci(Some("0")));
        assert!(!ci_value_is_ci(None));
    }

    /// Issue 1656: `skip_if_no_devnet_fork!` panics under CI when the fork is absent and still
    /// skips locally. Removing the panic in `devnet_fork_gate` fails the `should_panic` tests.
    #[test]
    #[should_panic(expected = "Refusing to skip")]
    fn devnet_fork_gate_panics_in_ci_without_url() {
        devnet_fork_gate(Some("true"), true, None);
    }

    #[test]
    #[should_panic(expected = "Refusing to skip")]
    fn devnet_fork_gate_panics_in_ci_without_anvil() {
        devnet_fork_gate(Some("true"), false, Some("http://127.0.0.1:8545"));
    }

    #[test]
    #[should_panic(expected = "Refusing to skip")]
    fn devnet_fork_gate_panics_in_ci_with_empty_url() {
        devnet_fork_gate(Some("1"), true, Some(""));
    }

    #[test]
    fn devnet_fork_gate_skips_locally_and_runs_when_available() {
        assert!(!devnet_fork_gate(None, true, None));
        assert!(!devnet_fork_gate(Some("false"), false, Some("http://x")));
        assert!(devnet_fork_gate(None, true, Some("http://x")));
        assert!(devnet_fork_gate(Some("true"), true, Some("http://x")));
    }

    /// The transient-detection predicate that gates [`Rpc::wait_for_receipt`]'s
    /// retry: it must match Geth's "indexing is in progress" message (however
    /// `rpc()` stringifies the JSON-RPC error object) and nothing else, so the
    /// receipt-wait loop retries the indexing window but propagates every
    /// unrelated RPC error.
    #[test]
    fn is_indexing_transient_matches_geth_window_only() {
        // The harness `rpc()` helper formats the whole JSON-RPC error object
        // into the message; both the `message` and `data` placements Geth uses
        // carry the same substring.
        assert!(is_indexing_transient(&HarnessError::Rpc(
            "eth_getTransactionReceipt: {\"code\":-32000,\"message\":\"transaction indexing is in progress\"}".to_string(),
        )));
        assert!(is_indexing_transient(&HarnessError::Rpc(
            "eth_getTransactionReceipt: {\"code\":-32000,\"message\":\"the method ... is not available\",\"data\":\"transaction indexing is in progress\"}".to_string(),
        )));
        // Unrelated RPC error must not be treated as a transient.
        assert!(!is_indexing_transient(&HarnessError::Rpc(
            "eth_getTransactionReceipt: {\"code\":-32000,\"message\":\"execution reverted\"}"
                .to_string(),
        )));
        // A non-RPC harness error never matches.
        assert!(!is_indexing_transient(&HarnessError::BadForkBlock(
            "indexing is in progress".to_string()
        )));
    }
}
