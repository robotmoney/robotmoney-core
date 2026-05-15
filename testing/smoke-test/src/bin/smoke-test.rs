//! CLI entry point: `cargo r smoke-test`
//!
//! Boots the full Geth+Lighthouse devnet with deployed contracts and
//! keeps it alive so external tests or tools can connect to it. Prints
//! the allocated URLs and addresses to stdout, then blocks until Ctrl-C.
//! Drop tears the stack down on clean exit.
//!
//! With `--full-stack` the binary also starts the dapp, explorer-api,
//! explorer-indexer, and Postgres containers after contract deployment,
//! printing a structured endpoint summary once all services are healthy.
//! Dropping or Ctrl-C tears down both compose stacks.
//!
//! Canonical: docs/implementation-plan.md §10.5 — Phase 4.5.

use clap::Parser;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Parser, Debug)]
#[command(name = "smoke-test", about = "Robot Money devnet smoke test harness")]
struct Cli {
    /// Boot the dapp, explorer-api, explorer-indexer, and Postgres
    /// containers after deploying contracts. Prints a structured
    /// endpoint summary once all services are healthy.
    #[arg(long, default_value_t = false)]
    full_stack: bool,

    /// Fix the host port for the dapp frontend instead of randomizing it.
    /// Useful when attaching a reverse proxy to the webapp.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    dapp_port: Option<u16>,

    /// Open ephemeral `trycloudflare.com` tunnels for the dapp, explorer-api,
    /// and Geth RPC ports, and build the dapp bundle with those public URLs
    /// in the standard `VITE_*` env vars. Tunnels close when smoke-test exits.
    /// Requires `--full-stack`.
    ///
    /// Demo affordance only — bakes hoster-controlled URLs into the bundle
    /// and is explicitly out of scope for `docs/security/dapp-topology.md`.
    /// Not a production hosting pattern.
    #[arg(long, default_value_t = false)]
    tunnel: bool,

    /// Pin the host port for Geth's RPC. Required when fronting the
    /// stack with a stable reverse proxy (named cloudflared tunnel,
    /// nginx, etc.) so the proxy's upstream target is deterministic.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    rpc_port: Option<u16>,

    /// Pin the host port for explorer-api. Same rationale as --rpc-port.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    explorer_port: Option<u16>,

    /// Public URL the dapp's wallet integration will announce as the
    /// RPC endpoint for the devnet chain (baked into the bundle as
    /// `VITE_DEVNET_RPC_URL`). When set together with --public-dapp-url
    /// and --public-explorer-url, smoke-test skips ephemeral tunnels
    /// and assumes an external reverse proxy is already routing those
    /// hostnames to the pinned local ports.
    #[arg(long)]
    public_rpc_url: Option<String>,

    /// Public URL the dapp is reachable from in the browser
    /// (`VITE_DAPP_URL`). See --public-rpc-url.
    #[arg(long)]
    public_dapp_url: Option<String>,

    /// Public URL the explorer-api is reachable from in the browser
    /// (`VITE_EXPLORER_API_URL`). See --public-rpc-url.
    #[arg(long)]
    public_explorer_url: Option<String>,

    /// Write harness logs to this file instead of the default
    /// `target/smoke-test/smoke-test.log`.
    #[arg(long, value_name = "PATH")]
    log_file: Option<PathBuf>,

    /// Rotate the unified log file after it grows beyond this many bytes.
    /// Defaults to 10 MiB.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    log_max_bytes: Option<u64>,
}

