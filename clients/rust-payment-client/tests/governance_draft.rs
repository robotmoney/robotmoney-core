//! Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3.4
//! Canonical: docs/technical/router-governance-handoff-runbook.md
//! Implements: issue #1248 — (fusion) governance handoff; round-2 review tasks T01, T07.
//!
//! Integration tests for `rmpc governance draft-proposal`, driven end to end
//! through the real binary against a mock chain and a mock payload host.
//!
//! # What these tests are FOR
//!
//! `draft-proposal` is the one command that turns a consensus receipt's
//! `weights` vector into `RouterGovernance.propose` calldata. Before T01 it
//! verified **nothing cryptographic**: its only identity check was
//! `receipt_id`, which is `keccak256(sep + session_id + "\n" + subject_id)`.
//! `weights` is outside that preimage and the analyst signatures cover each
//! member's own `canonical_submission`, never the aggregate — so a
//! weights-only edit of the published receipt produced an identical
//! `receipt_id`, every signature still `verified:true`, `status`
//! `"ready_for_review"`, and calldata sending 100% of the treasury wherever
//! the editor chose. The human reviewer AC-GOV-01 relies on was being handed a
//! document core had already labelled ready.
//!
//! The subject under test is therefore the **binding**: the fetched bytes must
//! canonicalize to the `payloadDigest` anchored beside the receipt, and they
//! must have been fetched from the anchored `payloadUri`.
//!
//! The receipt used is the REAL one from run `20260913T-run1` — session
//! `a31ecf60-bb8f-44c0-8b69-23d3e9c2562f`, anchored and released on devnet
//! 918453 — served in the publisher's envelope form exactly as
//! `stage.robotmoney-labs.dev` serves it. A synthetic fixture would not have
//! caught the envelope path.
//!
//! T07's half is here too: a *content* refusal in scan mode is absorbed into
//! the range result (`ok:true`, one `"refused"` draft) so a watcher's cursor
//! can pass a poison receipt, while a *transport* refusal exits non-zero so
//! the same watcher HOLDS the range instead of silently skipping receipts it
//! never examined.

mod common;

use crate::common::{jrpc_result, match_eth_call_selector, selector_hex_of};
use alloy_primitives::{hex as ahex, Address, B256, U256};
use alloy_sol_types::SolValue;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::consensus_receipt::{payload_digest, ConsensusReceipt};
use rust_payment_client::gateway::{
    ConsensusRecommendationReceipt, PortfolioRouter, RouterGovernance,
};
use serde_json::json;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const CHAIN_ID: u64 = 918_453;
const RECEIPT_ADDRESS: &str = "0x00000000000000000000000000000000000000bb";
const ROUTER_ADDRESS: &str = "0x00000000000000000000000000000000000000cc";
const GOVERNANCE_ADDRESS: &str = "0x00000000000000000000000000000000000000dd";
/// Where the mock payload host serves the receipt — this is what gets anchored
/// as `payloadUri`, and therefore the only URL a draft may be built from.
const PAYLOAD_PATH: &str =
    "/api/swarm/sessions/a31ecf60-bb8f-44c0-8b69-23d3e9c2562f/consensus-receipt";

// ─── Fixtures ────────────────────────────────────────────────────────────────

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut cur: &Path = &manifest;
    loop {
        if cur.join("plugins").is_dir() && cur.join("clients").is_dir() {
            return cur.to_path_buf();
        }
        cur = cur.parent().expect("walked past filesystem root");
    }
}

/// The real run-1 receipt, in the publisher's envelope form. A MISSING FIXTURE
/// PANICS: it is the subject under test, so its absence must be red.
fn run1_envelope() -> serde_json::Value {
    let path = repo_root().join("tests/fixtures/consensus-receipt.run1-anchored.json");
    let raw = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "read {} — the real anchored run-1 receipt is the subject under test: {e}",
            path.display()
        )
    });
    serde_json::from_slice(&raw).expect("run-1 fixture is valid JSON")
}

