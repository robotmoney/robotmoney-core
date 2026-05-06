//! `rmpc` subcommand implementations.
//!
//! Each module exposes a `run(...)` function that returns the process exit
//! code. JSON output goes on stdout; logs/warnings go on stderr.

pub mod deposit;
pub mod self_check;
pub mod status;
