//! Canonical: docs/development/smoke-test-design.md (Devnet + USDC faucet sections).
//! Implements: issue #255 — fork-block manifest validator.
//!
//! The fork-block manifest lives at `testing/ethereum-testnet/config/fork-block.json`
//! and is the single source of truth for the Base fork point used to
//! seed the smoke-test devnet's genesis `alloc`. This module deserializes and
//! validates that manifest.
//!
//! Validation rules (mirror of issue #255 acceptance criteria):
//! - All required fields present.
//! - `chain == "base"` (regression guard — devnet only forks Base).
//! - `block_number > 0`.
//! - `block_hash` is a 0x-prefixed 32-byte hex string.
//! - `snapshot_uri` is non-empty.
//! - `ingested_addresses` is non-empty and each entry is a valid 20-byte
//!   address.
//! - `harness_usdc_holder` is a valid address AND does not overlap with any
//!   entry in `ingested_addresses` — this preserves the "clean history"
//!   property documented in `docs/development/smoke-test-design.md`.
//! - `harness_usdc_grant_units` parses as a positive `u128` (USDC has 6
//!   decimals, so realistic grants fit comfortably).
//!
//! On-chain hash verification (asserting that `block_hash` matches the actual
//! Base block at `block_number`) is deliberately out of scope here: it requires
//! a live archive RPC and is gated behind the `pinned` flag. The validator
//! surfaces `pinned` so callers (CI, the genesis ingester) can decide whether
//! to require pin verification.
//!
//! ── DEV-SCOUT SEAM (off-chain scan remediation — residual; issue #1027) ──────
//! Canonical: `docs/code-review/external-scan-verification-20260619.md`
//! (smoke-test / fork-e2e harness subsystem table). Documentation-only pointer:
//! no behaviour change here. The findings below are still present at HEAD and
//! are owned by issue #1026 (fix(harness): authenticate fork snapshot + remove
//! faucet-key / USDC-slot). NEITHER this scout (#1027) NOR this comment
//! implements the fixes.
//!
//! HARN-5 (Med — supply-chain): the pinned manifest does not authenticate the
//!   snapshot BYTES. `snapshot_uri` is only validated as non-empty (see the
//!   validation rule above and `validate()` below); `pinned` covers the
//!   `block_hash` ↔ archive-RPC check but says nothing about the contents
//!   fetched from `snapshot_uri`. Seam for #1026: add a content digest field
//!   (e.g. `snapshot_sha256`) to `ForkManifest` + a validation rule, and have
//!   the genesis ingester (`src/bin/genesis-ingester.rs`) verify the downloaded
//!   snapshot hashes to it before constructing genesis `alloc`. The struct +
//!   `validate()` here are the seam; the ingester is the enforcement point.
//!
//! HARN-2 (Med — most-real): the devnet faucet private key is exposed in the
//!   public Vite bundle / cloudflared tunnel and printed. Lives in the faucet
//!   wiring, NOT this file (`src/genesis_alloc.rs`, `src/base_testnet.rs`,
//!   `src/bin/smoke-test.rs`, and the dapp/Vite env). Seam for #1026: stop
//!   embedding the key in any client-reachable surface; serve faucet grants
//!   from a harness-side signer instead. Disjoint from the manifest struct.
//!
//! HARN-6 (Med — robustness, no attacker needed): the USDC grant ignores the
//!   PACKED blacklist bit (FiatToken V2_1-vs-V2_2 storage-layout mismatch), so
//!   on a V2_2 snapshot the grant can target/leave a stale blacklist slot.
//!   Lives in the USDC-seed path (`src/base_testnet.rs` /
//!   `src/bin/demo-seed-depositors.rs`), NOT this manifest module. Seam for
//!   #1026: detect the FiatToken minor version and compute the blacklist slot
//!   from the packed layout rather than the hardcoded V2_1 slot.
//!
//! Disjointness: #1026 is confined to `testing/` (manifest + USDC-seed +
//!   faucet wiring) and does not touch the indexer (#1021/#1022), watchdog
//!   (#1023), rmpc (#1024) or dapp (#1025); it runs in parallel after the scout.

