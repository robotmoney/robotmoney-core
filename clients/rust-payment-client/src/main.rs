//! Canonical: docs/implementation-plan.md §4 — Phase 1 Rust client
//!
//! `rmpc` — Robot Money payment client CLI entry point.
//!
//! All command logic lives in [`rust_payment_client::commands`]; this file
//! is a thin shim that parses argv, initialises logging, and dispatches.

use std::path::Path;

use clap::Parser;
use rust_payment_client::cli::{Cli, Command};
use rust_payment_client::commands;
use rust_payment_client::config::Config;
use rust_payment_client::logging;

fn main() {
    let cli = Cli::parse();

    // Best-effort logging init from the subcommand's config file. We
    // refuse to skip logging silently: if the config can't load, we'll
    // still run with defaults so the operator gets at least the boot
    // banner. Subcommands re-load the config themselves and surface
    // proper errors there.
    let config_path = match &cli.command {
        Command::Deposit { config, .. } => Some(config.as_path()),
        Command::Status { config, .. } => Some(config.as_path()),
        Command::SelfCheck { config, .. } => Some(config.as_path()),
        Command::GetVault { config, .. } => Some(config.as_path()),
        Command::GetVaults { config, .. } => Some(config.as_path()),
        Command::GetRouter { config, .. } => Some(config.as_path()),
        Command::GetGovernance { config, .. } => Some(config.as_path()),
        Command::GetGateway { config, .. } => Some(config.as_path()),
        Command::GetAgent { config, .. } => Some(config.as_path()),
        Command::GetRoles { config, .. } => Some(config.as_path()),
        Command::GetBalance { config, .. } => Some(config.as_path()),
        Command::GetAllowance { config, .. } => Some(config.as_path()),
        Command::GetDeposit { config, .. } => Some(config.as_path()),
        Command::GetTx { config, .. } => Some(config.as_path()),
        Command::Withdraw { config, .. } => Some(config.as_path()),
    };
    init_logging_best_effort(config_path);

    let exit_code = match cli.command {
        Command::Deposit {
            config,
            amount,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap,
            pretty,
        } => commands::deposit::run(commands::deposit::Args {
            config_path: config,
            amount,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap_wei: fee_cap,
            pretty,
        }),
        Command::SelfCheck { config, pretty } => commands::self_check::run(&config, pretty),
        Command::Status {
            config,
            payment_id,
            pretty,
        } => commands::status::run(&config, &payment_id, pretty),
        Command::GetVault {
            config,
            address,
            pretty,
        } => commands::get_vault::run(&config, address.as_deref(), pretty),
        Command::GetVaults { config, pretty } => commands::get_vaults::run(&config, pretty),
        Command::GetRouter { config, pretty } => commands::get_router::run(&config, pretty),
        Command::GetGovernance { config, pretty } => commands::get_governance::run(&config, pretty),
        Command::GetGateway { config, pretty } => commands::get_gateway::run(&config, pretty),
        Command::GetAgent {
            config,
            agent,
            pretty,
        } => commands::get_agent::run(&config, &agent, pretty),
        Command::GetRoles {
            config,
            address,
            pretty,
        } => commands::get_roles::run(&config, &address, pretty),
        Command::GetBalance {
            config,
            address,
            pretty,
        } => commands::get_balance::run(&config, &address, pretty),
        Command::GetAllowance {
            config,
            owner,
            spender,
            pretty,
        } => commands::get_allowance::run(&config, &owner, &spender, pretty),
        Command::GetDeposit {
            config,
            deposit_id,
            pretty,
        } => commands::get_deposit::run(&config, &deposit_id, pretty),
        Command::GetTx {
            config,
            tx_hash,
            pretty,
        } => commands::get_tx::run(&config, &tx_hash, pretty),
        Command::Withdraw {
            config,
            shares,
            source_vault,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap,
            pretty,
        } => commands::withdraw::run(commands::withdraw::Args {
            config_path: config,
            shares,
            source_vault,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap_wei: fee_cap,
            pretty,
        }),
    };
    std::process::exit(exit_code);
}

/// Load the config file (if any) just to extract its `[log]` block,
/// apply env overrides, and start the loggers. Failures here are
/// non-fatal — the subcommand will report config errors via its own
/// JSON output. We deliberately fall back to fully-default logging so
/// the audit trail is always populated.
fn init_logging_best_effort(config_path: Option<&Path>) {
    let log_cfg = config_path
        .and_then(|p| Config::from_path(p).ok())
        .map(|c| c.log)
        .unwrap_or_default()
        .with_env_overrides();

    if let Err(e) = logging::init(&log_cfg) {
        // Print to stderr only — pre-init we can't use the `log` macros.
        eprintln!("rmpc[WARN] logging init failed: {e}");
    }
}
