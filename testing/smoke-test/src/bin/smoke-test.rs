//! CLI entry point: `cargo r smoke-test`
//!
//! Boots the full Geth+Lighthouse devnet with deployed contracts and
//! keeps it alive so external tests or tools can connect to it. Prints
//! the allocated URLs and addresses to stdout, then blocks until Ctrl-C.
//! Drop tears the stack down on clean exit.

fn main() {
    if !smoke_test::prerequisites_available() {
        eprintln!(
            "smoke-test: docker / forge / cast not on PATH. \
             Install Docker + Foundry to run the devnet."
        );
        std::process::exit(1);
    }

    eprintln!("smoke-test: booting devnet (this takes 60-120 seconds)...");
    let fixture = smoke_test::Fixture::new().expect("devnet boot failed");

    println!("rpc_url={}", fixture.rpc_url());
    println!("chain_id={}", fixture.chain_id());
    println!("gateway_addr={:#x}", fixture.gateway());
    println!("usdc_addr={:#x}", fixture.usdc());
    println!("vault_addr={:#x}", fixture.vault());
    println!("agent_addr={:#x}", fixture.agent());
    println!("gateway_runtime_hash={}", fixture.gateway_runtime_hash());

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    ctrlc::set_handler(move || {
        let _ = tx.send(());
    })
    .expect("set Ctrl-C handler");

    eprintln!("smoke-test: network ready. Stop with Ctrl-C.");
    let _ = rx.recv();
    eprintln!("smoke-test: stopping devnet...");
    // fixture drops here → docker compose down
}
