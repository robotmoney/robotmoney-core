//! The Twin chain run of publish contracts, end to end (core 1488).
//!
//! One test boots the Twin chain (918453) through the harness. The harness has already called
//! `publish` (deploy all four vaults, real Safe handover). This test then asserts the four
//! manifests, runs the one verifier (which holds the router, basket and timelock role proofs), runs the stage 13 govern matrix through the real Safe,
//! and runs the verifier again (the order is publish, verify, govern, verify: issue 1667).
//! The verifier output (SMOKE_TEST_VERIFY_OUT) and the run sheet (SMOKE_TEST_SHEET_OUT) are saved for the
//! parity step in suite 14. Every govern row must carry a tx hash and receipt status 1 (checked by `govern_matrix`).
//!
//! Run with:
//!   cargo test -p smoke-test --release --test twin_publish -- --test-threads=1 --nocapture

use smoke_test::{require_prereqs, Fixture};
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

#[test]
fn twin_chain_publish_verify_and_govern_matrix() {
    require_prereqs("twin_chain_publish_verify_and_govern_matrix");
    let fx = Fixture::new_closed().expect("smoke-test fixture boot failed");
    let dir = fx.manifest_dir();
    let table = smoke_test::stage_table::StageTable::load_default().expect("read the stage table");
    let missing = table.missing(dir);
    assert!(
        missing.is_empty(),
        "manifests the stage table names are missing in {}: {missing:?}",
        dir.display()
    );
    // Core 1710: all four vaults deploy paused, rmUSDC included. The verifier below expects exactly that before stage 13.
    let deposits_paused = |vault: alloy_primitives::Address| -> bool {
        fx.cast_call_raw(vault, "depositsPaused()", &[])
            .expect("read depositsPaused")
            .ends_with('1')
    };
    let four_vaults = [
        ("rmUSDC", fx.vault()),
        ("rmPROTO", fx.proto_vault()),
        ("rmAGENT", fx.agent_vault()),
        ("rmRWA", fx.rwa_vault()),
    ];
    for (name, vault) in four_vaults {
        assert!(deposits_paused(vault), "{name} must deploy paused");
    }
    let verified = fx
        .published()
        .verify()
        .expect("the verifier must pass on the Twin chain");
    assert!(!verified.trim().is_empty(), "the verifier printed nothing");
    // Core 1618: before the stage 11 handover the real Safe executed one self-call signed by EVERY owner. The verifier read it back
    // from the chain (four `safe:` labels, all passed or `verify()` above would have failed), and the run manifest records it.
    for label in [
        "safe: control proof transaction recorded",
        "safe: control proof transaction succeeded",
        "safe: control proof is a self-call signed by every owner",
        "safe: nonce at least 1",
    ] {
        assert!(
            verified.lines().any(|l| l.trim() == label),
            "the verifier output lacks the label '{label}'"
        );
    }
    // Issue 1666: every basket ships with a nonzero NAV deviation guard from the sheet and sits on pools at or above the sheet liquidity
    // floor. The verifier read both back from the chain; `verify()` above would have failed on any of these labels failing.
    for vault in ["rmPROTO", "rmAGENT", "rmRWA"] {
        for what in [
            "navDeviationGuardBps equals sheet",
            "navDeviationGuardBps above zero",
            "pool liquidity meets the sheet floor",
        ] {
            let label = format!("vault[{vault}]: {what}");
            assert!(
                verified.lines().any(|l| l.trim() == label),
                "the verifier output lacks the label '{label}'"
            );
        }
    }
    let run_manifest_path = dir
        .parent()
        .unwrap_or(dir)
        .join("evidence")
        .join("publish-run.json");
    let run_manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&run_manifest_path).expect("read the run manifest"),
    )
    .expect("the run manifest is JSON");
    let proof = &run_manifest["stages"]["prove-control"];
    assert_eq!(proof["status"], "done", "no finished prove-control record");
    assert!(
        proof["txHash"]
            .as_str()
            .is_some_and(|h| h.starts_with("0x") && h.len() == 66),
        "the prove-control record has no transaction hash"
    );
    assert_eq!(
        proof["signers"].as_array().map(|a| a.len()),
        Some(3),
        "the prove-control record must name all three Safe owners"
    );
    // Issue 1670: the run crashed AFTER the proof landed on the real Safe but before the run manifest was written. Simulated by removing the record
    // (the Safe is at nonce 1, as it is now). Without --resume the rerun refuses (exit 16, RESUME). With --resume the tool finds the nonce-0 execution on the
    // real chain (the Safe's own ExecutionSuccess event), recovers the owner signatures from the real calldata, adopts it with the SAME on-chain
    // hash and sends nothing.
    {
        let original = proof.clone();
        let mut crashed = run_manifest.clone();
        crashed["stages"]
            .as_object_mut()
            .expect("stages is an object")
            .remove("prove-control");
        std::fs::write(
            &run_manifest_path,
            serde_json::to_string_pretty(&crashed).unwrap(),
        )
        .expect("write the crashed run manifest");
        let refused = fx
            .published()
            .stage_raw(&["--stage", "prove-control"])
            .expect("run the prove-control rerun");
        // The run manifest has earlier stages, so a rerun without --resume stops at RESUME (exit 16) before any stage runs. The
        // refusal to adopt without --resume on a manifest with no other stages (exit 24) is asserted in prove-control.test.ts.
        assert_eq!(
            refused.code, 16,
            "a rerun without --resume must refuse: {}{}",
            refused.stdout, refused.stderr
        );
        let adopted = fx
            .published()
            .stage_raw(&["--stage", "prove-control", "--resume"])
            .expect("run the prove-control resume");
        assert_eq!(
            adopted.code, 0,
            "--resume must adopt the landed proof: {}{}",
            adopted.stdout, adopted.stderr
        );
        let after: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&run_manifest_path).expect("read the run manifest"),
        )
        .expect("the run manifest is JSON");
        let rec = &after["stages"]["prove-control"];
        assert_eq!(rec["status"], "done");
        assert_eq!(rec["adopted"], true, "the record must say it was adopted");
        assert_eq!(
            rec["txHash"], original["txHash"],
            "the adopted hash is the on-chain hash of the original proof"
        );
        assert_eq!(rec["signers"], original["signers"]);
        // Nothing was sent again: the verifier still reads the Safe at the same single execution.
        fx.published()
            .verify()
            .expect("the verifier must pass after the adoption");
    }
    // Saved for scripts/stage/label-diff.ts: the stage label set must equal mainnet's.
    if let Ok(path) = std::env::var("SMOKE_TEST_VERIFY_OUT") {
        std::fs::write(&path, &verified).expect("write the verifier output");
    }
    // Saved for scripts/stage/parity.ts: the run sheet (parameter lines plus the generated identity
    // lines) must differ from the production sheet only in parameter and identity lines.
    if let Ok(path) = std::env::var("SMOKE_TEST_SHEET_OUT") {
        std::fs::copy(&fx.published().sheet_path, &path).expect("copy the run sheet");
    }

    // Core 1488: the run report prints stages, tx counts, the vault set and the verifier labels. The router,
    // basket and timelock role proofs are labels of the one verifier above (gateway and registry router(), vault
    // registry link and one-shot setRegistry, asset config, roles). The report is written to SMOKE_TEST_PROOF_DIR
    // (uploaded by the suite 14 twin_publish job).
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
            // The runner writes its run manifest under the evidence directory (run_dir_args).
            dir.parent()
                .unwrap_or(dir)
                .join("evidence")
                .join("publish-run.json")
                .display()
                .to_string(),
            s("--labels"),
            verify_labels.display().to_string(),
            s("--json-out"),
            p("twin-run-report.json"),
        ],
    );
    let rows = fx
        .published()
        .govern_matrix()
        .expect("the govern matrix must pass through the real Safe");
    assert!(!rows.is_empty(), "the govern matrix ran no rows");
    // Core 1710: stage 13 is four unpauses, rmUSDC first. Each is its own scheduled and executed line, and each vault reads open afterwards.
    for row in [
        "unpause-USDC",
        "unpause-PROTO",
        "unpause-AGENT",
        "unpause-RWA",
    ] {
        assert_eq!(
            rows.iter().filter(|r| r.row == row).count(),
            2,
            "the govern matrix must print one scheduled and one executed line for {row}"
        );
    }
    for (name, vault) in four_vaults {
        assert!(
            !deposits_paused(vault),
            "{name} must read open after stage 13"
        );
    }

    // Issue 1667: the order is publish, verify, govern, verify. The first verify above passed before govern (all four vaults paused). This second verify reads the
    // post-govern state: the unpause rows are executed, so the verifier expects those vaults open. The Twin run only checks that the scripts execute in this
    // order. The 48 hour delay and the Safe signers are proven on chain 8453 through the real Safe.
    let verified_after = fx
        .published()
        .verify()
        .expect("the verifier must pass on the Twin chain after govern");
    assert!(
        !verified_after.trim().is_empty(),
        "the post-govern verifier printed nothing"
    );
    let labels = |out: &str| -> Vec<String> { out.lines().map(|l| l.trim().to_string()).collect() };
    assert_eq!(
        labels(&verified),
        labels(&verified_after),
        "the verifier ran the same checks before and after govern"
    );

    // Core 1611: one consensus receipt is released end to end through the REAL Safe and the REAL timelock on the fork. The seed records two
    // receipts (the gateway committee registration is itself a Safe -> Timelock call), then `govern --row release-receipt` schedules
    // `releaseReceipt` through the Safe, waits the real timelock delay (one time warp on the fork) and executes it. The CLI reads `released`
    // back, and this test reads it again from the chain: A is released, B (recorded, never released) is not.
    fx.seed_consensus_receipts()
        .expect("record two receipts and release one through the real Safe and timelock");
    let receipt = format!("{:#x}", fx.consensus_receipt());
    let is_released = |file: &str| -> bool {
        let r = smoke_test::load_fixture_receipt(fx.repo_root(), file).expect("fixture receipt");
        let id = format!("0x{}", hex::encode(r.receipt_id));
        let out = Command::new("cast")
            .args([
                "call",
                "--rpc-url",
                fx.rpc_url(),
                &receipt,
                "isReleased(bytes32)(bool)",
                &id,
            ])
            .output()
            .expect("cast on PATH");
        assert!(
            out.status.success(),
            "cast call isReleased failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim() == "true"
    };
    assert!(
        is_released("receipt-a.json"),
        "receipt A must read released after the Safe -> Timelock release round"
    );
    assert!(
        !is_released("receipt-b.json"),
        "receipt B was recorded only: it must not read released"
    );

    // Issue 1696: the Safe applies a consensus receipt through the timelock as ONE batch (releaseReceipt plus the router weight change), after the
    // unpause rows. A third receipt (receipt-c) is recorded with its own digest, unreleased. `govern --row apply-receipt` checks it before sending,
    // schedules the batch through the real Safe, waits the real delay (one time warp on the fork) and executes it. The tool read both back; this test
    // reads them again from the chain. The Twin proves the row executes on the real contracts, not that mainnet governance works.
    // Issue 1743: a VOTED vector (PortfolioRouter.setWeights) overrides the DEFAULT vector while votedWeightsActive is true, so the DEFAULT alone says nothing
    // about routing. Every check below reads both the default vector and the EFFECTIVE vector (what deposits route by) and the voted flag.
    let router_vector = |fx: &Fixture, sig: &str| -> (Vec<String>, Vec<u64>) {
        let raw = fx
            .cast_call_raw(fx.router(), sig, &[])
            .unwrap_or_else(|e| panic!("read the router {sig}: {e}"));
        let n = usize::from_str_radix(&word(&raw, 2), 16).expect("vault count");
        let vaults = (0..n)
            .map(|i| format!("0x{}", &word(&raw, 3 + i)[24..]))
            .collect();
        let bps = (0..n)
            .map(|i| u64::from_str_radix(&word(&raw, 4 + n + i), 16).expect("bps"))
            .collect();
        (vaults, bps)
    };
    let router_weights = |fx: &Fixture| router_vector(fx, "getDefaultWeights()");
    let effective_weights = |fx: &Fixture| router_vector(fx, "getEffectiveWeights()");
    let voted_active = |fx: &Fixture| -> bool {
        fx.cast_call_raw(fx.router(), "votedWeightsActive()", &[])
            .expect("read votedWeightsActive")
            .ends_with('1')
    };
    let c_id = fx
        .record_fixture_receipt("receipt-c.json")
        .expect("record receipt C with its own digest");
    let c_released = |fx: &Fixture| -> bool {
        fx.cast_call_raw(fx.consensus_receipt(), "isReleased(bytes32)", &[&c_id])
            .expect("read isReleased")
            .ends_with('1')
    };
    assert!(!c_released(&fx), "receipt C is recorded, not released");
    let before = router_weights(&fx);
    let want_vaults: Vec<String> = [
        fx.vault(),
        fx.proto_vault(),
        fx.agent_vault(),
        fx.rwa_vault(),
    ]
    .iter()
    .map(|a| format!("{a:#x}"))
    .collect();
    assert_eq!(
        before.0, want_vaults,
        "the router lists the eligible vaults in registry order"
    );
    assert_eq!(
        before.1,
        vec![9500, 500, 0, 0],
        "the deployer left the 8453 launch vector on the router (rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0)"
    );
    assert_ne!(
        before.1,
        vec![5000, 3000, 0, 2000],
        "the router must not already hold receipt C's vector"
    );
    // Issue 1743 (the real 8453 deploy failure): the router stage must not leave a voted vector. Effective routing after the deploy IS the sheet's launch
    // vector, 9500/500/0/0, not 100% rmUSDC.
    assert!(
        !voted_active(&fx),
        "the deploy must leave votedWeightsActive false (a voted vector would override the launch vector)"
    );
    assert_eq!(
        effective_weights(&fx),
        before,
        "the effective routing after the deploy equals the default launch vector 9500/500/0/0"
    );
    // Issue 1743, the clear row on the REAL contracts. The seam is HONEST governance, no impersonation: a voted vector is created the way production creates
    // one. The timelock (through the real Safe) calls RouterGovernance.propose, the two Twin voters (their throwaway keystores, voting power set at deploy,
    // quorum 2) vote, the voting period and execution delay pass by time warp, and anyone executes, which calls router.setWeights. Then apply-receipt
    // must REFUSE, `govern --row clear-voted-weights` runs through the real Safe and timelock, and the router reads votedWeightsActive false and
    // effective == default again.
    {
        let gov = fx.governance_hex().to_string();
        let rpc = fx.rpc_url().to_string();
        let vault_list: Vec<String> = [
            fx.vault(),
            fx.proto_vault(),
            fx.agent_vault(),
            fx.rwa_vault(),
        ]
        .iter()
        .map(|a| format!("{a:#x}"))
        .collect();
        let voted_bps = [8000u64, 1000, 500, 500];
        let list = format!("[{}]", vault_list.join(","));
        let bps_arg = format!(
            "[{}]",
            voted_bps
                .iter()
                .map(|b| b.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let calldata = Command::new("cast")
            .args(["calldata", "propose(address[],uint256[])", &list, &bps_arg])
            .output()
            .expect("cast on PATH");
        assert!(calldata.status.success(), "cast calldata propose failed");
        let calldata = String::from_utf8_lossy(&calldata.stdout).trim().to_string();
        fx.published()
            .govern_call("voted-vector-propose", &gov, &calldata)
            .expect("the timelock proposes a voted vector through the real Safe");
        let pid_raw = Command::new("cast")
            .args([
                "call",
                "--rpc-url",
                &rpc,
                &gov,
                "currentProposalId()(uint256)",
            ])
            .output()
            .expect("cast on PATH");
        let pid = String::from_utf8_lossy(&pid_raw.stdout)
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        assert!(
            !pid.is_empty() && pid != "0",
            "a proposal must exist, got '{pid}'"
        );
        let keys = &fx.published().keys;
        for voter in ["VOTER1", "VOTER2"] {
            let out = Command::new("cast")
                .args(["send", "--rpc-url", &rpc, "--keystore"])
                .arg(keys.key_dir.join(voter))
                .arg("--password-file")
                .arg(&keys.password_file)
                .args([&gov, "vote(uint256)", &pid])
                .output()
                .expect("cast on PATH");
            assert!(
                out.status.success(),
                "{voter} vote failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        // voting period (3600) plus execution delay (3600) of the Twin sheet, plus a margin
        fx.warp(7300)
            .expect("warp past the voting period and delay");
        let exec = fx.cast_send(
            &format!("0x{}", hex::encode(smoke_test::AGENT_PRIVATE_KEY)),
            fx.governance(),
            "execute(uint256)",
            &[&pid],
        );
        exec.expect("anyone executes the passed proposal: router.setWeights");
        assert!(
            voted_active(&fx),
            "the passed proposal must leave a voted vector active"
        );
        assert_eq!(
            effective_weights(&fx).1,
            voted_bps.to_vec(),
            "the voted vector overrides the default"
        );
        assert_eq!(
            router_weights(&fx),
            before,
            "the default vector is untouched by the vote"
        );
        // apply-receipt refuses while the voted vector is active, and sends nothing
        let refusal = fx
            .apply_fixture_receipt("receipt-c.json")
            .expect_err("apply-receipt must refuse while a voted vector is active")
            .to_string();
        assert!(
            refusal.contains("VOTED_WEIGHTS_ACTIVE"),
            "the refusal must name VOTED_WEIGHTS_ACTIVE, got: {refusal}"
        );
        assert!(
            !c_released(&fx),
            "the refused apply-receipt must not release receipt C"
        );
        // the clear row, through the real Safe and timelock
        let cleared = fx
            .published()
            .govern("clear-voted-weights", &[])
            .expect("the Safe clears the voted vector through the timelock");
        assert_eq!(
            cleared.iter().map(|r| r.row.as_str()).collect::<Vec<_>>(),
            vec!["clear-voted-weights", "clear-voted-weights"],
            "one scheduled line and one executed line"
        );
        assert!(
            !voted_active(&fx),
            "votedWeightsActive must read false after the clear"
        );
        assert_eq!(
            effective_weights(&fx),
            router_weights(&fx),
            "effective equals default after the clear"
        );
        assert_eq!(
            effective_weights(&fx),
            before,
            "effective is the launch vector again"
        );
    }
    let applied = fx
        .apply_fixture_receipt("receipt-c.json")
        .expect("the Safe applies receipt C through the timelock");
    assert_eq!(
        applied.iter().map(|r| r.row.as_str()).collect::<Vec<_>>(),
        vec!["apply-receipt", "apply-receipt"],
        "one scheduled line and one executed line"
    );
    assert!(
        c_released(&fx),
        "receipt C must read released after the batch"
    );
    let after = router_weights(&fx);
    assert_eq!(after.0, want_vaults, "the vault list is unchanged");
    // Core 1710: the Safe operation CHANGES the router split. The read-back differs from what the router held before the batch.
    assert_ne!(
        after.1, before.1,
        "apply-receipt must change the router weights from the launch vector"
    );
    assert_eq!(
        after.1,
        vec![5000, 3000, 0, 2000],
        "the router holds receipt C's vector after the batch"
    );
    // Issue 1743: a receipt-driven rebalance must change the EFFECTIVE routing, not only the default vector.
    assert!(
        !voted_active(&fx),
        "no voted vector may override the applied receipt"
    );
    assert_eq!(
        effective_weights(&fx),
        after,
        "the effective routing after apply-receipt equals receipt C's vector"
    );
    // The rehearsal evidence: the run manifest records the round under receipt_applications and evidence-check asserts it against the chain
    // (one batch of exactly the release and the weight change, one real delay apart).
    // The Twin timelock runs a short delay: the floor is the delay the chain itself reports, so the gap must still reach it.
    let min_delay = u64::from_str_radix(
        &word(
            &fx.cast_call_raw(fx.timelock(), "getMinDelay()", &[])
                .expect("read the timelock min delay"),
            0,
        ),
        16,
    )
    .expect("min delay");
    run_bun(
        fx.repo_root(),
        &[
            s("publish-contracts/src/evidence-check.ts"),
            s("--delay-floor"),
            min_delay.to_string(),
            s("--receipt-applications"),
            run_manifest_path.display().to_string(),
            s("--consensus-receipt"),
            fx.consensus_receipt_hex().to_string(),
            s("--governance"),
            fx.governance_hex().to_string(),
            s("--timelock"),
            fx.timelock_hex().to_string(),
            s("--rpc"),
            fx.rpc_url().to_string(),
        ],
    );
    let run_after: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&run_manifest_path).expect("read the run manifest"),
    )
    .expect("the run manifest is JSON");
    let apps = run_after["receipt_applications"]
        .as_array()
        .expect("the run manifest records receipt_applications");
    assert_eq!(apps.len(), 1, "one receipt was applied");
    assert_eq!(apps[0]["receipt_id"], c_id.to_lowercase());

    // Core 1676 (owner decision 2026-10-08): rmAGENT holds RM on the Uniswap V4 RM/USDC pool. The verifier read the venue, the V4 adapter, the
    // recorder PoolKey and the absence of any recorder admin back from the chain: each label is in the output or `verify()` above would have failed.
    for label in [
        "vault[rmAGENT]: asset row is venue V4 with the price recorder as its pool",
        "vault[rmAGENT]: V4 adapter codehash is allowed",
        "vault[rmAGENT]: V4 adapter is bound to the recorder, the PoolManager and the pool key",
        "recorder: PoolKey and PoolManager equal config",
        "recorder: observation ring holds the full window floor",
        "recorder: has no owner, role or setter",
        "recorder: runtime code equals build artifact (masked)",
        "adapter[V4:rmAGENT]: runtime code equals build artifact (masked)",
    ] {
        assert!(
            verified.lines().any(|l| l.trim() == label),
            "the verifier output lacks the label '{label}'"
        );
    }
    rm_v4_flows(&fx, dir);

    // Issues 1485 (AC7) and 1493 (AC5): a router deposit and a router withdraw both succeed on the Twin chain after the full publish and govern run.
    // `cast_send` fails on a reverted receipt.
    //
    // Issue 1746: the router routes by the sheet's launch vector 9500/500/0/0 over all four (open, eligible) vaults. The 0 bps rmAGENT and rmRWA legs have a
    // computed amount of 0, so the router skips them (no vault call): before the fix `rmAGENT.deposit(0)` reverted the whole router deposit.
    let user = fx.agent();
    let pk = format!("0x{}", hex::encode(smoke_test::AGENT_PRIVATE_KEY));
    let amount: u128 = 100_000_000; // 100 USDC
    fx.fund_gas(user, 10_000_000_000_000_000_000)
        .expect("fund gas for the depositor");
    fx.fund_usdc(user, amount)
        .expect("fund USDC for the depositor");
    let router = fx.router();
    let (router_s, amount_s) = (format!("{router:#x}"), amount.to_string());
    let usdc_before = fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance");
    fx.cast_send(
        &pk,
        fx.usdc(),
        "approve(address,uint256)",
        &[&router_s, &amount_s],
    )
    .expect("approve the router");
    let vault_shares =
        |v: alloy_primitives::Address| fx.erc20_balance_of(v, user).expect("share balance");
    let (agent_before, rwa_before) = (vault_shares(fx.agent_vault()), vault_shares(fx.rwa_vault()));
    let (usdc_vault_before, proto_before) =
        (vault_shares(fx.vault()), vault_shares(fx.proto_vault()));
    fx.cast_send(
        &pk,
        router,
        "deposit(uint256,uint256[])",
        &[&amount_s, "[]"],
    )
    .expect("the router deposit over the 9500/500/0/0 launch vector must succeed (issue 1746)");
    let usdc_after_deposit = fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance");
    assert_eq!(
        usdc_after_deposit,
        usdc_before - amount,
        "the router deposit must pull exactly the amount"
    );
    // The 0 bps legs received nothing.
    assert_eq!(
        vault_shares(fx.agent_vault()),
        agent_before,
        "the 0 bps rmAGENT leg must receive nothing"
    );
    assert_eq!(
        vault_shares(fx.rwa_vault()),
        rwa_before,
        "the 0 bps rmRWA leg must receive nothing"
    );
    // rmUSDC and rmPROTO got 9500 and 500 bps of the amount, within rounding (the share price is read back, so the check holds for any price).
    let assets_of = |v: alloy_primitives::Address, shares: u128| -> u128 {
        let raw = fx
            .cast_call_raw(v, "convertToAssets(uint256)", &[&shares.to_string()])
            .expect("convertToAssets");
        u128::from_str_radix(raw.trim().trim_start_matches("0x"), 16).expect("assets word")
    };
    let usdc_minted = vault_shares(fx.vault()) - usdc_vault_before;
    let proto_minted = vault_shares(fx.proto_vault()) - proto_before;
    assert!(
        usdc_minted > 0 && proto_minted > 0,
        "the router deposit minted no shares to rmUSDC and rmPROTO"
    );
    let (usdc_assets, proto_assets) = (
        assets_of(fx.vault(), usdc_minted),
        assets_of(fx.proto_vault(), proto_minted),
    );
    let (want_usdc, want_proto) = (amount * 9500 / 10_000, amount * 500 / 10_000);
    assert!(
        usdc_assets.abs_diff(want_usdc) <= 2 && proto_assets.abs_diff(want_proto) <= 2,
        "the split must be 9500/500 within rounding: rmUSDC {usdc_assets} (want {want_usdc}), rmPROTO {proto_assets} (want {want_proto})"
    );
    // The withdraw path does not depend on the weights: redeem the rmUSDC shares through the router.
    let shares = vault_shares(fx.vault());
    assert!(shares > 0, "the rmUSDC leg minted no shares");
    let (vault_s, shares_s) = (format!("{:#x}", fx.vault()), shares.to_string());
    fx.cast_send(
        &pk,
        fx.vault(),
        "approve(address,uint256)",
        &[&router_s, &shares_s],
    )
    .expect("approve the router to redeem the shares");
    fx.cast_send(
        &pk,
        router,
        "redeemFor(address,address,address[],uint256[],uint256[],uint256)",
        &[
            &format!("{user:#x}"),
            &format!("{user:#x}"),
            &format!("[{vault_s}]"),
            &format!("[{shares_s}]"),
            "[0]",
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        ],
    )
    .expect("the router withdraw must succeed on the Twin chain");
    assert_eq!(
        fx.erc20_balance_of(fx.vault(), user).expect("shares"),
        0,
        "the withdraw left shares behind"
    );
    let usdc_after_withdraw = fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance");
    assert!(
        usdc_after_withdraw > usdc_after_deposit,
        "the withdraw returned no USDC"
    );
}

fn word(raw: &str, i: usize) -> String {
    let h = raw.trim_start_matches("0x");
    h[i * 64..(i + 1) * 64].to_string()
}

/// A signed 24-bit tick from a 32-byte ABI word (sign-extended).
fn tick_of(raw: &str, i: usize) -> i32 {
    let w = word(raw, i);
    u32::from_str_radix(&w[w.len() - 8..], 16).expect("tick word") as i32
}

/// Core 1676. rmAGENT holds RM through the REAL Uniswap V4 PoolManager pool `0xf2e7b957...`, priced by the REAL recorder, on the Twin chain
/// after the full publish and govern run. Nothing is mocked: the pool is real Base state (the live pool, never funded), the vault is opened by the real Safe and timelock, and every swap goes through the real PoolManager.
///  1. the asset row is RM, venue V4, pool = the recorder, adapter = the V4 adapter the vault manifest names;
///  2. after the 48 hour govern warp the recorder is stale: a deposit fails closed until someone pokes it (permissionless);
///  3. a deposit swaps USDC to RM through the PoolManager (the pool tick moves) and the swap pokes the recorder (its index advances);
///  4. a USDC redeem returns USDC;
///  5. left unpoked for more than one window the recorder is stale: a deposit and a USDC redeem fail, and redeemInKind still pays RM.
fn rm_v4_flows(fx: &Fixture, dir: &Path) {
    let cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fx.repo_root().join("config/agent-token-shortlist.json"))
            .expect("read the shipped agent config"),
    )
    .expect("agent config is JSON");
    let rm_cfg = &cfg["shortlist"][0];
    assert_eq!(rm_cfg["venue"], "UniswapV4", "RM is a Uniswap V4 asset");
    let pool_id = rm_cfg["poolId"].as_str().expect("poolId").to_string();
    assert_eq!(
        pool_id,
        "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391"
    );
    let state_view: alloy_primitives::Address = rm_cfg["stateView"]
        .as_str()
        .expect("stateView")
        .parse()
        .expect("stateView address");
    let rm: alloy_primitives::Address = rm_cfg["token"]
        .as_str()
        .expect("token")
        .parse()
        .expect("RM address");
    let read_json = |f: &str| -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(dir.join(f)).unwrap_or_else(|_| panic!("read {f}")),
        )
        .unwrap_or_else(|_| panic!("{f} is JSON"))
    };
    let recorder: alloy_primitives::Address = read_json("recorder.json")["recorder"]
        .as_str()
        .expect("recorder manifest")
        .parse()
        .expect("recorder address");
    let agent_manifest = read_json("agent-token-vault.json");
    let v4_adapter = agent_manifest["adapter_v4"].as_str().expect("adapter_v4");

    // 1. The asset row.
    let agent_vault = fx.agent_vault();
    let first = fx
        .cast_call_raw(agent_vault, "assets(uint256)", &["0"])
        .expect("read rmAGENT assets(0)");
    assert!(
        word(&first, 0).ends_with("65021a79aeef22b17cdc1b768f5e79a8618beba3"),
        "rmAGENT asset 0 must be RM, got {first}"
    );
    assert!(
        word(&first, 1).ends_with(
            &format!("{recorder:#x}")
                .trim_start_matches("0x")
                .to_lowercase()
        ),
        "rmAGENT asset 0 pool must be the recorder {recorder:#x}, got {first}"
    );
    assert_eq!(
        u64::from_str_radix(word(&first, 2).trim_start_matches('0').max("0"), 16).unwrap(),
        29100,
        "the swap fee is the pool fee 29100"
    );
    assert!(
        word(&first, 4).ends_with(&v4_adapter.trim_start_matches("0x").to_lowercase()),
        "rmAGENT asset 0 adapter must be the V4 adapter {v4_adapter}, got {first}"
    );
    assert_eq!(
        word(&first, 5).trim_start_matches('0'),
        "1",
        "venue is V4 (1)"
    );

    // The depositor: a funded EOA. rmAGENT is already open: the govern matrix above unpaused it through the real Safe and timelock.
    let user = fx.agent();
    let pk = format!("0x{}", hex::encode(smoke_test::AGENT_PRIVATE_KEY));
    fx.fund_gas(user, 10_000_000_000_000_000_000)
        .expect("fund gas for the depositor");
    let deposit: u128 = 10_000_000; // 10 USDC: the live pool is unfunded (owner 2026-10-09), one swap above about 18 USDC exceeds the 209 bps margin
    fx.fund_usdc(user, deposit * 4)
        .expect("fund USDC for the depositor");
    let (vault_s, dep_s) = (format!("{agent_vault:#x}"), deposit.to_string());
    let user_s = format!("{user:#x}");
    let slot0 = |fx: &Fixture| {
        fx.cast_call_raw(state_view, "getSlot0(bytes32)", &[&pool_id])
            .expect("StateView.getSlot0")
    };
    let latest = |fx: &Fixture| {
        // latest() -> (lastTick, lastRecordedAt, index, cardinality, cardinalityNext)
        let raw = fx
            .cast_call_raw(recorder, "latest()", &[])
            .expect("recorder.latest()");
        let at = u64::from_str_radix(word(&raw, 1).trim_start_matches('0').max("0"), 16).unwrap();
        let idx = u64::from_str_radix(word(&raw, 2).trim_start_matches('0').max("0"), 16).unwrap();
        let card = u64::from_str_radix(word(&raw, 3).trim_start_matches('0').max("0"), 16).unwrap();
        (at, idx, card)
    };

    // 2. Stale after the govern warp: the deposit fails closed. (Anyone may poke the recorder: `record()` has no role.)
    fx.cast_send(
        &pk,
        fx.usdc(),
        "approve(address,uint256)",
        &[&vault_s, &dep_s],
    )
    .expect("approve rmAGENT");
    assert!(
        fx.cast_send(
            &pk,
            agent_vault,
            "deposit(uint256,address)",
            &[&dep_s, &user_s]
        )
        .is_err(),
        "a deposit into rmAGENT must fail closed while the recorder is stale"
    );
    fx.cast_send(&pk, recorder, "record()", &[])
        .expect("anyone may poke the recorder");
    let (poked_at, idx_before, card) = latest(fx);
    assert!(card >= 901, "the ring holds the 901 slot floor, got {card}");
    let tick_before = tick_of(&slot0(fx), 1);

    // 3. A deposit, one block later, routed through the real PoolManager pool.
    fx.warp(10).expect("one block later");
    let rm_before = fx.erc20_balance_of(rm, agent_vault).expect("RM balance");
    fx.cast_send(
        &pk,
        agent_vault,
        "deposit(uint256,address)",
        &[&dep_s, &user_s],
    )
    .expect("the rmAGENT deposit must succeed through the V4 PoolManager");
    let shares = fx
        .erc20_balance_of(agent_vault, user)
        .expect("rmAGENT shares");
    assert!(shares > 0, "the rmAGENT deposit minted no shares");
    let rm_after = fx.erc20_balance_of(rm, agent_vault).expect("RM balance");
    assert!(
        rm_after > rm_before,
        "rmAGENT holds no RM after the deposit"
    );
    assert_ne!(
        tick_of(&slot0(fx), 1),
        tick_before,
        "the deposit must move the tick of PoolManager pool {pool_id}: the swap went through it"
    );
    let (swap_at, idx_after, _) = latest(fx);
    assert!(
        swap_at > poked_at && idx_after != idx_before,
        "the recorder index must advance during the swap (index {idx_before} -> {idx_after}, time {poked_at} -> {swap_at})"
    );

    // 4. A USDC redeem returns USDC.
    let half = (shares / 2).to_string();
    let usdc_before = fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance");
    fx.cast_send(
        &pk,
        agent_vault,
        "redeem(uint256,address,address)",
        &[&half, &user_s, &user_s],
    )
    .expect("the rmAGENT USDC redeem must succeed while the recorder is fresh");
    assert!(
        fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance") > usdc_before,
        "the USDC redeem returned no USDC"
    );

    // 5. Left unpoked for more than one window: deposits and USDC redeems fail closed, redeemInKind pays RM with no oracle read.
    fx.warp(1900)
        .expect("leave the recorder unpoked for more than one 1800 s window");
    let rest = fx
        .erc20_balance_of(agent_vault, user)
        .expect("rmAGENT shares");
    assert!(rest > 0, "no shares left for the in-kind exit");
    fx.cast_send(
        &pk,
        fx.usdc(),
        "approve(address,uint256)",
        &[&vault_s, &dep_s],
    )
    .expect("approve rmAGENT");
    assert!(
        fx.cast_send(
            &pk,
            agent_vault,
            "deposit(uint256,address)",
            &[&dep_s, &user_s]
        )
        .is_err(),
        "a deposit must fail closed with a stale recorder"
    );
    assert!(
        fx.cast_send(
            &pk,
            agent_vault,
            "redeem(uint256,address,address)",
            &[&rest.to_string(), &user_s, &user_s]
        )
        .is_err(),
        "a USDC redeem must fail closed with a stale recorder"
    );
    let rm_user_before = fx.erc20_balance_of(rm, user).expect("RM balance");
    fx.cast_send(
        &pk,
        agent_vault,
        "redeemInKind(uint256,address,address)",
        &[&rest.to_string(), &user_s, &user_s],
    )
    .expect("redeemInKind must pay with a stale recorder (withdrawals are never frozen)");
    assert!(
        fx.erc20_balance_of(rm, user).expect("RM balance") > rm_user_before,
        "redeemInKind returned no RM"
    );
}