/// `(receipt_id, payload_digest)` derived from a served body exactly as the
/// submit path derives them. Never transcribed as a constant: a constant that
/// can only agree with itself proves nothing about the canonicalization.
fn derive(body: &str) -> (B256, B256) {
    let receipt = ConsensusReceipt::from_json_slice(body.as_bytes()).expect("parses");
    let canonical = receipt.canonical_bytes().expect("canonicalizes");
    (receipt.receipt_id(), payload_digest(&canonical))
}

/// The run-1 receipt with its `weights` rewritten to put 100% in one bucket —
/// the exact tamper reproduced against the shipped binary, which it drafted.
/// `receipt_id` is unchanged by construction: `weights` is not in its preimage.
/// Re-seal an edited envelope: recompute the publisher's own `canonicalBytes`
/// so the envelope is internally consistent. A tamperer who edits the receipt
/// and forgets this is already caught by `ErrReceiptCanonicalBytesMismatch`
/// (T03); the interesting adversary is the one who does not forget, and for
/// that one the anchored `payloadDigest` is the only remaining defence.
fn reseal(env: &mut serde_json::Value) {
    let bare = serde_json::to_vec(&env["receipt"]).expect("serializes");
    let canonical = ConsensusReceipt::from_json_slice(&bare)
        .expect("edited receipt still parses")
        .canonical_bytes()
        .expect("edited receipt still canonicalizes");
    env["canonicalBytes"] = json!(String::from_utf8(canonical).expect("canonical bytes are utf-8"));
}

fn weights_tampered_body() -> String {
    let mut env = run1_envelope();
    env["receipt"]["weights"] = json!([
        {"bucket": "agent_tokens", "weight_bps": 10000},
        {"bucket": "conservative_defi_yield", "weight_bps": 0},
        {"bucket": "protocol_tokens", "weight_bps": 0},
        {"bucket": "real_world_assets", "weight_bps": 0},
    ]);
    reseal(&mut env);
    serde_json::to_string(&env).expect("serializes")
}

/// The run-1 receipt with one analyst's signature corrupted in a way that
/// still base64-decodes to 64 bytes, so it fails at `verify_strict` rather
/// than at parsing.
fn signature_corrupted_body() -> String {
    let mut env = run1_envelope();
    let sig = env["receipt"]["analyst_signatures"][0]["signature"]
        .as_str()
        .expect("signature is a string")
        .to_string();
    // Flip one base64 symbol; length (and therefore the decoded 64 bytes) is
    // preserved, so the failure is cryptographic, not structural.
    let mut chars: Vec<char> = sig.chars().collect();
    chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
    env["receipt"]["analyst_signatures"][0]["signature"] =
        json!(chars.into_iter().collect::<String>());
    reseal(&mut env);
    serde_json::to_string(&env).expect("serializes")
}

fn untampered_body() -> String {
    serde_json::to_string(&run1_envelope()).expect("serializes")
}

// ─── Chain mocks ─────────────────────────────────────────────────────────────

/// ABI-encode the `Receipt` tuple `getReceiptById` returns.
fn anchored_tuple(receipt_id: B256, digest: B256, uri: &str, released: bool) -> String {
    let encoded = (
        receipt_id,
        digest,
        uri.to_string(),
        Address::ZERO,
        1_757_000_000u64,
        if released { 1_757_000_001u64 } else { 0u64 },
        released,
    )
        .abi_encode_params();
    // `getReceiptById` returns ONE dynamic tuple, so the return data is a
    // 32-byte offset to the tuple followed by the tuple's own head/tail
    // encoding — not the bare parameter encoding.
    let mut out = vec![0u8; 32];
    out[31] = 0x20;
    out.extend_from_slice(&encoded);
    format!("0x{}", ahex::encode(out))
}

struct DraftFixture {
    _tmp: TempDir,
    config_path: PathBuf,
}

