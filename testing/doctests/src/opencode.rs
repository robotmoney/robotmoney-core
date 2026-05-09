//! Helpers for the OpenCode walkthrough doc-parity tests.
//! Canonical doc: `docs/walkthroughs/opencode-readonly-fork.md`

use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    test_utils::find_workspace_root()
        .expect("could not locate workspace root from CARGO_MANIFEST_DIR")
}

/// Path to the walkthrough doc this module validates.
pub fn walkthrough_md() -> PathBuf {
    repo_root().join("docs/walkthroughs/opencode-readonly-fork.md")
}

/// Path to the TOML config template shipped with the walkthrough.
pub fn config_template_path() -> PathBuf {
    repo_root().join("testing/doctests/fixtures/opencode/rmpc-fork.toml.template")
}

pub fn rmpc_bin() -> &'static PathBuf {
    test_utils::build_rmpc_bin()
}

/// Run `rmpc <args> --help` and return stdout.
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
