//! Hermetic tests of the `--deploy-only` command line of the smoke-test binary (core 1549).
//!
//! `--deploy-only` is the stage deploy job: it runs the ceremony against a running Twin chain, writes the dapp
//! compose environment and exits, so the dapp stack and the chain are owned by compose, not by this process. The
//! flag combinations that make no sense are refused before anything is booted. No chain, no Docker.

use std::process::{Command, Output};

fn smoke(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_smoke-test"))
        .args(args)
        // A refusal must come from argument validation, never from a boot that happened to fail.
        .env(
            "SMOKE_TEST_LOG_FILE",
            std::env::temp_dir().join("deploy-only-cli.log"),
        )
        .output()
        .expect("run smoke-test")
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).to_string()
}

#[test]
fn deploy_only_is_listed_in_the_help() {
    let o = smoke(&["--help"]);
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    assert!(text.contains("--deploy-only"), "help: {text}");
    assert!(text.contains("--dapp-env-out"), "help: {text}");
}

#[test]
fn deploy_only_without_its_outputs_is_refused() {
    let o = smoke(&["--deploy-only"]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert!(stderr(&o).contains("--dapp-env-out"), "{}", stderr(&o));
}

#[test]
fn deploy_only_with_a_missing_port_is_refused() {
    let o = smoke(&[
        "--deploy-only",
        "--dapp-env-out",
        "/tmp/x.json",
        "--dapp-port",
        "5173",
    ]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert!(stderr(&o).contains("--explorer-port"), "{}", stderr(&o));
}

#[test]
fn deploy_only_excludes_the_stack_flags() {
    for flag in ["--full-stack", "--tunnel"] {
        let o = smoke(&["--deploy-only", flag]);
        assert_eq!(o.status.code(), Some(2), "{flag}: {}", stderr(&o));
        assert!(
            stderr(&o).contains("starts no stack"),
            "{flag}: {}",
            stderr(&o)
        );
    }
}

#[test]
fn public_urls_still_need_all_three() {
    let o = smoke(&[
        "--deploy-only",
        "--dapp-env-out",
        "/tmp/x.json",
        "--dapp-port",
        "5173",
        "--explorer-port",
        "18546",
        "--public-rpc-url",
        "https://rpc.example",
    ]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert!(
        stderr(&o).contains("must all be set together"),
        "{}",
        stderr(&o)
    );
}
