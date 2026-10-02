//! The Twin chain run of publish contracts, end to end (core 1488).
//!
//! One test boots the Twin chain (918453) through the harness. The harness has already called
//! `publish` (deploy all four vaults, real Safe handover). This test then asserts the four
//! manifests, runs the one verifier, and runs the stage 13 govern matrix through the real Safe.
//! The verifier output (SMOKE_TEST_VERIFY_OUT) and the run sheet (SMOKE_TEST_SHEET_OUT) are saved for the
//! parity step in suite 14. Every govern row must carry a tx hash and receipt status 1 (checked by `govern_matrix`).
//!
//! Run with:
//!   cargo test -p smoke-test --release --test twin_publish -- --test-threads=1 --nocapture

use smoke_test::{prerequisites_available, Fixture};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run one Bun script from the core checkout. Its output goes to the test log. A non-zero exit fails the test.
fn run_bun(repo_root: &Path, args: &[String]) {
    let out = Command::new("bun")
        .args(args)
        .current_dir(repo_root)
        .output()
        .expect("bun must be on PATH");
    println!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success(),
        "bun {} exited {:?}",
        args.join(" "),
        out.status.code()
    );
}

/// The value of `export NAME=VALUE` in the run sheet. The sheet is read as data, never sourced.
fn sheet_value(sheet: &Path, name: &str) -> String {
    let text = std::fs::read_to_string(sheet).expect("read the run sheet");
    let prefix = format!("export {name}=");
    text.lines()
        .find_map(|l| l.trim().strip_prefix(&prefix).map(|v| v.trim().to_string()))
        .unwrap_or_else(|| panic!("the run sheet has no {name}"))
}

#[test]
fn twin_chain_publish_verify_and_govern_matrix() {
    if !prerequisites_available() {
        panic!("docker/forge/cast not on PATH: the Twin chain publish run cannot be skipped in CI");
    }
    let fx = Fixture::new().expect("smoke-test fixture boot failed");
    let dir = fx.manifest_dir();
    assert!(
        dir.join("core.json").is_file(),
        "rmUSDC manifest (core.json) missing"
    );
    for key in ["rmPROTO", "rmAGENT", "rmRWA"] {
        assert!(
            dir.join(format!("vault-{key}.json")).is_file(),
            "manifest for {key} missing in {}",
            dir.display()
        );
    }
    let verified = fx
        .published()
        .verify()
        .expect("the verifier must pass on the Twin chain");
    assert!(!verified.trim().is_empty(), "the verifier printed nothing");
    // Saved for scripts/stage/label-diff.ts: the stage label set must equal mainnet's.
    if let Ok(path) = std::env::var("SMOKE_TEST_VERIFY_OUT") {
        std::fs::write(&path, &verified).expect("write the verifier output");
    }
    // Saved for scripts/stage/parity.ts: the run sheet (parameter lines plus the generated identity
    // lines) must differ from the production sheet only in parameter and identity lines.
    if let Ok(path) = std::env::var("SMOKE_TEST_SHEET_OUT") {
        std::fs::copy(&fx.published().sheet_path, &path).expect("copy the run sheet");
    }

    // Core 1488: the three assertion scripts run against the live Twin chain while it is up, then the
    // run report prints stages, tx counts, the vault set and the verifier labels. Proofs and the report
    // are written to SMOKE_TEST_PROOF_DIR (uploaded by the suite 14 twin_publish job).
    let proof_dir: PathBuf = std::env::var("SMOKE_TEST_PROOF_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| fx.tempdir().join("proofs"));
    std::fs::create_dir_all(&proof_dir).expect("create the proof directory");
    let root = fx.repo_root().to_path_buf();
    let p = |f: &str| proof_dir.join(f).display().to_string();
    let verify_labels = proof_dir.join("verifier-labels.txt");
    std::fs::write(&verify_labels, &verified).expect("write the verifier labels");
    let s = |x: &str| x.to_string();
    run_bun(
        &root,
        &[
            s("scripts/stage/twin-run-report.ts"),
            s("--manifest-dir"),
            dir.display().to_string(),
            s("--run-manifest"),
            dir.join("publish-run.json").display().to_string(),
            s("--labels"),
            verify_labels.display().to_string(),
            s("--merged-out"),
            p("merged-manifest.json"),
            s("--json-out"),
            p("twin-run-report.json"),
        ],
    );
    let rpc = fx.rpc_url().to_string();
    let keys = &fx.published().keys;
    run_bun(
        &root,
        &[
            s("scripts/deploy/assert-core-router.ts"),
            s("--rpc-url"),
            rpc.clone(),
            s("--manifest"),
            p("merged-manifest.json"),
            s("--out"),
            p("proof-router.json"),
            // The share receiver on the Twin chain is a keyless address, so the signed deposit and
            // withdraw round trip runs where both signers exist. The two router() reads run here.
            s("--read-only"),
        ],
    );
    run_bun(
        &root,
        &[
            s("scripts/deploy/assert-basket-vaults.ts"),
            s("--rpc-url"),
            rpc.clone(),
            s("--manifest"),
            p("merged-manifest.json"),
            s("--out"),
            p("proof-basket.json"),
        ],
    );
    run_bun(
        &root,
        &[
            s("scripts/deploy/assert-timelock-roles.ts"),
            s("--rpc-url"),
            rpc,
            s("--manifest"),
            p("merged-manifest.json"),
            s("--deployer"),
            keys.address("ADMIN_ADDRESS")
                .expect("ADMIN_ADDRESS")
                .to_string(),
            s("--safe"),
            format!("{:#x}", fx.safe()),
            s("--emergency"),
            keys.address("EMERGENCY_ADDRESS")
                .expect("EMERGENCY_ADDRESS")
                .to_string(),
            s("--min-delay"),
            sheet_value(&fx.published().sheet_path, "TIMELOCK_MIN_DELAY"),
            s("--out"),
            p("proof-timelock-roles.json"),
        ],
    );

    let rows = fx
        .published()
        .govern_matrix()
        .expect("the govern matrix must pass through the real Safe");
    assert!(!rows.is_empty(), "the govern matrix ran no rows");
}
