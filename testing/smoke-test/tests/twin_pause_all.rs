//! A failed verify pauses deposits on all four vaults, on the Twin chain (core 1619, plan decision 22).
//!
//! Everything here is real. The chain is the Twin fork (a pinned lazy fork of Base). The vaults are the four production vaults the
//! harness deployed through publish contracts, handed over to the real Safe and timelock. The signer of the pause is the EMERGENCY
//! keystore the rehearsal key helper minted, because the stage 11 handover has run. No mock, no stand-in contract, no faked receipt.
//!
//! The test forces a real stage 12 failure: it runs the one verifier against a sheet that disagrees with the chain by one unit of
//! one cap. The CLI must then pause rmUSDC, rmPROTO, rmAGENT and rmRWA by itself, read `depositsPaused` back on each and write the
//! rollout report. Then a holder redeems on every paused vault that holds shares (withdrawals stay open, core 1494).
//!
//! Run with:
//!   cargo test -p smoke-test --release --test twin_pause_all -- --test-threads=1 --nocapture

use smoke_test::{require_prereqs, Fixture};
use std::process::Command;

const VAULT_NAMES: [&str; 4] = ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"];
/// The verifier's own exit code (publish-contracts EXIT_CODES.VERIFY).
const EXIT_VERIFY: i32 = 13;

