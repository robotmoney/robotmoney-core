//! The Twin chain run of publish contracts, end to end (core 1488).
//!
//! One test boots the Twin chain (918453) through the harness. The harness has already called
//! `publish` (deploy all four vaults, real Safe handover). This test then asserts the four
//! manifests, runs the one verifier, and runs the stage 13 govern matrix through the real Safe.
//! Every govern row must carry a tx hash and receipt status 1 (checked by `govern_matrix`).
//!
//! Run with:
//!   cargo test -p smoke-test --release --test twin_publish -- --test-threads=1 --nocapture

use smoke_test::{prerequisites_available, Fixture};

#[test]
fn twin_chain_publish_verify_and_govern_matrix() {
    if !prerequisites_available() {
        panic!("docker/forge/cast not on PATH: the Twin chain publish run cannot be skipped in CI");
    }
    let fx = Fixture::new().expect("smoke-test fixture boot failed");
    let dir = fx.manifest_dir();
    assert!(dir.join("core.json").is_file(), "rmUSDC manifest (core.json) missing");
    for key in ["rmPROTO", "rmAGENT", "rmRWA"] {
        assert!(
            dir.join(format!("vault-{key}.json")).is_file(),
            "manifest for {key} missing in {}",
            dir.display()
        );
    }
    let verified = fx.published().verify().expect("the verifier must pass on the Twin chain");
    assert!(!verified.trim().is_empty(), "the verifier printed nothing");
    // Saved for scripts/stage/label-diff.ts: the stage label set must equal mainnet's.
    if let Ok(path) = std::env::var("SMOKE_TEST_VERIFY_OUT") {
        std::fs::write(&path, &verified).expect("write the verifier output");
    }
    let rows = fx
        .published()
        .govern_matrix()
        .expect("the govern matrix must pass through the real Safe");
    assert!(!rows.is_empty(), "the govern matrix ran no rows");
}
