//! Canonical: docs/walkthroughs/opencode-readonly-fork.md (issue #53),
//! step 6 (refusal demonstration).
//!
//! Asserts the structured refusal contract the walkthrough promises:
//! invoking `rmpc` with an unknown subcommand exits non-zero and emits
//! a non-empty stderr payload. OpenCode (or any harness) surfaces both
//! channels, so the agent can refuse cleanly rather than fabricate a
//! recovery action.
//!
//! No RPC, no anvil, no fork — this test runs on every PR.

use std::process::Command;

use doctests::opencode::rmpc_bin;

#[test]
fn unknown_subcommand_refuses_with_nonzero_exit() {
    let out = Command::new(rmpc_bin())
        .arg("not-a-real-subcommand")
        .output()
        .expect("spawn rmpc with unknown subcommand");

    assert!(
        !out.status.success(),
        "rmpc accepted an unknown subcommand instead of refusing; exit = {:?}",
        out.status.code()
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.trim().is_empty(),
        "refusal must include a stderr payload so the harness can surface it; \
         got empty stderr"
    );
    // Clap's behaviour for unknown subcommands: stderr starts with
    // `error:` and includes the offending token. Pin both, so a future
    // CLI rewrite that drops one channel still flags the contract
    // change rather than silently passing.
    assert!(
        stderr.to_lowercase().contains("error"),
        "stderr must label the refusal as an error; got:\n{stderr}"
    );
    assert!(
        stderr.contains("not-a-real-subcommand") || stderr.contains("unrecognized"),
        "stderr must identify the unknown subcommand or be labelled \
         `unrecognized`; got:\n{stderr}"
    );
}

#[test]
fn missing_required_config_flag_refuses() {
    // Every read subcommand requires --config; invoking one without it
    // is the second refusal shape an OpenCode session is likely to
    // trigger (typo, forgotten flag). Lock that contract too.
    let out = Command::new(rmpc_bin())
        .arg("get-vault")
        .output()
        .expect("spawn rmpc get-vault with no flags");
    assert!(
        !out.status.success(),
        "rmpc get-vault accepted no --config and exited 0"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.trim().is_empty(),
        "missing-flag refusal must include stderr; got empty"
    );
}
