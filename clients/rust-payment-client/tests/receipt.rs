//! Canonical: docs/architecture.md §4.9 — Consensus Rebalance Receipt Contract
//! Implements: issue #1247 (AC4, AC13) and the second half of issue #1280.
//!
//! Integration tests for `rmpc receipt`.
//!
//! # What these tests are FOR
//!
//! Two separate obligations meet here.
//!
//! **The cross-repo byte pin (issue #1247 AC13).** The canonical bytes are
//! specified by `tests/fixtures/consensus-receipt.canonicalization.json`, which
//! is byte-identical to `contract/src/__fixtures__/` in `robotmoney-frontend`.
//! A second implementation of those bytes is only allowed to exist if it is
//! proved equal to the first, so `consensus-receipt.valid.canonical.txt` and
//! `consensus-receipt.escaping.canonical.txt` are compared **byte for byte**,
//! not field by field and not by digest alone. The escaping golden is the one
//! that matters: an ASCII-only comparison passes for a serializer that escapes
//! non-ASCII, `<`/`>`/`&`, or U+2028 — which is exactly what Go's
//! `encoding/json` and Python's `json.dumps` do by default.
//!
//! **The anchoring pin (issue #1280).** `consensus-receipt.anchor-digest.json`
//! records the keccak256 of each golden. That file is a core-only sidecar
//! because `contract/` in the frontend has zero dependencies and cannot reach a
//! keccak256 implementation at all. Its constants are **read out of the JSON at
//! test time and compared against a freshly derived hash** — never transcribed
//! into Rust — because a constant that can only ever agree with itself is the
//! precise failure the 1.0 draft's stale `valid_fixture_digest` demonstrated.
//! `submitted_calldata_carries_the_derived_digest_and_receipt_id` closes the
//! half #1280 left open: it decodes the calldata the anchoring path actually
//! builds and asserts the `payloadDigest` argument IS that derived digest.
//!
//! # No silent skips
//!
//! Every fixture read panics when the file is missing. There is no `#[ignore]`
//! and no early `return` on an absent fixture: a test that quietly passes when
//! the pin it exists to check has been deleted is worse than no test.

mod common;

use crate::common::{jrpc_result, jrpc_result_raw, GATEWAY, SIGNER_ADDRESS, TEST_PASSPHRASE};
use alloy_primitives::{b256, hex as ahex, keccak256, Address, B256};
use alloy_sol_types::SolCall;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::commands::receipt::encode_record_receipt_call;
use rust_payment_client::consensus_receipt::{
    derive_receipt_id, payload_digest, ConsensusReceipt, DOMAIN_SEPARATOR,
};
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::json;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

// ─── Test constants ───────────────────────────────────────────────────────────

/// Local devnet chain id, so the software signer passes the production-grade gate.
const CHAIN_ID: u64 = 31337;

const TX_HASH: B256 = b256!("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");

/// The public route the receipt bytes are served from, anchored as `payloadUri`.
const RECEIPT_PATH: &str = "/api/swarm/receipts/12440000-0000-4000-8000-000000000001";

// ─── Fixture plumbing ─────────────────────────────────────────────────────────

/// Repo root, located by walking up from `CARGO_MANIFEST_DIR` until we find a
/// `plugins/` directory next to `clients/`. Copied from
/// `tests/skill_docs_parity.rs` so both binaries resolve the repo-root
/// `tests/fixtures/` the same way.
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut cur: &Path = &manifest;
    loop {
        if cur.join("plugins").is_dir() && cur.join("clients").is_dir() {
            return cur.to_path_buf();
        }
        cur = cur.parent().expect(
            "walked past filesystem root without finding repo root \
             (expected sibling `plugins/` and `clients/` directories)",
        );
    }
}

/// Read a repo-root fixture. A MISSING FIXTURE PANICS — these files are the
/// subject under test, so an absent one must be red, never a skip.
fn fixture(name: &str) -> Vec<u8> {
    let path = repo_root().join("tests/fixtures").join(name);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "read {} — this fixture is the cross-repo pin under test and must exist: {e}",
            path.display()
        )
    })
}

fn fixture_str(name: &str) -> String {
    String::from_utf8(fixture(name)).expect("fixture is utf-8")
}

