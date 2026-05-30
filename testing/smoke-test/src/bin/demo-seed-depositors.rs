//! Canonical: docs/architecture.md §3 — Technology Stack
//!
//! Standalone demo-depositor seeder (issue #503).
//!
//! Seeds deterministic simulated-depositor EOAs against an already-deployed
//! devnet. Does NOT boot a devnet — it expects the chain to be running and
//! the contracts to be deployed. Invoked by `make demo-seed-depositors`.
//!
//! Usage:
//!   cargo run -p smoke-test --bin demo-seed-depositors -- \
//!     --rpc-url <URL> \
//!     --deployer-key <0xHEX> \
//!     --usdc <0xADDR> \
//!     --router <0xADDR> \
//!     [--count 5] \
//!     [--per-user-usdc 1000]
//!
//! The seed is reproducible: depositor keys are derived from
//! `keccak256("rm-demo-depositor-v1\0" || index)`, the same derivation used
//! by `Fixture::seed_demo_depositors` in the smoke-test harness.
//!
//! Each depositor is funded with 0.05 ETH (gas) from the deployer key and
//! `per_user_usdc` USDC from the same deployer key (which must hold enough
//! USDC — typically the genesis-funded harness USDC holder key, or whatever
//! key owns the faucet supply on the target devnet). Then the depositor
//! approves the router and calls `deposit(uint256,uint256[])`.

use clap::Parser;
use std::process::Command;

