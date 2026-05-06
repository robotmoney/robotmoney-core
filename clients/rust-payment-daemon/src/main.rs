//! `rmpd` — Robot Money payment daemon CLI entry point.
//!
//! All command logic lives in [`rust_payment_daemon::commands`]; this file
//! is a thin shim that parses argv and dispatches.

use clap::Parser;
use rust_payment_daemon::cli::{Cli, Command};
use rust_payment_daemon::commands;

fn main() {
    let cli = Cli::parse();
    let exit_code = match cli.command {
        Command::Deposit { .. } => {
            // Issue #16 — still a stub.
            println!("{{\"status\":\"unimplemented\"}}");
            0
        }
        Command::SelfCheck { config, pretty } => commands::self_check::run(&config, pretty),
        Command::Status {
            config,
            payment_id,
            pretty,
        } => commands::status::run(&config, &payment_id, pretty),
    };
    std::process::exit(exit_code);
}