impl DraftFixture {
    fn build(rpc_url: &str) -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let config_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = {CHAIN_ID}
rpc_url               = "{rpc_url}"
gateway_address       = "0x0000000000000000000000000000000000000b00"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
receipt_address       = "{RECEIPT_ADDRESS}"
router_address        = "{ROUTER_ADDRESS}"
governance_address    = "{GOVERNANCE_ADDRESS}"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"

[vault_addresses]
rmUSDC  = "0x0000000000000000000000000000000000000001"
rmPROTO = "0x0000000000000000000000000000000000000002"
rmAGENT = "0x0000000000000000000000000000000000000003"
rmRWA   = "0x0000000000000000000000000000000000000004"
"#,
            zeros = "0".repeat(64),
            ks = tmp.path().join("keystore.json").display(),
        );
        std::fs::write(&config_path, toml).expect("write rmpc.toml");
        Self {
            _tmp: tmp,
            config_path,
        }
    }
}

/// Wire every chain read a draft makes: the anchored tuple, vault eligibility,
/// the (absent) active proposal, and the pinned block.
async fn install_chain_mocks(
    server: &mut mockito::ServerGuard,
    receipt_id: B256,
    anchored_digest: B256,
    anchored_uri: &str,
    released: bool,
) {
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            ConsensusRecommendationReceipt::getReceiptByIdCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result_raw_hex(&anchored_tuple(
            receipt_id,
            anchored_digest,
            anchored_uri,
            released,
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::isRouterEligibleAndActiveCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_word(U256::from(1))))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RouterGovernance::currentProposalIdCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_word(U256::ZERO)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result("0x100"))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{CHAIN_ID:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
}

fn enc_word(v: U256) -> String {
    format!("0x{}", ahex::encode(v.to_be_bytes::<32>()))
}

fn jrpc_result_raw_hex(hex: &str) -> String {
    jrpc_result(hex)
}

fn rmpc() -> Command {
    let mut c = Command::cargo_bin("rmpc").expect("rmpc binary built");
    // A startup refusal is reported through the log, not the JSON envelope, so
    // an assertion that fails here must be able to say WHY without a rerun.
    c.env("RMPC_LOG_LEVEL", "debug");
    c
}

fn stdout_json(out: &[u8]) -> serde_json::Value {
    let s = String::from_utf8_lossy(out);
    let line = s
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or_else(|| panic!("no JSON object on stdout:\n{s}"));
    serde_json::from_str(line).expect("stdout line is JSON")
}

// ─── T01 ─────────────────────────────────────────────────────────────────────

/// THE REGRESSION. A weights-only tamper of the real anchored run-1 receipt
/// must be refused with `ErrReceiptDigestMismatch` and must never reach
/// `ready_for_review` or emit calldata.
#[tokio::test]
async fn a_weights_only_tamper_is_refused_and_never_drafted() {
    let mut server = mockito::Server::new_async().await;
    let good = untampered_body();
    let (receipt_id, anchored_digest) = derive(&good);
    let tampered = weights_tampered_body();
    let (tampered_id, tampered_digest) = derive(&tampered);

    // The premise of the whole finding: the tamper is invisible to receipt_id.
    assert_eq!(
        tampered_id, receipt_id,
        "weights are outside the receipt_id preimage — if this ever fails, the \
         finding this test exists for has changed shape"
    );
    assert_ne!(
        tampered_digest, anchored_digest,
        "the tamper must move the digest"
    );

    let uri = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, anchored_digest, &uri, true).await;
    // The URL serves the TAMPERED bytes while the chain still commits to the
    // honest digest — the publisher-compromise case, exactly.
    server
        .mock("GET", PAYLOAD_PATH)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(&tampered)
        .expect_at_least(1)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--receipt-id",
            &format!("{receipt_id:#x}"),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(out.status.code(), Some(2), "a refusal exits EXIT_REFUSAL");
    let v = stdout_json(&out.stdout);
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrReceiptDigestMismatch");
    let all = String::from_utf8_lossy(&out.stdout);
    assert!(
        !all.contains("ready_for_review"),
        "a tampered receipt must never be labelled ready for a human reviewer: {all}"
    );
    assert!(
        !all.contains("propose_calldata"),
        "a tampered receipt must never produce treasury calldata: {all}"
    );
}

