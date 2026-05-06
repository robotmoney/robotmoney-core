//! Canonical: docs/implementation-plan.md §4.8 — CLI surface
//!
//! `rmpc` subcommand implementations.
//!
//! Each module exposes a `run(...)` function that returns the process exit
//! code. JSON output goes on stdout; logs/warnings go on stderr.

pub mod deposit;
pub mod get_agent;
pub mod get_gateway;
pub mod get_roles;
pub mod get_vault;
pub mod self_check;
pub mod status;
