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
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// `smoke-test.log` in the current directory.
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
