//! Canonical: docs/implementation-plan.md §4.8 — CLI surface
//!
//! Argument parsing for the `rmpc` CLI.
//!
//! Lives in the library so integration tests can introspect the parser.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "rmpc", version, about = "Robot Money payment client")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign and broadcast a USDC deposit through the gateway.
    Deposit {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Deposit amount in USDC's smallest unit (6 decimals). Decimal
        /// integer string; e.g. `100000000` = 100 USDC.
        #[arg(long)]
        amount: String,
        /// 32-byte order id, 0x-prefixed hex.
        #[arg(long = "order-id")]
        order_id: String,
        /// 32-byte idempotency key, 0x-prefixed hex. Defaults to
        /// `--order-id` when omitted.
        #[arg(long = "idempotency-key")]
        idempotency_key: Option<String>,
        /// Deadline horizon in seconds from now. Capped at 600 (the
        /// gateway's `MAX_DEADLINE_SKEW`). Default 300.
        #[arg(long = "deadline-secs", default_value_t = 300)]
        deadline_secs: u64,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Gas limit for the deposit tx envelope. Default 350_000 — the
        /// happy-path deposit is ~150k; the cushion covers cold-storage
        /// vault writes on first interaction.
        #[arg(long = "gas-limit", default_value_t = 350_000)]
        gas_limit: u64,
        /// Pretty-print the JSON output (multi-line, indented).
        #[arg(long)]
        pretty: bool,
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
    /// Read vault state directly from chain (issue #49 / §9).
    GetVault {
        #[arg(long, short = 'c')]
        config: PathBuf,
        #[arg(long)]
        pretty: bool,
    },
    /// Read gateway state directly from chain (issue #49 / §9).
    GetGateway {
        #[arg(long, short = 'c')]
        config: PathBuf,
        #[arg(long)]
        pretty: bool,
    },
    /// Read an agent's authorization + window usage (issue #49 / §9).
    GetAgent {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Target agent address, 0x-prefixed hex.
        #[arg(long)]
        agent: String,
        #[arg(long)]
        pretty: bool,
    },
    /// Read role membership on the gateway for a target address
    /// (issue #49 / §9).
    GetRoles {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Target address, 0x-prefixed hex.
        #[arg(long)]
        address: String,
        #[arg(long)]
        pretty: bool,
    },
}
