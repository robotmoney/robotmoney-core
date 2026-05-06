//! Anvil-flavor smoke test for the e2e harness scaffold (issue #17).
//!
//! This is the trivial proof that `Fixture::anvil()` boots Anvil, runs
//! the deploy script, ingests the deployment JSON, and that
//! `rmpd self-check` runs against the result and returns `ok: true`.
//!
//! Real scenario coverage lives in #18 / #19 — this test only exercises
//! the harness plumbing.
//!
//! Skips (with a printed warning, not a failure) when `anvil` or
//! `forge` are not on PATH so the test stays runnable on developer
//! machines without Foundry. CI installs Foundry, so the test runs
//! for real there.

use rmpd_e2e::Fixture;

#[test]
fn anvil_self_check_ok() {
    if !rmpd_e2e::foundry_available() {
        eprintln!(
            "[anvil_smoke] foundry (anvil + forge) not on PATH; skipping. \
             Install via https://getfoundry.sh to run this test."
        );
        return;
    }

    let fx = Fixture::anvil().expect("boot anvil + deploy");

    // Sanity: deployment JSON parsed and addresses are non-zero.
    assert_ne!(fx.gateway(), alloy_primitives::Address::ZERO);
    assert_ne!(fx.usdc(), alloy_primitives::Address::ZERO);
    assert_ne!(fx.vault(), alloy_primitives::Address::ZERO);

    // self-check must exit 0 and report ok.
    let out = fx.run_rmpd_self_check().expect("rmpd self-check");
    assert!(
        out.status.success(),
        "rmpd self-check exited non-zero: status={:?}, stdout={}, stderr={}",
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
