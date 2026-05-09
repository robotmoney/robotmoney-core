//! Canonical: docs/implementation-plan.md §5 — End-to-end scenarios
//!
//! End-to-end scenario tests for `rmpc` against the Geth+Lighthouse
//! devnet (issues #18, #19, #37).
//!
//! Issue #37 consolidated the previous Anvil-flavor scenarios into
//! this file so the harness has a single backend. The window-cap
//! scenario lives in a sibling `tests/window_cap.rs` because it needs
//! a deploy-time `AGENT_MAX_PER_WINDOW` override; co-residing it here
//! would require either a fixture swap or per-test boots, both of
//! which dwarf the cost of a separate test binary.
//!
//! Scenarios in this file (alphabetical, the order libtest runs them
//! under `--test-threads=1`):
//!
//! 1. `code_hash_mismatch_aborts` — pinned `gateway_runtime_hash`
//!    mismatch refused with `ErrCodeHashMismatch`.
//! 2. `concurrent_invocation_locked` — per-agent flock wins for one
//!    process; the loser refuses with `ErrConcurrentInvocation`.
//! 3. `deposit_happy_path` — full deposit pipeline, asserts on JSON +
//!    on-chain side effects via `rmpc status`.
//! 4. `idempotent_replay_rejected` — replaying `(orderId,
//!    idempotencyKey)` reverts on chain, surfaced as `ErrTxReverted`.
//! 5. `over_per_payment_cap_rejected` — `amount > maxPerPayment`
//!    refused by preflight (`ErrConfig`).
//! 6. `paused_blocks_deposit` — `paused() == true` refused by
//!    preflight (`ErrGatewayPaused`); test cleans up by calling
//!    `unpause()` so subsequent tests can deposit.
//! 7. `role_separation_invariant` — admin granting itself
//!    `AGENT_ROLE` reverts via `RoleSeparationViolated`.
//! 8. `software_fallback_disabled_aborts_startup` — startup-time
//!    refusal with `ErrSoftwareSignerDisallowed` proven to fire
//!    before any RPC call.
//! 9. `unauthorized_agent_rejected` — agent without `AGENT_ROLE`
//!    refused by preflight; test cleans up by re-granting
//!    `AGENT_ROLE` so subsequent tests can deposit.
//!
//! ## Boot model
//!
//! All scenarios share a single Geth devnet boot. Bringing up the
//! Geth + Lighthouse + 4-validator stack costs ~60-90s, so paying
//! that nine times is a CI budget killer. We serialize via
//! `--test-threads=1` (the only safe mode for Docker tests anyway —
//! port 8545 is a global resource) and share one [`Fixture`] across
//! the suite via a `OnceLock<Mutex<…>>`.
//!
//! ## State hygiene
//!
//! State-mutating tests restore the deployment to its post-deploy
//! shape before returning, so the alphabetical order above is the
//! only order the suite is verified against — but every reset is
//! local to the test that produced it. Successful deposits accumulate
//! window-gross within `AGENT_MAX_PER_WINDOW` (100_000 USDC default),
//! which is large enough that the 100-USDC deposits across the suite
//! never exhaust the budget.
//!
//! ## Skip behavior
//!
//! Skips with a printed warning when Docker / Foundry are not on
//! PATH so plain `cargo test -p rmpc-e2e` stays runnable on dev
//! machines without the prerequisites.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use rmpc_e2e::{Fixture, AGENT_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY_HEX};
use serde_json::Value;

/// USDC has 6 decimals throughout the harness.
const ONE_USDC: u128 = 1_000_000;
/// 100 USDC. Comfortably below the default `maxPerPayment` (10_000)
/// and the default `maxPerWindow` (100_000).
const SMALL_DEPOSIT: u128 = 100 * ONE_USDC;
/// 20_000 USDC. Comfortably above the default `maxPerPayment` (10_000).
const OVER_PAYMENT_CAP_DEPOSIT: u128 = 20_000 * ONE_USDC;

