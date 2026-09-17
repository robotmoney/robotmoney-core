//! Canonical: docs/development/smoke-test-design.md (Devnet section).
//!
//! Anvil chain backend for the smoke-test fixture.
//!
//! The default smoke-test chain is the Geth+Lighthouse Docker devnet
//! (`testing/ethereum-testnet/config/docker-compose.yaml`). That devnet runs
//! real proof-of-stake, so `block.timestamp` tracks wall clock 1:1 and no
//! amount of slot tuning lets a test jump past a governance timelock delay.
//! The Fusion QA run has to clear two one-hour delays, so it needs a chain
//! whose clock can be moved on command — that is Anvil
//! (`evm_setNextBlockTimestamp` / `evm_increaseTime`).
//!
//! This module is the Rust port of `scripts/devnet/boot-fork-state-anvil.sh`,
//! the canonical `--load-state` consumer in this repo. It boots Anvil from the
//! committed warmed Base fork state, replays the canonical USDC proxy storage
//! seed, stamps the devnet chain id, and funds the harness EOAs — so the same
//! `forge script Deploy` path the Geth fixture runs works unchanged.
//!
//! Lifecycle contract (mirrors the Geth chain fixture inside [`crate::Fixture`]):
//!   * [`AnvilFixture::boot`] — start the chain and return only once its RPC
//!     answers.
//!   * [`AnvilFixture::rpc_url`] / [`AnvilFixture::rpc_port`] — the host endpoint.
//!   * `Drop` — kill the chain unconditionally.
//!
//! ## `--block-time 1` is load-bearing
//!
//! `services/explorer-indexer/src/lib.rs` caps the indexer's safe head at
//! `tip - CONFIRMATIONS` (5). An automine-only Anvil produces a block per
//! transaction and then stops, so the five blocks past a `ReceiptRecorded` or
//! `ReceiptReleased` that the index stage waits on would never arrive, and the
//! QA run would hang instead of failing. A one-second block time keeps the tip
//! moving on its own.
//!
//! ## Chain id
//!
//! The fixture's SOURCE chain is Base (8453), but the devnet runs at the
//! synthetic id 918453 — the same id the Geth devnet uses. rmpc classifies
//! 8453 as `production_base` and hard-refuses software-keystore writes there.
//! See `scripts/devnet/boot-fork-state-anvil.sh` for the full rationale.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{keccak256, Address, U256};

use crate::{
    agent_address, genesis_alloc, logging, HarnessError, MonitoredChild, DEPLOYER_ADDRESS_HEX,
    HARNESS_USDC_HOLDER_ADDRESS_HEX, PAUSER_ADDRESS_HEX, SHARE_RECEIVER_ADDRESS_HEX,
};

/// Synthetic devnet chain id. Must match the Geth devnet
/// (`testing/ethereum-testnet/config`) and `INDEXER_CHAIN_ID`.
pub const ANVIL_CHAIN_ID: u64 = 918_453;

/// External Docker network the dapp compose stack attaches the indexer to
/// (`docker-compose.dapp.yaml::networks.chain-net`). In Geth mode the chain
/// compose stack creates it. In Anvil mode there is no chain compose stack, so
/// this fixture creates the bare network itself and removes it on teardown —
/// the compose file stays untouched (suite-14 depends on it unchanged).
pub const CHAIN_NET_NAME: &str = "ethereum-testnet_default";

/// Env override for the address containers use to reach the host-side Anvil.
/// Set this when the Docker bridge gateway is not routable from the compose
/// network (unusual on Linux).
pub const ANVIL_HOST_ADDR_ENV: &str = "SMOKE_TEST_ANVIL_HOST_ADDR";

/// USDC granted to `HARNESS_USDC_HOLDER`. Matches
/// `testing/ethereum-testnet/config/fork-block.json::harness_usdc_grant_units`
/// so both backends hand the harness the same faucet reserve.
const HARNESS_USDC_GRANT_UNITS: u128 = 1_000_000_000_000; // 1,000,000 USDC, 6dp

/// ETH granted to every harness EOA, in wei (10,000 ETH).
const HARNESS_ETH_WEI: u128 = 10_000_000_000_000_000_000_000;