/// `cast call` a view and return its trimmed output. A failed call is a failed test.
fn cast_call(rpc: &str, to: &str, sig: &str, args: &[&str]) -> String {
    let out = Command::new("cast")
        .args(["call", "--rpc-url", rpc, to, sig])
        .args(args)
        .output()
        .expect("cast must be on PATH");
    assert!(
        out.status.success(),
        "cast call {sig} on {to} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn deposits_paused(rpc: &str, vault: &str) -> bool {
    match cast_call(rpc, vault, "depositsPaused()(bool)", &[]).as_str() {
        "true" => true,
        "false" => false,
        other => panic!("depositsPaused() on {vault} returned '{other}'"),
    }
}

/// `balanceOf` as a number. `cast call` prints `123 [1.23e2]` for a uint: keep the first word.
fn balance_of(rpc: &str, token: &str, owner: &str) -> u128 {
    cast_call(rpc, token, "balanceOf(address)(uint256)", &[owner])
        .split_whitespace()
        .next()
        .and_then(|w| w.parse().ok())
        .expect("a balance")
}

#[test]
fn twin_forced_verify_failure_pauses_all_four_vaults_and_every_redeem_still_works() {
    require_prereqs(
        "twin_forced_verify_failure_pauses_all_four_vaults_and_every_redeem_still_works",
    );
    let fx = Fixture::new_closed().expect("smoke-test fixture boot failed");
    let rpc = fx.rpc_url().to_string();
    let vaults = fx.vault_addresses().clone();
    for n in VAULT_NAMES {
        assert!(vaults.contains_key(n), "the topology has no {n}");
    }
    let published = fx.published();

    // After the deploy: all four vaults ship paused (core 1710: rmUSDC takes its seed deposit, then pauses).
    for n in VAULT_NAMES {
        assert!(deposits_paused(&rpc, &vaults[n]), "{n} must deploy paused");
    }

    // Stage 13 through the real Safe and timelock opens the four vaults the sheet names (rmUSDC, rmPROTO, rmAGENT and rmRWA).
    published
        .govern_matrix()
        .expect("the govern matrix must pass through the real Safe");
    for n in ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"] {
        assert!(
            !deposits_paused(&rpc, &vaults[n]),
            "{n} must be open after stage 13"
        );
    }

    // A real depositor puts USDC straight into each open vault: shares in rmUSDC, rmPROTO and rmRWA.
    let user = fx.agent();
    let user_s = format!("{user:#x}");
    let pk = format!("0x{}", hex::encode(smoke_test::AGENT_PRIVATE_KEY));
    let per_vault: u128 = 20_000_000; // 20 USDC, under every per-deposit cap
    fx.fund_gas(user, 10_000_000_000_000_000_000)
        .expect("fund gas for the depositor");
    fx.fund_usdc(user, per_vault * 3)
        .expect("fund USDC for the depositor");
    let (amount_s, usdc_s) = (per_vault.to_string(), format!("{:#x}", fx.usdc()));
    for n in ["rmUSDC", "rmPROTO", "rmRWA"] {
        let vault: alloy_primitives::Address = vaults[n].parse().expect("a vault address");
        fx.cast_send(
            &pk,
            fx.usdc(),
            "approve(address,uint256)",
            &[&vaults[n], &amount_s],
        )
        .expect("approve the vault");
        fx.cast_send(
            &pk,
            vault,
            "deposit(uint256,address)",
            &[&amount_s, &user_s],
        )
        .unwrap_or_else(|e| panic!("the deposit into open {n} must succeed before the pause: {e}"));
    }
    let before: Vec<(&str, u128)> = VAULT_NAMES
        .iter()
        .map(|n| (*n, balance_of(&rpc, &vaults[*n], &user_s)))
        .collect();
    for (n, shares) in &before {
        if *n != "rmAGENT" {
            assert!(
                *shares > 0,
                "the depositor holds no {n} shares before the pause"
            );
        }
    }

    // Force a real stage 12 failure: the sheet says one rmRWA cap, the chain holds another.
    let sheet_text = std::fs::read_to_string(&published.sheet_path).expect("read the run sheet");
    let wrong =
        smoke_test::publish::with_sheet_value(&sheet_text, "VAULT_RWA_TVL_CAP", "1000000001")
            .expect("the run sheet carries VAULT_RWA_TVL_CAP");
    let wrong_path = fx.tempdir().join("wrong-sheet.env");
    std::fs::write(&wrong_path, wrong).expect("write the wrong sheet");
    let run = published
        .verify_against_sheet(&wrong_path)
        .expect("start the verifier");
    println!("{}\n{}", run.stdout, run.stderr);
    assert_eq!(
        run.code, EXIT_VERIFY,
        "a failed verify keeps its own exit code (the pause must not hide it)"
    );
    assert!(
        run.stderr.contains("tvlCap equals sheet"),
        "the failure must be the verifier's tvlCap check"
    );
    assert!(
        run.stderr.contains("\"event\":\"pause_all.auto\""),
        "the CLI must have run pause-all by itself"
    );

    // The result, read from the chain and not from the CLI: deposits are paused on all four vaults.
    for n in VAULT_NAMES {
        assert!(
            deposits_paused(&rpc, &vaults[n]),
            "{n} must be paused after the failed verify"
        );
    }
    // ... and a deposit into rmUSDC (opened by stage 13) is now refused.
    fx.cast_send(
        &pk,
        fx.usdc(),
        "approve(address,uint256)",
        &[&format!("{:#x}", fx.vault()), &amount_s],
    )
    .expect("approve the vault");
    assert!(
        fx.cast_send(
            &pk,
            fx.vault(),
            "deposit(uint256,address)",
            &["1000000", &user_s]
        )
        .is_err(),
        "a deposit into paused rmUSDC must revert"
    );

    // The rollout report records each vault's paused state, the signer role and the trigger.
    let report_path = published.evidence_dir().join("rollout-report-918453.json");
    let report: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&report_path).expect("the rollout report must exist"),
    )
    .expect("the rollout report is JSON");
    let pause = &report["pauseAll"];
    assert_eq!(pause["trigger"], "verify");
    assert_eq!(pause["allPaused"], true);
    let rows = pause["vaults"].as_array().expect("a vaults array");
    assert_eq!(rows.len(), 4, "the report must list all four vaults");
    for (row, name) in rows.iter().zip(VAULT_NAMES) {
        assert_eq!(row["vault"], name);
        assert_eq!(
            row["address"].as_str().map(str::to_lowercase),
            Some(vaults[name].to_lowercase())
        );
        assert_eq!(row["depositsPaused"], true, "{name} in the report");
        assert_eq!(
            row["signerRole"], "emergency",
            "after the handover the EMERGENCY key signs"
        );
        assert!(
            row["txHash"]
                .as_str()
                .is_some_and(|h| h.starts_with("0x") && h.len() == 66),
            "{name} has no pause transaction hash"
        );
    }

    // Withdrawals stay open (core 1494): the holder redeems on every paused vault that holds shares.
    for (name, shares) in &before {
        if *shares == 0 {
            continue;
        }
        let usdc_before = balance_of(&rpc, &usdc_s, &user_s);
        fx.cast_send(
            &pk,
            vaults[*name].parse().expect("a vault address"),
            "redeem(uint256,address,address)",
            &[&shares.to_string(), &user_s, &user_s],
        )
        .unwrap_or_else(|e| panic!("redeem on paused {name} must succeed: {e}"));
        assert_eq!(
            balance_of(&rpc, &vaults[*name], &user_s),
            0,
            "the redeem on {name} left shares behind"
        );
        assert!(
            balance_of(&rpc, &usdc_s, &user_s) > usdc_before,
            "the redeem on {name} returned no USDC"
        );
        assert!(
            deposits_paused(&rpc, &vaults[*name]),
            "{name} must still be paused"
        );
    }
    // rmAGENT holds RM and the test deposits nothing there (a deposit needs a V4 swap): there are no shares to redeem.
    assert_eq!(
        before
            .iter()
            .find(|(n, _)| *n == "rmAGENT")
            .map(|(_, s)| *s),
        Some(0)
    );

    // pause-all by hand is the same path and idempotent: it exits 0 with every vault already paused.
    published
        .pause_all()
        .expect("pause-all by hand must succeed");
    for n in VAULT_NAMES {
        assert!(deposits_paused(&rpc, &vaults[n]), "{n} must stay paused");
    }
    let manual: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&report_path).expect("report"))
            .expect("JSON");
    assert_eq!(manual["pauseAll"]["trigger"], "manual");
    assert_eq!(manual["pauseAll"]["allPaused"], true);

    // Core 1710: the on-demand reopen round works for all four vaults. Each `govern --row unpause-X` after the pause-all is a new numbered round
    // (its own timelock operation) through the real Safe, ordered after the pause entry. Every vault reads open again.
    for (name, row) in [
        ("rmUSDC", "unpause-USDC"),
        ("rmPROTO", "unpause-PROTO"),
        ("rmAGENT", "unpause-AGENT"),
        ("rmRWA", "unpause-RWA"),
    ] {
        let lines = published
            .govern(row, &[])
            .unwrap_or_else(|e| panic!("the reopen round {row} after pause-all must pass: {e}"));
        assert_eq!(lines.len(), 2, "{row}: one scheduled and one executed line");
        assert!(
            !deposits_paused(&rpc, &vaults[name]),
            "{name} must be open after its reopen round"
        );
    }
}