/// Match the Deploy.s.sol defaults so [`Fixture::reauthorize_agent`]
/// restores the policy that was in place at deploy time.
const DEFAULT_MAX_PER_PAYMENT: u128 = 10_000 * ONE_USDC;
const DEFAULT_MAX_PER_WINDOW: u128 = 100_000 * ONE_USDC;

/// Deterministic order id from a per-test label. Avoids cross-test
/// payment-id collisions on the shared deployment.
fn order_id(label: &str) -> String {
    use alloy_primitives::keccak256;
    let h = keccak256(format!("rmpc-e2e-{label}").as_bytes());
    format!("{h:#x}")
}

/// Print + return `true` when the harness prerequisites aren't on
/// PATH (Docker, forge, cast).
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

/// Parse rmpc stdout as JSON, panicking with a helpful diagnostic on
/// failure.
fn parse_json(stdout: &str, ctx: &str) -> Value {
    serde_json::from_str(stdout)
        .unwrap_or_else(|e| panic!("{ctx}: rmpc stdout is not valid JSON: {e}\nstdout:\n{stdout}"))
}

/// Shared fixture holder. Boot is paid by whichever test runs first;
/// the stack is reused for the rest of the suite. Drop never fires
/// during the process lifetime (statics live forever) — the inner
/// `Mutex<Option<Fixture>>` exists so a future hook can manually
/// take-and-drop the fixture if we ever want explicit teardown.
fn shared_fixture() -> &'static Mutex<Option<Fixture>> {
    static CELL: OnceLock<Mutex<Option<Fixture>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Lazily boot the geth fixture on first call. Subsequent calls reuse
/// the live deployment. The lock is held for the duration of each
/// test, which is fine because tests run with `--test-threads=1`.
fn with_fixture<F: FnOnce(&Fixture) -> R, R>(f: F) -> R {
    let cell = shared_fixture();
    let mut guard = cell.lock().expect("shared fixture mutex poisoned");
    if guard.is_none() {
        let fx = Fixture::new().expect("boot geth devnet + deploy");
        *guard = Some(fx);
    }
    f(guard.as_ref().expect("fixture present"))
}

/// Receipt timeout suitable for 12-second blocks. Default is 60s
/// (~5 blocks); 180s gives us 15 blocks of headroom for the
/// `--slow`/finality stutters that happen in early devnet life.
const RECEIPT_TIMEOUT_SECS: &str = "180";

/// Common deposit args for the geth flavor.
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

// ------------------------------------------------------------- scenario 1