/// How long to wait for Anvil's RPC to answer after spawn.
const RPC_READY_TIMEOUT: Duration = Duration::from_secs(60);

/// A running Anvil chain. Drop kills it.
pub struct AnvilFixture {
    child: MonitoredChild,
    rpc_port: u16,
    rpc_url: String,
    log_path: Option<PathBuf>,
    /// True iff this fixture created [`CHAIN_NET_NAME`] and therefore owns
    /// removing it again.
    created_chain_net: bool,
}

impl AnvilFixture {
    /// Boot Anvil from the committed Base fork state on `rpc_port`, seed USDC,
    /// and fund the harness EOAs. Returns once the RPC answers `eth_chainId`
    /// with [`ANVIL_CHAIN_ID`].
    pub fn boot(repo_root: &Path, rpc_port: u16) -> Result<Self, HarnessError> {
        if which::which("anvil").is_err() {
            return Err(HarnessError::FoundryMissing("anvil"));
        }

        // A listener already on this port is never something to boot alongside:
        // the new anvil would exit `Address already in use` within a second and
        // the readiness probe below would be answered by the SURVIVOR, which
        // reports the same `--chain-id`. The run would then deploy onto a stale
        // chain that already carries an earlier run's contracts and receipts.
        // Geth mode refuses this case loudly in `ensure_compose_project_idle`;
        // this is the anvil-mode equivalent.
        if port_has_listener(rpc_port) {
            return Err(HarnessError::other(format!(
                "port {rpc_port} already has a listener, so a chain from an earlier run is still \
                 up; stop it before booting another (`pkill -f 'anvil --port {rpc_port}'`, or \
                 `docker compose -p ethereum-testnet down` in Geth mode) — booting on top of it \
                 would silently run this fixture against that chain"
            )));
        }

        let fixture_dir = repo_root.join("testing/fixtures/fork-state");
        let state_file = fixture_dir.join("CURRENT.anvil-state");
        let seed_file = fixture_dir.join("usdc-storage-seed.json");
        for f in [&state_file, &seed_file] {
            if !f.exists() {
                return Err(HarnessError::other(format!(
                    "fork-state fixture missing: {}",
                    f.display()
                )));
            }
        }

        let created_chain_net = ensure_chain_net()?;

        let log_path = open_log_path(repo_root, rpc_port);
        let (stdout, stderr) = match log_path.as_ref().and_then(|p| {
            let out = std::fs::File::create(p).ok()?;
            let err = out.try_clone().ok()?;
            Some((out, err))
        }) {
            Some((out, err)) => (Stdio::from(out), Stdio::from(err)),
            None => (Stdio::null(), Stdio::null()),
        };

        logging::info(
            "anvil",
            format!(
                "booting anvil --port {rpc_port} --chain-id {ANVIL_CHAIN_ID} --block-time 1 \
                 --load-state {}",
                state_file.display()
            ),
        );
        let mut child = Command::new("anvil")
            // Bind every interface: the explorer-indexer container reaches this
            // chain over the Docker bridge, not over loopback.
            .args(["--host", "0.0.0.0"])
            .args(["--port", &rpc_port.to_string()])
            .arg("--load-state")
            .arg(&state_file)
            .args(["--chain-id", &ANVIL_CHAIN_ID.to_string()])
            // MANDATORY, not cosmetic — see the module docs: the indexer's safe
            // head is `tip - 5`, so the chain must keep producing blocks after
            // the last transaction or the index stage waits forever.
            .args(["--block-time", "1"])
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(HarnessError::from)?;

        let rpc_url = crate::localhost_url(rpc_port);

        // The readiness poll watches the process it just spawned, not just the
        // port: an anvil that died on startup must abort the boot rather than
        // let whatever else answers on this port be mistaken for our chain.
        let mut watch_child = || match child.try_wait() {
            Ok(Some(status)) => Err(HarnessError::other(format!(
                "anvil exited during startup ({status}) before its RPC answered on port \
                 {rpc_port}; see the anvil log for the reason"
            ))),
            Ok(None) => Ok(()),
            Err(err) => Err(HarnessError::other(format!(
                "could not check on the anvil process during startup: {err}"
            ))),
        };
        let ready = crate::wait_for_rpc_with_probe(
            &rpc_url,
            RPC_READY_TIMEOUT,
            Some(&mut watch_child as &mut dyn FnMut() -> Result<(), HarnessError>),
        );

        let fixture = Self {
            child: MonitoredChild::new("anvil", child),
            rpc_port,
            rpc_url: rpc_url.clone(),
            log_path,
            created_chain_net,
        };

        ready.inspect_err(|err| {
            logging::error("anvil", format!("anvil RPC readiness failed: {err}"));
            fixture.log_tail();
        })?;

        let live_chain_id = fixture.chain_id()?;
        if live_chain_id != ANVIL_CHAIN_ID {
            return Err(HarnessError::other(format!(
                "anvil live chain-id {live_chain_id} != devnet chain id {ANVIL_CHAIN_ID}"
            )));
        }

        fixture.apply_usdc_storage_seed(&seed_file)?;
        fixture.install_arachnid_factory()?;
        fixture.advance_timestamp_to_now()?;
        fixture.fund_harness_accounts()?;

        logging::info("anvil", "anvil chain ready");
        Ok(fixture)
    }

