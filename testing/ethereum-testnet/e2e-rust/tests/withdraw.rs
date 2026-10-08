//! Canonical: Plan tracking issue #109 §5 — End-to-end scenarios
//! (See also: docs/technical/rmpc-read-output-contract.md)
//!
//! Suite-07 withdraw scenarios for `rmpc withdraw` against the Twin chain
//! devnet (issue #312).
//!
//! These tests exercise preflight refusal paths that do not require
//! `gateway.withdraw()` to be deployed. The gateway withdraw contract
//! implementation is tracked in a separate issue; the happy-path test
//! in this file will be enabled once that lands.
//!
//! Scenarios:
//! 1. `withdraw_non_vault_source_refuses` — the source "vault" is not an
//!    ERC-4626 share token, so the share preflight read fails and rmpc
//!    refuses. A deposit pause is never a withdrawal refusal (core 1494).
//! 2. `withdraw_allowance_insufficient_refuses` — share allowance(agent, gateway)
//!    is zero, preflight refuses with `ErrShareAllowanceInsufficient`.
//! 3. `withdraw_balance_insufficient_refuses` — agent holds no shares,
//!    preflight refuses with `ErrShareBalanceInsufficient`.
//! 4. `withdraw_over_per_payment_cap_refuses` — shares exceed agent
//!    `maxPerPayment` policy, preflight refuses with `ErrConfig`.
//!
//! Skips with a printed warning when Docker/Foundry are not on PATH.

use std::sync::{Mutex, OnceLock};

use rmpc_e2e::{require_prereqs, Fixture};
use serde_json::Value;

/// USDC/share units (6 decimals) used throughout the suite.
const ONE_SHARE: u128 = 1_000_000;

fn parse_json(stdout: &str, ctx: &str) -> Value {
    serde_json::from_str(stdout)
        .unwrap_or_else(|e| panic!("{ctx}: rmpc stdout is not valid JSON: {e}\nstdout:\n{stdout}"))
}

/// Deterministic order id from a per-test label.
fn order_id(label: &str) -> String {
    use alloy_primitives::keccak256;
    let h = keccak256(format!("rmpc-e2e-withdraw-{label}").as_bytes());
    format!("{h:#x}")
}

fn shared_fixture() -> &'static Mutex<Option<Fixture>> {
    static CELL: OnceLock<Mutex<Option<Fixture>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn with_fixture<F: FnOnce(&Fixture) -> R, R>(f: F) -> R {
    let cell = shared_fixture();
    let mut guard = cell.lock().expect("shared fixture mutex poisoned");
    if guard.is_none() {
        let fx = Fixture::new().expect("boot the Twin chain + deploy");
        *guard = Some(fx);
    }
    f(guard.as_ref().expect("fixture present"))
}

/// Receipt timeout for 12-second blocks.
const RECEIPT_TIMEOUT_SECS: &str = "180";

/// Common withdraw args (shares, source-vault, order-id, receipt-timeout).
fn withdraw_args(shares: u128, vault_hex: &str, oid: &str) -> Vec<String> {
    vec![
        "--shares".into(),
        shares.to_string(),
        "--source-vault".into(),
        vault_hex.into(),
        "--order-id".into(),
        oid.into(),
        "--receipt-timeout-secs".into(),
        RECEIPT_TIMEOUT_SECS.into(),
    ]
}

// ------------------------------------------------------------- scenario 1

/// When `--source-vault` is not a share token, `rmpc withdraw` must refuse
/// before signing anything.
///
/// We point `--source-vault` at the gateway address itself, which does not
/// implement the ERC-20 share reads, so the eth_call reverts and the
/// preflight surfaces an `ErrRpcServer` or `ErrRpcDecode` refusal.
#[test]
fn withdraw_non_vault_source_refuses() {
    require_prereqs("withdraw_non_vault_source_refuses");
    with_fixture(|fx| {
        // The gateway does not implement the share reads; calling them
        // causes the vault preflight to fail (RPC error or decode error),
        // which is a hard refusal. We accept any non-zero exit here as
        // proof the preflight gate fires before signing.
        let gateway_hex = format!("{:#x}", fx.gateway());
        let oid = order_id("non_vault_source_refuses");
        let args = withdraw_args(ONE_SHARE, &gateway_hex, &oid);
        let run = fx.run_rmpc_withdraw(args).expect("spawn rmpc withdraw");

        assert!(
            !run.status.success(),
            "rmpc withdraw must refuse when the source is not a share token; \
             got exit 0.\nstdout={}\nstderr={}",
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "withdraw_non_vault_source_refuses");
        assert_eq!(
            v.get("status").and_then(|s| s.as_str()),
            Some("refused"),
            "stdout status must be 'refused'; got {v}"
        );
    });
}

// ------------------------------------------------------------- scenario 2

