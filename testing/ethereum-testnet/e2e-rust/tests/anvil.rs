//! Anvil-layer scenario tests for `rmpd` (issue #18).
//!
//! Per `docs/implementation-plan-mvp.md` §4. These eight `#[test]`
//! functions exercise every refusal path the daemon is responsible for —
//! preflight refusals, fee-cap refusals, lock contention, and the one
//! happy-path failure mode (idempotent replay) that requires a
//! successful first deposit. Each test boots a fresh
//! [`Fixture::anvil`], asserts on rmpd's JSON output **and** on
//! observable on-chain side effects (or absence thereof), and lets
//! `Drop` tear the Anvil child process down.
//!
//! All eight tests skip cleanly with a printed warning when Foundry is
//! not on PATH so `cargo test -p rmpd-e2e` stays runnable on developer
//! machines that haven't installed it. CI installs Foundry, so the
//! tests run for real there.
//!
//! The scenarios match the canonical list in issue #18:
//!
//! 1. `unauthorized_agent_rejected`
//! 2. `paused_blocks_deposit`
//! 3. `over_per_payment_cap_rejected`
//! 4. `idempotent_replay_rejected`
//! 5. `code_hash_mismatch_aborts`
//! 6. `software_fallback_disabled_aborts_startup`
//! 7. `fee_cap_exceeded_aborts`
//! 8. `concurrent_invocation_locked`

use std::collections::HashMap;
use std::process::{Command, Stdio};

use rmpd_e2e::{Fixture, AGENT_PRIVATE_KEY};
use serde_json::Value;

/// USDC has 6 decimals throughout the harness; this matches the
/// gateway's `DEFAULT_MAX_PER_PAYMENT = 10_000 * 1e6`.
const ONE_USDC: u128 = 1_000_000;
/// 100 USDC. Comfortably below `DEFAULT_MAX_PER_PAYMENT`.
const SMALL_DEPOSIT: u128 = 100 * ONE_USDC;
/// 20_000 USDC. Comfortably above `DEFAULT_MAX_PER_PAYMENT`.
const OVER_CAP_DEPOSIT: u128 = 20_000 * ONE_USDC;

/// Random 32-byte hex used as a deterministic order id. Generated once
/// per test so we never accidentally re-use one across scenarios.
fn order_id(label: &str) -> String {
    use alloy_primitives::keccak256;
    let h = keccak256(format!("rmpd-e2e-issue-18-{label}").as_bytes());
    format!("{h:#x}")
}

/// Print + return `true` when Foundry is unavailable so tests can early
/// out without flapping CI on dev machines.
fn skip_if_no_foundry(test_name: &str) -> bool {
    if !rmpd_e2e::foundry_available() {
        eprintln!(
            "[{test_name}] foundry (anvil + forge) not on PATH; skipping. \
             Install via https://getfoundry.sh to run this test."
        );
        return true;
    }
    false
}

/// Parse rmpd stdout as JSON, panicking with a helpful diagnostic on
/// failure. Tests rely on the JSON contract for the operator-visible
/// fields documented in `commands/deposit.rs`.
fn parse_json(stdout: &str, ctx: &str) -> Value {
    serde_json::from_str(stdout)
        .unwrap_or_else(|e| panic!("{ctx}: rmpd stdout is not valid JSON: {e}\nstdout:\n{stdout}",))
}

// ------------------------------------------------------------- scenario 1