    // ---- accessors --------------------------------------------------

    /// Host-side RPC endpoint (loopback). This is what `cast` / `forge` use.
    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    pub fn rpc_port(&self) -> u16 {
        self.rpc_port
    }

    /// RPC endpoint a Docker container can reach. In Geth mode the indexer
    /// talks to the `geth` compose service by name; with a host-side Anvil it
    /// has to cross the bridge, so hand it the bridge gateway address.
    pub fn container_rpc_url(&self) -> String {
        format!("http://{}:{}", container_host_addr(), self.rpc_port)
    }

    // ---- chain setup ------------------------------------------------

    fn chain_id(&self) -> Result<u64, HarnessError> {
        let result = self.rpc("eth_chainId", serde_json::json!([]))?;
        let hex = result
            .as_str()
            .ok_or_else(|| HarnessError::other("eth_chainId returned a non-string result"))?;
        u64::from_str_radix(hex.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::other(format!("eth_chainId parse: {e}")))
    }

    /// Replay the canonical Base USDC proxy storage seed plus the
    /// implementation bytecode, exactly as `boot-fork-state-anvil.sh` does.
    ///
    /// `--load-state` captures the proxy's runtime bytecode but not its
    /// admin/impl/config storage; without this seed every non-admin selector
    /// reverts on the proxy-admin collision.
    fn apply_usdc_storage_seed(&self, seed_file: &Path) -> Result<(), HarnessError> {
        logging::info("anvil", "applying USDC proxy storage seed");
        let raw = std::fs::read_to_string(seed_file)?;
        let seed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| HarnessError::other(format!("usdc-storage-seed.json parse: {e}")))?;

        let storage = seed
            .pointer("/proxy/storage")
            .and_then(|v| v.as_object())
            .ok_or_else(|| HarnessError::other("usdc-storage-seed.json has no .proxy.storage"))?;
        for (slot, value) in storage {
            let value = value.as_str().ok_or_else(|| {
                HarnessError::other(format!(
                    "usdc-storage-seed.json slot {slot} is not a string"
                ))
            })?;
            self.rpc(
                "anvil_setStorageAt",
                serde_json::json!([genesis_alloc::BASE_USDC_ADDR, slot, value]),
            )?;
        }

