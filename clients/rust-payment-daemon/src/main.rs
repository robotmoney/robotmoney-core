//! `rmpd` — Robot Money payment daemon CLI.
//!
//! This is the skeleton from issue #7: the subcommands parse and exit 0
//! with a stub JSON payload. Actual signing, RPC, and policy work lands in
//! later wave-1 issues.

// Skeleton crate (issue #7): types are defined and unit-tested here, but not
// yet wired into `main`. Subsequent wave-1 issues consume them. Allow dead
// code at the crate root so `cargo clippy -- -D warnings` stays green.
#![allow(dead_code)]

use clap::{Parser, Subcommand};

mod config;
mod errors;

// Module stubs reserved for parallel workstreams (issues #8, #11, #12, ...).
// Each is intentionally empty so other PRs can fill them without merge conflicts.
mod fees;
mod gateway;
mod nonce;
mod policy;
mod rpc;
mod signer;
mod tx;

#[derive(Debug, Parser)]
#[command(name = "rmpd", version, about = "Robot Money payment daemon")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Sign and broadcast a USDC deposit through the gateway.
    Deposit {
        #[arg(long)]
        amount: Option<String>,
        #[arg(long = "order-id")]
        order_id: Option<String>,
    },
    /// Look up the status of a previously submitted payment.
    Status {
        #[arg(long = "payment-id")]
        payment_id: Option<String>,
    },
    /// Print the signer-backend self-check report.
    SelfCheck,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Deposit { .. } | Command::Status { .. } | Command::SelfCheck => {
            println!("{{\"status\":\"unimplemented\"}}");
        }
    }
}