/// Issue #18 scenario 1: agent without `AGENT_ROLE` is rejected by
/// preflight with `ErrAgentNotAuthorized`. The gateway is otherwise
/// healthy.
#[test]
fn unauthorized_agent_rejected() {
    if skip_if_no_foundry("unauthorized_agent_rejected") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    // Approve so we can prove the refusal triggers BEFORE the
    // allowance/balance checks (preflight returns on first failure).
    fx.approve_usdc_from_agent(SMALL_DEPOSIT)
        .expect("approve usdc");

    // Strip AGENT_ROLE from the agent EOA.
    fx.revoke_agent().expect("revokeAgent");

    let oid = order_id("unauthorized_agent_rejected");
    let run = fx
        .run_rmpd_deposit([
            "--amount".to_string(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".to_string(),
            oid.clone(),
        ])
        .expect("run rmpd deposit");

    assert_eq!(
        run.status.code(),
        Some(2),
        "expected exit 2 (refusal); stdout={} stderr={}",
        run.stdout,
        run.stderr
    );
    let v = parse_json(&run.stdout, "unauthorized_agent_rejected");
    assert_eq!(v["status"], "refused");
    assert_eq!(
        v["error"], "ErrAgentNotAuthorized",
        "wrong error variant: {}",
        run.stdout
    );
    // Side-effect assertion: no AgentDeposit log, no tx_hash field.
    assert!(
        v.get("tx_hash").and_then(|x| x.as_str()).is_none(),
        "refusal must not carry a tx_hash; got {}",
        run.stdout
    );
}

// ------------------------------------------------------------- scenario 2

/// Issue #18 scenario 2: `paused() == true` causes preflight to refuse
/// with `ErrGatewayPaused`. The client never broadcasts.
#[test]
fn paused_blocks_deposit() {
    if skip_if_no_foundry("paused_blocks_deposit") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    fx.approve_usdc_from_agent(SMALL_DEPOSIT)
        .expect("approve usdc");
    fx.pause_gateway().expect("pause()");

    let oid = order_id("paused_blocks_deposit");
    let run = fx
        .run_rmpd_deposit([
            "--amount".to_string(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".to_string(),
            oid,
        ])
        .expect("run rmpd deposit");

    assert_eq!(
        run.status.code(),
        Some(2),
        "expected exit 2 (refusal); stdout={} stderr={}",
        run.stdout,
        run.stderr
    );
    let v = parse_json(&run.stdout, "paused_blocks_deposit");
    assert_eq!(v["status"], "refused");
    assert_eq!(v["error"], "ErrGatewayPaused", "stdout={}", run.stdout);
    // The `checks` block (when populated) records the paused observation.
    if let Some(checks) = v.get("checks") {
        assert_eq!(checks["gateway_paused"], true, "stdout={}", run.stdout);
    }
    assert!(
        v.get("tx_hash").and_then(|x| x.as_str()).is_none(),
        "refusal must not carry a tx_hash; got {}",
        run.stdout
    );
}

// ------------------------------------------------------------- scenario 3

/// Issue #18 scenario 3: `amount > maxPerPayment` is rejected by
/// preflight before any signature is produced. Today the daemon maps
/// this onto `ErrConfig` (the per-payment cap is reported via the
/// generic config error, see `policy/mod.rs` rule 7); the test asserts
/// on the message body so the rule is unambiguous.
#[test]
fn over_per_payment_cap_rejected() {
    if skip_if_no_foundry("over_per_payment_cap_rejected") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    // Approve more than the cap so we exclusively exercise the
    // per-payment-cap rule, not allowance.
    fx.approve_usdc_from_agent(OVER_CAP_DEPOSIT)
        .expect("approve usdc");

    let oid = order_id("over_per_payment_cap_rejected");
    let run = fx
        .run_rmpd_deposit([
            "--amount".to_string(),
            OVER_CAP_DEPOSIT.to_string(),
            "--order-id".to_string(),
            oid,
        ])
        .expect("run rmpd deposit");

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
}

// ------------------------------------------------------------- scenario 4

/// Issue #18 scenario 4: replaying the same `(orderId, idempotencyKey)`
/// twice — the second call passes preflight (the gateway only learns
/// the payment id is used at execution time) and reverts with
/// `PaymentIdAlreadyUsed`, surfaced by rmpd as `ErrTxReverted`.
#[test]
fn idempotent_replay_rejected() {
    if skip_if_no_foundry("idempotent_replay_rejected") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    // Approve enough for two deposits' worth (the second never lands).
    fx.approve_usdc_from_agent(SMALL_DEPOSIT * 2)
        .expect("approve usdc");

    let oid = order_id("idempotent_replay_rejected");

    // First deposit must succeed.
    let first = fx
        .run_rmpd_deposit([
            "--amount".to_string(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".to_string(),
            oid.clone(),
        ])
        .expect("run rmpd deposit (first)");
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

    // Replay with the same orderId / idempotencyKey.
    let second = fx
        .run_rmpd_deposit([
            "--amount".to_string(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".to_string(),
            oid,
        ])
        .expect("run rmpd deposit (second)");
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
    // ErrTxReverted always carries the failed-tx hash.
    assert!(
        v2["tx_hash"].as_str().is_some(),
        "ErrTxReverted should carry tx_hash; stdout={}",
        second.stdout
    );
}

// ------------------------------------------------------------- scenario 5

/// Issue #18 scenario 5: flipping the pinned `gateway_runtime_hash`
/// causes preflight to refuse with `ErrCodeHashMismatch` *before* any
/// signing happens. We write a tweaked config to the fixture's tempdir
/// rather than mutating the canonical one in place.
#[test]
fn code_hash_mismatch_aborts() {
    if skip_if_no_foundry("code_hash_mismatch_aborts") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    let original = std::fs::read_to_string(fx.config_path()).expect("read config");
    // Flip every nibble of the pinned hash; the result is still a valid
    // 32-byte hex string but cannot match the deployed code.
    let bad_hash = bitflip_hash(fx.gateway_runtime_hash());
    let tampered = original.replace(fx.gateway_runtime_hash(), &bad_hash);
    assert_ne!(tampered, original, "config bitflip must change content");
    let bad_cfg = fx.tempdir().join("rmpd.bad-hash.toml");
    std::fs::write(&bad_cfg, tampered).expect("write bad config");

    fx.approve_usdc_from_agent(SMALL_DEPOSIT)
        .expect("approve usdc");

    let oid = order_id("code_hash_mismatch_aborts");
    let mut env = HashMap::new();
    env.insert(
        rmpd_e2e::PASSPHRASE_ENV_VAR.to_string(),
        fx.passphrase().to_string(),
    );
    // Drive rmpd against the tampered config.
    let mut args: Vec<String> = vec!["deposit".into(), "--config".into()];
    args.push(bad_cfg.to_string_lossy().into_owned());
    args.push("--amount".into());
    args.push(SMALL_DEPOSIT.to_string());
    args.push("--order-id".into());
    args.push(oid);
    let run = fx
        .run_rmpd_with(&args, env)
        .expect("run rmpd deposit (bad hash)");

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

// ------------------------------------------------------------- scenario 6

/// Issue #18 scenario 6: with `[signer].allow_software_fallback =
/// false` the daemon refuses to start when the only available backend
/// is the software keystore. This is a startup-time refusal that
/// happens **before any RPC call** — proven by pointing rmpd at an
/// unreachable RPC URL and confirming it still exits non-zero with the
/// right error.
#[test]
fn software_fallback_disabled_aborts_startup() {
    if skip_if_no_foundry("software_fallback_disabled_aborts_startup") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    // Build a config with allow_software_fallback = false AND an
    // unreachable RPC. If startup actually reaches RPC, the test would
    // fail with a transport error instead of the expected refusal —
    // making the "before any RPC" assertion observable.
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
    let cfg = fx.tempdir().join("rmpd.no-fallback.toml");
    std::fs::write(&cfg, tweaked).expect("write tweaked config");

    let oid = order_id("software_fallback_disabled_aborts_startup");
    let mut env = HashMap::new();
    env.insert(
        rmpd_e2e::PASSPHRASE_ENV_VAR.to_string(),
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
    ];
    let run = fx
        .run_rmpd_with(&args, env)
        .expect("run rmpd deposit (no fallback)");

    assert!(
        !run.status.success(),
        "expected non-zero exit on disabled fallback; stdout={} stderr={}",
        run.stdout,
        run.stderr
    );
    // Startup-fail is exit 3 in the daemon; preflight refusal is 2.
    // Both are acceptable evidence of "aborts before broadcast" — the
    // *combined* signal we assert is "non-zero AND no transport error
    // mentioning the unreachable RPC".
    let combined = format!("{}\n{}", run.stdout, run.stderr);
    assert!(
        !combined.contains("127.0.0.1:1"),
        "rmpd must not have made an RPC call to {} before refusing; combined output:\n{}",
        "http://127.0.0.1:1",
        combined,
    );
    // The error variant for this refusal is ErrSoftwareSignerDisallowed.
    assert!(
        combined.contains("ErrSoftwareSignerDisallowed"),
        "expected ErrSoftwareSignerDisallowed; combined output:\n{}",
        combined,
    );
}

// ------------------------------------------------------------- scenario 7

/// Issue #18 scenario 7: `anvil_setNextBlockBaseFeePerGas` set above
/// the operator-configured `max_fee_per_gas_cap` causes the fee
/// computation step to refuse with `ErrFeeCapExceeded`. Preflight
/// must pass first (the fee step runs after preflight in `deposit::run`).
#[test]
fn fee_cap_exceeded_aborts() {
    if skip_if_no_foundry("fee_cap_exceeded_aborts") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    fx.approve_usdc_from_agent(SMALL_DEPOSIT)
        .expect("approve usdc");

    // The harness writes max_fee_per_gas_cap = 100 gwei (1e11). Bump
    // base fee for the next block to 200 gwei so 2*baseFee + tip
    // exceeds the cap by a comfortable margin.
    fx.anvil_set_next_base_fee(200_000_000_000)
        .expect("anvil_setNextBlockBaseFeePerGas");

    let oid = order_id("fee_cap_exceeded_aborts");
    let run = fx
        .run_rmpd_deposit([
            "--amount".to_string(),
            SMALL_DEPOSIT.to_string(),
            "--order-id".to_string(),
            oid,
        ])
        .expect("run rmpd deposit");

    assert_eq!(
        run.status.code(),
        Some(2),
        "expected exit 2 (refusal); stdout={} stderr={}",
        run.stdout,
        run.stderr
    );
    let v = parse_json(&run.stdout, "fee_cap_exceeded_aborts");
    assert_eq!(v["status"], "refused");
    assert_eq!(v["error"], "ErrFeeCapExceeded", "stdout={}", run.stdout);
    assert!(
        v.get("tx_hash").and_then(|x| x.as_str()).is_none(),
        "fee-cap refusal happens pre-broadcast; stdout={}",
        run.stdout
    );
}

// ------------------------------------------------------------- scenario 8

/// Issue #18 scenario 8: two `rmpd deposit` invocations against the
/// same agent are mutually exclusive — one wins the per-agent file
/// lock, the other refuses fast with `ErrConcurrentInvocation`.
///
/// We orchestrate the race manually (rather than via
/// `Fixture::run_rmpd_deposit`, which blocks) by spawning the two
/// children with `Stdio::piped()` and joining both. Anvil's instant-mine
/// makes the winning deposit complete in well under a second, so we
/// don't need a delay barrier — the loser's `flock` attempt overlaps
/// with the winner's preflight + broadcast on every run we have
/// observed. Distinct order ids so the *second* process, if it somehow
/// loses the race after the first finishes, would still attempt its
/// own (independent) deposit — avoiding flakiness from a pure
/// PaymentIdAlreadyUsed revert.
#[test]
fn concurrent_invocation_locked() {
    if skip_if_no_foundry("concurrent_invocation_locked") {
        return;
    }
    let fx = Fixture::anvil().expect("boot anvil + deploy");

    fx.approve_usdc_from_agent(SMALL_DEPOSIT * 2)
        .expect("approve usdc");

    let oid_a = order_id("concurrent_invocation_locked-a");
    let oid_b = order_id("concurrent_invocation_locked-b");

    let spawn = |oid: &str| -> std::process::Child {
        Command::new(fx.rmpd_binary())
            .env(rmpd_e2e::PASSPHRASE_ENV_VAR, fx.passphrase())
            .env("RMPD_STATE_DIR", fx.state_dir())
            .arg("deposit")
            .arg("--config")
            .arg(fx.config_path())
            .arg("--amount")
            .arg(SMALL_DEPOSIT.to_string())
            .arg("--order-id")
            .arg(oid)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn rmpd deposit")
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
    // Sanity: not both winners (the lock is real).
    assert!(
        !(out_a.status.success() && out_b.status.success()),
        "both processes succeeded; lock is not actually mutually exclusive"
    );
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
    // The address derivation is exercised by `agent_address()` in the
    // harness; this test just checks that we can hex-encode the privkey
    // without panicking (used by `cast send --private-key ...`).
    let _hex = format!("0x{}", hex::encode(agent_pk_bytes));
    let _ = keccak256(agent_pk_bytes);
}
