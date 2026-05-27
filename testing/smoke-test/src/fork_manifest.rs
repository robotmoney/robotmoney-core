//! Canonical: docs/development/smoke-test-design.md (Devnet + USDC faucet sections).
//! Implements: issue #255 — fork-block manifest validator.
//!
//! The fork-block manifest lives at `testing/ethereum-testnet/config/fork-block.json`
//! and is the single source of truth for the Base mainnet fork point used to
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

        Ok(ForkManifest {
            chain,
            block_number,
            block_hash,
            snapshot_uri,
            ingested_addresses: ingested,
            harness_usdc_holder,
            harness_usdc_grant_units,
            pinned,
        })
    }
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

        // snapshot_uri must resolve to the same Anvil state file the
        // fork-e2e harness already uses, so both stacks ingest the same
        // captured state.
        assert!(
            manifest
                .snapshot_uri
                .contains("testing/fixtures/fork-state/CURRENT.anvil-state"),
            "snapshot_uri ({:?}) must point at testing/fixtures/fork-state/\
             CURRENT.anvil-state so the smoke-test devnet and fork-e2e \
             Anvil tests share one captured-state file",
            manifest.snapshot_uri
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
}