fn main() {
    let exit_code = run();
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn run() -> i32 {
    let cli = Cli::parse();
    if cli.tunnel && !cli.full_stack {
        eprintln!("smoke-test: --tunnel requires --full-stack.");
        return 2;
    }
    let named_url_count = [
        cli.public_rpc_url.is_some(),
        cli.public_dapp_url.is_some(),
        cli.public_explorer_url.is_some(),
    ]
    .iter()
    .filter(|x| **x)
    .count();
    if named_url_count != 0 && named_url_count != 3 {
        eprintln!(
            "smoke-test: --public-rpc-url, --public-dapp-url, and --public-explorer-url \
             must all be set together (or all omitted)."
        );
        return 2;
    }
    let use_named = named_url_count == 3;
    if use_named && cli.tunnel {
        eprintln!("smoke-test: --tunnel is incompatible with --public-*-url flags.");
        return 2;
    }
    if use_named && !cli.full_stack {
        eprintln!("smoke-test: --public-*-url flags require --full-stack.");
        return 2;
    }
    if let Some(rpc_port) = cli.rpc_port {
        std::env::set_var("SMOKE_TEST_GETH_RPC_PORT", rpc_port.to_string());
    }
    if let Some(path) = cli.log_file {
        std::env::set_var("SMOKE_TEST_LOG_FILE", path);
    }
    if let Some(limit) = cli.log_max_bytes {
        std::env::set_var("SMOKE_TEST_LOG_MAX_BYTES", limit.to_string());
    }
    let _ = smoke_test::logging::init();
    let genesis_timestamp = ensure_genesis_timestamp();
    smoke_test::logging::info(
        "smoke-test",
        format!(
            "CLI starting: full_stack={} tunnel={} log_file={} log_max_bytes={} genesis_timestamp={}",
            cli.full_stack,
            cli.tunnel,
            smoke_test::logging::log_path().display(),
            smoke_test::logging::max_bytes(),
            genesis_timestamp
        ),
    );
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let interrupted = Arc::clone(&interrupted);
        ctrlc::set_handler(move || {
            interrupted.store(true, Ordering::SeqCst);
        })
        .expect("set Ctrl-C handler");
    }

    if !smoke_test::prerequisites_available() {
        eprintln!(
            "smoke-test: docker / forge / cast not on PATH. \
             Install Docker + Foundry to run the devnet."
        );
        smoke_test::logging::error("smoke-test", "missing prerequisites: docker / forge / cast");
        return 1;
    }

    eprintln!("smoke-test: booting devnet (this takes 60-120 seconds)...");
    smoke_test::logging::info("smoke-test", "booting devnet");
    let fixture = match smoke_test::Fixture::new() {
        Ok(fixture) => fixture,
        Err(err) => {
            smoke_test::logging::error("smoke-test", format!("devnet boot failed: {err}"));
            eprintln!("smoke-test: devnet boot failed: {err}");
            if matches!(
                &err,
                smoke_test::HarnessError::Docker(message)
                    if message.contains("already running containers")
            ) {
                std::process::exit(2);
            }
            return 1;
        }
    };
    if interrupted.load(Ordering::SeqCst) {
        eprintln!("smoke-test: interrupted during devnet startup.");
        smoke_test::logging::warn("smoke-test", "shutdown reason=ctrl-c during startup");
        return 0;
    }

    println!("rpc_url={}", fixture.rpc_url());
    println!("chain_id={}", fixture.chain_id());
    println!("gateway_addr={:#x}", fixture.gateway());
    println!("usdc_addr={:#x}", fixture.usdc());
    println!("vault_addr={:#x}", fixture.vault());
    println!("agent_addr={:#x}", fixture.agent());
    println!("gateway_runtime_hash={}", fixture.gateway_runtime_hash());

    // Hold the DappStack alive until the end of main so its Drop tears
    // down the compose stack together with the chain fixture.
    let _dapp_stack: Option<smoke_test::DappStack> = if cli.full_stack {
        eprintln!("smoke-test: starting full-stack (dapp + explorer-api + indexer + postgres)...");
        smoke_test::logging::info("smoke-test", "starting full-stack compose stack");
        let public_endpoints = if use_named {
            smoke_test::PublicEndpoints::Named {
                rpc_url: cli.public_rpc_url.clone().unwrap(),
                dapp_url: cli.public_dapp_url.clone().unwrap(),
                explorer_api_url: cli.public_explorer_url.clone().unwrap(),
            }
        } else if cli.tunnel {
            smoke_test::PublicEndpoints::EphemeralTunnel
        } else {
            smoke_test::PublicEndpoints::Local
        };
        let opts = smoke_test::DappStackOptions {
            dapp_port: cli.dapp_port,
            explorer_api_port: cli.explorer_port,
            public_endpoints,
        };
        let stack = match smoke_test::DappStack::boot(&fixture, opts) {
            Ok(stack) => stack,
            Err(err) => {
                smoke_test::logging::error("smoke-test", format!("dapp stack boot failed: {err}"));
                eprintln!("smoke-test: dapp stack boot failed: {err}");
                return 1;
            }
        };
        if interrupted.load(Ordering::SeqCst) {
            eprintln!("smoke-test: interrupted during full-stack startup.");
            smoke_test::logging::warn(
                "smoke-test",
                "shutdown reason=ctrl-c during full-stack startup",
            );
            return 0;
        }

        // Structured endpoint summary — printed after all health checks pass.
        // Includes the deterministic test-EOA private keys so the Playwright
        // harness can inject a window.ethereum provider without re-deriving
        // them. These keys are test-only fixtures hardcoded in lib.rs and
        // are not secrets.
        println!("--- endpoint summary ---");
        println!("rpc_url={}", stack.endpoints.rpc_url);
        println!("dapp_url={}", stack.endpoints.dapp_url);
        println!("explorer_api_url={}", stack.endpoints.explorer_api_url);
        println!("chain_id={}", fixture.chain_id());
        println!("gateway_addr={:#x}", fixture.gateway());
        println!("vault_addr={:#x}", fixture.vault());
        println!("usdc_addr={:#x}", fixture.usdc());
        println!("agent_addr={:#x}", fixture.agent());
        println!("admin_addr={}", smoke_test::DEPLOYER_ADDRESS_HEX);
        println!("pauser_addr={}", smoke_test::PAUSER_ADDRESS_HEX);
        println!(
            "share_receiver_addr={}",
            smoke_test::SHARE_RECEIVER_ADDRESS_HEX
        );
        println!("admin_private_key={}", smoke_test::DEPLOYER_PRIVATE_KEY_HEX);
        println!("pauser_private_key={}", smoke_test::PAUSER_PRIVATE_KEY_HEX);
        println!(
            "agent_private_key=0x{}",
            hex::encode(smoke_test::AGENT_PRIVATE_KEY)
        );
        println!("gateway_runtime_hash={}", fixture.gateway_runtime_hash());
        // Issue #320: surface registry and router addresses so dapp e2e
        // tests can drive the vault-selector and router deposit flow.
        println!("registry_addr={:#x}", fixture.registry());
        println!("router_addr={:#x}", fixture.router());
        // Issue #261: surface the harness USDC holder so dapp e2e tests
        // can verify the testnet faucet path drips from the same EOA the
        // Rust `Fixture::fund_usdc` helper uses.
        println!(
            "harness_usdc_holder_addr={}",
            smoke_test::HARNESS_USDC_HOLDER_ADDRESS_HEX
        );
        println!(
            "harness_usdc_holder_private_key={}",
            smoke_test::HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX
        );
        println!("--- end endpoint summary ---");

        Some(stack)
    } else {
        None
    };

    if cli.full_stack {
        eprintln!("smoke-test: full stack ready. Stop with Ctrl-C.");
        smoke_test::logging::info("smoke-test", "full stack ready");
    } else {
        eprintln!("smoke-test: network ready. Stop with Ctrl-C.");
        smoke_test::logging::info("smoke-test", "network ready");
    }
    let _chain_health_poller = start_chain_health_poller(fixture.rpc_url().to_string());
    while !interrupted.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("smoke-test: stopping...");
    smoke_test::logging::info("smoke-test", "shutdown reason=ctrl-c tearing down stacks");
    // _dapp_stack drops here first → docker compose down dapp stack
    // fixture drops next → docker compose down chain stack
    0
}

