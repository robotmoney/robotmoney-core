//! Canonical: docs/technical/security-model.md §16 (rmpc CLI integration tests: no mocking),
//! docs/technical/governance-isomorphism.md.
//! Implements: issue #422 (rmpc get-timelock against a real Safe proxy holding PROPOSER_ROLE),
//! issue #1647 (the real Safe topology on the Twin chain, no EOA proposer, no mock).
//!
//! This test boots the SAME topology stage and mainnet use, on the Twin chain (a pinned lazy fork of
//! real Base state): the smoke-test `Fixture` runs the one deploy driver (publish contracts), which
//! deploys the real 2-of-3 Safe proxy through the canonical SafeProxyFactory, the
//! `TimelockController` with that Safe as proposer, and the handover of every admin role to the
//! timelock. It then runs `rmpc get-timelock` and checks its output against on-chain state read
//! independently with `cast`:
//!
//! 1. `proposers` is exactly the real Safe (`hasRole(PROPOSER_ROLE, safe)`), and the Safe is a real
//!    contract with threshold 2 of 3 owners.
//! 2. `executors` matches `hasRole(EXECUTOR_ROLE, address(0))`, whether EXECUTOR_ROLE is open or
//!    Safe-restricted.
//! 3. `min_delay_secs` equals `getMinDelay()`.
//! 4. After the real Safe schedules an operation through the timelock (propose, two owner
//!    signatures, execute, by the publish-contracts Safe tool) and leaves it pending, `pending_ops`
//!    holds exactly that operation id, ready at `getTimestamp(id)`.
//!
//! There is no EOA proposer and no mock. A broken Safe signing path (one signature short of the
//! quorum) or a broken role wiring (the Safe not holding PROPOSER_ROLE) makes this test fail.
//!
//! To run locally (needs anvil, bun, forge, cast):
//!   TWIN_RPC_URL=<running Twin fork> \
//!     cargo test -p rmpc-fork-e2e --test rmpc_get_timelock_fork -- --nocapture

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde_json::Value;
use smoke_test::{require_prereqs, Fixture};

/// keccak256("PROPOSER_ROLE"), the OZ TimelockController constant.
const PROPOSER_ROLE: &str = "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1";
/// keccak256("EXECUTOR_ROLE"), the OZ TimelockController constant.
const EXECUTOR_ROLE: &str = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63";
/// keccak256("CANCELLER_ROLE"), the OZ TimelockController constant.
const CANCELLER_ROLE: &str = "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783";
const ZERO_ADDR: &str = "0x0000000000000000000000000000000000000000";

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // testing/fork-e2e-rust → testing → repo root
    p.pop();
    p.pop();
    p
}

fn rmpc_bin() -> &'static PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let manifest = workspace_root().join("clients/rust-payment-client/Cargo.toml");
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "--quiet",
                "--bin",
                "rmpc",
                "--manifest-path",
                manifest.to_str().expect("manifest path utf-8"),
            ])
            .status()
            .expect("spawn cargo build rmpc");
        assert!(status.success(), "cargo build --bin rmpc failed");
        let bin = workspace_root().join("target/debug/rmpc");
        assert!(bin.exists(), "rmpc binary not at {bin:?} after build");
        bin
    })
}

