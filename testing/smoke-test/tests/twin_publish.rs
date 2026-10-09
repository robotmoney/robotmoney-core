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
    let fx = Fixture::new().expect("smoke-test fixture boot failed");
    let dir = fx.manifest_dir();
    let table = smoke_test::stage_table::StageTable::load_default().expect("read the stage table");
    let missing = table.missing(dir);
    assert!(
        missing.is_empty(),
        "manifests the stage table names are missing in {}: {missing:?}",
        dir.display()
    );
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

    // Issue 1667: the order is publish, verify, govern, verify. The first verify above passed before govern (the baskets paused). This second verify reads the
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

    // Issues 1485 (AC7) and 1493 (AC5): a router deposit and a router withdraw both succeed on the Twin chain
    // after the full publish and govern run. `cast_send` fails on a reverted receipt.
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
    fx.cast_send(
        &pk,
        router,
        "deposit(uint256,uint256[])",
        &[&amount_s, "[]"],
    )
    .expect("the router deposit must succeed on the Twin chain");
    let usdc_after_deposit = fx.erc20_balance_of(fx.usdc(), user).expect("USDC balance");
    assert_eq!(
        usdc_after_deposit,
        usdc_before - amount,
        "the deposit must pull exactly the amount"
    );
    let shares = fx
        .erc20_balance_of(fx.vault(), user)
        .expect("rmUSDC share balance");
    assert!(shares > 0, "the router deposit minted no rmUSDC shares");
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
/// after the full publish and govern run. Nothing is mocked: the pool is real Base state (funded through the real PositionManager by
/// `rehearsal fund-rm-pool`), the vault is opened by the real Safe and timelock, and every swap goes through the real PoolManager.
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

    // The depositor: a funded EOA. rmAGENT is opened through the real Safe and timelock (a generic Twin-only call).
    fx.unpause_agent_vault()
        .expect("open rmAGENT deposits through the real Safe and timelock");
    let user = fx.agent();
    let pk = format!("0x{}", hex::encode(smoke_test::AGENT_PRIVATE_KEY));
    fx.fund_gas(user, 10_000_000_000_000_000_000)
        .expect("fund gas for the depositor");
    let deposit: u128 = 50_000_000; // 50 USDC, under the 100 USDC per-deposit cap
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