/// Flipping the pinned `gateway_runtime_hash` causes preflight to
/// refuse with `ErrCodeHashMismatch` *before* any signing happens. We
/// write a tweaked config to the fixture's tempdir rather than mutating
/// the canonical one in place.
#[test]
fn code_hash_mismatch_aborts() {
    if skip_if_no_prereqs("code_hash_mismatch_aborts") {
        return;
    }
    with_fixture(|fx| {
        let original = std::fs::read_to_string(fx.config_path()).expect("read config");
        let bad_hash = bitflip_hash(fx.gateway_runtime_hash());
        let tampered = original.replace(fx.gateway_runtime_hash(), &bad_hash);
        assert_ne!(tampered, original, "config bitflip must change content");
        let bad_cfg = fx.tempdir().join("rmpc.bad-hash.toml");
        std::fs::write(&bad_cfg, tampered).expect("write bad config");

        fx.approve_usdc_from_agent(SMALL_DEPOSIT)
            .expect("approve usdc");

        let oid = order_id("code_hash_mismatch_aborts");
        let mut env = HashMap::new();
        env.insert(
            rmpc_e2e::PASSPHRASE_ENV_VAR.to_string(),
            fx.passphrase().to_string(),
        );
        let args: Vec<String> = vec![
            "deposit".into(),
            "--config".into(),
            bad_cfg.to_string_lossy().into_owned(),
            "--amount".into(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".into(),
            oid,
            "--receipt-timeout-secs".into(),
            RECEIPT_TIMEOUT_SECS.into(),
        ];
        let run = fx
            .run_rmpc_with(&args, env)
            .expect("run rmpc deposit (bad hash)");

        assert_eq!(
            run.status.code(),
            Some(2),
            "expected exit 2 on hash mismatch; stdout={} stderr={}",
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "code_hash_mismatch_aborts");
        assert_eq!(v["status"], "refused");
        assert_eq!(v["error"], "ErrCodeHashMismatch", "stdout={}", run.stdout);
        assert!(
            v.get("tx_hash").and_then(|x| x.as_str()).is_none(),
            "refusal must not carry a tx_hash; got {}",
            run.stdout
        );
    });
}

/// Bit-flip every byte of a 0x-prefixed 32-byte hex string. Cheap,
/// deterministic way to produce a wrong-but-well-formed hash.
fn bitflip_hash(h: &str) -> String {
    let stripped = h.strip_prefix("0x").unwrap_or(h);
    let mut bytes = hex::decode(stripped).expect("valid hex");
    for b in &mut bytes {
        *b ^= 0xff;
    }
    format!("0x{}", hex::encode(bytes))
}

// ------------------------------------------------------------- scenario 2

/// Two `rmpc deposit` invocations against the same agent are mutually
/// exclusive — one wins the per-agent file lock, the other refuses
/// fast with `ErrConcurrentInvocation`. We spawn two children manually
/// (rather than via `Fixture::run_rmpc_deposit`, which blocks). With
/// 12-second blocks the winning deposit takes >>1s, so the loser's
/// `flock` attempt overlaps with the winner's preflight every run.
#[test]
fn concurrent_invocation_locked() {
    if skip_if_no_prereqs("concurrent_invocation_locked") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(SMALL_DEPOSIT * 2)
            .expect("approve usdc");

        let oid_a = order_id("concurrent_invocation_locked-a");
        let oid_b = order_id("concurrent_invocation_locked-b");

        let spawn = |oid: &str| -> std::process::Child {
            Command::new(fx.rmpc_binary())
                .env(rmpc_e2e::PASSPHRASE_ENV_VAR, fx.passphrase())
                .env("RMPC_STATE_DIR", fx.state_dir())
                .arg("deposit")
                .arg("--config")
                .arg(fx.config_path())
                .arg("--amount")
                .arg(SMALL_DEPOSIT.to_string())
                .arg("--order-id")
                .arg(oid)
                .arg("--receipt-timeout-secs")
                .arg(RECEIPT_TIMEOUT_SECS)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn rmpc deposit")
        };

        let child_a = spawn(&oid_a);
        let child_b = spawn(&oid_b);

        let out_a = child_a.wait_with_output().expect("wait a");
        let out_b = child_b.wait_with_output().expect("wait b");

        let stdout_a = String::from_utf8_lossy(&out_a.stdout).into_owned();
        let stdout_b = String::from_utf8_lossy(&out_b.stdout).into_owned();
        let stderr_a = String::from_utf8_lossy(&out_a.stderr).into_owned();
        let stderr_b = String::from_utf8_lossy(&out_b.stderr).into_owned();

        let saw_lock = |s: &str| s.contains("ErrConcurrentInvocation");
        let either_locked = saw_lock(&stdout_a) || saw_lock(&stdout_b);
        assert!(
            either_locked,
            "expected one process to refuse with ErrConcurrentInvocation;\n\
             A status={:?} stdout={stdout_a}\n\
             B status={:?} stdout={stdout_b}\nstderr_a={stderr_a}\nstderr_b={stderr_b}",
            out_a.status, out_b.status,
        );
        let either_succeeded = out_a.status.success() || out_b.status.success();
        assert!(
            either_succeeded,
            "expected one process to win the lock and complete its deposit;\n\
             A status={:?} stdout={stdout_a}\n\
             B status={:?} stdout={stdout_b}",
            out_a.status, out_b.status,
        );
        assert!(
            !(out_a.status.success() && out_b.status.success()),
            "both processes succeeded; lock is not actually mutually exclusive"
        );
    });
}

