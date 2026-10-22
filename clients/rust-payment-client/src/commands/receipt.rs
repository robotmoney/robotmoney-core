//! Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
//! Implements: issue #1247 — anchor the consensus receipt on chain (rmpc side).
//!
//! `rmpc receipt` — verify a consensus recommendation receipt off-chain.
//!
//! Subcommands:
//! - `verify` — fetch/read the receipt JSON, canonicalize it, print the derived
//!   `payload_digest` and `receipt_id`, and report per-analyst Ed25519
//!   verification. Read-only: no signer, no nonce, no chain.
//!
//! The chain cannot prove each named analyst signed, because the EVM has no
//! Ed25519 precompile (ADR-0012 §5). The embedded signatures are verified
//! off-chain here.
//!
//! Exit codes:
//! - 0 — success.
//! - 2 — refusal (bad receipt, digest mismatch, failed signature, revert).
//! - 3 — startup failure (missing config, keystore, RPC, etc.).

use std::path::PathBuf;
use std::time::Duration;

use alloy_primitives::B256;
use serde::Serialize;

use crate::config::Config;
use crate::consensus_receipt::{ConsensusReceipt, ReceiptError, SignatureCheck};
use crate::output::emit;

const EXIT_OK: i32 = 0;
const EXIT_REFUSAL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Largest receipt body accepted over HTTP. A consensus receipt is a few KiB;
/// the cap stops a runaway allocation on a hostile or misconfigured URL.
/// Mirrors `services/explorer-indexer/src/indexer.rs::fetch_and_verify_memo`.
const MAX_RECEIPT_BODY_BYTES: usize = 1024 * 1024;

/// HTTP timeout for the receipt fetch. Same value and same reason as the
/// indexer's memo fetch.
const RECEIPT_FETCH_TIMEOUT_SECS: u64 = 10;

// ─── Args ────────────────────────────────────────────────────────────────────

/// Where the receipt bytes come from.
#[derive(Debug, Clone)]
pub enum ReceiptSource {
    /// Fetch over HTTP from the swarm API.
    Url(String),
    /// Read from a local file. For `submit` this supplies the BYTES only; the
    /// anchored `payloadUri` still comes from `--receipt-url`.
    File(PathBuf),
}

/// Args for `rmpc receipt verify`.
#[derive(Debug, Clone)]
pub struct VerifyArgs {
    /// Path to the operator config TOML.
    pub config_path: PathBuf,
    /// Where to read the receipt from.
    pub source: ReceiptSource,
    /// Pretty-print the JSON output.
    pub pretty: bool,
}

// ─── Output types ────────────────────────────────────────────────────────────

/// Successful `rmpc receipt` output.
#[derive(Debug, Serialize)]
pub struct ReceiptOutput {
    /// Always true.
    pub ok: bool,
    /// `"verify"` or `"submit"`.
    pub action: String,
    /// `keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id + "\n" + subject_id)`.
    pub receipt_id: String,
    /// `keccak256` of the canonical bytes — the value anchored on chain.
    pub payload_digest: String,
    /// Length of the canonical preimage, so an operator can eyeball a
    /// truncated fetch without re-deriving anything.
    pub canonical_bytes: usize,
    /// The receipt's session.
    pub session_id: String,
    /// The receipt's subject.
    pub subject_id: String,
    /// Present on `submit`: the URI anchored beside the digest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_uri: Option<String>,
    /// Per-analyst Ed25519 verification. Every entry is `verified: true` when
    /// the command succeeds — a single failure is a refusal, not a false entry.
    pub analyst_signatures: Vec<SignatureCheck>,
    /// Present on `submit`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    /// Present on `submit`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_number: Option<u64>,
}

