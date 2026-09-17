//! Embeds the exact source commit `rmpc` was compiled from.
//!
//! fusion-qa's AC-ID-03 binary-provenance check used to infer staleness from
//! the executable's filesystem mtime, on the theory that a rebuild always
//! bumps it. That's false whenever a release tag doesn't touch this crate's
//! own source: cargo's incremental build leaves an unchanged binary alone,
//! mtime included, even though the artifact is provably built from the
//! pinned commit. Embedding the commit at compile time gives the check
//! something to compare that isn't a filesystem side effect.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let git_dir = repo_root.join(".git");

    // A `git checkout <tag>` always moves HEAD (and, for a branch, the ref it
    // points at), even when the new tree touches no file under this crate.
    // Watching those two paths — not the crate directory — is what makes the
    // embedded commit track the checkout instead of just this crate's diff.
    println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
    if let Ok(head) = std::fs::read_to_string(git_dir.join("HEAD")) {
        if let Some(ref_path) = head.strip_prefix("ref: ") {
            println!(
                "cargo:rerun-if-changed={}",
                git_dir.join(ref_path.trim()).display()
            );
        }
    }

    let commit = run_git(&repo_root, &["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = Command::new("git")
        .args(["-C", &repo_root.to_string_lossy(), "status", "--porcelain"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false);

    println!("cargo:rustc-env=RMPC_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=RMPC_BUILD_DIRTY={dirty}");
}

fn run_git(repo_root: &std::path::Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8(output.stdout).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}
