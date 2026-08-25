//! Canonical: Plan tracking issue #109 — CLI integration tests for `rmpc --version`
//!
//! Regression tests for issue #1191: the released binary reported `rmpc 0.1.0`
//! regardless of the release tag, so an operator could not identify which build
//! they were running.
//!
//! clap's bare `version` derive on `Cli` (see `src/cli.rs`) expands to
//! `CARGO_PKG_VERSION`, i.e. the `version` field of
//! `clients/rust-payment-client/Cargo.toml`. Nothing in the release pipeline
//! injects the tag into the binary — `release-rmpc.yml` resolves the tag only
//! to name the archive. So the checked-in manifest version IS the version
//! operators see, and keeping it truthful is a source-level obligation, not a
//! packaging one.
//!
//! `release-rmpc.yml` additionally asserts at build time that the reported
//! version matches the tag being released; these tests are the local half of
//! that contract, so a stale manifest fails in PR CI rather than at release.

use assert_cmd::Command;

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// `--version` reports the manifest version, and that version is not the
/// unpublished `0.1.0` placeholder that shipped in every release up to #1191.
#[test]
fn version_flag_reports_manifest_version_and_is_not_the_placeholder() {
    let expected = env!("CARGO_PKG_VERSION");

    assert_ne!(
        expected, "0.1.0",
        "clients/rust-payment-client/Cargo.toml is back at the 0.1.0 placeholder. \
         Releases take their binary version from this field (see issue #1191), so \
         leaving it at 0.1.0 ships unidentifiable binaries again."
    );

    let out = rmpc().arg("--version").assert().success();
    let stdout =
        String::from_utf8(out.get_output().stdout.clone()).expect("utf-8 --version output");

    assert_eq!(
        stdout.trim(),
        format!("rmpc {expected}"),
        "`rmpc --version` must report the manifest version verbatim"
    );
}

/// The short `-V` alias agrees with `--version`. Guards against a future
/// `long_version` or custom version string desynchronising the two.
#[test]
fn short_version_flag_agrees_with_long_flag() {
    let long = rmpc().arg("--version").assert().success();
    let short = rmpc().arg("-V").assert().success();

    assert_eq!(
        String::from_utf8(long.get_output().stdout.clone()).expect("utf-8"),
        String::from_utf8(short.get_output().stdout.clone()).expect("utf-8"),
        "`-V` and `--version` must report the same string"
    );
}
