//! `rmpc build-info` — the exact source commit this binary was compiled
//! from, embedded at build time via `build.rs`.
//!
//! No config file, no chain access: this is a static property of the
//! artifact on disk, readable before any operator config exists.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct BuildInfoOutput {
    pub commit: &'static str,
    pub dirty: bool,
    pub version: &'static str,
}

pub fn run(pretty: bool) -> i32 {
    let out = BuildInfoOutput {
        commit: env!("RMPC_BUILD_COMMIT"),
        dirty: env!("RMPC_BUILD_DIRTY") == "true",
        version: env!("CARGO_PKG_VERSION"),
    };
    let json = if pretty {
        serde_json::to_string_pretty(&out)
    } else {
        serde_json::to_string(&out)
    }
    .expect("build-info output serialises");
    println!("{json}");
    0
}