use std::path::Path;

use alloy_primitives::Address;
use serde::Deserialize;

/// Parsed and validated fork-block manifest.
///
/// Construct via [`ForkManifest::load`] (reads + validates the JSON file) or
/// [`ForkManifest::from_str`] (validates an in-memory JSON string). Both
/// entrypoints return `Err(ManifestError::…)` on any validation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkManifest {
    pub chain: String,
    pub block_number: u64,
    pub block_hash: String,
    pub snapshot_uri: String,
    pub ingested_addresses: Vec<Address>,
    pub harness_usdc_holder: Address,
    pub harness_usdc_grant_units: u128,
    /// When `false`, the manifest is structurally valid but `block_hash` has
    /// not been verified against an archive RPC. The genesis ingester is
    /// expected to refuse final devnet construction unless `pinned == true`.
    pub pinned: bool,
    /// HARN-5 (off-chain scan remediation, issue #1026): SHA-256 content digest
    /// of the snapshot bytes the genesis ingester will ingest, as a 0x-prefixed
    /// 32-byte (64-hex) string. `pinned` authenticates `block_hash` against an
    /// archive RPC but says nothing about the BYTES fetched from
    /// `snapshot_uri`; this field closes that gap. When present, the ingester
    /// MUST verify the snapshot hashes to it before constructing genesis
    /// `alloc` (see [`ForkManifest::verify_snapshot_digest`]). `None` preserves
    /// backward compatibility with manifests captured before this field
    /// existed, but the ingester refuses to ingest an unauthenticated snapshot
    /// under `--require-pinned`.
    pub snapshot_sha256: Option<String>,
}

/// Errors returned by [`ForkManifest::load`] / [`ForkManifest::from_str`].
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest io: {0}")]
    Io(#[from] std::io::Error),
    #[error("manifest json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid manifest: {0}")]
    Invalid(String),
}

/// Raw on-disk shape. Kept private — callers always work with the validated
/// [`ForkManifest`].
#[derive(Debug, Deserialize)]
struct RawManifest {
    #[serde(default)]
    chain: Option<String>,
    #[serde(default)]
    block_number: Option<u64>,
    #[serde(default)]
    block_hash: Option<String>,
    #[serde(default)]
    snapshot_uri: Option<String>,
    #[serde(default)]
    ingested_addresses: Option<Vec<String>>,
    #[serde(default)]
    harness_usdc_holder: Option<String>,
    #[serde(default)]
    harness_usdc_grant_units: Option<String>,
    #[serde(default)]
    pinned: Option<bool>,
    #[serde(default)]
    snapshot_sha256: Option<String>,
}

impl ForkManifest {
    /// Read and validate the manifest at `path`.
    pub fn load(path: &Path) -> Result<Self, ManifestError> {
        let raw = std::fs::read_to_string(path)?;
        Self::from_str(&raw)
    }

    /// Validate an in-memory JSON manifest. Used by unit tests and by the
    /// CI manifest-validator binary.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(raw_json: &str) -> Result<Self, ManifestError> {
        let raw: RawManifest = serde_json::from_str(raw_json)?;

        let chain = raw
            .chain
            .ok_or_else(|| ManifestError::Invalid("missing field: chain".into()))?;
        if chain != "base" {
            return Err(ManifestError::Invalid(format!(
                "chain must be \"base\", got {chain:?}"
            )));
        }

        let block_number = raw
            .block_number
            .ok_or_else(|| ManifestError::Invalid("missing field: block_number".into()))?;
        if block_number == 0 {
            return Err(ManifestError::Invalid("block_number must be > 0".into()));
        }

        let block_hash = raw
            .block_hash
            .ok_or_else(|| ManifestError::Invalid("missing field: block_hash".into()))?;
        if !is_valid_b256_hex(&block_hash) {
            return Err(ManifestError::Invalid(format!(
                "block_hash must be 0x-prefixed 32-byte hex, got {block_hash:?}"
            )));
        }