        let impl_addr = seed
            .pointer("/implementation/address")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                HarnessError::other("usdc-storage-seed.json has no .implementation.address")
            })?;
        let impl_code = seed
            .pointer("/implementation/code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                HarnessError::other("usdc-storage-seed.json has no .implementation.code")
            })?;
        self.rpc("anvil_setCode", serde_json::json!([impl_addr, impl_code]))?;

        // Regression guard: the ZeppelinOS proxy admin slot must now be set,
        // otherwise the seed silently did nothing and every USDC call reverts.
        let admin = self.rpc(
            "eth_getStorageAt",
            serde_json::json!([
                genesis_alloc::BASE_USDC_ADDR,
                genesis_alloc::ZEPPELINOS_PROXY_ADMIN_SLOT,
                "latest"
            ]),
        )?;
        let admin = admin.as_str().unwrap_or_default();
        if admin
            .trim_start_matches("0x")
            .trim_start_matches('0')
            .is_empty()
        {
            return Err(HarnessError::other(
                "USDC proxy admin slot still zero after applying the storage seed",
            ));
        }
        Ok(())
    }

    /// Register the Arachnid deterministic-deployment proxy so
    /// `DeployDemoUniswapV3Stubs.s.sol`'s CREATE2 deploys resolve. The Geth
    /// backend gets this from the genesis alloc overlay instead.
    fn install_arachnid_factory(&self) -> Result<(), HarnessError> {
        self.rpc(
            "anvil_setCode",
            serde_json::json!([
                genesis_alloc::ARACHNID_FACTORY_ADDR,
                genesis_alloc::ARACHNID_FACTORY_BYTECODE
            ]),
        )?;
        Ok(())
    }

    /// Move the next block's timestamp up to wall-clock now so Aave V3's
    /// `getReserveNormalizedIncome` index math stays monotonic against the
    /// forked reserve state.
    fn advance_timestamp_to_now(&self) -> Result<(), HarnessError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| HarnessError::other(format!("system time before UNIX_EPOCH: {e}")))?
            .as_secs();
        logging::info("anvil", format!("advancing next-block timestamp to {now}"));
        self.rpc("evm_setNextBlockTimestamp", serde_json::json!([now]))?;
        self.rpc("evm_mine", serde_json::json!([]))?;
        Ok(())
    }

    /// Grant every harness EOA gas money, and hand `HARNESS_USDC_HOLDER` its
    /// USDC reserve by writing the FiatToken balances slot (slot 9) directly —
    /// no whale impersonation, same approach as the shell script and the Geth
    /// genesis alloc builder.
    fn fund_harness_accounts(&self) -> Result<(), HarnessError> {
        let agent = format!("{:#x}", agent_address());
        let eth_wei = format!("{:#x}", U256::from(HARNESS_ETH_WEI));
        for addr in [
            DEPLOYER_ADDRESS_HEX,
            PAUSER_ADDRESS_HEX,
            SHARE_RECEIVER_ADDRESS_HEX,
            HARNESS_USDC_HOLDER_ADDRESS_HEX,
            agent.as_str(),
        ] {
            self.rpc("anvil_setBalance", serde_json::json!([addr, eth_wei]))?;
        }

        let holder: Address = HARNESS_USDC_HOLDER_ADDRESS_HEX
            .parse()
            .map_err(|e| HarnessError::other(format!("harness holder address: {e}")))?;
        let slot = fiat_token_balance_slot(holder);
        let grant = U256::from(HARNESS_USDC_GRANT_UNITS);
        self.rpc(
            "anvil_setStorageAt",
            serde_json::json!([
                genesis_alloc::BASE_USDC_ADDR,
                format!("{slot:#066x}"),
                format!("{grant:#066x}")
            ]),
        )?;

        // Keep `totalSupply()` consistent with the grant, as the Geth genesis
        // alloc builder does (see genesis_alloc::FIAT_TOKEN_TOTAL_SUPPLY_SLOT).
        let supply_slot = U256::from(genesis_alloc::FIAT_TOKEN_TOTAL_SUPPLY_SLOT);
        let current = self.rpc(
            "eth_getStorageAt",
            serde_json::json!([
                genesis_alloc::BASE_USDC_ADDR,
                format!("{supply_slot:#066x}"),
                "latest"
            ]),
        )?;
        let current = current
            .as_str()
            .and_then(|s| U256::from_str_radix(s.trim_start_matches("0x"), 16).ok())
            .unwrap_or(U256::ZERO);
        let next = current.saturating_add(grant);
        self.rpc(
            "anvil_setStorageAt",
            serde_json::json!([
                genesis_alloc::BASE_USDC_ADDR,
                format!("{supply_slot:#066x}"),
                format!("{next:#066x}")
            ]),
        )?;
        logging::info(
            "anvil",
            format!(
                "funded harness EOAs with ETH; granted {HARNESS_USDC_GRANT_UNITS} USDC units to \
                 {HARNESS_USDC_HOLDER_ADDRESS_HEX}"
            ),
        );
        Ok(())
    }

    // ---- plumbing ---------------------------------------------------

    fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, HarnessError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let resp = client
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .map_err(|e| HarnessError::other(format!("{method}: {e}")))?;
        if !resp.status().is_success() {
            return Err(HarnessError::other(format!(
                "{method}: HTTP {}",
                resp.status()
            )));
        }
        let json: serde_json::Value = resp
            .json()
            .map_err(|e| HarnessError::other(format!("{method}: response decode: {e}")))?;
        if let Some(error) = json.get("error") {
            return Err(HarnessError::other(format!("{method}: {error}")));
        }
        Ok(json
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    fn log_tail(&self) {
        let Some(path) = self.log_path.as_ref() else {
            return;
        };
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents
                .lines()
                .rev()
                .take(50)
                .collect::<Vec<_>>()
                .iter()
                .rev()
            {
                logging::error("anvil", *line);
            }
        }
    }
}

