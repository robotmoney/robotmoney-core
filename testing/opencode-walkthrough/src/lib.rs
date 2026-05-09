//! Canonical: docs/walkthroughs/opencode-readonly-fork.md
//!
//! Shared helpers for the OpenCode walkthrough test suite. The
//! integration tests in `tests/` shell out to the real `rmpc` binary
//! built from the sibling `rust-payment-client` crate, parse the
//! walkthrough markdown, and assert that every command/flag/file
//! reference in the walkthrough resolves against actual code.
//!
//! No library surface is intended for downstream consumers — this
//! `lib.rs` only exists so multiple integration tests can share the
//! repo-root resolver and the rmpc-build helper without code
//! duplication.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Walk up from `CARGO_MANIFEST_DIR` until we find a sibling
/// `clients/` and `plugins/` directory pair — the unambiguous repo
/// root marker also used by `clients/rust-payment-client/tests/skill_docs_parity.rs`.
pub fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut cur: &Path = &manifest;
    loop {
        if cur.join("plugins").is_dir() && cur.join("clients").is_dir() {
            return cur.to_path_buf();
        }
        cur = cur.parent().expect(
            "walked past filesystem root without finding repo root \
             (expected sibling `plugins/` and `clients/` directories)",
        );
    }
}

/// Path to the walkthrough doc this crate validates.
pub fn walkthrough_md() -> PathBuf {
    repo_root().join("docs/walkthroughs/opencode-readonly-fork.md")
}

/// Path to the shipped TOML config template the walkthrough's step 3
/// instructs operators to copy.
pub fn config_template_path() -> PathBuf {
    repo_root().join("testing/opencode-walkthrough/fixtures/rmpc-fork.toml.template")
}

/// Build the `rmpc` binary in the sibling `rust-payment-client` crate
/// and return its path. Cached behind a [`OnceLock`] so multiple test
/// targets sharing a process do not rebuild.
///
/// `rust-payment-client` is a workspace member, so cargo places the
/// compiled binary in the workspace-root `target/debug/` rather than
/// in the per-crate `clients/rust-payment-client/target/debug/`.
pub fn rmpc_bin() -> &'static PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        // Use the workspace-root Cargo.toml so cargo resolves the shared
        // target directory correctly for all workspace members.
        let manifest = repo_root().join("Cargo.toml");
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "--quiet",
                "--bin",
                "rmpc",
                "--manifest-path",
                manifest.to_str().expect("manifest path utf-8"),
            ])
            .status()
            .expect("spawn cargo build for rmpc");
        assert!(status.success(), "cargo build --bin rmpc failed");
        // Workspace target dir: target/debug/, not clients/rust-payment-client/target/debug/.
        let bin = repo_root().join("target/debug/rmpc");
        assert!(bin.exists(), "rmpc binary not at {bin:?} after build");
        bin
    })
}

/// Run `rmpc <args> --help` and return stdout. Used by the walkthrough
/// parity tests to enumerate the actual CLI surface.
pub fn rmpc_help(args: &[&str]) -> String {
    let mut cmd = Command::new(rmpc_bin());
    cmd.args(args).arg("--help");
    let out = cmd.output().expect("spawn rmpc --help");
    assert!(
        out.status.success(),
        "`rmpc {} --help` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr),
    );
    String::from_utf8(out.stdout).expect("rmpc --help stdout is utf-8")
}