/// Failure envelope. `error` is the stable machine-readable code.
#[derive(Debug, Serialize)]
pub struct ReceiptFailure {
    /// Always false.
    pub ok: bool,
    /// Stable `ErrX` code.
    pub error: String,
    /// Human-readable detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// ─── Public entry points ─────────────────────────────────────────────────────

/// Run `rmpc receipt verify`. Returns the process exit code.
///
/// Purely off-chain: it loads the config (for logging and for symmetry with the
/// write path) but never opens a keystore, takes a nonce lock, or calls an RPC.
pub fn run_verify(args: VerifyArgs) -> i32 {
    if let Err(e) = Config::from_path(&args.config_path) {
        log::error!("rmpc receipt verify: failed to load config: {e}");
        return EXIT_STARTUP_FAIL;
    }

    let rt = match build_rt("verify") {
        Ok(rt) => rt,
        Err(code) => return code,
    };

    let raw = match load_receipt_bytes(&rt, &args.source, "verify", args.pretty) {
        Ok(b) => b,
        Err(code) => return code,
    };

    let checked = match check_receipt(&raw, None, "verify", args.pretty) {
        Ok(c) => c,
        Err(code) => return code,
    };

    log::info!(
        "rmpc receipt verify: ok receipt_id={:#x} payload_digest={:#x} signatures={}",
        checked.receipt_id,
        checked.payload_digest,
        checked.signatures.len()
    );
    emit_output(
        &ReceiptOutput {
            ok: true,
            action: "verify".to_string(),
            receipt_id: format!("{:#x}", checked.receipt_id),
            payload_digest: format!("{:#x}", checked.payload_digest),
            canonical_bytes: checked.canonical_len,
            session_id: checked.receipt.session_id.clone(),
            subject_id: checked.receipt.subject_id.clone(),
            payload_uri: None,
            analyst_signatures: checked.signatures,
            tx_hash: None,
            block_number: None,
        },
        args.pretty,
    );
    EXIT_OK
}

// ─── The check ───────────────────────────────────────────────────────────────

/// Everything the refusal gate derives, carried forward so the caller never
/// re-canonicalizes (and so cannot accidentally anchor a second derivation).
struct CheckedReceipt {
    receipt: ConsensusReceipt,
    receipt_id: B256,
    payload_digest: B256,
    canonical_len: usize,
    signatures: Vec<SignatureCheck>,
}

/// Parse, validate, canonicalize, derive, compare and verify — in that order.
///
/// `expected_digest` is `Some` only when the operator supplied
/// `--expected-digest`; the comparison is then mandatory.
fn check_receipt(
    raw: &[u8],
    expected_digest: Option<B256>,
    subcommand: &str,
    pretty: bool,
) -> Result<CheckedReceipt, i32> {
    let receipt = ConsensusReceipt::from_json_slice(raw).map_err(|e| {
        refuse(&e, subcommand, pretty);
        EXIT_REFUSAL
    })?;

    // Validates before canonicalizing; a missing required field is refused
    // here rather than silently omitted from the bytes.
    let canonical = receipt.canonical_bytes().map_err(|e| {
        refuse(&e, subcommand, pretty);
        EXIT_REFUSAL
    })?;

    let payload_digest = crate::consensus_receipt::payload_digest(&canonical);
    let receipt_id = receipt.receipt_id();

    if let Some(expected) = expected_digest {
        if expected != payload_digest {
            log::error!(
                "rmpc receipt {subcommand}: derived digest {payload_digest:#x} does not equal \
                 --expected-digest {expected:#x}; refusing to submit"
            );
            emit_failure(
                &ReceiptFailure {
                    ok: false,
                    error: "ErrReceiptDigestMismatch".to_string(),
                    message: Some(format!(
                        "derived payload_digest {payload_digest:#x} does not equal \
                         --expected-digest {expected:#x} — the fetched bytes are not the bytes \
                         the caller intended to anchor"
                    )),
                },
                pretty,
            );
            return Err(EXIT_REFUSAL);
        }
    }

    let signatures = receipt.verify_analyst_signatures().map_err(|e| {
        refuse(&e, subcommand, pretty);
        EXIT_REFUSAL
    })?;

    Ok(CheckedReceipt {
        receipt,
        receipt_id,
        payload_digest,
        canonical_len: canonical.len(),
        signatures,
    })
}

fn refuse(e: &ReceiptError, subcommand: &str, pretty: bool) {
    log::error!("rmpc receipt {subcommand}: {e}");
    emit_failure(
        &ReceiptFailure {
            ok: false,
            error: e.code().to_string(),
            message: Some(format!("{e}")),
        },
        pretty,
    );
}

// ─── Receipt bytes ───────────────────────────────────────────────────────────

fn load_receipt_bytes(
    rt: &tokio::runtime::Runtime,
    source: &ReceiptSource,
    subcommand: &str,
    pretty: bool,
) -> Result<Vec<u8>, i32> {
    match source {
        ReceiptSource::File(path) => std::fs::read(path).map_err(|e| {
            log::error!("rmpc receipt {subcommand}: read {}: {e}", path.display());
            emit_failure(
                &ReceiptFailure {
                    ok: false,
                    error: "ErrReceiptReadFailed".to_string(),
                    message: Some(format!("read {}: {e}", path.display())),
                },
                pretty,
            );
            EXIT_REFUSAL
        }),
        ReceiptSource::Url(url) => rt
            .block_on(async { fetch_receipt(url).await })
            .map_err(|e| {
                log::error!("rmpc receipt {subcommand}: {e}");
                emit_failure(
                    &ReceiptFailure {
                        ok: false,
                        error: "ErrReceiptFetchFailed".to_string(),
                        message: Some(e),
                    },
                    pretty,
                );
                EXIT_REFUSAL
            }),
    }
}

/// GET the receipt JSON, capped at [`MAX_RECEIPT_BODY_BYTES`] with a
/// [`RECEIPT_FETCH_TIMEOUT_SECS`]-second timeout.
async fn fetch_receipt(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(RECEIPT_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GET {url} returned {}", resp.status()));
    }

    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("read body from {url}: {e}"))?;

    if body.len() > MAX_RECEIPT_BODY_BYTES {
        return Err(format!(
            "receipt body from {url} is {} bytes (max {MAX_RECEIPT_BODY_BYTES})",
            body.len()
        ));
    }

    Ok(body.to_vec())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn build_rt(subcommand: &str) -> Result<tokio::runtime::Runtime, i32> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| {
            log::error!("rmpc receipt {subcommand}: tokio runtime build failed: {e}");
            EXIT_STARTUP_FAIL
        })
}

fn emit_output(out: &ReceiptOutput, pretty: bool) {
    emit(out, pretty);
}

fn emit_failure(out: &ReceiptFailure, pretty: bool) {
    emit(out, pretty);
}
