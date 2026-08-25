//! Canonical: none — integration tests for `rmpc committee-identity`
//! Implements: issue #1111 AC-3 (Test plan); issue #1192 (safe passphrase
//! input — file channel, `/dev/tty` prompt, loud non-interactive refusal)
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
//! - `sign_refuses_payload_file_with_trailing_whitespace`: a newline from
//!   `echo` is rejected before it can yield an unverifiable signature.
//! - `create_without_any_passphrase_source_fails_loudly`: with neither
//!   `RMPC_COMMITTEE_IDENTITY_PASSPHRASE` nor
//!   `RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE` set and no terminal
//!   attached, `create` refuses with exit 2 and names both safe channels
//!   — it never hangs on `/dev/tty` and never no-ops (issue #1192).
//! - `passphrase_piped_on_stdin_is_never_accepted`: a secret written to
//!   the child's stdin is ignored and refused (issue #1192).
//! - `empty_passphrase_file_variable_fails_loudly`: an empty
//!   `RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE` refuses instead of falling
//!   back to another source (issue #1192).
//! - `file_passphrase_trims_newline_and_preserves_signatures`: a mode-0600
//!   passphrase file is an exact substitute for the environment variable,
//!   trailing newline trimmed (issue #1192).
//! - `unsafe_passphrase_file_permissions_are_rejected`: a group- or
//!   world-readable passphrase file is refused before any keystore is
//!   written (issue #1192).
//! - `tty_prompt_reads_the_passphrase_without_echo`: over a real allocated
//!   pty, `create` prompts on `/dev/tty`, never echoes the typed secret,
//!   and writes a keystore that decrypts under exactly those bytes
//!   (issue #1192).
//! - `create_refuses_to_overwrite_existing_keystore`: a second `create` at
//!   the same `--path` exits 2 instead of clobbering the identity.
//! - `sign_requires_exactly_one_payload_source`: neither/both of
//!   `--payload`/`--payload-file` is a parser-level refusal.
//! - `help_documents_committee_identity_subcommands`: `rmpc --help` and
//!   `rmpc committee-identity --help` surface the new command (AC-2).

use assert_cmd::Command;
use rust_payment_client::committee_identity::{PASSPHRASE_ENV_VAR, PASSPHRASE_FILE_ENV_VAR};
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
fn sign_refuses_payload_file_with_trailing_whitespace() {
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

    let payload_file = dir.path().join("payload-with-newline.json");
    std::fs::write(&payload_file, format!("{SAMPLE_CANONICAL_PAYLOAD}\n")).unwrap();

    let out = rmpc()
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
        .code(2)
        .get_output()
        .clone();
    let failure: Value =
        serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap();
    assert_eq!(failure["ok"], false);
    assert_eq!(failure["error"], "ErrPayloadFormat");
    assert!(failure["message"].as_str().unwrap().contains("printf '%s'"));
}

/// With no passphrase source and no terminal (assert_cmd gives the child a
/// null stdin, exactly like an agent-driven or CI invocation), `create`
/// must refuse loudly and point at the two safe channels — never hang on a
/// `/dev/tty` read nobody is there to answer, and never no-op.
#[test]
fn create_without_any_passphrase_source_fails_loudly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");

    let out = rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .env_remove(PASSPHRASE_FILE_ENV_VAR)
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
    let message = v["message"].as_str().unwrap();
    assert!(
        message.contains(PASSPHRASE_FILE_ENV_VAR),
        "the refusal must name the passphrase-file channel: {message}"
    );
    assert!(
        message.contains("/dev/tty"),
        "the refusal must name the interactive channel: {message}"
    );
    assert!(
        !path.exists(),
        "no keystore should be written when the passphrase is missing"
    );
}

/// A passphrase piped on stdin must never be accepted: the prompt reads
/// `/dev/tty`, so an agent that tries to feed the secret through the pipe
/// gets the same loud refusal rather than a silently created keystore.
#[test]
fn passphrase_piped_on_stdin_is_never_accepted() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");

    let out = rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .env_remove(PASSPHRASE_FILE_ENV_VAR)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .write_stdin(format!("{TEST_PASSPHRASE}\n"))
        .assert()
        .code(2)
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrPassphrase");
    assert!(
        !path.exists(),
        "a stdin-supplied passphrase must not produce a keystore"
    );
}

/// An empty `RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE` must refuse, not fall
/// through to another source.
#[test]
fn empty_passphrase_file_variable_fails_loudly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");

    let out = rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .env(PASSPHRASE_FILE_ENV_VAR, "")
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
    assert_eq!(v["error"], "ErrPassphrase");
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn file_passphrase_trims_newline_and_preserves_signatures() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");
    let passphrase_file = dir.path().join("passphrase");
    std::fs::write(&passphrase_file, format!("{TEST_PASSPHRASE}\n")).unwrap();
    std::fs::set_permissions(&passphrase_file, std::fs::Permissions::from_mode(0o600)).unwrap();

    rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .env(PASSPHRASE_FILE_ENV_VAR, &passphrase_file)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .assert()
        .success();

    let sign_with_file = rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .env(PASSPHRASE_FILE_ENV_VAR, &passphrase_file)
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
    let sign_with_env = rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .env_remove(PASSPHRASE_FILE_ENV_VAR)
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

    let file: Value = serde_json::from_slice(&sign_with_file.stdout).unwrap();
    let env: Value = serde_json::from_slice(&sign_with_env.stdout).unwrap();
    assert_eq!(file["signature"], env["signature"]);
}