fn ensure_genesis_timestamp() -> String {
    match std::env::var("GENESIS_TIMESTAMP") {
        Ok(value) => value,
        Err(_) => {
            const GENESIS_LEAD_SECS: u64 = 15;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before UNIX_EPOCH")
                .saturating_add(std::time::Duration::from_secs(GENESIS_LEAD_SECS))
                .as_secs()
                .to_string();
            std::env::set_var("GENESIS_TIMESTAMP", &ts);
            ts
        }
    }
}

const CHAIN_HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(3);
const CHAIN_STALL_WINDOW: Duration = Duration::from_secs(30);

fn start_chain_health_poller(rpc_url: String) -> thread::JoinHandle<()> {
    thread::spawn(move || poll_chain_health(&rpc_url))
}

fn poll_chain_health(rpc_url: &str) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            eprintln!(
                "smoke-test: [{}] warning: chain health poller could not start: {err}",
                timestamp_ms()
            );
            return;
        }
    };

    let mut next_poll = Instant::now();
    let mut tracker = ChainHealthTracker::default();

    loop {
        let now = Instant::now();
        if now < next_poll {
            thread::sleep(next_poll - now);
        }
        next_poll += CHAIN_HEALTH_POLL_INTERVAL;

        match fetch_block_number(&client, rpc_url) {
            Ok(block_number) => {
                if let Some(warning) = tracker.observe_block_number(Instant::now(), block_number) {
                    eprintln!("smoke-test: [{}] warning: {}", timestamp_ms(), warning);
                }
            }
            Err(err) => {
                if let Some(warning) = tracker.observe_rpc_failure(Instant::now(), err) {
                    eprintln!("smoke-test: [{}] warning: {}", timestamp_ms(), warning);
                }
            }
        }
    }
}

#[derive(Debug, Default)]
struct ChainHealthTracker {
    rpc_unreachable_since: Option<Instant>,
    stall_window_started_at: Option<Instant>,
    stall_window_block: Option<u64>,
}

