//! Geth+Lighthouse smoke test for the e2e harness scaffold.
//!
//! Gated behind `RMPC_E2E_GETH=1` so plain `cargo test` doesn't
//! require Docker. The full Docker stack takes ~30s to come up plus a
//! few blocks to finalize before deposits land — overkill for the
//! issue #17 scaffold, but exercising the boot/teardown plumbing here
//! lets #19 (the real-chain scenarios) build on a trusted harness.

use rmpc_e2e::Fixture;

#[test]
fn geth_self_check_ok() {
    if !rmpc_e2e::geth_enabled() {
        eprintln!(
            "[geth_smoke] RMPC_E2E_GETH!=1 or docker missing; skipping. \
             Set RMPC_E2E_GETH=1 with Docker installed to run this test."
        );
        return;
    }

    let fx = Fixture::geth().expect("boot geth devnet + deploy");
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
    assert_eq!(v.get("ok").and_then(|x| x.as_bool()), Some(true));
}