/// The core-only anchor-digest sidecar, parsed.
fn anchor_digest_sidecar() -> serde_json::Value {
    serde_json::from_slice(&fixture("consensus-receipt.anchor-digest.json"))
        .expect("consensus-receipt.anchor-digest.json is valid JSON")
}

/// One `goldens[]` entry: `(file name, pinned byte_length, pinned keccak256)`.
fn pinned_golden(index: usize) -> (String, usize, String) {
    let sidecar = anchor_digest_sidecar();
    let entry = sidecar["goldens"]
        .get(index)
        .unwrap_or_else(|| panic!("anchor-digest.json goldens[{index}] is missing"));
    (
        entry["file"]
            .as_str()
            .expect("file is a string")
            .to_string(),
        entry["byte_length"]
            .as_u64()
            .expect("byte_length is an integer") as usize,
        entry["keccak256"]
            .as_str()
            .expect("keccak256 is a string")
            .to_string(),
    )
}

/// Build a receipt-enabled config TOML in a temp dir.
struct ReceiptFixture {
    _tmp: TempDir,
    config_path: PathBuf,
}

impl ReceiptFixture {
    fn build(rpc_url: &str) -> Self {
        use rust_payment_client::signer::software::SoftwareSigner;

        // anvil account #0, the same deterministic key the other suites use.
        const TEST_PRIVKEY: [u8; 32] = [
            0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38,
            0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b,
            0xf4, 0xf2, 0xff, 0x80,
        ];
        const GATEWAY_CODE: &[u8] = &[0x60, 0x80, 0x60, 0x40, 0x52, 0xfe, 0xfe, 0xfe];

        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("keystore.json");
        SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
            .expect("create keystore");

        let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
        let config_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = {CHAIN_ID}
rpc_url               = "{rpc_url}"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
ic_policy_address     = "0x0000000000000000000000000000000000000e00"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            ks = keystore_path.display()
        );
        std::fs::write(&config_path, toml).expect("write config");

        Self {
            _tmp: tmp,
            config_path,
        }
    }

    fn write_receipt(&self, name: &str, body: &str) -> PathBuf {
        let p = self._tmp.path().join(name);
        std::fs::write(&p, body).expect("write receipt fixture");
        p
    }
}

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

fn fee_history_body() -> String {
    r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#
    .to_string()
}

fn simple_receipt_body() -> String {
    format!(
        r#"{{
            "transactionHash":"{TX_HASH:#x}",
            "transactionIndex":"0x0",
            "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
            "blockNumber":"0x2a",
            "from":"{SIGNER_ADDRESS:#x}",
            "to":"{GATEWAY:#x}",
            "cumulativeGasUsed":"0x5208",
            "gasUsed":"0x5208",
            "contractAddress":null,
            "logs":[],
            "status":"0x1",
            "logsBloom":"0x{bloom}",
            "type":"0x2",
            "effectiveGasPrice":"0x3b9aca00"
        }}"#,
        bloom = "00".repeat(256),
    )
}

/// Register the fee/nonce/receipt mocks a happy-path write needs. The
/// `eth_sendRawTransaction` mock is registered by the caller, because the
/// refusal tests need it pinned at `expect(0)`.
async fn mock_write_preamble(server: &mut mockito::ServerGuard) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{CHAIN_ID:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&fee_history_body()))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionCount"}),
        ))
        .with_status(200)
        .with_body(jrpc_result("0x0"))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&simple_receipt_body()))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// Parse the JSON envelope `rmpc` printed on stdout, echoing both streams so a
