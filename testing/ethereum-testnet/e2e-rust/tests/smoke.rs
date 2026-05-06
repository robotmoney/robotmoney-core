//! Canonical: docs/implementation-plan.md §5 — Geth+Lighthouse smoke test
//!
//! Smoke test for the e2e harness scaffold. Boots the Docker
//! Geth+Lighthouse devnet via [`Fixture::new`], runs `forge script
//! Deploy` from the host, decrypts the harness keystore, and invokes
//! `rmpc self-check`. Expects `ok: true` in the JSON output.
//!
//! Issue #37 dropped the prior Anvil flavor; the e2e crate now has a
//! single backend, so this smoke test (formerly `geth_smoke.rs`) is
//! the only smoke test. Skips with a printed warning when Docker /
//! Foundry are not on PATH so plain `cargo test -p rmpc-e2e` stays
//! runnable on dev machines without the prerequisites.

use rmpc_e2e::Fixture;

#[test]
fn self_check_ok() {
    if !rmpc_e2e::prerequisites_available() {
        eprintln!(
            "[smoke] docker / forge / cast not on PATH; skipping. \
             Install Docker + Foundry to run this test."
        );
        return;
    }

    let fx = Fixture::new().expect("boot geth devnet + deploy");
    assert_ne!(fx.gateway(), alloy_primitives::Address::ZERO);

    let out = fx.run_rmpc_self_check().expect("rmpc self-check");
    assert!(
        out.status.success(),
        "rmpc self-check exited non-zero: status={:?}, stdout={}, stderr={}",
        out.status,
        out.stdout,
        out.stderr
    );
    let v: serde_json::Value =
        serde_json::from_str(&out.stdout).expect("self-check emits valid JSON");
    assert_eq!(
        v.get("ok").and_then(|x| x.as_bool()),
        Some(true),
        "self-check did not report ok: {}",
        out.stdout
    );
    assert_eq!(
        v.get("chain_id").and_then(|x| x.as_u64()),
        Some(fx.chain_id()),
        "self-check chain_id mismatch: {}",
        out.stdout
    );
}