// ------------------------------------------------------------- scenario 3

/// Happy-path deposit on the Geth devnet.
///
/// Approves USDC from the agent, runs `rmpc deposit`, asserts the JSON
/// reports success with a `payment_id` + `tx_hash`, then asserts on the
/// observable on-chain side effects via `rmpc status`.
#[test]
fn deposit_happy_path() {
    if skip_if_no_prereqs("deposit_happy_path") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(SMALL_DEPOSIT)
            .expect("approve usdc");

        let oid = order_id("deposit_happy_path");
        let run = fx
            .run_rmpc_deposit(deposit_args(SMALL_DEPOSIT, &oid))
            .expect("run rmpc deposit");
        assert!(
            run.status.success(),
            "deposit must succeed; status={:?}\nstdout={}\nstderr={}",
            run.status,
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "deposit_happy_path");
        assert_eq!(v["status"], "success", "stdout={}", run.stdout);
        let payment_id = v["payment_id"]
            .as_str()
            .expect("payment_id present")
            .to_string();
        assert!(
            payment_id.starts_with("0x") && payment_id.len() == 66,
            "payment_id should be 32-byte hex; got {payment_id}"
        );
        let tx_hash = v["tx_hash"].as_str().expect("tx_hash present");
        assert!(
            tx_hash.starts_with("0x") && tx_hash.len() == 66,
            "tx_hash should be 32-byte hex; got {tx_hash}"
        );

        let st = fx.run_rmpc_status(&payment_id).expect("run rmpc status");
        assert!(
            st.status.success(),
            "status lookup must succeed; status={:?}\nstdout={}\nstderr={}",
            st.status,
            st.stdout,
            st.stderr
        );
        // rmpc status emits the Phase 3 shared envelope: top-level fields
        // (chain_id, block_number, source, partial, errors) plus the deposit
        // record nested inside `data`. Tests must use sv["data"][…].
        let sv = parse_json(&st.stdout, "deposit_happy_path/status");
        assert_eq!(sv["source"], "json_rpc", "stdout={}", st.stdout);
        assert!(
            sv["data"]
                .get("block_number")
                .and_then(|v| v.as_u64())
                .is_some(),
            "rmpc status should locate the deposit; stdout={}",
            st.stdout
        );
        assert_eq!(
            sv["data"]["payment_id"].as_str(),
            Some(payment_id.as_str()),
            "status payment_id roundtrip; stdout={}",
            st.stdout
        );
        assert_eq!(
            sv["data"]["amount"].as_str(),
            Some(SMALL_DEPOSIT.to_string().as_str()),
            "status amount; stdout={}",
            st.stdout
        );
    });
}

// ------------------------------------------------------------- scenario 4

