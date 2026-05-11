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
}

fn main() {
    let cli = Cli::parse();
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
        let stack =
            smoke_test::DappStack::boot(&fixture, cli.dapp_port).expect("dapp stack boot failed");
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