/// `cast <args>` against the Twin chain; returns trimmed stdout and panics with stderr on failure.
fn cast(rpc: &str, args: &[&str]) -> String {
    let out = Command::new("cast")
        .args(args)
        .args(["--rpc-url", rpc])
        .output()
        .expect("spawn cast");
    assert!(
        out.status.success(),
        "cast {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn has_role(rpc: &str, timelock: &str, role: &str, who: &str) -> bool {
    cast(
        rpc,
        &[
            "call",
            timelock,
            "hasRole(bytes32,address)(bool)",
            role,
            who,
        ],
    ) == "true"
}

/// First block at which `addr` has code, by bisection over `[lo, hi]`. The rmpc log scan starts
/// there: a forked chain forwards ranges older than the pin to the upstream, which caps
/// `eth_getLogs` at 500 blocks, so the scan must not start below the deployment.
fn first_block_with_code(rpc: &str, addr: &str, lo: u64, hi: u64) -> u64 {
    let (mut lo, mut hi) = (lo, hi);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let code = cast(rpc, &["code", addr, "--block", &mid.to_string()]);
        if code.len() > 2 {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

fn write_config(dir: &Path, fx: &Fixture, from_block: u64) -> PathBuf {
    let keystore = dir.join("keystore.json");
    let cfg_path = dir.join("rmpc.toml");
    // Read commands only consume the fields of the command under test. The addresses are the real
    // topology's.
    let toml = format!(
        r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{gateway}"
usdc_address          = "{usdc}"
vault_address         = "{vault}"
timelock_address      = "{timelock}"
timelock_from_block   = {from_block}
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        chain_id = fx.chain_id(),
        rpc_url = fx.rpc_url(),
        gateway = fx.gateway_hex(),
        usdc = fx.usdc_hex(),
        vault = fx.vault_hex(),
        timelock = fx.timelock_hex(),
        zeros = "0".repeat(64),
        ks = keystore.display(),
    );
    std::fs::write(&cfg_path, toml).expect("write rmpc.toml");
    cfg_path
}

fn run_get_timelock(cfg: &Path) -> Value {
    let out = Command::new(rmpc_bin())
        .args(["get-timelock", "--config", cfg.to_str().unwrap()])
        .output()
        .expect("spawn rmpc get-timelock");
    assert!(
        out.status.success(),
        "rmpc get-timelock exited {:?}; stderr=\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
    );
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "rmpc get-timelock stdout not valid JSON: {e}\nstdout=\n{}",
            String::from_utf8_lossy(&out.stdout)
        )
    })
}

fn addr_list(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("expected an array")
        .iter()
        .map(|a| a.as_str().expect("address string").to_ascii_lowercase())
        .collect()
}