/// The positive control. Without it, the test above passes for a binary that
/// refuses everything.
#[tokio::test]
async fn the_untampered_run1_receipt_still_drafts() {
    let mut server = mockito::Server::new_async().await;
    let good = untampered_body();
    let (receipt_id, digest) = derive(&good);
    let uri = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, digest, &uri, true).await;
    server
        .mock("GET", PAYLOAD_PATH)
        .with_status(200)
        .with_body(&good)
        .expect_at_least(1)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--receipt-id",
            &format!("{receipt_id:#x}"),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(
        out.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let v = stdout_json(&out.stdout);
    assert_eq!(v["ok"], true);
    assert_eq!(v["drafts"][0]["status"], "ready_for_review");
    assert_eq!(
        v["drafts"][0]["payload_digest"],
        format!("{digest:#x}"),
        "the draft records the digest it proved equal to the anchored one"
    );
    assert_eq!(
        v["drafts"][0]["payload_uri"], uri,
        "the draft records the anchored URI it was built from"
    );
    assert!(v["drafts"][0]["propose_calldata"]
        .as_str()
        .expect("calldata")
        .starts_with("0x"));
}

/// A corrupted analyst signature is refused even when the digest agrees —
/// which is the case that proves the signature check is not subsumed by the
/// digest comparison. (The digest anchored here is the CORRUPTED bytes' own,
/// so step 4 passes and only step 5 can reject.)
#[tokio::test]
async fn a_corrupted_analyst_signature_is_refused() {
    let mut server = mockito::Server::new_async().await;
    let body = signature_corrupted_body();
    let (receipt_id, digest) = derive(&body);
    let uri = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, digest, &uri, true).await;
    server
        .mock("GET", PAYLOAD_PATH)
        .with_status(200)
        .with_body(&body)
        .expect_at_least(1)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--receipt-id",
            &format!("{receipt_id:#x}"),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(out.status.code(), Some(2));
    let v = stdout_json(&out.stdout);
    assert_eq!(v["error"], "ErrReceiptSignatureInvalid");
}

/// The draft is built from the URL the receipt commits to on chain, not from
/// whatever the operator templated. A second URL serving perfectly valid bytes
/// is still refused.
#[tokio::test]
async fn a_url_that_is_not_the_anchored_payload_uri_is_refused() {
    let mut server = mockito::Server::new_async().await;
    let good = untampered_body();
    let (receipt_id, digest) = derive(&good);
    let anchored = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, digest, &anchored, true).await;
    server
        .mock("GET", Matcher::Any)
        .with_status(200)
        .with_body(&good)
        .expect_at_least(0)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--receipt-id",
            &format!("{receipt_id:#x}"),
            "--receipt-url",
            &format!("{}/somewhere-else.json", server.url()),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(out.status.code(), Some(2));
    let v = stdout_json(&out.stdout);
    assert_eq!(v["error"], "ErrReceiptUriMismatch");
}

/// A receipt that was never released is refused before anything is fetched.
#[tokio::test]
async fn an_unreleased_receipt_is_refused() {
    let mut server = mockito::Server::new_async().await;
    let good = untampered_body();
    let (receipt_id, digest) = derive(&good);
    let uri = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, digest, &uri, false).await;
    let payload = server
        .mock("GET", PAYLOAD_PATH)
        .with_status(200)
        .with_body(&good)
        .expect(0)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--receipt-id",
            &format!("{receipt_id:#x}"),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(out.status.code(), Some(2));
    assert_eq!(stdout_json(&out.stdout)["error"], "ErrReceiptNotReleased");
    payload.assert_async().await;
}

// ─── T07: content is absorbed, transport holds the range ─────────────────────

