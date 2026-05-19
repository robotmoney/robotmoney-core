//! Canonical: docs/architecture.md §8 — Signer Backends
//!
//! `signer` module — `AgentSigner` trait and backends.
//!
//! Issue #8 / `docs/implementation-plan.md` §3.2–§3.3. The trait is
//! deliberately narrow: only [`AgentSigner::sign_eip1559_hash`] — the
//! live deposit path. Raw `sign_hash` / `sign_message` /
//! `sign_typed_data` are intentionally absent so future HSM/KMS
//! backends cannot widen the signing surface.
//!
//! The MVP backend lives in [`software`] and decrypts a passphrase-protected
//! keystore on demand.
//!
//! NB: alloy 0.5.4's `Signature` is the type the EIP-1559 envelope path
//! (`tx::encode_signed`) consumes; the upstream type is marked deprecated
//! pending a crate-wide upgrade to `PrimitiveSignature`. We silence the
//! deprecation here because the wire format is unchanged — the upgrade is
//! a separate workstream tracked alongside the alloy bump.

#![allow(deprecated)]

use alloy_primitives::{Address, Signature as AlloySignature};
use thiserror::Error;

use crate::errors::{Result as RmpcResult, RmpcError};
use crate::network_env::NetworkEnv;

pub mod software;

/// Backend kinds the daemon may report to operators (see `rmpc self-check`).
///
/// The MVP only ships [`SignerBackendKind::Software`]; the other variants
/// are reserved so the on-the-wire `backend_kind` JSON value does not change
/// when HSM/KMS land later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignerBackendKind {
    /// Encrypted-at-rest keystore decrypted in process memory. v0 §10.5.
    Software,
    /// Reserved — hardware security module backend.
    Hsm,
    /// Reserved — cloud KMS backend.
    Kms,
}

/// Errors surfaced by signer backends.
///
/// Variant names are part of the operator-visible contract (matched by log
/// scrapers and the `rmpc self-check` JSON). Renaming a variant is a
/// breaking change.
#[derive(Debug, Error)]
#[allow(clippy::enum_variant_names)]
pub enum SignerError {
    /// `[signer].allow_software_fallback` was not set to `true`.
    #[error("ErrSoftwareSignerDisallowed: [signer].allow_software_fallback must be true")]
    ErrSoftwareSignerDisallowed,
    /// Keystore file could not be read.
    #[error("ErrKeystoreIo: {0}")]
    ErrKeystoreIo(String),
    /// Keystore file was malformed JSON or had wrong fields.
    #[error("ErrKeystoreFormat: {0}")]
    ErrKeystoreFormat(String),
    /// Decryption failed — passphrase wrong, file corrupted, or tampered with.
    #[error("ErrKeystoreDecrypt: passphrase rejected or keystore tampered")]
    ErrKeystoreDecrypt,
    /// Passphrase source (env / stdin) could not be read.
    #[error("ErrPassphrase: {0}")]
    ErrPassphrase(String),
    /// Underlying secp256k1 error.
    #[error("ErrSign: {0}")]
    ErrSign(String),
}

/// Sign-only handle for an agent's signing key.
///
/// Implementations MUST NOT expose a generic signing oracle — only the
/// EIP-1559 envelope hash is signable. See §3.2.
///
/// The trait is deliberately synchronous: software signing is a few
/// microseconds of CPU; an HSM/KMS backend can park the whole thread on
/// its own runtime if it wants. Forcing async on every caller would push
/// the entire daemon onto a runtime for no MVP benefit.
pub trait AgentSigner: Send + Sync {
    /// Which backend is in use. Surfaced in `rmpc self-check`.
    fn backend_kind(&self) -> SignerBackendKind;

    /// Public Ethereum address derived from the signing key.
    fn public_address(&self) -> Address;

    /// Sign the raw 32-byte EIP-1559 transaction signing-hash and return an
    /// alloy [`AlloySignature`] (with parity bit set for typed-tx use).
    ///
    /// This is the only signing entry point on the trait. The
    /// envelope itself is computed by `tx::build_eip1559` from
    /// fields the caller controls; signing arbitrary digests outside
    /// the envelope is not exposed.
    fn sign_eip1559_hash(&self, hash: &[u8; 32]) -> Result<AlloySignature, SignerError>;
}

/// Returns whether a signer backend is acceptable for production writes.
pub const fn backend_is_production_grade(kind: SignerBackendKind) -> bool {
    matches!(kind, SignerBackendKind::Hsm | SignerBackendKind::Kms)
}

/// Refuse non-production signers before write commands decrypt a software
/// keystore or build a transaction for production Base.
pub fn require_production_grade_for_write(
    chain_id: u64,
    backend: SignerBackendKind,
) -> RmpcResult<()> {
    if NetworkEnv::from_chain_id(chain_id).is_production() && !backend_is_production_grade(backend)
    {
        Err(RmpcError::ErrProductionSignerRequired)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-only check: `AgentSigner` must be object-safe (downstream
    /// callers will hold a `Box<dyn AgentSigner>`).
    #[allow(dead_code)]
    fn assert_object_safe(_: &dyn AgentSigner) {}

    #[test]
    fn backend_kind_serializes_kebab_case() {
        let s = serde_json::to_string(&SignerBackendKind::Software).unwrap();
        assert_eq!(s, "\"software\"");
    }

    #[test]
    fn production_base_refuses_software_signer_for_writes() {
        let err = require_production_grade_for_write(8453, SignerBackendKind::Software)
            .expect_err("software signer must be refused on Base mainnet");
        assert!(matches!(err, RmpcError::ErrProductionSignerRequired));
        assert!(format!("{err}").contains("HSM/KMS"));
    }

    #[test]
    fn devnet_allows_software_signer_for_writes() {
        require_production_grade_for_write(31337, SignerBackendKind::Software)
            .expect("local devnet software signer remains available");
    }

    #[test]
    fn production_base_allows_reserved_production_grade_backends() {
        require_production_grade_for_write(8453, SignerBackendKind::Hsm)
            .expect("HSM is production grade");
        require_production_grade_for_write(8453, SignerBackendKind::Kms)
            .expect("KMS is production grade");
    }
}