#[test]
fn get_timelock_integration() {
    require_prereqs("get_timelock_integration");
    let fx = Fixture::new().expect("boot the Twin chain and publish the real Safe topology");
    let rpc = fx.rpc_url().to_string();
    let timelock = fx.timelock_hex().to_string();
    let safe = fx.safe_hex().to_string();
    let safe_lc = safe.to_ascii_lowercase();

    // ── The topology is the real one, checked on chain before rmpc is asked ───────────────────
    // A Safe proxy: it has code, and it is a 2-of-3 (threshold read from the Safe itself).
    let safe_code = cast(&rpc, &["code", &safe]);
    assert!(safe_code.len() > 2, "no contract at the Safe {safe}");
    assert_eq!(
        cast(&rpc, &["call", &safe, "getThreshold()(uint256)"]),
        "2",
        "the Safe threshold must be 2"
    );
    let owners = cast(&rpc, &["call", &safe, "getOwners()(address[])"]);
    assert_eq!(
        owners
            .trim_matches(|c| c == '[' || c == ']')
            .split(',')
            .count(),
        3,
        "the Safe must have 3 owners: {owners}"
    );
    // The Safe, not an EOA, is the proposer and the canceller.
    assert!(
        has_role(&rpc, &timelock, PROPOSER_ROLE, &safe),
        "the real Safe must hold PROPOSER_ROLE"
    );
    assert!(
        has_role(&rpc, &timelock, CANCELLER_ROLE, &safe),
        "the real Safe must hold CANCELLER_ROLE"
    );
    let deployer = fx
        .published()
        .keys
        .address("ADMIN_ADDRESS")
        .expect("deployer address")
        .to_string();
    assert!(
        !has_role(&rpc, &timelock, PROPOSER_ROLE, &deployer),
        "the deployer EOA must not hold PROPOSER_ROLE after handover"
    );
    let on_chain_delay: u64 = cast(&rpc, &["call", &timelock, "getMinDelay()(uint256)"])
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .expect("getMinDelay is a number");
    let executor_open = has_role(&rpc, &timelock, EXECUTOR_ROLE, ZERO_ADDR);
    let safe_is_executor = has_role(&rpc, &timelock, EXECUTOR_ROLE, &safe);

    let tip: u64 = cast(&rpc, &["block-number"]).parse().expect("block number");
    let pin: u64 = std::env::var("TWIN_PIN_BLOCK")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let from_block = first_block_with_code(&rpc, &timelock, pin, tip);

    let tmp = tempfile::TempDir::new().expect("tempdir");
    let cfg = write_config(tmp.path(), &fx, from_block);

    // ── 1. rmpc get-timelock on the real topology, no pending operation ───────────────────────
    let v = run_get_timelock(&cfg);
    eprintln!("[get_timelock_integration] rmpc output:\n{v:#}");
    assert_eq!(v["chain_id"].as_u64().unwrap_or(0), fx.chain_id(), "{v}");
    assert_eq!(v["source"], "json_rpc", "source must be json_rpc: {v}");
    assert!(
        v["block_number"].is_u64(),
        "block_number must be a u64: {v}"
    );
    assert_eq!(v["partial"], false, "the envelope must not be partial: {v}");
    let d = &v["data"];
    assert_eq!(
        d["address"].as_str().unwrap().to_ascii_lowercase(),
        timelock.to_ascii_lowercase(),
        "data.address must be the deployed timelock"
    );
    assert_eq!(
        d["min_delay_secs"].as_u64().unwrap(),
        on_chain_delay,
        "data.min_delay_secs must equal getMinDelay()"
    );
    assert_eq!(
        addr_list(&d["proposers"]),
        vec![safe_lc.clone()],
        "the real Safe must be the only proposer"
    );
    let executors = addr_list(&d["executors"]);
    assert_eq!(
        executors.contains(&ZERO_ADDR.to_string()),
        executor_open,
        "data.executors must say whether EXECUTOR_ROLE is open (address(0)): {executors:?}"
    );
    assert_eq!(
        executors.contains(&safe_lc),
        safe_is_executor,
        "data.executors must say whether the Safe holds EXECUTOR_ROLE: {executors:?}"
    );
    assert!(
        executor_open || safe_is_executor,
        "someone must be able to execute: open or the Safe"
    );
    // The handover and any earlier rounds are done, so nothing is pending.
    assert!(
        d["pending_ops"].as_array().unwrap().is_empty(),
        "no operation was scheduled yet: {d}"
    );

    // ── 2. The real Safe schedules an operation and leaves it pending ─────────────────────────
    let target = fx.consensus_receipt_hex().to_string();
    // releaseReceipt(bytes32 0x..01): the call is scheduled, never executed.
    let calldata = Command::new("cast")
        .args([
            "calldata",
            "releaseReceipt(bytes32)",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        ])
        .output()
        .expect("spawn cast calldata");
    assert!(calldata.status.success(), "cast calldata failed");
    let data = String::from_utf8_lossy(&calldata.stdout).trim().to_string();
    let salt = "0x1647000000000000000000000000000000000000000000000000000000000001";
    fx.published()
        .schedule_pending_op(&safe, &timelock, &target, &data, salt)
        .expect("the real 2-of-3 Safe schedules the operation through the timelock");
    let op_id = cast(
        &rpc,
        &[
            "call",
            &timelock,
            "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)",
            &target,
            "0",
            &data,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            salt,
        ],
    );
    assert_eq!(
        cast(
            &rpc,
            &[
                "call",
                &timelock,
                "isOperationPending(bytes32)(bool)",
                &op_id
            ]
        ),
        "true",
        "the Safe-scheduled operation must be pending on chain"
    );
    let ready_at: u64 = cast(
        &rpc,
        &["call", &timelock, "getTimestamp(bytes32)(uint256)", &op_id],
    )
    .split_whitespace()
    .next()
    .unwrap()
    .parse()
    .expect("getTimestamp is a number");

    let v = run_get_timelock(&cfg);
    eprintln!("[get_timelock_integration] rmpc output with a pending op:\n{v:#}");
    let ops = v["data"]["pending_ops"].as_array().unwrap();
    assert_eq!(ops.len(), 1, "exactly one pending op expected: {v}");
    assert_eq!(
        ops[0]["operation_id"]
            .as_str()
            .unwrap()
            .to_ascii_lowercase(),
        op_id.to_ascii_lowercase(),
        "pending op id must be the operation the Safe scheduled"
    );
    assert_eq!(
        ops[0]["ready_timestamp"].as_u64().unwrap(),
        ready_at,
        "pending op ready_timestamp must equal getTimestamp(id)"
    );
    assert_eq!(
        addr_list(&v["data"]["proposers"]),
        vec![safe_lc],
        "the proposer is still the real Safe"
    );
    eprintln!("\n[get_timelock_integration] all assertions passed");
}
