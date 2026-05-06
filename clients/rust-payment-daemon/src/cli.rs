//! Argument parsing for the `rmpd` CLI.
//!
//! Lives in the library so integration tests can introspect the parser.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "rmpd", version, about = "Robot Money payment daemon")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign and broadcast a USDC deposit through the gateway.
    Deposit {
        #[arg(long)]
        amount: Option<String>,
        #[arg(long = "order-id")]
        order_id: Option<String>,
    },
    /// Look up a previously submitted payment by its on-chain `paymentId`.
    Status {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// 32-byte payment id, 0x-prefixed hex.
        #[arg(long = "payment-id")]
        payment_id: String,
        /// Pretty-print the JSON output (multi-line, indented).
        #[arg(long)]
        pretty: bool,
    },
    /// Print the signer-backend self-check report (v0 §9.2 JSON).
    SelfCheck {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Pretty-print the JSON output (multi-line, indented).
        #[arg(long)]
        pretty: bool,
    },
}