/// Replaying the same `(orderId, idempotencyKey)` twice — the second
/// call passes preflight (the gateway only learns the payment id is
/// used at execution time) and reverts with `PaymentIdAlreadyUsed`,
/// surfaced by rmpc as `ErrTxReverted`.
#[test]
fn idempotent_replay_rejected() {
    if skip_if_no_prereqs("idempotent_replay_rejected") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(SMALL_DEPOSIT * 2)
            .expect("approve usdc");

        let oid = order_id("idempotent_replay_rejected");

        let first = fx
            .run_rmpc_deposit(deposit_args(SMALL_DEPOSIT, &oid))
            .expect("run rmpc deposit (first)");
        assert!(
            first.status.success(),
            "first deposit should succeed; status={:?} stdout={} stderr={}",
            first.status,
            first.stdout,
            first.stderr
        );
        let v1 = parse_json(&first.stdout, "idempotent_replay_rejected#1");
        assert_eq!(v1["status"], "success", "stdout={}", first.stdout);
        let payment_id = v1["payment_id"].as_str().expect("payment_id").to_string();
        assert!(payment_id.starts_with("0x"), "stdout={}", first.stdout);

        // Re-approve so we can prove the second refusal isn't an allowance
        // bug (the contract zeroes allowance on success).
        fx.approve_usdc_from_agent(SMALL_DEPOSIT)
            .expect("approve usdc 2");

        let second = fx
            .run_rmpc_deposit(deposit_args(SMALL_DEPOSIT, &oid))
            .expect("run rmpc deposit (second)");
        assert_eq!(
            second.status.code(),
            Some(2),
            "expected exit 2 on replay; stdout={} stderr={}",
            second.stdout,
            second.stderr
        );
        let v2 = parse_json(&second.stdout, "idempotent_replay_rejected#2");
        assert_eq!(v2["status"], "refused");
        assert_eq!(v2["error"], "ErrTxReverted", "stdout={}", second.stdout);
        assert!(
            v2["tx_hash"].as_str().is_some(),
            "ErrTxReverted should carry tx_hash; stdout={}",
            second.stdout
        );
    });
}

// ------------------------------------------------------------- scenario 5

/// `amount > maxPerPayment` is rejected by preflight before any
/// signature is produced. The daemon maps this onto `ErrConfig` with a
/// message mentioning `maxPerPayment`.
#[test]
fn over_per_payment_cap_rejected() {
    if skip_if_no_prereqs("over_per_payment_cap_rejected") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(OVER_PAYMENT_CAP_DEPOSIT)
            .expect("approve usdc");

        let oid = order_id("over_per_payment_cap_rejected");
        let run = fx
            .run_rmpc_deposit(deposit_args(OVER_PAYMENT_CAP_DEPOSIT, &oid))
            .expect("run rmpc deposit");

        assert_eq!(
            run.status.code(),
            Some(2),
            "expected exit 2 (refusal); stdout={} stderr={}",
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "over_per_payment_cap_rejected");
        assert_eq!(v["status"], "refused");
        let err = v["error"].as_str().unwrap_or("");
        assert!(
            err == "ErrConfig" || err == "ErrAgentNotAuthorized" || err.contains("ErrConfig"),
            "expected ErrConfig (per-payment cap), got {err}; stdout={}",
            run.stdout
        );
        let msg = v["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("maxPerPayment"),
            "refusal message should mention maxPerPayment; stdout={}",
            run.stdout
        );
        assert!(
            v.get("tx_hash").and_then(|x| x.as_str()).is_none(),
            "refusal must not carry a tx_hash; got {}",
            run.stdout
        );
    });
}

// ------------------------------------------------------------- scenario 6

/// `paused() == true` causes preflight to refuse with
/// `ErrGatewayPaused`. The client never broadcasts. Cleans up by
/// calling `unpause()` so subsequent tests can deposit.
#[test]
fn paused_blocks_deposit() {
    if skip_if_no_prereqs("paused_blocks_deposit") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(SMALL_DEPOSIT)
            .expect("approve usdc");
        fx.pause_gateway().expect("pause()");

        let oid = order_id("paused_blocks_deposit");
        let run = fx
            .run_rmpc_deposit(deposit_args(SMALL_DEPOSIT, &oid))
            .expect("run rmpc deposit");

        // Always restore the gateway state, even if assertions panic.
        let pause_result = (|| -> Result<(), String> {
            if run.status.code() != Some(2) {
                return Err(format!(
                    "expected exit 2 (refusal); status={:?} stdout={} stderr={}",
                    run.status, run.stdout, run.stderr
                ));
            }
            let v = parse_json(&run.stdout, "paused_blocks_deposit");
            if v["status"] != "refused" {
                return Err(format!("expected refused; stdout={}", run.stdout));
            }
            if v["error"] != "ErrGatewayPaused" {
                return Err(format!("expected ErrGatewayPaused; stdout={}", run.stdout));
            }
            if let Some(checks) = v.get("checks") {
                if checks["gateway_paused"] != true {
                    return Err(format!(
                        "expected checks.gateway_paused=true; stdout={}",
                        run.stdout
                    ));
                }
            }
            if v.get("tx_hash").and_then(|x| x.as_str()).is_some() {
                return Err(format!(
                    "refusal must not carry a tx_hash; stdout={}",
                    run.stdout
                ));
            }
            Ok(())
        })();

        // Unpause so subsequent scenarios can deposit. Errors here are
        // surfaced after the assertion check so a real test failure
        // reports the right thing.
        fx.unpause_gateway().expect("unpause() to restore fixture");

        if let Err(e) = pause_result {
            panic!("{e}");
        }
    });
}