/// Minimum viable cast wrapper — runs `cast send` and returns the tx hash.
fn cast_send(
    rpc_url: &str,
    private_key_hex: &str,
    to: &str,
    sig: &str,
    args: &[&str],
) -> Result<String, String> {
    let mut cmd = Command::new("cast");
    cmd.args([
        "send",
        "--rpc-url",
        rpc_url,
        "--private-key",
        private_key_hex,
        to,
        sig,
    ]);
    for a in args {
        cmd.arg(a);
    }
    cmd.arg("--json");
    let out = cmd
        .output()
        .map_err(|e| format!("cast send IO error: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cast send {sig} failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("cast send {sig} json parse: {e}"))?;
    Ok(v.get("transactionHash")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string())
}

/// Send native ETH from the deployer key to `recipient_hex` (wei string).
fn fund_eth(
    rpc_url: &str,
    deployer_key: &str,
    recipient_hex: &str,
    value_wei: &str,
) -> Result<(), String> {
    let out = Command::new("cast")
        .args([
            "send",
            "--rpc-url",
            rpc_url,
            "--private-key",
            deployer_key,
            "--value",
            value_wei,
            recipient_hex,
            "--json",
        ])
        .output()
        .map_err(|e| format!("cast send (ETH fund) IO error: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ETH fund failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        ));
    }
    Ok(())
}

/// Call `totalAssets()` (selector 0x01e1d114) on a vault and print the result.
fn print_total_assets(rpc_url: &str, vault: &str) {
    let out = Command::new("cast")
        .args([
            "call",
            "--rpc-url",
            rpc_url,
            vault,
            "totalAssets()(uint256)",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            println!("  totalAssets({vault}) = {s}");
        }
        Ok(o) => {
            eprintln!(
                "  totalAssets({vault}) failed: {}",
                String::from_utf8_lossy(&o.stderr)
            );
        }
        Err(e) => eprintln!("  totalAssets({vault}) IO error: {e}"),
    }
}

/// Resolve all Active vaults from the registry, for display after seeding.
/// Uses `listVaults()` selector 0x50cc258e. Falls back to an empty list on
/// any failure so the binary still exits 0 if the registry is unavailable.
fn list_active_vaults(rpc_url: &str, registry: Option<&str>) -> Vec<String> {
    let Some(reg) = registry else {
        return Vec::new();
    };
    let out = Command::new("cast")
        .args(["call", "--rpc-url", rpc_url, reg, "listVaults()(address[])"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            // cast formats address[] as:
            //   [0xABCD..., 0xDEAD..., ...]
            let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
            raw.trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        }
        _ => Vec::new(),
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "demo-seed-depositors",
    about = "Seed deterministic demo depositors against an already-deployed Robot Money devnet (issue #503)."
)]
struct Cli {
    /// JSON-RPC endpoint of the devnet (e.g. https://robotmoney-dev-rpc.superfield.co)
    #[arg(long, env = "RPC_URL")]
    rpc_url: String,

    /// 0x-prefixed hex private key of the deployer / faucet EOA.
    /// Must hold enough ETH and USDC to fund all depositors.
    #[arg(long, env = "DEPLOYER_KEY")]
    deployer_key: String,

    /// USDC contract address (canonical Base USDC on the devnet).
    #[arg(long, env = "USDC_ADDRESS")]
    usdc: String,

    /// PortfolioRouter contract address.
    #[arg(long, env = "ROUTER_ADDRESS")]
    router: String,

    /// VaultRegistry address. When provided, `totalAssets` is printed for
    /// each registered vault after seeding. Optional — omit to skip.
    #[arg(long, env = "REGISTRY_ADDRESS")]
    registry: Option<String>,

    /// Number of simulated depositors to seed (default 5).
    #[arg(long, default_value_t = 5)]
    count: u32,

    /// USDC per depositor in whole USDC units (default 1000 → 1 000 000 000 μUSDC).
    #[arg(long, default_value_t = 1000)]
    per_user_usdc: u64,
}

fn main() {
    let cli = Cli::parse();

    // Validate that cast is on PATH before iterating.
    if which::which("cast").is_err() {
        eprintln!("error: `cast` (Foundry) not found on PATH; install foundry and retry");
        std::process::exit(1);
    }

    let per_user_usdc_units: u128 = cli.per_user_usdc as u128 * 1_000_000;
    let router = cli.router.trim().to_string();
    let usdc = cli.usdc.trim().to_string();

    println!(
        "demo-seed-depositors: seeding {} depositors with {} USDC each",
        cli.count, cli.per_user_usdc
    );
    println!("  rpc_url : {}", cli.rpc_url);
    println!("  router  : {router}");
    println!("  usdc    : {usdc}");

    for i in 0..cli.count {
        let (pk_hex, depositor) = smoke_test::demo_depositor_key(i);
        let depositor_hex = format!("{depositor:#x}");

        println!("[{i}] depositor {depositor_hex}");

        // 1. Fund gas — 0.05 ETH is enough for approve + deposit.
        print!("  [1/4] fund ETH ... ");
        match fund_eth(
            &cli.rpc_url,
            &cli.deployer_key,
            &depositor_hex,
            "50000000000000000",
        ) {
            Ok(()) => println!("ok"),
            Err(e) => {
                eprintln!("FAILED: {e}");
                std::process::exit(1);
            }
        }

        // 2. Fund USDC via the deployer key (must hold the faucet supply).
        print!("  [2/4] fund USDC ({} units) ... ", per_user_usdc_units);
        match cast_send(
            &cli.rpc_url,
            &cli.deployer_key,
            &usdc,
            "transfer(address,uint256)",
            &[&depositor_hex, &per_user_usdc_units.to_string()],
        ) {
            Ok(tx) => println!("ok (tx={tx})"),
            Err(e) => {
                eprintln!("FAILED: {e}");
                std::process::exit(1);
            }
        }

        // 3. Approve the router for the full amount.
        print!("  [3/4] approve router ... ");
        match cast_send(
            &cli.rpc_url,
            &pk_hex,
            &usdc,
            "approve(address,uint256)",
            &[&router, &per_user_usdc_units.to_string()],
        ) {
            Ok(tx) => println!("ok (tx={tx})"),
            Err(e) => {
                eprintln!("FAILED: {e}");
                std::process::exit(1);
            }
        }

        // 4. Deposit through the router. Empty minSharesPerLeg skips slippage
        //    guard — fine for the demo seed against passthrough adapters.
        print!("  [4/4] router.deposit ... ");
        match cast_send(
            &cli.rpc_url,
            &pk_hex,
            &router,
            "deposit(uint256,uint256[])",
            &[&per_user_usdc_units.to_string(), "[]"],
        ) {
            Ok(tx) => println!("ok (tx={tx})"),
            Err(e) => {
                eprintln!("FAILED: {e}");
                std::process::exit(1);
            }
        }
    }

    println!(
        "\ndemo-seed-depositors: all {} depositors seeded",
        cli.count
    );

    // Print totalAssets for each registered vault so the operator can verify
    // that every vault received deposits.
    let vaults = list_active_vaults(&cli.rpc_url, cli.registry.as_deref());
    if !vaults.is_empty() {
        println!("\nvault totalAssets after seeding:");
        for v in &vaults {
            print_total_assets(&cli.rpc_url, v);
        }
    } else if cli.registry.is_some() {
        println!("\n(registry returned no vaults)");
    }
}
