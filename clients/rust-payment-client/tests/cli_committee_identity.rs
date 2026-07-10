//! Canonical: none — integration tests for `rmpc committee-identity`
//! Implements: issue #1111 AC-3 (Test plan)
//!
//! Exercises the actual `rmpc` binary end-to-end for the MCP committee
//! identity flow: create -> show-public-key -> sign. No RPC fixture, no
//! devnet, no external resource of any kind — this is a pure local
//! crypto helper, so every test here runs unconditionally in CI.
//!
//! Tests:
//! - `create_then_show_public_key_round_trips`: `create` writes an
//!   encrypted keystore and prints its base64 public key; `show-public-key`
//!   (no passphrase) reads back the identical key.
//! - `sign_is_deterministic_for_a_sample_canonical_payload`: signing the
//!   same sample canonical payload twice via the CLI yields byte-identical
//!   base64 signatures, and the exported public key verifies the exported
//!   signature end-to-end (AC-3).
//! - `sign_accepts_payload_from_file_identically_to_inline`: `--payload`
//!   and `--payload-file` over the same bytes produce the same signature.
//! - `create_without_passphrase_env_fails_loudly`: missing
//!   `RMPC_COMMITTEE_IDENTITY_PASSPHRASE` refuses with exit 2, not a
//!   silent no-op.
//! - `create_refuses_to_overwrite_existing_keystore`: a second `create` at
//!   the same `--path` exits 2 instead of clobbering the identity.
//! - `sign_requires_exactly_one_payload_source`: neither/both of
//!   `--payload`/`--payload-file` is a parser-level refusal.
//! - `help_documents_committee_identity_subcommands`: `rmpc --help` and
//!   `rmpc committee-identity --help` surface the new command (AC-2).

use assert_cmd::Command;
use rust_payment_client::committee_identity::PASSPHRASE_ENV_VAR;
use serde_json::Value;
use tempfile::TempDir;

const TEST_PASSPHRASE: &str = "correct horse battery staple";

/// A representative `canonicalizeSubmission` payload shape (see
/// `src/committee_identity.rs` module docs): fixed key order, plain
/// `JSON.stringify` whitespace rules — this is what MCP
/// `get_signing_payload` returns and `rmpc committee-identity sign` must
/// sign byte-for-byte.
const SAMPLE_CANONICAL_PAYLOAD: &str = r#"{"memberId":"agent-1","date":"2026-07-10","subjectId":"vault-a","nonce":"n-1","stance":"overweight","confidence":80,"body":"rationale for the recommendation","memoUrl":""}"#;

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

#[test]
fn create_then_show_public_key_round_trips() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");

    let create_out = rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let created: Value =
        serde_json::from_str(std::str::from_utf8(&create_out.stdout).unwrap().trim()).unwrap();
    assert_eq!(created["ok"], true);
    let public_key = created["public_key"].as_str().unwrap().to_string();
    assert_eq!(
        base64_decode_len(&public_key),
        32,
        "public_key must decode to a raw 32-byte Ed25519 key"
    );

    // show-public-key needs no passphrase at all.
    let show_out = rmpc()
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "show-public-key",
        ])
        .env_remove(PASSPHRASE_ENV_VAR)
        .assert()
        .success()
        .get_output()
        .clone();
    let shown: Value =
        serde_json::from_str(std::str::from_utf8(&show_out.stdout).unwrap().trim()).unwrap();
    assert_eq!(shown["ok"], true);
    assert_eq!(shown["public_key"], public_key);
}

#[test]
fn sign_is_deterministic_for_a_sample_canonical_payload() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .success();

    let sign_once = || -> Value {
        let out = rmpc()
            .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
            .args([
                "committee-identity",
                "--path",
                path.to_str().unwrap(),
                "sign",
                "--payload",
                SAMPLE_CANONICAL_PAYLOAD,
            ])
            .assert()
            .success()
            .get_output()
            .clone();
        serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap()
    };

    let a = sign_once();
    let b = sign_once();
    assert_eq!(a["ok"], true);
    assert_eq!(
        a["signature"], b["signature"],
        "signing the same canonical payload twice must be deterministic"
    );
    let sig_b64 = a["signature"].as_str().unwrap();
    assert_eq!(
        base64_decode_len(sig_b64),
        64,
        "signature must decode to a raw 64-byte Ed25519 signature"
    );

    // End-to-end wire-format check: the exported public key verifies the
    // exported signature over the exact payload bytes, exactly as the
    // frontend's `crypto.subtle.verify({name:"Ed25519"}, ...)` would.
    let public_key_b64 = a["public_key"].as_str().unwrap();
    assert!(verify_ed25519(
        public_key_b64,
        sig_b64,
        SAMPLE_CANONICAL_PAYLOAD.as_bytes()
    ));
}