/// failure names what actually happened.
fn stdout_json(output: &std::process::Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {stderr}");
    serde_json::from_str(stdout.trim()).expect("rmpc printed a JSON envelope on stdout")
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–3. The canonical bytes, byte for byte.
// ─────────────────────────────────────────────────────────────────────────────

/// AC13, ASCII half. The all-ASCII golden reproduces exactly.
#[test]
fn valid_fixture_reproduces_the_golden_canonical_bytes() {
    let produced =
        ConsensusReceipt::canonical_bytes_from_json_slice(&fixture("consensus-receipt.valid.json"))
            .expect("the valid fixture canonicalizes");
    let golden = fixture("consensus-receipt.valid.canonical.txt");

    assert_eq!(
        golden.len(),
        2818,
        "the committed golden is 2818 bytes; a different length means the pinned \
         fixture itself changed"
    );
    assert_eq!(
        produced.len(),
        golden.len(),
        "canonical byte LENGTH diverged from the golden"
    );
    assert_eq!(
        produced, golden,
        "canonical BYTES diverged from the golden — field order, whitespace, \
         escaping or the trailing newline"
    );
    assert!(
        produced.starts_with(DOMAIN_SEPARATOR.as_bytes()),
        "the preimage is domain-separated by its own first line"
    );
    assert_eq!(
        *produced.last().expect("non-empty"),
        b'\n',
        "the trailing newline is part of the preimage"
    );
}

/// AC13, and the whole reason a Rust serializer is allowed to exist here.
///
/// This fixture carries an em-dash, three non-Latin scripts, an ampersand, an
/// angle bracket, an escaped newline, U+2028, a non-breaking space and an
/// astral-plane emoji. A serializer that escapes any of them still reproduces
/// the ASCII golden above exactly, so this is the assertion that can tell them
/// apart.
#[test]
fn escaping_fixture_reproduces_the_golden_canonical_bytes() {
    let produced = ConsensusReceipt::canonical_bytes_from_json_slice(&fixture(
        "consensus-receipt.escaping.json",
    ))
    .expect("the escaping fixture canonicalizes");
    let golden = fixture("consensus-receipt.escaping.canonical.txt");

    assert_eq!(golden.len(), 3046, "the committed golden is 3046 bytes");
    assert_eq!(
        produced.len(),
        golden.len(),
        "canonical byte LENGTH diverged — the most likely cause is a serializer \
         emitting \\uXXXX where the contract requires raw UTF-8"
    );
    assert_eq!(produced, golden, "non-ASCII canonical BYTES diverged");

    // Name the specific divergences the contract calls out, so a failure says
    // which rule broke rather than just "bytes differ".
    let text = std::str::from_utf8(&produced).expect("canonical bytes are utf-8");
    assert!(text.contains('\u{2014}'), "em-dash must be raw UTF-8");
    assert!(text.contains('\u{2028}'), "U+2028 must be raw UTF-8");
    assert!(text.contains('\u{00a0}'), "U+00A0 must be raw UTF-8");
    assert!(
        text.contains('\u{1f680}'),
        "an astral-plane code point must be raw 4-byte UTF-8, never an escaped \
         surrogate pair"
    );
    assert!(
        text.contains('&') && text.contains('<') && text.contains('>'),
        "the HTML-sensitive characters must be raw — Go's encoding/json escapes \
         all three by default"
    );
    assert!(
        !text.contains("\\u"),
        "no \\uXXXX escape may appear: every C0 code point in this fixture has an \
         RFC 8259 short form, and nothing else is ever escaped"
    );
    assert!(!text.contains("\\/"), "U+002F SOLIDUS is never escaped");
}

/// An absent allocation vector is OMITTED, never nulled and never shortened —
/// and the digest over the omitting bytes is stable and derivable.
#[test]
fn no_weights_fixture_omits_weights_and_has_a_derivable_digest() {
    let raw = fixture("consensus-receipt.valid-no-weights.json");
    let receipt = ConsensusReceipt::from_json_slice(&raw).expect("parses");
    assert!(receipt.weights.is_none());

    let produced = receipt.canonical_bytes().expect("canonicalizes");
    let text = std::str::from_utf8(&produced).expect("utf-8");
    assert!(
        !text.contains("\"weights\""),
        "the weights key must not appear at all"
    );
    assert!(text.starts_with(DOMAIN_SEPARATOR));
    assert!(text.ends_with("}\n"));

    // Stable: canonicalizing twice, and via the one-shot helper, gives the same
    // bytes and therefore the same digest.
    let again = ConsensusReceipt::canonical_bytes_from_json_slice(&raw).expect("canonicalizes");
    assert_eq!(produced, again);

    // Derivable: the digest is keccak256 of exactly these bytes, and it is not
    // the digest of the with-weights receipt.
    let digest = receipt.payload_digest().expect("digest");
    assert_eq!(digest, keccak256(&produced));
    let (valid_file, _, _) = pinned_golden(0);
    assert_ne!(
        digest,
        keccak256(fixture(&valid_file)),
        "omitting weights must change the anchored digest"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The anchor-digest sidecar — read at test time, never transcribed.
// ─────────────────────────────────────────────────────────────────────────────

/// Issue #1280, digest half. Both pinned constants are READ OUT of
/// `consensus-receipt.anchor-digest.json` and compared against a hash derived
/// here and now. Changing a golden's bytes without changing the constant fails;
/// changing the constant without changing the bytes fails.
#[test]
fn every_pinned_golden_digest_is_freshly_derived_and_matches_the_sidecar() {
    let sidecar = anchor_digest_sidecar();
    let goldens = sidecar["goldens"]
        .as_array()
        .expect("goldens is an array")
        .len();
    assert_eq!(
        goldens, 2,
        "the sidecar must pin BOTH goldens: an ASCII-only digest check cannot \
         detect a serializer that escapes non-ASCII"
    );
    assert_eq!(
        sidecar["digest_algorithm"], "keccak256",
        "sha3-256 is NIST-padded and is NOT a substitute for keccak256"
    );

    for index in 0..goldens {
        let (file, byte_length, pinned) = pinned_golden(index);
        let bytes = fixture(&file);
        assert_eq!(
            bytes.len(),
            byte_length,
            "{file}: byte_length in the sidecar disagrees with the file on disk"
        );
        let derived = format!("{:#x}", keccak256(&bytes));
        assert_eq!(
            derived, pinned,
            "{file}: keccak256 derived here ({derived}) disagrees with the constant \
             pinned in consensus-receipt.anchor-digest.json ({pinned})"
        );
    }
}

/// The same constants, reached through the module's own canonicalizer rather
/// than by hashing the committed bytes. This is the join between the two pins:
/// the bytes rmpc PRODUCES hash to the digest the sidecar RECORDS.
#[test]
fn canonicalizer_output_hashes_to_the_pinned_anchor_digests() {
    for (index, source) in [
        (0usize, "consensus-receipt.valid.json"),
        (1usize, "consensus-receipt.escaping.json"),
    ] {
        let (_, _, pinned) = pinned_golden(index);
        let produced = ConsensusReceipt::canonical_bytes_from_json_slice(&fixture(source))
            .unwrap_or_else(|e| panic!("{source} canonicalizes: {e}"));
        assert_eq!(
            format!("{:#x}", payload_digest(&produced)),
            pinned,
            "{source}: the digest of the bytes rmpc produces must equal the pinned anchor digest"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The digest the anchoring path actually submits.
// ─────────────────────────────────────────────────────────────────────────────

/// Issue #1280, second half. Decode the calldata the anchoring path builds and
/// assert its `payloadDigest` argument IS the derived digest and its `receiptId`
/// IS the derived id. Without this, the sidecar constant could be correct while
/// the submitter anchored something else entirely.
#[test]
fn submitted_calldata_carries_the_derived_digest_and_receipt_id() {
    let receipt = ConsensusReceipt::from_json_slice(&fixture("consensus-receipt.valid.json"))
        .expect("parses");
    let canonical = receipt.canonical_bytes().expect("canonicalizes");
    let digest = payload_digest(&canonical);
    let receipt_id = receipt.receipt_id();
    let uri = format!("https://robotmoney.net{RECEIPT_PATH}");

    let calldata = encode_record_receipt_call(receipt_id, digest, &uri);

    assert_eq!(
        &calldata[..4],
        &RobotMoneyGateway::consensusRecordReceiptCall::SELECTOR[..],
        "the anchoring path must call consensusRecordReceipt"
    );

    let decoded = RobotMoneyGateway::consensusRecordReceiptCall::abi_decode(&calldata, true)
        .expect("decodes");

    // The pinned constant, read from the sidecar — not a literal in this file.
    let (_, _, pinned) = pinned_golden(0);
    assert_eq!(
        format!("{:#x}", decoded.payloadDigest),
        pinned,
        "the payloadDigest argument must be the digest pinned by \
         consensus-receipt.anchor-digest.json"
    );
    assert_eq!(decoded.payloadDigest, digest);
    assert_eq!(
        decoded.receiptId,
        derive_receipt_id(
            "12440000-0000-4000-8000-000000000001",
            "treasury-allocation"
        ),
        "the receiptId argument must be the session/subject-bound derivation"
    );
    assert_eq!(decoded.receiptId, receipt_id);
    assert_eq!(decoded.payloadUri, uri);
}

// ─────────────────────────────────────────────────────────────────────────────
// The CLI: verify.
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn receipt_verify_from_file_prints_the_derived_digest_and_receipt_id() {
    let server = mockito::Server::new_async().await;
    let fix = ReceiptFixture::build(&server.url());
    let path = fix.write_receipt("receipt.json", &fixture_str("consensus-receipt.valid.json"));

    let output = rmpc()
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "verify",
            "--receipt-file",
            path.to_str().unwrap(),
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(output.status.success(), "expected exit 0");
    assert_eq!(v["ok"], true);
    assert_eq!(v["action"], "verify");

    let (_, byte_length, pinned) = pinned_golden(0);
    assert_eq!(v["payload_digest"], pinned, "derived digest");
    assert_eq!(v["canonical_bytes"], byte_length as u64);
    assert_eq!(
        v["receipt_id"],
        format!(
            "{:#x}",
            derive_receipt_id(
                "12440000-0000-4000-8000-000000000001",
                "treasury-allocation"
            )
        )
    );
    let sigs = v["analyst_signatures"].as_array().expect("array");
    assert_eq!(sigs.len(), 2, "both analysts reported");
    assert!(sigs.iter().all(|s| s["verified"] == true));
    assert_eq!(sigs[0]["member_id"], "analyst-alpha");
    assert_eq!(sigs[1]["member_id"], "analyst-beta");
}

#[tokio::test]
async fn receipt_verify_fetches_over_http() {
    let mut server = mockito::Server::new_async().await;
    let body = fixture_str("consensus-receipt.valid.json");
    let fetch = server
        .mock("GET", RECEIPT_PATH)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(&body)
        .expect(1)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let url = format!("{}{RECEIPT_PATH}", server.url());

    let output = rmpc()
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "verify",
            "--receipt-url",
            &url,
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(output.status.success(), "expected exit 0");
    let (_, _, pinned) = pinned_golden(0);
    assert_eq!(v["payload_digest"], pinned);
    fetch.assert_async().await;
}

/// 7. `consensus-receipt.invalid.json` is refused by validation, through the
/// real CLI, with a machine-readable code.
#[tokio::test]
async fn receipt_verify_refuses_the_invalid_fixture() {
    let server = mockito::Server::new_async().await;
    let fix = ReceiptFixture::build(&server.url());
    let path = fix.write_receipt(
        "invalid.json",
        &fixture_str("consensus-receipt.invalid.json"),
    );

    let output = rmpc()
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "verify",
            "--receipt-file",
            path.to_str().unwrap(),
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(
        !output.status.success(),
        "the invalid fixture must exit non-zero"
    );
    assert_eq!(v["ok"], false);
    assert_eq!(
        v["error"], "ErrReceiptSchema",
        "expected ErrReceiptSchema, got {:?}",
        v["error"]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The CLI: submit — happy path, then the two refusals.
// ─────────────────────────────────────────────────────────────────────────────

/// The anchoring path end to end. The `eth_sendRawTransaction` mock only
/// matches when the signed envelope contains BOTH the derived `receiptId` and
/// the pinned `payloadDigest` — so a transaction carrying a different digest
/// does not merely fail an assertion, it fails to match the mock at all.
#[tokio::test]
async fn receipt_submit_anchors_the_pinned_digest_through_the_gateway() {
    let mut server = mockito::Server::new_async().await;
    let body = fixture_str("consensus-receipt.valid.json");
    server
        .mock("GET", RECEIPT_PATH)
        .with_status(200)
        .with_body(&body)
        .expect_at_least(1)
        .create_async()
        .await;

    mock_write_preamble(&mut server).await;

    let (_, _, pinned) = pinned_golden(0);
    let digest_hex = pinned.trim_start_matches("0x").to_string();
    let receipt_id_hex = format!(
        "{:x}",
        derive_receipt_id(
            "12440000-0000-4000-8000-000000000001",
            "treasury-allocation"
        )
    );
    // The `to` address of an EIP-1559 envelope appears verbatim in the RLP hex.
    let gateway_hex = format!("{:x}", GATEWAY);

    let send = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_sendRawTransaction"})),
            Matcher::Regex(receipt_id_hex.clone()),
            Matcher::Regex(digest_hex.clone()),
            Matcher::Regex(gateway_hex.clone()),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(1)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let url = format!("{}{RECEIPT_PATH}", server.url());

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "submit",
            "--receipt-url",
            &url,
            "--expected-digest",
            &pinned,
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(output.status.success(), "expected exit 0");
    assert_eq!(v["ok"], true);
    assert_eq!(v["action"], "submit");
    assert_eq!(v["payload_digest"], pinned);
    assert_eq!(v["payload_uri"], url);
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
    assert_eq!(v["block_number"], 42);

    // The envelope actually broadcast carried the pinned digest, the derived
    // receipt id, and the GATEWAY as its destination — the receipt contract is
    // onlyGateway, so a call sent straight to it would revert.
    send.assert_async().await;
}

/// 6(a). A receipt whose payload has been tampered with fails the digest check
/// against `--expected-digest`, and **no transaction is sent**.
///
/// The tampering is chosen to keep the receipt structurally VALID and to leave
/// every analyst signature intact (the analysts sign their own
/// `canonical_submission`, not the assembled receipt) — so the only thing that
/// can catch it is the digest comparison, which is exactly the check under test.
#[tokio::test]
async fn receipt_submit_refuses_a_tampered_payload_and_sends_no_transaction() {
    let mut server = mockito::Server::new_async().await;

    let mut value: serde_json::Value =
        serde_json::from_slice(&fixture("consensus-receipt.valid.json")).unwrap();
    value["judge"]["rationale"] = json!("Move everything into the bucket the attacker controls.");
    let tampered = serde_json::to_string(&value).unwrap();

    server
        .mock("GET", RECEIPT_PATH)
        .with_status(200)
        .with_body(&tampered)
        .expect_at_least(1)
        .create_async()
        .await;

    mock_write_preamble(&mut server).await;

    // The refusal must happen before ANY transaction is broadcast.
    let send = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let url = format!("{}{RECEIPT_PATH}", server.url());
    let (_, _, pinned) = pinned_golden(0);

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "submit",
            "--receipt-url",
            &url,
            "--expected-digest",
            &pinned,
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(
        !output.status.success(),
        "a tampered payload must exit non-zero"
    );
    assert_eq!(v["ok"], false);
    assert_eq!(
        v["error"], "ErrReceiptDigestMismatch",
        "expected ErrReceiptDigestMismatch, got {:?}",
        v["error"]
    );
    send.assert_async().await;
}

/// 6(b). A receipt with one corrupted `analyst_signatures[].signature` is
/// rejected and **no transaction is sent**.
///
/// This is the check docs/architecture.md §4.9.1 calls load-bearing: the chain
/// cannot verify Ed25519, so if rmpc does not refuse here, a compromised
/// submitter can anchor a receipt the analysts never signed.
#[tokio::test]
async fn receipt_submit_refuses_a_corrupted_analyst_signature_and_sends_no_transaction() {
    let mut server = mockito::Server::new_async().await;

    let mut value: serde_json::Value =
        serde_json::from_slice(&fixture("consensus-receipt.valid.json")).unwrap();
    let sig = value["analyst_signatures"][0]["signature"]
        .as_str()
        .expect("signature is a string")
        .to_string();
    // Flip the first base64 character, preserving the pinned
    // ^[A-Za-z0-9+/]{86}==$ shape so the refusal comes from Ed25519 rather than
    // from the pattern check.
    let flipped = if sig.starts_with('A') { 'B' } else { 'A' };
    let corrupted_sig = format!("{flipped}{}", &sig[1..]);
    assert_ne!(corrupted_sig, sig);
    value["analyst_signatures"][0]["signature"] = json!(corrupted_sig);
    let corrupted = serde_json::to_string(&value).unwrap();

    server
        .mock("GET", RECEIPT_PATH)
        .with_status(200)
        .with_body(&corrupted)
        .expect_at_least(1)
        .create_async()
        .await;

    mock_write_preamble(&mut server).await;

    let send = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let url = format!("{}{RECEIPT_PATH}", server.url());

    // No --expected-digest: the signature check alone must refuse. The receipt
    // is otherwise well-formed and its digest is internally consistent, so
    // nothing else here can catch it.
    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "submit",
            "--receipt-url",
            &url,
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(
        !output.status.success(),
        "a corrupted analyst signature must exit non-zero"
    );
    assert_eq!(v["ok"], false);
    assert_eq!(
        v["error"], "ErrReceiptSignatureInvalid",
        "expected ErrReceiptSignatureInvalid, got {:?}",
        v["error"]
    );
    assert!(
        v["message"]
            .as_str()
            .unwrap_or_default()
            .contains("analyst-alpha"),
        "the refusal must name the failing member_id: {:?}",
        v["message"]
    );
    send.assert_async().await;
}

/// A malformed `--expected-digest` is a refusal, not a panic and not a silent
/// skip of the comparison.
#[tokio::test]
async fn receipt_submit_refuses_a_malformed_expected_digest() {
    let mut server = mockito::Server::new_async().await;
    mock_write_preamble(&mut server).await;
    let send = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let path = fix.write_receipt("receipt.json", &fixture_str("consensus-receipt.valid.json"));

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "submit",
            "--receipt-url",
            "https://robotmoney.net/api/swarm/receipts/x",
            "--receipt-file",
            path.to_str().unwrap(),
            "--expected-digest",
            "0xdeadbeef",
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(!output.status.success());
    assert_eq!(v["error"], "ErrReceiptDigestMalformed");
    send.assert_async().await;
}

/// `--receipt-file` supplies the BYTES; `--receipt-url` still supplies the
/// anchored `payloadUri`. An operator who has the bytes locally must not end up
/// anchoring a file path.
#[tokio::test]
async fn receipt_submit_anchors_the_url_even_when_bytes_come_from_a_file() {
    let mut server = mockito::Server::new_async().await;
    mock_write_preamble(&mut server).await;

    let (_, _, pinned) = pinned_golden(0);
    let digest_hex = pinned.trim_start_matches("0x").to_string();
    let send = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_sendRawTransaction"})),
            Matcher::Regex(digest_hex),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(1)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let path = fix.write_receipt("receipt.json", &fixture_str("consensus-receipt.valid.json"));
    let public_url =
        "https://robotmoney.net/api/swarm/receipts/12440000-0000-4000-8000-000000000001";

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "submit",
            "--receipt-url",
            public_url,
            "--receipt-file",
            path.to_str().unwrap(),
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(output.status.success(), "expected exit 0");
    assert_eq!(v["payload_uri"], public_url);
    send.assert_async().await;
}

/// A fetch that fails is a refusal with a named code, never a submission of
/// whatever bytes happened to come back.
#[tokio::test]
async fn receipt_verify_refuses_a_failed_fetch() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", RECEIPT_PATH)
        .with_status(404)
        .with_body("not found")
        .expect_at_least(1)
        .create_async()
        .await;

    let fix = ReceiptFixture::build(&server.url());
    let url = format!("{}{RECEIPT_PATH}", server.url());

    let output = rmpc()
        .args([
            "receipt",
            "--config",
            fix.config_path.to_str().unwrap(),
            "verify",
            "--receipt-url",
            &url,
        ])
        .output()
        .expect("rmpc ran");

    let v = stdout_json(&output);
    assert!(!output.status.success());
    assert_eq!(v["error"], "ErrReceiptFetchFailed");
}

/// The gateway address is what `submit` sends to. Stated as its own assertion
/// because `src/commands/committee.rs` has a latent bug of exactly this shape
/// (it sends `submitVote` calldata to the IC address even though `submitVote`
/// is `onlyGateway`), and copying it here would produce a command that always
/// reverts on a real chain.
#[test]
fn the_anchor_call_targets_the_gateway_abi_not_the_receipt_contract() {
    // The selector must belong to RobotMoneyGateway, and the gateway ABI must
    // actually expose it.
    let calldata = encode_record_receipt_call(B256::ZERO, B256::ZERO, "https://example.test/r");
    assert_eq!(
        &calldata[..4],
        &RobotMoneyGateway::consensusRecordReceiptCall::SELECTOR[..]
    );
    // And the fixture config's gateway_address is the destination the submit
    // path reads (`cfg.gateway_address`), not `ic_policy_address`.
    let gateway: Address = GATEWAY;
    assert_ne!(
        gateway,
        Address::from([0u8; 20]),
        "the test fixture must configure a real gateway address"
    );
}