/// Register the `eth_getLogs` mock that makes scan mode find exactly one
/// released receipt.
async fn install_logs_mock(server: &mut mockito::ServerGuard, receipt_id: B256) {
    let topic0 = format!(
        "0x{}",
        ahex::encode(
            <ConsensusRecommendationReceipt::ReceiptReleased as alloy_sol_types::SolEvent>::SIGNATURE_HASH
        )
    );
    let log = json!([{
        "address": RECEIPT_ADDRESS,
        "topics": [topic0, format!("{receipt_id:#x}")],
        "data": "0x",
        "blockNumber": "0x10",
        "transactionHash": format!("0x{}", "11".repeat(32)),
        "transactionIndex": "0x0",
        "blockHash": format!("0x{}", "22".repeat(32)),
        "logIndex": "0x0",
        "removed": false,
    }]);
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(format!(r#"{{"jsonrpc":"2.0","id":1,"result":{log}}}"#))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// A CONTENT refusal in scan mode is absorbed: the range succeeds, the poison
/// receipt is reported inside it, and a watcher may advance its cursor.
#[tokio::test]
async fn a_content_refusal_in_scan_mode_is_reported_inside_an_ok_range() {
    let mut server = mockito::Server::new_async().await;
    let good = untampered_body();
    let (receipt_id, anchored_digest) = derive(&good);
    let uri = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, anchored_digest, &uri, true).await;
    install_logs_mock(&mut server, receipt_id).await;
    server
        .mock("GET", PAYLOAD_PATH)
        .with_status(200)
        .with_body(weights_tampered_body())
        .expect_at_least(1)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--from-block",
            "0",
            "--to-block",
            "0x20",
            "--receipt-url-template",
            &format!("{}{PAYLOAD_PATH}", server.url()),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(
        out.status.code(),
        Some(0),
        "a content refusal must not fail the range: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v = stdout_json(&out.stdout);
    assert_eq!(v["ok"], true);
    assert_eq!(v["drafts"][0]["status"], "refused");
    assert_eq!(v["drafts"][0]["error"], "ErrReceiptDigestMismatch");
}

/// A TRANSPORT refusal in scan mode must NOT be absorbed. Before T07 a single
/// 404 or 503 produced `ok:true` with a `"refused"` entry, the watcher
/// advanced its cursor, and that release was never drafted again — from one
/// blip. The range must fail so the cursor is held.
#[tokio::test]
async fn an_unfetchable_payload_in_scan_mode_holds_the_range() {
    let mut server = mockito::Server::new_async().await;
    let good = untampered_body();
    let (receipt_id, anchored_digest) = derive(&good);
    let uri = format!("{}{PAYLOAD_PATH}", server.url());
    install_chain_mocks(&mut server, receipt_id, anchored_digest, &uri, true).await;
    install_logs_mock(&mut server, receipt_id).await;
    let payload = server
        .mock("GET", PAYLOAD_PATH)
        .with_status(404)
        .with_body("nope")
        .expect_at_least(2)
        .create_async()
        .await;

    let fx = DraftFixture::build(&server.url());
    let out = rmpc()
        .args([
            "governance",
            "-c",
            fx.config_path.to_str().unwrap(),
            "draft-proposal",
            "--from-block",
            "0",
            "--to-block",
            "0x20",
            "--receipt-url-template",
            &format!("{}{PAYLOAD_PATH}", server.url()),
        ])
        .output()
        .expect("run rmpc");

    assert_eq!(
        out.status.code(),
        Some(3),
        "a transport failure must exit the code the watcher holds its cursor on"
    );
    let all = String::from_utf8_lossy(&out.stdout);
    assert!(
        !all.contains("\"ok\":true"),
        "an unexamined range must never be reported as a successful one: {all}"
    );
    let v = stdout_json(&out.stdout);
    assert_eq!(v["error"], "ErrReceiptFetchFailed");
    // The bounded retry actually retried rather than giving up on one GET.
    payload.assert_async().await;
}
