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
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

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
}

fn main() {
    let cli = Cli::parse();
    if cli.tunnel && !cli.full_stack {
        eprintln!("smoke-test: --tunnel requires --full-stack.");
        std::process::exit(2);
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
        std::process::exit(2);
    }
    let use_named = named_url_count == 3;
    if use_named && cli.tunnel {
        eprintln!("smoke-test: --tunnel is incompatible with --public-*-url flags.");
        std::process::exit(2);
    }
    if use_named && !cli.full_stack {
        eprintln!("smoke-test: --public-*-url flags require --full-stack.");
        std::process::exit(2);
    }
    if let Some(rpc_port) = cli.rpc_port {
        std::env::set_var("SMOKE_TEST_GETH_RPC_PORT", rpc_port.to_string());
    }
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
        std::process::exit(1);
    }

    eprintln!("smoke-test: booting devnet (this takes 60-120 seconds)...");
    let fixture = smoke_test::Fixture::new().expect("devnet boot failed");
    if interrupted.load(Ordering::SeqCst) {
        eprintln!("smoke-test: interrupted during devnet startup.");
        return;
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
        let stack = smoke_test::DappStack::boot(&fixture, opts).expect("dapp stack boot failed");
        if interrupted.load(Ordering::SeqCst) {
            eprintln!("smoke-test: interrupted during full-stack startup.");
            return;
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
    } else {
        eprintln!("smoke-test: network ready. Stop with Ctrl-C.");
    }
    while !interrupted.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("smoke-test: stopping...");
    // _dapp_stack drops here first → docker compose down dapp stack
    // fixture drops next → docker compose down chain stack
}
