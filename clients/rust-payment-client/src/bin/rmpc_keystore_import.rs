//! Canonical: docs/implementation-plan.md §4.3 — Software signer
//!
//! `rmpc-keystore-import` — test-only helper that takes a raw secp256k1
//! private key (32 bytes, hex) and writes an Argon2id+AES-256-GCM
//! keystore at the supplied path under the passphrase carried by
//! `RMPC_KEYSTORE_PASSPHRASE`.
//!
//! Used by the dapp fork-roundtrip Playwright spec
//! (`clients/dapp/tests/e2e/fork-roundtrip.spec.ts`) to mint a keystore
//! for the agent EOA so that `rmpc self-check` can decrypt the keystore
//! and run the preflight against the same fork that the dapp drove.
//!
//! Exit codes mirror `rmpc self-check` startup-fail semantics:
//!   0  — keystore written.
//!   2  — bad input (missing argv, malformed hex, wrong key length).
//!   3  — io / encryption failure.
//!
//! Inputs:
//!   argv[1]                   — output keystore path.
//!   $RMPC_IMPORT_PRIVKEY_HEX  — 64-hex-char (optionally 0x-prefixed) secp256k1 private key.
//!   $RMPC_KEYSTORE_PASSPHRASE — passphrase used to encrypt the keystore.
//!
//! The private-key hex is read from the environment, never from argv,
//! so `ps` does not leak it. The helper unsets the env var on entry to
//! reduce the leak window.

use std::env;
use std::process::ExitCode;

use rust_payment_client::signer::software::{SoftwareSigner, PASSPHRASE_ENV_VAR};

const PRIVKEY_ENV_VAR: &str = "RMPC_IMPORT_PRIVKEY_HEX";

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(out_path) = args.next() else {
        eprintln!("usage: rmpc-keystore-import <output-keystore-path>");
        eprintln!("env  : RMPC_IMPORT_PRIVKEY_HEX, RMPC_KEYSTORE_PASSPHRASE");
        return ExitCode::from(2);
    };

    let privkey_hex = match env::var(PRIVKEY_ENV_VAR) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("rmpc-keystore-import: ${PRIVKEY_ENV_VAR} is unset");
            return ExitCode::from(2);
        }
    };
    // Best-effort scrub from the child env so subprocesses cannot read it.
    env::remove_var(PRIVKEY_ENV_VAR);

    let passphrase = match env::var(PASSPHRASE_ENV_VAR) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("rmpc-keystore-import: ${PASSPHRASE_ENV_VAR} is unset");
            return ExitCode::from(2);
        }
    };

    let trimmed = privkey_hex.trim().trim_start_matches("0x");
    let bytes = match hex::decode(trimmed) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("rmpc-keystore-import: ${PRIVKEY_ENV_VAR} not valid hex: {e}");
            return ExitCode::from(2);
        }
    };
    if bytes.len() != 32 {
        eprintln!(
            "rmpc-keystore-import: ${PRIVKEY_ENV_VAR} must decode to 32 bytes, got {}",
            bytes.len()
        );
        return ExitCode::from(2);
    }
    let mut privkey = [0u8; 32];
    privkey.copy_from_slice(&bytes);

    match SoftwareSigner::create_keystore(&out_path, &privkey, passphrase.as_bytes()) {
        Ok(ks) => {
            // Echo the address so callers can sanity-check the import
            // matches the EOA they were expecting.
            println!("{}", ks.address);
            ExitCode::from(0)
        }
        Err(e) => {
            eprintln!("rmpc-keystore-import: create_keystore failed: {e}");
            ExitCode::from(3)
        }
    }
}