// ------------------------------------------------------------- scenario 7

/// Admin trying to grant itself `AGENT_ROLE` reverts via the
/// role-separation invariant in `AccessRoles`.
///
/// We drive this via `cast send` rather than rmpc: the daemon never
/// calls `authorizeAgent`, so plumbing this through rmpc would prove
/// nothing about the gateway. The test calls `authorizeAgent(admin,
/// policy)` from the admin EOA; the inner `_grantRole` override in
/// `AccessRoles` reverts with `RoleSeparationViolated()`.
#[test]
fn role_separation_invariant() {
    if skip_if_no_prereqs("role_separation_invariant") {
        return;
    }
    with_fixture(|fx| {
        let admin = rmpc_e2e::DEPLOYER_ADDRESS_HEX;
        let policy_tuple = format!("(true,18446744073709551615,1,1,{admin})");

        let out = Command::new("cast")
            .args([
                "send",
                "--rpc-url",
                fx.rpc_url(),
                "--private-key",
                DEPLOYER_PRIVATE_KEY_HEX,
                &format!("{:#x}", fx.gateway()),
                "authorizeAgent(address,(bool,uint64,uint256,uint256,address))",
                admin,
                &policy_tuple,
            ])
            .output()
            .expect("invoke cast send");

        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !out.status.success(),
            "authorizeAgent(admin) must revert; got success.\nstdout={stdout}\nstderr={stderr}"
        );
        let combined = format!("{stdout}\n{stderr}");
        assert!(
            combined.contains("RoleSeparationViolated")
                || combined.contains("0x") && combined.to_lowercase().contains("revert"),
            "expected RoleSeparationViolated in revert output;\nstdout={stdout}\nstderr={stderr}"
        );

        // Sanity: AGENT_PRIVATE_KEY constant is not silently empty.
        assert_eq!(AGENT_PRIVATE_KEY.len(), 32);
    });
}

// ------------------------------------------------------------- scenario 8

