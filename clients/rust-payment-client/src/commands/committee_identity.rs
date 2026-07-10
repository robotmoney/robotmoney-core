//! Canonical: no in-repo doc — see `crate::committee_identity` module docs.
//! Implements: issue #1111 — `rmpc committee-identity`: MCP committee signing identity
//!
//! `rmpc committee-identity create|show-public-key|sign` — local-only
//! Ed25519 identity management for the Investment Committee demo's MCP
//! flow. No RPC, no operator config TOML, no on-chain state: this is a
//! pure client-side crypto helper so a prospective agent never has to
//! hand-roll Ed25519 code (issue #1111 AC-1). See
//! [`crate::committee_identity`] for the wire-format rationale.
//!
//! Exit codes:
//! - 0 — success.
//! - 2 — input/auth refusal (bad or missing passphrase, keystore already
//!   exists at the `create` target).
//! - 3 — io / format failure (unreadable keystore, malformed JSON, etc.).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::committee_identity::{
    read_passphrase_from_env, CommitteeIdentity, CommitteeIdentityError,
};

const EXIT_OK: i32 = 0;
const EXIT_REFUSAL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Where the `sign` subcommand reads the exact payload bytes to sign
/// from. Kept as an enum (rather than always reading stdin) so the
/// canonical string never has to survive shell quoting/escaping when the
/// caller has it in a file.
pub enum PayloadSource {
    /// The payload string passed inline via `--payload`. Signed as its
    /// UTF-8 bytes exactly as given.
    Inline(String),
    /// A file whose exact bytes (no trimming) are signed.
    File(PathBuf),
}

#[derive(Debug, Serialize)]
struct CreateOutput {
    ok: bool,
    path: String,
    public_key: String,
}

#[derive(Debug, Serialize)]
struct PublicKeyOutput {
    ok: bool,
    public_key: String,
}

#[derive(Debug, Serialize)]
struct SignOutput {
    ok: bool,
    public_key: String,
    signature: String,
}

#[derive(Debug, Serialize)]
struct Failure {
    ok: bool,
    error: String,
    message: String,
}

/// Run `rmpc committee-identity create`. Returns the process exit code.
pub fn run_create(path: &Path, pretty: bool) -> i32 {
    let passphrase = match read_passphrase_from_env() {
        Ok(p) => p,
        Err(e) => return emit_error(&e, pretty),
    };
    match CommitteeIdentity::create(path, passphrase.as_bytes()) {
        Ok(ks) => {
            emit(
                &CreateOutput {
                    ok: true,
                    path: path.display().to_string(),
                    public_key: ks.public_key,
                },
                pretty,
            );
            EXIT_OK
        }
        Err(e) => emit_error(&e, pretty),
    }
}

/// Run `rmpc committee-identity show-public-key`. Returns the process
/// exit code. Does not require a passphrase — the public key is stored
/// in cleartext in the keystore.
pub fn run_show_public_key(path: &Path, pretty: bool) -> i32 {
    match CommitteeIdentity::public_key_from_path(path) {
        Ok(public_key) => {
            emit(
                &PublicKeyOutput {
                    ok: true,
                    public_key,
                },
                pretty,
            );
            EXIT_OK
        }
        Err(e) => emit_error(&e, pretty),
    }
}

/// Run `rmpc committee-identity sign`. Returns the process exit code.
pub fn run_sign(path: &Path, source: PayloadSource, pretty: bool) -> i32 {
    let passphrase = match read_passphrase_from_env() {
        Ok(p) => p,
        Err(e) => return emit_error(&e, pretty),
    };

    let payload: Vec<u8> = match source {
        PayloadSource::Inline(s) => s.into_bytes(),
        PayloadSource::File(f) => match std::fs::read(&f) {
            Ok(b) => b,
            Err(e) => {
                return emit_error(
                    &CommitteeIdentityError::ErrKeystoreIo(format!(
                        "reading --payload-file {}: {e}",
                        f.display()
                    )),
                    pretty,
                )
            }
        },
    };

    let identity = match CommitteeIdentity::load(path, passphrase.as_bytes()) {
        Ok(id) => id,
        Err(e) => return emit_error(&e, pretty),
    };

    emit(
        &SignOutput {
            ok: true,
            public_key: identity.public_key_b64(),
            signature: identity.sign_b64(&payload),
        },
        pretty,
    );
    EXIT_OK
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("committee-identity output serialises");
    println!("{json}");
}

fn emit_error(e: &CommitteeIdentityError, pretty: bool) -> i32 {
    let (code, name) = classify(e);
    emit(
        &Failure {
            ok: false,
            error: name.to_string(),
            message: format!("{e}"),
        },
        pretty,
    );
    code
}

fn classify(e: &CommitteeIdentityError) -> (i32, &'static str) {
    match e {
        CommitteeIdentityError::ErrIdentityExists(_) => (EXIT_REFUSAL, "ErrIdentityExists"),
        CommitteeIdentityError::ErrKeystoreDecrypt => (EXIT_REFUSAL, "ErrKeystoreDecrypt"),
        CommitteeIdentityError::ErrPassphrase(_) => (EXIT_REFUSAL, "ErrPassphrase"),
        CommitteeIdentityError::ErrKeystoreIo(_) => (EXIT_STARTUP_FAIL, "ErrKeystoreIo"),
        CommitteeIdentityError::ErrKeystoreFormat(_) => (EXIT_STARTUP_FAIL, "ErrKeystoreFormat"),
        CommitteeIdentityError::ErrSign(_) => (EXIT_STARTUP_FAIL, "ErrSign"),
    }
}
