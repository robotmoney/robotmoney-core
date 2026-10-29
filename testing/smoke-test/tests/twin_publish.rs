//! The Twin chain run of publish contracts, end to end (core 1488).
//!
//! One test boots the Twin chain (918453) through the harness. The harness has already called
//! `publish` (deploy all three vaults, real Safe handover). This test then asserts the three
//! manifests, runs the one verifier (which holds the router, basket and timelock role proofs), runs the stage 13 govern matrix through the real Safe,
//! runs the verifier again (the order is publish, verify, govern, verify: issue 1667), then one Safe self-administration row on the real SafeL2
//! (`govern --row safe-change-threshold` raised to the owner count and restored to the sheet's value: QA plan v1 B5, finding T5).
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
    // Issue 1892: the vaults system and the gateway system are independent runs. The vaults run left no gateway manifest and sent no gateway transaction; the gateway run
    // came after it, against its manifests, left every one of them byte-unchanged, moved the gateway roles to GATEWAY_ADMIN_ADDRESS and authorized no agent.
    {
        let published = fx.published();
        let gateway_files = table.gateway_manifests();
        assert_eq!(
            gateway_files,
            ["gateway.json", "gateway-handover.json"],
            "the table's gateway system writes exactly the gateway and its handover"
        );
        assert!(
            !published.vaults_snapshot.is_empty()
                && published.vaults_snapshot.len() == table.vaults_manifests().len(),
            "the vaults run's snapshot must hold every vaults manifest (executed count)"
        );
        assert!(
            published
                .vaults_snapshot
                .keys()
                .all(|f| !gateway_files.contains(f)),
            "the vaults-only run left a gateway manifest"
        );
        for (f, before) in &published.vaults_snapshot {
            assert_eq!(
                &std::fs::read(dir.join(f)).expect("read a vaults manifest"),
                before,
                "the gateway run changed the vaults manifest {f}"
            );
        }
        let read_json = |p: PathBuf| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
            )
            .unwrap_or_else(|e| panic!("{}: {e}", p.display()))
        };
        let vaults_run = read_json(fx.published().evidence_dir().join("publish-run.json"));
        let vaults_stages: Vec<&String> = vaults_run["stages"]
            .as_object()
            .expect("stages")
            .keys()
            .collect();
        assert!(
            vaults_stages.iter().all(|s| !s.starts_with("gateway")),
            "the vaults run manifest records a gateway stage: {vaults_stages:?}"
        );
        assert_eq!(vaults_run["system"], "vaults");
        let gateway_evidence = fx.gateway_run().evidence_dir.clone();
        let gateway_run = read_json(gateway_evidence.join("publish-run.json"));
        assert_eq!(gateway_run["system"], "gateway");
        for stage in ["gateway", "gateway-handover", "verify"] {
            assert!(
                gateway_run["stages"].get(stage).is_some(),
                "the gateway run manifest lacks stage {stage}"
            );
        }
        let handover = read_json(dir.join("gateway-handover.json"));
        for (role, want) in [
            ("admin_holder_has_admin_role", true),
            ("admin_holder_has_default_admin_role", true),
            ("deployer_has_admin_role", false),
            ("deployer_has_default_admin_role", false),
        ] {
            assert_eq!(
                handover["roles"][role], want,
                "gateway-handover.json roles.{role}"
            );
        }
        for label in [
            "agents: no AgentAuthorized log on the gateway up to the handover block",
            "agents: no AGENT_ROLE grant on the gateway up to the handover block",
            "vaults system: the manifests this run consumed are unchanged since it began",
            "gateway: ADMIN_ROLE held by the gateway admin",
        ] {
            assert!(
                fx.gateway_run()
                    .verify_output
                    .lines()
                    .any(|l| l.trim() == label),
                "the gateway verifier output lacks the label '{label}'"
            );
        }
        let marker = format!(
            "TWIN-SCENARIO rust-systems: vaults_manifests={} gateway_manifests={} vaults_unchanged=true agents_at_handover=0",
            published.vaults_snapshot.len(),
            gateway_files.len()
        );
        println!("{marker}");
        // The workflow names a file for the marker and requires it afterwards (suite 14): a removed scenario leaves no line.
        if let Some(p) = std::env::var_os("SMOKE_TEST_MARKER_OUT") {
            std::fs::write(p, format!("{marker}\n")).expect("write the scenario marker");
        }
    }
    // Core 1710, issue 1705: each vault's deposit state before govern is the stage table's deployPaused (all three deploy paused, rmUSDC included),
    // and after govern it is open where the table makes the unpause a stage 13 row. The verifier below expects exactly that.
    let rules = table.vault_deposit_rules();
    let deposits_paused = |vault: alloy_primitives::Address| -> bool {
        fx.cast_call_raw(vault, "depositsPaused()", &[])
            .expect("read depositsPaused")
            .ends_with('1')
    };
    let three_vaults = [
        ("rmUSDC", fx.vault()),
        ("rmPROTO", fx.proto_vault()),
        ("rmRWA", fx.rwa_vault()),
    ];
    assert_eq!(
        rules.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        three_vaults.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
        "the stage table's vault rows and the harness vaults must be the same three, in order"
    );
    for (rule, (name, vault)) in rules.iter().zip(three_vaults) {
        assert_eq!(
            deposits_paused(vault),
            rule.deploy_paused,
            "{name}: depositsPaused before govern must equal the stage table's deployPaused"
        );
    }
    let verified = fx
        .published()
        .verify()
        .expect("the verifier must pass on the Twin chain");
    assert!(!verified.trim().is_empty(), "the verifier printed nothing");
    // Core 1618: before the stage 11 handover the real Safe executed one self-call signed by EVERY owner. The verifier read it back
    // from the chain (the `safe:` labels, all passed or `verify()` above would have failed), and the run manifest records it.
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
    for vault in ["rmPROTO", "rmRWA"] {
        for what in [
            "navDeviationGuardBps equals sheet",
            "navDeviationGuardBps above zero",
            "pool liquidity meets the sheet floor",
            // QA plan v1 D7: present before govern too (a paused basket passes it); after govern it needs the set-unwind-guard rounds below
            "emergencyUnwindGuard minUsdcOut above zero on every active asset of an open vault",
        ] {
            let label = format!("vault[{vault}]: {what}");
            assert!(
                verified.lines().any(|l| l.trim() == label),
                "the verifier output lacks the label '{label}'"
            );
        }
    }
    // Issue 1668: the verifier lists every holder of every role on every governed contract from the chain's RoleGranted logs.
    // `verify()` above would have failed had any holder been unexpected.
    {
        let label = "roles: every holder of every role on every governed contract is an expected account (log scan)";
        assert!(
            verified.lines().any(|l| l.trim() == label),
            "the verifier output lacks the label '{label}'"
        );
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
    // Core 1710: stage 13 is three unpauses, rmUSDC first. Each is its own scheduled and executed line, and each vault reads open afterwards.
    for row in ["unpause-USDC", "unpause-PROTO", "unpause-RWA"] {
        assert_eq!(
            rows.iter().filter(|r| r.row == row).count(),
            2,
            "the govern matrix must print one scheduled and one executed line for {row}"
        );
    }
    for (rule, (name, vault)) in rules.iter().zip(three_vaults) {
        assert_eq!(
            deposits_paused(vault),
            rule.paused_after_stage13(),
            "{name}: depositsPaused after stage 13 must follow the stage table (deployPaused, unpauseInStage13)"
        );
    }

    // QA plan v1 D7: the verifier requires a non-zero emergency unwind guard on every active asset of an OPEN basket. The Safe sets it through the real timelock,
    // one `govern --row set-unwind-guard` round per basket (token=all), as the twin-publish step does, before the post-govern verify. The baskets hold nothing yet:
    // these values prove the row and the label on the real contracts, not a sizing (on 8453 the operator sizes min-usdc-out from each vault's holding).
    for basket in ["PROTO", "RWA"] {
        let vault_arg = format!("vault={basket}");
        let guarded = fx
            .published()
            .govern(
                "set-unwind-guard",
                &[
                    "--admin-arg",
                    vault_arg.as_str(),
                    "--admin-arg",
                    "token=all",
                    "--admin-arg",
                    "min-usdc-out=1000000",
                    "--admin-arg",
                    "max-loss-bps=500",
                ],
            )
            .expect("the Safe sets the basket's emergency unwind guard through the real timelock");
        assert_eq!(
            guarded.iter().map(|r| r.row.as_str()).collect::<Vec<_>>(),
            vec!["set-unwind-guard", "set-unwind-guard"],
            "one scheduled and one executed line for the {basket} guard"
        );
    }

    // Issue 1667: the order is publish, verify, govern, verify. The first verify above passed before govern (all three vaults paused). This second verify reads the
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

    // QA plan v1 B5 (finding T5, issue 1645): one Safe self-administration row on the REAL SafeL2, not only against the fake Safe of govern.test.ts. The matrix
    // raises the threshold to the owner count (so the next Safe transaction needs every owner's signature), then restores the sheet's threshold: that transaction
    // carries all three signatures and runs while the sheet is stale (the self-administration exemption). The restore keeps the rest of this test honest: the
    // verifier's Safe threshold label and every later row compare the live roster with the sheet, and a sheet cannot carry a threshold equal to the owner count.
    let safe_threshold = || -> u64 {
        u64::from_str_radix(
            &word(
                &fx.cast_call_raw(fx.safe(), "getThreshold()", &[])
                    .expect("read the Safe threshold"),
                0,
            ),
            16,
        )
        .expect("Safe threshold")
    };
    // getOwners() returns address[]: the offset word, then the length word, then the owners.
    let owner_count = u64::from_str_radix(
        &word(
            &fx.cast_call_raw(fx.safe(), "getOwners()", &[])
                .expect("read the Safe owners"),
            1,
        ),
        16,
    )
    .expect("Safe owner count");
    let sheet_threshold = safe_threshold();
    assert!(
        sheet_threshold < owner_count,
        "the sheet threshold {sheet_threshold} must be below the owner count {owner_count}: the self-administration pair has nothing to raise"
    );
    let raise_arg = format!("threshold={owner_count}");
    let raised = fx
        .published()
        .govern(
            "safe-change-threshold",
            &["--admin-arg", raise_arg.as_str()],
        )
        .expect("the Safe raises its own threshold through the real SafeL2");
    assert_eq!(
        raised.iter().map(|r| r.row.as_str()).collect::<Vec<_>>(),
        vec!["safe-change-threshold"],
        "one executed line: a Safe self-administration row is one Safe transaction, no timelock round"
    );
    assert_eq!(
        safe_threshold(),
        owner_count,
        "getThreshold must read the owner count after the raise"
    );
    let restore_arg = format!("threshold={sheet_threshold}");
    let restored = fx
        .published()
        .govern(
            "safe-change-threshold",
            &["--admin-arg", restore_arg.as_str()],
        )
        .expect("every owner signs the restore of the sheet's threshold");
    assert_eq!(
        restored.iter().map(|r| r.row.as_str()).collect::<Vec<_>>(),
        vec!["safe-change-threshold"],
        "one executed line for the restore"
    );
    assert_eq!(
        safe_threshold(),
        sheet_threshold,
        "the Safe reads the sheet's threshold again, so every later row and verify compares clean"
    );
    assert_ne!(
        raised[0].tx_hash, restored[0].tx_hash,
        "two Safe transactions, two run-manifest records (the calldata and the Safe nonce differ)"
    );

    // Core 1611: one consensus receipt is released end to end through the REAL Safe and the REAL timelock on the fork. The seed records two
    // receipts (the gateway committee registration is itself a Safe -> Timelock call), then a Safe -> Timelock call (issue 1831: the govern row is refused) schedules
    // `releaseReceipt` through the Safe, waits the real timelock delay (one time warp on the fork) and executes it. This test reads `released`
    // back from the chain: A is released, B (recorded, never released) is not.
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

    // Issue 1696, issue 1698: the Safe applies a consensus receipt through the timelock as ONE call, RouterGovernance.applyReceipt, which releases
    // the receipt and sets the router's ACTIVE vector together. A third receipt (receipt-c) is recorded with its own digest, unreleased.
    // `govern --row apply-receipt` checks it before sending, schedules the call through the real Safe, waits the real delay (one time warp on the
    // fork) and executes it. The tool read it back; this test reads it again from the chain. The default vector is untouched and stays the fallback.
    // Issue 1743: the active vector overrides the default while votedWeightsActive is true, so every check reads the default, the active and the
    // EFFECTIVE vector (what deposits route by) and the flag.
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
    let active_weights = |fx: &Fixture| router_vector(fx, "getWeights()");
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
    let want_vaults: Vec<String> = [fx.vault(), fx.proto_vault(), fx.rwa_vault()]
        .iter()
        .map(|a| format!("{a:#x}"))
        .collect();
    assert_eq!(
        before.0, want_vaults,
        "the router lists the eligible vaults in registry order"
    );
    assert_eq!(
        before.1,
        vec![9500, 500, 0],
        "the deployer left the 8453 launch vector on the router (rmUSDC 9500, rmPROTO 500, rmRWA 0)"
    );
    assert_ne!(
        before.1,
        vec![5000, 3000, 2000],
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
    {
        // Issues 1485 (AC7) and 1493 (AC5): a router deposit and a router withdraw both succeed on the Twin chain after the full publish and govern run.
        // `cast_send` fails on a reverted receipt.
        //
        // Issue 1746: the router skips every leg whose computed amount is 0 (no vault call). At this point of the run the EFFECTIVE vector is the default launch vector
        // (9500/500/0, no receipt applied yet: rmRWA is 0 bps). It runs before receipt C is applied, because nothing clears an applied vector (issue 1988) and receipt C
        // weights every vault. Before the fix a 0 bps leg reverted the whole router deposit (`deposit(0)` reverts).
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
        let legs = [
            ("rmUSDC", fx.vault()),
            ("rmPROTO", fx.proto_vault()),
            ("rmRWA", fx.rwa_vault()),
        ];
        let (leg_vaults, leg_bps) = effective_weights(&fx);
        assert_eq!(
            leg_vaults,
            legs.iter()
                .map(|(_, a)| format!("{a:#x}"))
                .collect::<Vec<_>>(),
            "the effective vector lists the three vaults in registry order"
        );
        assert!(
            leg_bps.contains(&0) && leg_bps.iter().any(|b| *b > 0),
            "the router deposit must exercise a 0 bps leg next to funded legs, got {leg_bps:?}"
        );
        let before: Vec<u128> = legs.iter().map(|(_, a)| vault_shares(*a)).collect();
        fx.cast_send(
            &pk,
            router,
            "deposit(uint256,uint256[])",
            &[&amount_s, "[]"],
        )
        .expect("the router deposit with a 0 bps eligible leg must succeed (issue 1746)");
        let usdc_after_deposit = fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance");
        assert_eq!(
            usdc_after_deposit,
            usdc_before - amount,
            "the router deposit must pull exactly the amount"
        );
        // The 0 bps legs received nothing. Every other leg got its bps of the amount within 0.5% (a basket deposit swaps, so its shares price in a small slippage; the exact split is proven by the forge router tests) (the share price is read back with convertToAssets, so the
        // check holds for any price). The rounding remainder lands on the last non-zero leg, so the legs together hold the whole amount.
        let assets_of = |v: alloy_primitives::Address, shares: u128| -> u128 {
            let raw = fx
                .cast_call_raw(v, "convertToAssets(uint256)", &[&shares.to_string()])
                .expect("convertToAssets");
            u128::from_str_radix(raw.trim().trim_start_matches("0x"), 16).expect("assets word")
        };
        let mut total_assets = 0u128;
        for (i, (name, v)) in legs.iter().enumerate() {
            let minted = vault_shares(*v) - before[i];
            if leg_bps[i] == 0 {
                assert_eq!(minted, 0, "the 0 bps {name} leg must receive nothing");
            } else {
                let want = amount * u128::from(leg_bps[i]) / 10_000;
                let got = assets_of(*v, minted);
                total_assets += got;
                assert!(minted > 0, "{name} ({} bps) minted no shares", leg_bps[i]);
                assert!(
                    got.abs_diff(want) <= want / 200 + 2,
                    "{name} must get {} bps within rounding: got {got}, want {want}",
                    leg_bps[i]
                );
            }
        }
        assert!(
            total_assets.abs_diff(amount) <= amount / 200 + 4,
            "the legs together must hold the whole amount: {total_assets} of {amount}"
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
        "receipt C must read released after the one applyReceipt call"
    );
    let after = active_weights(&fx);
    assert_eq!(after.0, want_vaults, "the vault list is unchanged");
    assert_eq!(
        after.1,
        vec![5000, 3000, 2000],
        "the router's active vector is receipt C's vector after the call"
    );
    // Issue 1743: a receipt-driven rebalance must change the EFFECTIVE routing.
    assert!(
        voted_active(&fx),
        "the applied vector is the router's active vector"
    );
    assert_eq!(
        effective_weights(&fx),
        after,
        "the effective routing after apply-receipt equals receipt C's vector"
    );
    assert_eq!(
        router_weights(&fx),
        before,
        "the default vector is untouched and stays the fallback"
    );
    // The rehearsal evidence: the run manifest records the round under receipt_applications and evidence-check asserts it against the chain
    // (exactly one applyReceipt call, one real delay apart).
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

    // Issue 1988: nothing clears the applied vector. It stays the router's active vector until a newer receipt replaces it.
    assert!(
        voted_active(&fx),
        "the applied vector stays active: nothing clears it"
    );
    assert!(c_released(&fx), "receipt C stays released");
}

fn word(raw: &str, i: usize) -> String {
    let h = raw.trim_start_matches("0x");
    h[i * 64..(i + 1) * 64].to_string()
}