#[cfg(unix)]
#[test]
fn unsafe_passphrase_file_permissions_are_rejected() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");
    let passphrase_file = dir.path().join("passphrase");
    std::fs::write(&passphrase_file, format!("{TEST_PASSPHRASE}\n")).unwrap();
    std::fs::set_permissions(&passphrase_file, std::fs::Permissions::from_mode(0o644)).unwrap();

    let out = rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .env(PASSPHRASE_FILE_ENV_VAR, &passphrase_file)
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
    let response: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(response["error"], "ErrPassphrase");
    assert!(!path.exists());
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

/// AC-3: with neither passphrase variable set, drive the real `/dev/tty`
/// prompt over an allocated pty.
///
/// This is the one path the other tests cannot reach — they run with a null
/// stdin, which is exactly the non-interactive refusal case. Here the child
/// gets a pty as its controlling terminal, so `read_passphrase` takes the
/// prompt branch. The test asserts the security-relevant properties: the
/// prompt is shown, the typed secret is never echoed back to the terminal,
/// and the keystore it produces decrypts under precisely those bytes.
///
/// Needs no external resource — a pty is a kernel facility, and every step
/// that could fail to obtain one asserts rather than skipping.
#[cfg(unix)]
#[test]
fn tty_prompt_reads_the_passphrase_without_echo() {
    use std::ffi::CStr;
    use std::io::{Read, Write};
    use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("identity.json");

    // Allocate a pty pair. posix_openpt/grantpt/unlockpt/ptsname is the
    // POSIX route and needs no libutil link.
    // SAFETY: plain FFI calls with no borrowed state; the raw fd is adopted
    // by an OwnedFd immediately so it is closed exactly once.
    let master = unsafe {
        let fd = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        assert!(
            fd >= 0,
            "posix_openpt failed: {}",
            std::io::Error::last_os_error()
        );
        let master = OwnedFd::from_raw_fd(fd);
        assert_eq!(
            libc::grantpt(master.as_raw_fd()),
            0,
            "grantpt failed: {}",
            std::io::Error::last_os_error()
        );
        assert_eq!(
            libc::unlockpt(master.as_raw_fd()),
            0,
            "unlockpt failed: {}",
            std::io::Error::last_os_error()
        );
        master
    };
    // SAFETY: ptsname returns a pointer into static storage owned by libc,
    // valid until the next ptsname call on this thread; it is copied here.
    let slave_path = unsafe {
        let name = libc::ptsname(master.as_raw_fd());
        assert!(
            !name.is_null(),
            "ptsname failed: {}",
            std::io::Error::last_os_error()
        );
        CStr::from_ptr(name).to_str().unwrap().to_owned()
    };

    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&slave_path)
        .expect("open pty slave");

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("rmpc"));
    command
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "create",
        ])
        .env_remove(PASSPHRASE_ENV_VAR)
        .env_remove(PASSPHRASE_FILE_ENV_VAR)
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave.try_clone().unwrap()))
        .stderr(Stdio::from(slave.try_clone().unwrap()));
    // SAFETY: between fork and exec only async-signal-safe syscalls are
    // used. setsid() makes the child a session leader with no controlling
    // terminal; TIOCSCTTY then adopts the pty slave (already this process's
    // fd 0) as it, which is what makes /dev/tty resolve in the child.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().expect("spawn rmpc on a pty");
    // The parent must not keep the slave open, or the master read below
    // never reports EOF after the child exits.
    drop(slave);

    let mut writer = std::fs::File::from(master.try_clone().unwrap());
    let mut reader = std::fs::File::from(master);
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        // A pty master reports EIO (not EOF) once the last slave closes,
        // so any error ends the loop and drops the sender.
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(60);
    let mut transcript = Vec::new();
    while !String::from_utf8_lossy(&transcript).contains("passphrase") {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .expect("timed out waiting for the /dev/tty passphrase prompt");
        let chunk = rx
            .recv_timeout(remaining)
            .expect("rmpc exited without prompting on /dev/tty");
        transcript.extend(chunk);
    }

    writer
        .write_all(format!("{TEST_PASSPHRASE}\n").as_bytes())
        .expect("type the passphrase on the pty");
    writer.flush().unwrap();

    let status = child.wait().expect("wait for rmpc");
    while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(5)) {
        transcript.extend(chunk);
    }
    let transcript = String::from_utf8_lossy(&transcript).into_owned();

    assert!(
        status.success(),
        "create should succeed from the /dev/tty prompt; transcript: {transcript}"
    );
    assert!(
        !transcript.contains(TEST_PASSPHRASE),
        "the typed passphrase must never be echoed to the terminal; transcript: {transcript}"
    );
    assert!(
        path.exists(),
        "the prompt should have produced a keystore; transcript: {transcript}"
    );

    // The keystore must decrypt under exactly the bytes typed at the prompt
    // — proving the prompt captured the line without the trailing newline.
    rmpc()
        .env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
        .env_remove(PASSPHRASE_FILE_ENV_VAR)
        .args([
            "committee-identity",
            "--path",
            path.to_str().unwrap(),
            "sign",
            "--payload",
            SAMPLE_CANONICAL_PAYLOAD,
        ])
        .assert()
        .success();
}