        let snapshot_uri = raw
            .snapshot_uri
            .ok_or_else(|| ManifestError::Invalid("missing field: snapshot_uri".into()))?;
        if snapshot_uri.is_empty() {
            return Err(ManifestError::Invalid(
                "snapshot_uri must not be empty".into(),
            ));
        }

        let ingested_raw = raw
            .ingested_addresses
            .ok_or_else(|| ManifestError::Invalid("missing field: ingested_addresses".into()))?;
        if ingested_raw.is_empty() {
            return Err(ManifestError::Invalid(
                "ingested_addresses must contain at least one address".into(),
            ));
        }
        let mut ingested = Vec::with_capacity(ingested_raw.len());
        for (i, s) in ingested_raw.iter().enumerate() {
            let a = s.parse::<Address>().map_err(|e| {
                ManifestError::Invalid(format!("ingested_addresses[{i}] invalid: {e}"))
            })?;
            ingested.push(a);
        }

        let holder_raw = raw
            .harness_usdc_holder
            .ok_or_else(|| ManifestError::Invalid("missing field: harness_usdc_holder".into()))?;
        let harness_usdc_holder = holder_raw
            .parse::<Address>()
            .map_err(|e| ManifestError::Invalid(format!("harness_usdc_holder invalid: {e}")))?;

        // Clean-history invariant: the harness EOA must not appear in the
        // ingested set. If it did, the genesis ingester would copy whatever
        // Base state (allowances, blacklist, inbound transfers) is attached
        // to that address — defeating the entire point of using a fresh EOA.
        if ingested.contains(&harness_usdc_holder) {
            return Err(ManifestError::Invalid(format!(
                "harness_usdc_holder {harness_usdc_holder} overlaps with ingested_addresses; \
                 the harness EOA must have clean Base history"
            )));
        }

        let grant_raw = raw.harness_usdc_grant_units.ok_or_else(|| {
            ManifestError::Invalid("missing field: harness_usdc_grant_units".into())
        })?;
        let harness_usdc_grant_units = grant_raw.parse::<u128>().map_err(|e| {
            ManifestError::Invalid(format!(
                "harness_usdc_grant_units must parse as u128, got {grant_raw:?}: {e}"
            ))
        })?;
        if harness_usdc_grant_units == 0 {
            return Err(ManifestError::Invalid(
                "harness_usdc_grant_units must be > 0".into(),
            ));
        }

        let pinned = raw.pinned.unwrap_or(false);

        // HARN-5: the snapshot content digest, when present, must be a
        // well-formed 0x-prefixed 32-byte sha256 hex string. A malformed
        // digest is rejected here so the ingester never silently treats an
        // unparseable digest as "no digest" and skips verification.
        let snapshot_sha256 = match raw.snapshot_sha256 {
            Some(s) => {
                if !is_valid_b256_hex(&s) {
                    return Err(ManifestError::Invalid(format!(
                        "snapshot_sha256 must be 0x-prefixed 32-byte hex, got {s:?}"
                    )));
                }
                Some(s.to_ascii_lowercase())
            }
            None => None,
        };

        Ok(ForkManifest {
            chain,
            block_number,
            block_hash,
            snapshot_uri,
            ingested_addresses: ingested,
            harness_usdc_holder,
            harness_usdc_grant_units,
            pinned,
            snapshot_sha256,
        })
    }

    /// HARN-5: verify that `snapshot_bytes` hashes to the manifest's
    /// `snapshot_sha256` digest. Returns:
    /// - `Ok(true)` when a digest is present and matches the bytes,
    /// - `Err(ManifestError::Invalid)` when a digest is present and does NOT
    ///   match (the snapshot was substituted or corrupted — reject before
    ///   ingest),
    /// - `Ok(false)` when no digest is present (unauthenticated; the caller
    ///   decides whether that is acceptable — the ingester refuses it under
    ///   `--require-pinned`).
    ///
    /// The genesis ingester calls this on the raw snapshot file bytes before
    /// constructing genesis `alloc`, so substituted/corrupted snapshot bytes
    /// are rejected rather than trusted.
    pub fn verify_snapshot_digest(&self, snapshot_bytes: &[u8]) -> Result<bool, ManifestError> {
        let Some(expected) = self.snapshot_sha256.as_deref() else {
            return Ok(false);
        };
        let actual = sha256_hex(snapshot_bytes);
        if actual != expected {
            return Err(ManifestError::Invalid(format!(
                "snapshot digest mismatch: manifest snapshot_sha256={expected} but ingested \
                 snapshot bytes hash to {actual}; refusing to ingest a snapshot that does not \
                 match the authenticated manifest digest"
            )));
        }
        Ok(true)
    }
}