impl Drop for AnvilFixture {
    fn drop(&mut self) {
        logging::info("anvil", "tearing down anvil chain");
        self.child.terminate();
        if self.created_chain_net {
            let _ = Command::new("docker")
                .args(["network", "rm", CHAIN_NET_NAME])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        logging::info("anvil", "anvil teardown complete");
    }
}

/// `keccak256(abi.encode(holder, 9))` — the FiatToken balances mapping slot.
fn fiat_token_balance_slot(holder: Address) -> U256 {
    let mut preimage = [0u8; 64];
    preimage[12..32].copy_from_slice(holder.as_slice());
    preimage[32..64]
        .copy_from_slice(&U256::from(genesis_alloc::FIAT_TOKEN_BALANCES_SLOT).to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(preimage).0)
}

/// Create [`CHAIN_NET_NAME`] when it is absent. Returns true iff this call
/// created it (and therefore owns removing it).
/// True when something is already accepting connections on `port` (loopback).
/// A short connect timeout, because a live local listener answers immediately
/// and a free port refuses immediately.
fn port_has_listener(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn ensure_chain_net() -> Result<bool, HarnessError> {
    let existing = Command::new("docker")
        .args(["network", "inspect", CHAIN_NET_NAME])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if matches!(existing, Ok(status) if status.success()) {
        return Ok(false);
    }
    let created = Command::new("docker")
        .args(["network", "create", CHAIN_NET_NAME])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(HarnessError::from)?;
    if !created.success() {
        return Err(HarnessError::Docker(format!(
            "could not create the `{CHAIN_NET_NAME}` bridge network the dapp compose stack \
             attaches the indexer to"
        )));
    }
    logging::info("anvil", format!("created docker network {CHAIN_NET_NAME}"));
    Ok(true)
}

/// Address a container uses to reach the host. Prefers the Docker bridge
/// gateway (routable from every bridge network on Linux); falls back to
/// `host.docker.internal`.
fn container_host_addr() -> String {
    if let Ok(value) = std::env::var(ANVIL_HOST_ADDR_ENV) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    let out = Command::new("docker")
        .args([
            "network",
            "inspect",
            "bridge",
            "-f",
            "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        ])
        .output();
    if let Ok(out) = out {
        if out.status.success() {
            let gateway = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !gateway.is_empty() {
                return gateway;
            }
        }
    }
    "host.docker.internal".to_string()
}

fn open_log_path(repo_root: &Path, rpc_port: u16) -> Option<PathBuf> {
    let dir = repo_root.join("artifacts/smoke-test");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("anvil-{rpc_port}.log")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balance_slot_matches_cast_index_address() {
        // `cast index address 0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5 9`
        let holder: Address = HARNESS_USDC_HOLDER_ADDRESS_HEX.parse().unwrap();
        let slot = fiat_token_balance_slot(holder);
        assert_eq!(
            format!("{slot:#066x}"),
            "0x13dd27dad043dede11b47aba7345d9986c798174fb05852bd379777f42846ee5"
        );
    }

    #[test]
    fn chain_id_is_the_devnet_id_not_base() {
        assert_eq!(ANVIL_CHAIN_ID, 918_453);
        assert_ne!(ANVIL_CHAIN_ID, 8_453);
    }
}
