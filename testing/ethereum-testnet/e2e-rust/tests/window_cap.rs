//! Canonical: docs/implementation-plan.md §5 — Window-cap scenario
//!
//! Per-agent `maxPerWindow` enforcement on the Geth+Lighthouse devnet.
//! This scenario lives in its own test binary because it requires a
//! deploy-time `AGENT_MAX_PER_WINDOW` override that disagrees with the
//! defaults the rest of the e2e suite assumes — co-residing it in
//! `tests/scenarios.rs` would force a fixture swap mid-suite (paying
//! the ~90s Geth boot twice).
//!
//! The boot cost is paid once for this single test. CI runs the
//! scenario binaries sequentially so port 8545 is never contended.
//!
//! Issue #37 is the consolidation that made this layout necessary.

use std::sync::{Mutex, OnceLock};

use rmpc_e2e::Fixture;
use serde_json::Value;

/// USDC has 6 decimals throughout the harness.
const ONE_USDC: u128 = 1_000_000;
/// Cap-test first leg.
const CAP_TEST_FIRST_LEG: u128 = 60 * ONE_USDC;
/// Cap-test second leg: 60 + 60 = 120; together with the leg-1 60 USDC
/// the cumulative gross hits 120, then 180, then 220 — pushing the
/// second leg above the 200-USDC `AGENT_MAX_PER_WINDOW_E2E` cap.
const CAP_TEST_SECOND_LEG: u128 = 60 * ONE_USDC;
/// Per-window cap used at deploy time. 200 USDC == 200_000_000 in 6dp.
const AGENT_MAX_PER_WINDOW_E2E: &str = "200000000";
/// Per-payment cap. Set per-payment == per-window so each individual
/// deposit is allowed but cumulative still trips the window cap on
/// leg 2.
const AGENT_MAX_PER_PAYMENT_E2E: &str = "200000000";

const RECEIPT_TIMEOUT_SECS: &str = "180";

fn order_id(label: &str) -> String {
    use alloy_primitives::keccak256;
    let h = keccak256(format!("rmpc-e2e-window-cap-{label}").as_bytes());
    format!("{h:#x}")
}

fn skip_if_no_prereqs(test_name: &str) -> bool {
    if !rmpc_e2e::prerequisites_available() {
        eprintln!(
            "[{test_name}] docker / forge / cast not on PATH; skipping. \
             Install Docker + Foundry to run this test."
        );
        return true;
    }
    false
}

fn parse_json(stdout: &str, ctx: &str) -> Value {
    serde_json::from_str(stdout)
        .unwrap_or_else(|e| panic!("{ctx}: rmpc stdout is not valid JSON: {e}\nstdout:\n{stdout}"))
}

fn shared_fixture() -> &'static Mutex<Option<Fixture>> {
    static CELL: OnceLock<Mutex<Option<Fixture>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn with_fixture<F: FnOnce(&Fixture) -> R, R>(f: F) -> R {
    let cell = shared_fixture();
    let mut guard = cell.lock().expect("shared fixture mutex poisoned");
    if guard.is_none() {
        let fx = Fixture::with_deploy_env(&[
            ("AGENT_MAX_PER_PAYMENT", AGENT_MAX_PER_PAYMENT_E2E),
            ("AGENT_MAX_PER_WINDOW", AGENT_MAX_PER_WINDOW_E2E),
        ])
        .expect("boot geth devnet + low-cap deploy");
        *guard = Some(fx);
    }
    f(guard.as_ref().expect("fixture present"))
}

fn deposit_args(amount: u128, oid: &str) -> [String; 6] {
    [
        "--amount".into(),
        amount.to_string(),
        "--order-id".into(),
        oid.into(),
        "--receipt-timeout-secs".into(),
        RECEIPT_TIMEOUT_SECS.into(),
    ]
}

/// Second deposit whose cumulative gross exceeds `maxPerWindow`
/// reverts. Two deposits both within `maxPerPayment` but whose sum
/// crosses the lowered 200-USDC `AGENT_MAX_PER_WINDOW`. The first leg
/// must succeed, the second leg must refuse with `ErrConfig`
/// (preflight) or `ErrTxReverted` (gateway revert).
#[test]
fn over_window_cap_rejected() {
    if skip_if_no_prereqs("over_window_cap_rejected") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(CAP_TEST_FIRST_LEG + CAP_TEST_SECOND_LEG)
            .expect("approve usdc");

        // Leg 1 — pushes window gross from 0 → 60 (under 200).
        let oid_a = order_id("a");
        let first = fx
            .run_rmpc_deposit(deposit_args(CAP_TEST_FIRST_LEG, &oid_a))
            .expect("run rmpc deposit (leg 1)");
        assert!(
            first.status.success(),
            "leg 1 should succeed (60 ≤ 200); status={:?}\nstdout={}\nstderr={}",
            first.status,
            first.stdout,
            first.stderr,
        );
        let v1 = parse_json(&first.stdout, "over_window_cap_rejected/leg1");
        assert_eq!(v1["status"], "success", "stdout={}", first.stdout);

        // Leg 2 — would push gross to 120 + ... wait. Recompute:
        // We need a *cumulative* over-cap. With caps 200/200 and two
        // 60-USDC legs, cumulative is only 120 — under the cap.
        // Re-do with a heavier second leg so leg2 crosses the line.
        // The legacy test layered on a prior happy-path's 100 USDC.
        // Here we want a self-contained breach: leg1 60, leg2 150 →
        // cumulative 210 > 200. (Per-payment 200 still allows leg2.)
        let heavy_leg = 150 * ONE_USDC;
        fx.approve_usdc_from_agent(heavy_leg)
            .expect("approve usdc (heavy leg)");
        let oid_b = order_id("b-heavy");
        let second = fx
            .run_rmpc_deposit(deposit_args(heavy_leg, &oid_b))
            .expect("run rmpc deposit (leg 2)");
        assert_eq!(
            second.status.code(),
            Some(2),
            "expected exit 2 on window-cap refusal; stdout={}\nstderr={}",
            second.stdout,
            second.stderr,
        );
        let v2 = parse_json(&second.stdout, "over_window_cap_rejected/leg2");
        assert_eq!(v2["status"], "refused", "stdout={}", second.stdout);
        let err = v2["error"].as_str().unwrap_or("");
        assert!(
            err == "ErrConfig" || err == "ErrTxReverted",
            "expected ErrConfig (preflight) or ErrTxReverted (gateway revert); got {err}; stdout={}",
            second.stdout
        );
        let msg = v2["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("maxPerWindow") || msg.to_lowercase().contains("window"),
            "refusal message should reference the window cap; got: {msg}; stdout={}",
            second.stdout
        );
    });
}