#[test]
fn sign_accepts_payload_from_file_identically_to_inline() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .success();

    let payload_file = dir.path().join("payload.json");
    std::fs::write(&payload_file, SAMPLE_CANONICAL_PAYLOAD).unwrap();

    let inline_out = rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "sign",
            "--payload",
            SAMPLE_CANONICAL_PAYLOAD,
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let file_out = rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "sign",
            "--payload-file",
            payload_file.to_str().unwrap(),
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let inline: Value =
        serde_json::from_str(std::str::from_utf8(&inline_out.stdout).unwrap().trim()).unwrap();
    let file: Value =
        serde_json::from_str(std::str::from_utf8(&file_out.stdout).unwrap().trim()).unwrap();
    assert_eq!(inline["signature"], file["signature"]);
}

#[test]
fn create_without_passphrase_env_fails_loudly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");

    let out = rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrPassphrase");
    assert!(
        !path.exists(),
        "no keystore should be written when the passphrase is missing"
    );
}

#[test]
fn create_refuses_to_overwrite_existing_keystore() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .success();

    let out = rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrIdentityExists");
}

#[test]
fn sign_requires_exactly_one_payload_source() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .success();

    // Neither --payload nor --payload-file.
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "sign",
        ])
        .assert()
        .code(3);

    // Both --payload and --payload-file: clap rejects at parse time
    // (`conflicts_with`).
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "sign",
            "--payload",
            "x",
            "--payload-file",
            "y",
        ])
        .assert()
        .failure();
}

#[test]
fn help_documents_committee_identity_subcommands() {
    let top = rmpc().arg("--help").assert().success().get_output().clone();
    let top_help = String::from_utf8(top.stdout).unwrap();
    assert!(
        top_help.contains("committee-identity"),
        "rmpc --help must list committee-identity:\n{top_help}"
    );

    let sub = rmpc()
        .args(["committee-identity", "--help"])
        .assert()
        .success()
        .get_output()
        .clone();
    let sub_help = String::from_utf8(sub.stdout).unwrap();
    assert!(sub_help.contains("create"));
    assert!(sub_help.contains("show-public-key"));
    assert!(sub_help.contains("sign"));

    let sign_help = rmpc()
        .args(["committee-identity", "--path", "x", "sign", "--help"])
        .assert()
        .success()
        .get_output()
        .clone();
    let sign_help_str = String::from_utf8(sign_help.stdout).unwrap();
    assert!(sign_help_str.contains("--payload"));
    assert!(sign_help_str.contains("--payload-file"));
}

// ─── Local helpers (kept dependency-free of the base64/ed25519 crates —
// this integration target treats the CLI as a black box) ──────────────

fn base64_decode_len(s: &str) -> usize {
    base64_decode(s).len()
}

/// Minimal standard-alphabet base64 decoder (padded), enough to check
/// decoded lengths and feed `verify_ed25519` without adding a test-only
/// dependency the production code doesn't already need.
fn base64_decode(s: &str) -> Vec<u8> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).expect("valid base64")
}

fn verify_ed25519(public_key_b64: &str, signature_b64: &str, message: &[u8]) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let pk_bytes = base64_decode(public_key_b64);
    let sig_bytes = base64_decode(signature_b64);
    let vk = VerifyingKey::from_bytes(&pk_bytes.try_into().expect("32-byte public key"))
        .expect("valid Ed25519 public key");
    let sig = Signature::from_bytes(&sig_bytes.try_into().expect("64-byte signature"));
    vk.verify(message, &sig).is_ok()
}