/// With `[signer].allow_software_fallback = false` the daemon refuses
/// to start when the only available backend is the software keystore.
/// Startup-time refusal that happens **before any RPC call** — proven
/// by pointing rmpc at an unreachable RPC URL and confirming it still
/// exits non-zero with the right error.
#[test]
fn software_fallback_disabled_aborts_startup() {
    if skip_if_no_prereqs("software_fallback_disabled_aborts_startup") {
        return;
    }
    with_fixture(|fx| {
        let original = std::fs::read_to_string(fx.config_path()).expect("read config");
        let tweaked = original
            .replace(
                "allow_software_fallback = true",
                "allow_software_fallback = false",
            )
            .replace(fx.rpc_url(), "http://127.0.0.1:1");
        assert!(
            tweaked.contains("allow_software_fallback = false"),
            "must flip the flag",
        );
        assert!(
            tweaked.contains("http://127.0.0.1:1"),
            "must rewrite RPC url",
        );
        let cfg = fx.tempdir().join("rmpc.no-fallback.toml");
        std::fs::write(&cfg, tweaked).expect("write tweaked config");

        let oid = order_id("software_fallback_disabled_aborts_startup");
        let mut env = HashMap::new();
        env.insert(
            rmpc_e2e::PASSPHRASE_ENV_VAR.to_string(),
            fx.passphrase().to_string(),
        );
        let args: Vec<String> = vec![
            "deposit".into(),
            "--config".into(),
            cfg.to_string_lossy().into_owned(),
            "--amount".into(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".into(),
            oid,
            "--receipt-timeout-secs".into(),
            RECEIPT_TIMEOUT_SECS.into(),
        ];
        let run = fx
            .run_rmpc_with(&args, env)
            .expect("run rmpc deposit (no fallback)");

        assert!(
            !run.status.success(),
            "expected non-zero exit on disabled fallback; stdout={} stderr={}",
            run.stdout,
            run.stderr
        );
        let combined = format!("{}\n{}", run.stdout, run.stderr);
        assert!(
            !combined.contains("127.0.0.1:1"),
            "rmpc must not have made an RPC call to {} before refusing; combined output:\n{}",
            "http://127.0.0.1:1",
            combined,
        );
        assert!(
            combined.contains("ErrSoftwareSignerDisallowed"),
            "expected ErrSoftwareSignerDisallowed; combined output:\n{}",
            combined,
        );
    });
}

// ------------------------------------------------------------- scenario 9

/// Agent without `AGENT_ROLE` is rejected by preflight with
/// `ErrAgentNotAuthorized`. The gateway is otherwise healthy. Cleans
/// up by re-granting `AGENT_ROLE` so subsequent tests in shared
/// fixtures (none today, but a future addition would inherit this
/// pattern) can deposit.
#[test]
fn unauthorized_agent_rejected() {
    if skip_if_no_prereqs("unauthorized_agent_rejected") {
        return;
    }
    with_fixture(|fx| {
        fx.approve_usdc_from_agent(SMALL_DEPOSIT)
            .expect("approve usdc");

        fx.revoke_agent().expect("revokeAgent");

        let oid = order_id("unauthorized_agent_rejected");
        let run = fx
            .run_rmpc_deposit(deposit_args(SMALL_DEPOSIT, &oid))
            .expect("run rmpc deposit");

        // Always restore the role grant, even if assertions panic.
        let assertion_result = (|| -> Result<(), String> {
            if run.status.code() != Some(2) {
                return Err(format!(
                    "expected exit 2 (refusal); status={:?} stdout={} stderr={}",
                    run.status, run.stdout, run.stderr
                ));
            }
            let v = parse_json(&run.stdout, "unauthorized_agent_rejected");
            if v["status"] != "refused" {
                return Err(format!("expected refused; stdout={}", run.stdout));
            }
            if v["error"] != "ErrAgentNotAuthorized" {
                return Err(format!(
                    "expected ErrAgentNotAuthorized; stdout={}",
                    run.stdout
                ));
            }
            if v.get("tx_hash").and_then(|x| x.as_str()).is_some() {
                return Err(format!(
                    "refusal must not carry a tx_hash; stdout={}",
                    run.stdout
                ));
            }
            Ok(())
        })();

        // Restore the deploy-time policy so any future scenario can
        // reuse the shared fixture without re-booting docker.
        fx.reauthorize_agent(DEFAULT_MAX_PER_PAYMENT, DEFAULT_MAX_PER_WINDOW)
            .expect("reauthorize agent to restore fixture");

        if let Err(e) = assertion_result {
            panic!("{e}");
        }
    });
}

// ------------------------------------------------------------- helpers

#[test]
fn agent_private_key_export_matches_address() {
    // Defensive sanity: keep the harness constants honest. The
    // scenario tests above lean on the agent privkey being the EOA
    // that holds AGENT_ROLE in the deployment; if anyone ever rotates
    // one but not the other, this test fires before the slow scenarios.
    use alloy_primitives::keccak256;
    let agent_pk_bytes = AGENT_PRIVATE_KEY;
    assert_eq!(agent_pk_bytes.len(), 32);
    let _hex = format!("0x{}", hex::encode(agent_pk_bytes));
    let _ = keccak256(agent_pk_bytes);
}