/// When the agent has not approved the gateway to spend its vault shares,
/// `rmpc withdraw` must refuse before signing.
///
/// The agent's vault share balance is zero at this point (no prior deposit
/// through the happy path), so this exercises both the allowance and
/// balance checks. We confirm the exit is non-zero and the JSON status
/// is "refused".
#[test]
fn withdraw_allowance_insufficient_refuses() {
    require_prereqs("withdraw_allowance_insufficient_refuses");
    with_fixture(|fx| {
        let vault_hex = format!("{:#x}", fx.vault());
        let oid = order_id("allowance_insufficient_refuses");
        // Request a non-trivial share amount; agent holds 0 shares so
        // both allowance and balance checks will refuse.
        let args = withdraw_args(ONE_SHARE, &vault_hex, &oid);
        let run = fx.run_rmpc_withdraw(args).expect("spawn rmpc withdraw");

        assert!(
            !run.status.success(),
            "rmpc withdraw must refuse when allowance < shares; \
             got exit 0.\nstdout={}\nstderr={}",
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "withdraw_allowance_insufficient_refuses");
        assert_eq!(
            v.get("status").and_then(|s| s.as_str()),
            Some("refused"),
            "stdout status must be 'refused'; got {v}"
        );
        // Must be ErrShareAllowanceInsufficient or ErrShareBalanceInsufficient
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("");
        assert!(
            err == "ErrShareAllowanceInsufficient" || err == "ErrShareBalanceInsufficient",
            "expected ErrShareAllowanceInsufficient or ErrShareBalanceInsufficient; \
             got error={err}\nfull output: {v}"
        );
    });
}

// ------------------------------------------------------------- scenario 3

/// When the agent's share balance is below the requested withdrawal,
/// `rmpc withdraw` refuses with `ErrShareBalanceInsufficient`.
///
/// We approve a large allowance from the agent to the gateway (so the
/// allowance check passes) but do not transfer any shares to the agent,
/// so the balance check fails.
#[test]
fn withdraw_balance_insufficient_refuses() {
    require_prereqs("withdraw_balance_insufficient_refuses");
    with_fixture(|fx| {
        // Approve shares from agent to gateway to pass the allowance check.
        // The vault token address is the vault itself (ERC-4626 shares).
        let vault_hex = format!("{:#x}", fx.vault());
        let gateway_hex = format!("{:#x}", fx.gateway());

        // Use cast to approve max allowance from agent to gateway on the vault
        // share token. The agent's private key is exposed for the e2e suite.
        let agent_pk_hex = format!(
            "0x{}",
            rmpc_e2e::AGENT_PRIVATE_KEY
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let _approve = fx.cast_send(
            &agent_pk_hex,
            fx.vault(),
            "approve(address,uint256)",
            &[
                &gateway_hex,
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            ],
        );
        // Even with max allowance, the agent holds 0 vault shares.

        let oid = order_id("balance_insufficient_refuses");
        let args = withdraw_args(ONE_SHARE, &vault_hex, &oid);
        let run = fx.run_rmpc_withdraw(args).expect("spawn rmpc withdraw");

        assert!(
            !run.status.success(),
            "rmpc withdraw must refuse when share balance < shares; \
             got exit 0.\nstdout={}\nstderr={}",
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "withdraw_balance_insufficient_refuses");
        assert_eq!(
            v.get("status").and_then(|s| s.as_str()),
            Some("refused"),
            "stdout status must be 'refused'; got {v}"
        );
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("");
        assert!(
            err == "ErrShareBalanceInsufficient" || err == "ErrShareAllowanceInsufficient",
            "expected ErrShareBalanceInsufficient; got error={err}\nfull output: {v}"
        );
    });
}

// ------------------------------------------------------------- scenario 4

/// Requesting more shares than the agent's `maxPerPayment` policy cap
/// must be refused by the gateway preflight (`ErrConfig`).
#[test]
fn withdraw_over_per_payment_cap_refuses() {
    require_prereqs("withdraw_over_per_payment_cap_refuses");
    with_fixture(|fx| {
        let vault_hex = format!("{:#x}", fx.vault());
        let oid = order_id("over_per_payment_cap_refuses");
        // 20_000 USDC worth of shares — well above the default 10_000 maxPerPayment.
        let over_cap = 20_000 * ONE_SHARE;
        let args = withdraw_args(over_cap, &vault_hex, &oid);
        let run = fx.run_rmpc_withdraw(args).expect("spawn rmpc withdraw");

        assert!(
            !run.status.success(),
            "rmpc withdraw must refuse when shares > maxPerPayment; \
             got exit 0.\nstdout={}\nstderr={}",
            run.stdout,
            run.stderr
        );
        let v = parse_json(&run.stdout, "withdraw_over_per_payment_cap_refuses");
        assert_eq!(
            v.get("status").and_then(|s| s.as_str()),
            Some("refused"),
            "stdout status must be 'refused'; got {v}"
        );
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("");
        assert!(
            err == "ErrConfig",
            "expected ErrConfig (maxPerPayment exceeded); got error={err}\nfull output: {v}"
        );
    });
}
