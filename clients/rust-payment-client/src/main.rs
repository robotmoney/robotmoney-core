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
        Command::GetGateway { config, .. } => Some(config.as_path()),
        Command::GetAgent { config, .. } => Some(config.as_path()),
        Command::GetRoles { config, .. } => Some(config.as_path()),
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
            pretty,
        } => commands::deposit::run(commands::deposit::Args {
            config_path: config,
            amount,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            pretty,
        }),
        Command::SelfCheck { config, pretty } => commands::self_check::run(&config, pretty),
        Command::Status {
            config,
            payment_id,
            pretty,
        } => commands::status::run(&config, &payment_id, pretty),
        Command::GetVault { config, pretty } => commands::get_vault::run(&config, pretty),
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