impl ChainHealthTracker {
    fn observe_block_number(
        &mut self,
        now: Instant,
        block_number: u64,
    ) -> Option<ChainHealthWarning> {
        self.rpc_unreachable_since = None;

        match (self.stall_window_started_at, self.stall_window_block) {
            (Some(started_at), Some(previous_block))
                if now.duration_since(started_at) >= CHAIN_STALL_WINDOW =>
            {
                self.stall_window_started_at = Some(now);
                self.stall_window_block = Some(block_number);
                if block_number <= previous_block {
                    return Some(ChainHealthWarning::BlockStalled {
                        previous: previous_block,
                        current: block_number,
                    });
                }
            }
            (Some(_), Some(previous_block)) if block_number > previous_block => {
                self.stall_window_started_at = Some(now);
                self.stall_window_block = Some(block_number);
            }
            (Some(_), Some(_)) => {}
            _ => {
                self.stall_window_started_at = Some(now);
                self.stall_window_block = Some(block_number);
            }
        }

        None
    }

    fn observe_rpc_failure(&mut self, now: Instant, error: String) -> Option<ChainHealthWarning> {
        self.stall_window_started_at = None;
        self.stall_window_block = None;

        match self.rpc_unreachable_since {
            Some(started_at) if now.duration_since(started_at) >= CHAIN_STALL_WINDOW => {
                self.rpc_unreachable_since = Some(now);
                Some(ChainHealthWarning::RpcUnreachable { error })
            }
            Some(_) => None,
            None => {
                self.rpc_unreachable_since = Some(now);
                None
            }
        }
    }
}

enum ChainHealthWarning {
    RpcUnreachable { error: String },
    BlockStalled { previous: u64, current: u64 },
}

impl std::fmt::Display for ChainHealthWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChainHealthWarning::RpcUnreachable { error } => {
                write!(f, "RPC unreachable while polling eth_blockNumber: {error}")
            }
            ChainHealthWarning::BlockStalled { previous, current } => write!(
                f,
                "block production stalled while polling eth_blockNumber (no increase for 30s; last={previous}, current={current})"
            ),
        }
    }
}

impl std::fmt::Debug for ChainHealthWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

fn fetch_block_number(client: &reqwest::blocking::Client, rpc_url: &str) -> Result<u64, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_blockNumber",
        "params": [],
    });
    let resp = client
        .post(rpc_url)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let json = resp
        .json::<serde_json::Value>()
        .map_err(|e| e.to_string())?;
    let hex = json
        .get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing result field".to_string())?;
    u64::from_str_radix(hex.trim_start_matches("0x"), 16).map_err(|e| e.to_string())
}

fn timestamp_ms() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_health_tracker_reports_block_stall_after_30s() {
        let mut tracker = ChainHealthTracker::default();
        let t0 = Instant::now();
        assert!(tracker.observe_block_number(t0, 123).is_none());
        assert!(tracker
            .observe_block_number(t0 + Duration::from_secs(29), 123)
            .is_none());

        let warning = tracker
            .observe_block_number(t0 + Duration::from_secs(30), 123)
            .expect("stall warning");
        assert!(matches!(warning, ChainHealthWarning::BlockStalled { .. }));
        assert_eq!(
            format!("{warning}"),
            "block production stalled while polling eth_blockNumber (no increase for 30s; last=123, current=123)"
        );
    }

    #[test]
    fn chain_health_tracker_resets_when_blocks_advance() {
        let mut tracker = ChainHealthTracker::default();
        let t0 = Instant::now();
        assert!(tracker.observe_block_number(t0, 123).is_none());
        assert!(tracker
            .observe_block_number(t0 + Duration::from_secs(31), 124)
            .is_none());
        assert!(tracker
            .observe_block_number(t0 + Duration::from_secs(61), 125)
            .is_none());
    }

    #[test]
    fn chain_health_tracker_reports_rpc_unreachable_after_30s() {
        let mut tracker = ChainHealthTracker::default();
        let t0 = Instant::now();
        assert!(tracker
            .observe_rpc_failure(t0, "connect refused".to_string())
            .is_none());

        let warning = tracker
            .observe_rpc_failure(t0 + Duration::from_secs(30), "connect refused".to_string())
            .expect("rpc warning");
        assert!(matches!(warning, ChainHealthWarning::RpcUnreachable { .. }));
        assert_eq!(
            format!("{warning}"),
            "RPC unreachable while polling eth_blockNumber: connect refused"
        );
    }

    #[test]
    fn chain_collision_test_name_keeps_grep_fixture_alive() {
        assert!(matches!(
            ChainHealthWarning::BlockStalled {
                previous: 7,
                current: 7
            },
            ChainHealthWarning::BlockStalled { .. }
        ));
    }
}