/// SHA-256 of `bytes` as a `0x`-prefixed lowercase 64-hex string, matching the
/// shape stored in `snapshot_sha256`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    format!("0x{}", hex::encode(digest))
}

/// Returns true iff `s` is a `0x`-prefixed 32-byte hex string. Used to
/// reject `block_hash` values that are obviously not block hashes (wrong
/// length, missing prefix, non-hex characters).
fn is_valid_b256_hex(s: &str) -> bool {
    if !s.starts_with("0x") {
        return false;
    }
    let body = &s[2..];
    body.len() == 64 && body.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a structurally-valid manifest body. Tests then mutate one field
    /// at a time to exercise each rejection branch in isolation.
    fn valid_manifest_json() -> String {
        r#"{
            "chain": "base",
            "block_number": 45743443,
            "block_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
            "snapshot_uri": "file://x",
            "ingested_addresses": [
                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "0x4F835c9F54bCF17daf9040f60Cb72951CCbb49Dd"
            ],
            "harness_usdc_holder": "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5",
            "harness_usdc_grant_units": "1000000000000",
            "pinned": false
        }"#
        .to_string()
    }

    #[test]
    fn accepts_valid_manifest() {
        let m = ForkManifest::from_str(&valid_manifest_json()).expect("should parse");
        assert_eq!(m.chain, "base");
        assert_eq!(m.block_number, 45_743_443);
        assert_eq!(m.ingested_addresses.len(), 2);
        assert_eq!(m.harness_usdc_grant_units, 1_000_000_000_000);
        assert!(!m.pinned);
    }

    #[test]
    fn rejects_wrong_chain() {
        let bad = valid_manifest_json().replace("\"base\"", "\"ethereum\"");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("chain must be")));
    }

    #[test]
    fn rejects_missing_chain() {
        let bad = valid_manifest_json().replace("\"chain\": \"base\",", "");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("missing field: chain")));
    }

    #[test]
    fn rejects_missing_block_number() {
        let bad = valid_manifest_json().replace("\"block_number\": 45743443,", "");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("missing field: block_number"))
        );
    }

    #[test]
    fn rejects_zero_block_number() {
        let bad = valid_manifest_json().replace("45743443", "0");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("block_number must be > 0")));
    }

    #[test]
    fn rejects_missing_block_hash() {
        let bad = valid_manifest_json().replace(
            "\"block_hash\": \"0x1111111111111111111111111111111111111111111111111111111111111111\",",
            "",
        );
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("missing field: block_hash"))
        );
    }

    #[test]
    fn rejects_short_block_hash() {
        let bad = valid_manifest_json().replace(
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            "0xdeadbeef",
        );
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("block_hash must be")));
    }

    #[test]
    fn rejects_unprefixed_block_hash() {
        let bad = valid_manifest_json().replace(
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            "1111111111111111111111111111111111111111111111111111111111111111",
        );
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("block_hash must be")));
    }

    #[test]
    fn rejects_empty_ingested_addresses() {
        let bad = valid_manifest_json().replace(
            "\"ingested_addresses\": [\n                \"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\",\n                \"0x4F835c9F54bCF17daf9040f60Cb72951CCbb49Dd\"\n            ]",
            "\"ingested_addresses\": []",
        );
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("ingested_addresses must contain"))
        );
    }

    #[test]
    fn rejects_invalid_ingested_address() {
        let bad =
            valid_manifest_json().replace("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xnothex");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("ingested_addresses[0]")));
    }

    #[test]
    fn rejects_harness_holder_in_ingested_set() {
        // Replace the second ingested address with the harness holder address.
        let bad = valid_manifest_json().replace(
            "0x4F835c9F54bCF17daf9040f60Cb72951CCbb49Dd",
            "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5",
        );
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(
            err,
            ManifestError::Invalid(s) if s.contains("overlaps with ingested_addresses")
        ));
    }

    #[test]
    fn rejects_zero_grant_units() {
        let bad = valid_manifest_json().replace("\"1000000000000\"", "\"0\"");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("harness_usdc_grant_units must be > 0"))
        );
    }

    #[test]
    fn rejects_non_numeric_grant_units() {
        let bad = valid_manifest_json().replace("\"1000000000000\"", "\"not-a-number\"");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(matches!(err, ManifestError::Invalid(s) if s.contains("must parse as u128")));
    }

    #[test]
    fn rejects_empty_snapshot_uri() {
        let bad = valid_manifest_json().replace("\"file://x\"", "\"\"");
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("snapshot_uri must not be empty"))
        );
    }

    // ── HARN-5 (issue #1026): snapshot-bytes digest authentication ──────────

    /// A manifest body carrying a well-formed `snapshot_sha256` whose value is
    /// the actual sha256 of `snapshot_bytes`. Returns (json, bytes) so tests
    /// can assert verification both matches and rejects substitution.
    fn manifest_with_digest_for(snapshot_bytes: &[u8]) -> (String, Vec<u8>) {
        let digest = sha256_hex(snapshot_bytes);
        let json = valid_manifest_json().replace(
            "\"pinned\": false",
            &format!("\"pinned\": false,\n            \"snapshot_sha256\": \"{digest}\""),
        );
        (json, snapshot_bytes.to_vec())
    }

    #[test]
    fn accepts_valid_snapshot_digest_field() {
        let (json, _) = manifest_with_digest_for(b"hello fork snapshot");
        let m = ForkManifest::from_str(&json).expect("should parse with snapshot_sha256");
        assert!(m.snapshot_sha256.is_some());
        // Stored lowercase, 0x-prefixed, 64 hex chars.
        let d = m.snapshot_sha256.unwrap();
        assert!(d.starts_with("0x") && d.len() == 66 && d == d.to_ascii_lowercase());
    }

    #[test]
    fn snapshot_sha256_absent_is_none() {
        let m = ForkManifest::from_str(&valid_manifest_json()).expect("parses");
        assert!(m.snapshot_sha256.is_none());
    }

    #[test]
    fn rejects_malformed_snapshot_digest() {
        let bad = valid_manifest_json().replace(
            "\"pinned\": false",
            "\"pinned\": false,\n            \"snapshot_sha256\": \"0xdeadbeef\"",
        );
        let err = ForkManifest::from_str(&bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("snapshot_sha256 must be")),
            "malformed digest must be rejected at parse time"
        );
    }

    /// AC: a fork manifest whose snapshot bytes do NOT match the manifest
    /// digest is rejected before ingest. `verify_snapshot_digest` returns
    /// `Err` on mismatch — the genesis ingester treats that as a hard refusal.
    #[test]
    fn rejects_snapshot_bytes_that_mismatch_digest() {
        let (json, bytes) = manifest_with_digest_for(b"the authentic snapshot bytes");
        let m = ForkManifest::from_str(&json).expect("parses");

        // Matching bytes verify Ok(true).
        assert!(m.verify_snapshot_digest(&bytes).unwrap());

        // Substituted/corrupted bytes are rejected with a digest-mismatch error.
        let substituted = b"a DIFFERENT (substituted) snapshot payload";
        let err = m
            .verify_snapshot_digest(substituted)
            .expect_err("mismatched snapshot bytes must be rejected");
        assert!(
            matches!(err, ManifestError::Invalid(s) if s.contains("snapshot digest mismatch")),
            "mismatch must surface as a digest-mismatch ManifestError"
        );
    }

    #[test]
    fn verify_snapshot_digest_absent_returns_false() {
        let m = ForkManifest::from_str(&valid_manifest_json()).expect("parses");
        // No digest present ⇒ Ok(false) (unauthenticated; caller decides).
        assert!(!m.verify_snapshot_digest(b"anything").unwrap());
    }

    #[test]
    fn sha256_hex_is_stable_and_lowercase() {
        // Known vector: sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            sha256_hex(b""),
            "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn pinned_defaults_to_false_when_absent() {
        let bad = valid_manifest_json().replace(",\n            \"pinned\": false", "");
        let m = ForkManifest::from_str(&bad).expect("should parse without pinned field");
        assert!(!m.pinned);
    }

    /// The smoke-test devnet's pinned fork block MUST match the Anvil
    /// fork-e2e fixture's pin in `testing/fixtures/fork-state/CURRENT.json`.
    /// Both harnesses test the same Robot Money contracts against the same
    /// USDC / DEX state; diverging fork blocks would make scenario
    /// reproducibility cross-harness impossible. See
    /// docs/development/smoke-test-design.md (Devnet section).
    #[test]
    fn fork_block_aligns_with_anvil_fixture_current() {
        let repo = crate::locate_repo_root().expect("locate repo root");
        let manifest =
            ForkManifest::load(&repo.join("testing/ethereum-testnet/config/fork-block.json"))
                .expect("manifest validates");

        let current_raw =
            std::fs::read_to_string(repo.join("testing/fixtures/fork-state/CURRENT.json"))
                .expect("CURRENT.json readable");
        let current: serde_json::Value =
            serde_json::from_str(&current_raw).expect("CURRENT.json parses");
        let current_fork_block = current["fork_block"]
            .as_u64()
            .expect("CURRENT.json has fork_block: u64");

        assert_eq!(
            manifest.block_number, current_fork_block,
            "smoke-test fork-block.json block_number ({}) drifted from \
             Anvil fork-e2e CURRENT.json fork_block ({}); refresh both \
             together via scripts/devnet/snapshot-fork.sh",
            manifest.block_number, current_fork_block
        );
    }

    /// The committed `testing/ethereum-testnet/config/fork-block.json` must
    /// load and validate. This is the CI guard that fails the build if the
    /// committed manifest drifts out of compliance with the schema.
    #[test]
    fn committed_manifest_validates() {
        let repo = crate::locate_repo_root().expect("locate repo root");
        let path = repo.join("testing/ethereum-testnet/config/fork-block.json");
        let m = ForkManifest::load(&path)
            .unwrap_or_else(|e| panic!("committed fork-block.json failed validation: {e}"));
        assert_eq!(m.chain, "base");
        // The harness EOA in the committed manifest must match the constant
        // exported from `smoke_test::HARNESS_USDC_HOLDER_ADDRESS_HEX`.
        let expected: Address = crate::HARNESS_USDC_HOLDER_ADDRESS_HEX
            .parse()
            .expect("HARNESS_USDC_HOLDER_ADDRESS_HEX parses");
        assert_eq!(m.harness_usdc_holder, expected);
    }

    /// HARN-5 CI guard (issue #1026): the committed manifest MUST carry a
    /// `snapshot_sha256`, and it MUST match the sha256 of the committed
    /// `CURRENT.anvil-state` snapshot the genesis ingester ingests. This fails
    /// the build if a fixture refresh bumps the snapshot bytes without
    /// recomputing the digest (or vice-versa), so the devnet can never ingest
    /// an unauthenticated/stale snapshot.
    #[test]
    fn committed_manifest_authenticates_current_snapshot() {
        let repo = crate::locate_repo_root().expect("locate repo root");
        let manifest =
            ForkManifest::load(&repo.join("testing/ethereum-testnet/config/fork-block.json"))
                .expect("manifest validates");
        assert!(
            manifest.snapshot_sha256.is_some(),
            "committed fork-block.json must carry snapshot_sha256 (HARN-5); add the sha256 of \
             testing/fixtures/fork-state/CURRENT.anvil-state"
        );

        let snapshot_path = repo.join("testing/fixtures/fork-state/CURRENT.anvil-state");
        let bytes = std::fs::read(&snapshot_path).expect("read CURRENT.anvil-state");
        let verified = manifest
            .verify_snapshot_digest(&bytes)
            .expect("committed snapshot must match committed snapshot_sha256 digest");
        assert!(
            verified,
            "verify_snapshot_digest returned false despite snapshot_sha256 being present"
        );
    }

    /// CI guard for issue #557: every pair in the expected-prices fixture must
    /// have `captured: true` and a non-null `expected_price` so that the fork
    /// integration test's magnitude assertions are active for all pairs. A
    /// pair with `captured: false` or `expected_price: null` silently disables
    /// the price-drift assertion for that pair, hiding stale fixture values.
    /// See docs/prd.md#112-protocol-asset-vault.
    #[test]
    fn all_pairs_captured_and_priced() {
        let repo = crate::locate_repo_root().expect("locate repo root");
        let fixture_raw = std::fs::read_to_string(
            repo.join("testing/ethereum-testnet/config/expected-prices.json"),
        )
        .expect("expected-prices.json readable");
        let fixture: serde_json::Value =
            serde_json::from_str(&fixture_raw).expect("expected-prices.json parses");

        let pairs = fixture["pairs"]
            .as_array()
            .expect("expected-prices.json pairs is an array");
        assert!(
            !pairs.is_empty(),
            "expected-prices.json must have at least one pair"
        );

        for pair in pairs {
            let id = pair["id"].as_str().unwrap_or("<unknown>");
            assert!(
                pair["captured"].as_bool() == Some(true),
                "pair {id}: captured must be true (run scripts/devnet/snapshot-fork.sh \
                 against a Base archive RPC and update expected_price + captured per pair)"
            );
            assert!(
                pair["expected_price"].as_f64().is_some(),
                "pair {id}: expected_price must be a non-null number (run \
                 scripts/devnet/snapshot-fork.sh against a Base archive RPC)"
            );
        }
    }

    /// CI guard for issue #482: the landing-page price-strip expected-prices
    /// fixture (`testing/ethereum-testnet/config/expected-prices.json`) is
    /// pinned to the fork-block manifest. If the fork block is bumped without
    /// the fixture being refreshed in the same commit, this test fails — the
    /// fixture's recorded prices would no longer correspond to on-chain state
    /// at the new block, silently breaking the fork-proof demo point.
    /// See docs/prd.md#112-protocol-asset-vault.
    #[test]
    fn fork_block_aligns_with_expected_prices() {
        let repo = crate::locate_repo_root().expect("locate repo root");
        let manifest =
            ForkManifest::load(&repo.join("testing/ethereum-testnet/config/fork-block.json"))
                .expect("manifest validates");

        let fixture_raw = std::fs::read_to_string(
            repo.join("testing/ethereum-testnet/config/expected-prices.json"),
        )
        .expect("expected-prices.json readable");
        let fixture: serde_json::Value =
            serde_json::from_str(&fixture_raw).expect("expected-prices.json parses");

        let fixture_block = fixture["fork_block"]
            .as_u64()
            .expect("expected-prices.json has fork_block: u64");
        assert_eq!(
            manifest.block_number, fixture_block,
            "fork-block.json block_number ({}) drifted from expected-prices.json \
             fork_block ({}); refresh the price fixture in the same commit that \
             bumps the fork block (issue #482)",
            manifest.block_number, fixture_block
        );

        // The fixture must enumerate exactly the four landing-strip pairs so a
        // dropped/renamed pair is caught here rather than at demo time.
        let pairs = fixture["pairs"]
            .as_array()
            .expect("expected-prices.json pairs is an array");
        let ids: Vec<&str> = pairs
            .iter()
            .map(|p| p["id"].as_str().expect("pair id is a string"))
            .collect();
        assert_eq!(
            ids,
            vec!["eth-usd", "weth-usdc", "cbbtc-usdc", "wsol-usdc"],
            "expected-prices.json must list the four landing-strip pairs in order"
        );

        // Guard: every pool address referenced in expected-prices.json must be
        // present in fork-block.json::ingested_addresses.  If a DEX pool
        // address is NOT ingested the genesis alloc will not contain that
        // pool's storage, so the forked-Base devnet will have a zeroed slot0
        // and the price strip will read 0.  Failing here catches the drift at
        // manifest-validation time rather than at demo boot time.
        let ingested_lower: std::collections::HashSet<String> = manifest
            .ingested_addresses
            .iter()
            .map(|a| a.to_string().to_lowercase())
            .collect();
        for pair in pairs {
            let pool_raw = pair["pool"]
                .as_str()
                .expect("each expected-prices pair has a pool field");
            let pool_lower = pool_raw.to_lowercase();
            assert!(
                ingested_lower.contains(&pool_lower),
                "expected-prices.json pair {:?} references pool {} which is absent from \
                 fork-block.json ingested_addresses; add the pool to ingested_addresses \
                 in the same commit that refreshes the price fixture (issue #558)",
                pair["id"].as_str().unwrap_or("?"),
                pool_raw
            );
        }
    }

    /// Simulates a fork-block bump where the developer forgot to add the new
    /// pool address to `ingested_addresses`.  The guard in
    /// `fork_block_aligns_with_expected_prices` must catch this by detecting
    /// the pool referenced in expected-prices.json is absent from
    /// `ingested_addresses`.  This test exercises that logic path in isolation
    /// without touching the on-disk fixtures (issue #558).
    #[test]
    fn pool_missing_from_ingested_addresses_is_detected() {
        // Build a manifest that does NOT include the pool address that will
        // appear in the simulated expected-prices fixture.
        let manifest_json = r#"{
            "chain": "base",
            "block_number": 99999999,
            "block_hash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "snapshot_uri": "file://testing/fixtures/fork-state/genesis-alloc.json",
            "ingested_addresses": [
                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
            ],
            "harness_usdc_holder": "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5",
            "harness_usdc_grant_units": "1000000000000",
            "pinned": false
        }"#;
        let manifest = ForkManifest::from_str(manifest_json).expect("manifest parses");

        // Simulate an expected-prices fixture that references a pool address
        // NOT in the manifest's ingested_addresses — exactly the condition that
        // occurs when a fork block is bumped without refreshing the pool list.
        let prices_json: serde_json::Value = serde_json::from_str(
            r#"{
            "fork_block": 99999999,
            "chain": "base",
            "pairs": [
                {
                    "id": "eth-usd",
                    "pool": "0xd0b53D9277642d899DF5C87A3966A349A798F224",
                    "base_decimals": 18,
                    "quote_decimals": 6,
                    "base_is_token0": true,
                    "expected_price": 3000.0
                }
            ]
        }"#,
        )
        .unwrap();

        let ingested_lower: std::collections::HashSet<String> = manifest
            .ingested_addresses
            .iter()
            .map(|a| a.to_string().to_lowercase())
            .collect();

        let pairs = prices_json["pairs"].as_array().unwrap();
        let unsynced: Vec<&str> = pairs
            .iter()
            .filter_map(|p| {
                let pool = p["pool"].as_str()?;
                if ingested_lower.contains(&pool.to_lowercase()) {
                    None
                } else {
                    Some(pool)
                }
            })
            .collect();

        assert!(
            !unsynced.is_empty(),
            "expected the guard to detect pool 0xd0b53... as missing from ingested_addresses"
        );
        assert_eq!(
            unsynced,
            vec!["0xd0b53D9277642d899DF5C87A3966A349A798F224"],
            "guard must report the specific un-ingested pool address"
        );
    }
}
