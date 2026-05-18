//! Canonical: docs/implementation-plan.md §4.8 — CLI surface
//!
//! `rmpc` subcommand implementations.
//!
//! Each module exposes a `run(...)` function that returns the process exit
//! code. JSON output goes on stdout; logs/warnings go on stderr.

pub mod deposit;
pub mod get_agent;
pub mod get_allowance;
pub mod get_balance;
pub mod get_deposit;
pub mod get_gateway;
pub mod get_governance;
pub mod get_roles;
pub mod get_router;
pub mod get_timelock;
pub mod get_tx;
pub mod get_vault;
pub mod get_vaults;
pub mod self_check;
pub mod status;
pub mod withdraw;
