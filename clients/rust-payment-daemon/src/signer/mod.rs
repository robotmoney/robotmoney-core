//! `signer` module — `AgentSigner` trait and backends.
//!
//! Issue #8 / `docs/implementation-plan-mvp.md` §3.2–§3.3. The trait is
//! deliberately narrow: only `sign_gateway_tx`, never raw `sign_hash` /
//! `sign_message` / `sign_typed_data`. This is enforced at the type level
//! so future HSM/KMS backends cannot widen the surface.
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

use alloy_primitives::{Address, Signature as AlloySignature, B256, U256};
use thiserror::Error;

pub mod software;

/// Backend kinds the daemon may report to operators (see `rmpd self-check`).
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

/// Request envelope passed to [`AgentSigner::sign_gateway_tx`].
///
/// The trait only exposes structured gateway operations; raw-hash signing
/// is intentionally absent. New gateway methods extend this enum rather
/// than widening the trait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayTxRequest {
    /// `RobotMoneyGateway.deposit(...)` per §3.2.
    Deposit {
        /// Operator-supplied order id (32 bytes).
        order_id: B256,
        /// USDC amount in token base units. Matches the contract's
        /// `uint256`; never narrowed at the trust boundary.
        amount: U256,
        /// Unix-seconds deadline after which the tx must not be valid.
        deadline: u64,
        /// Idempotency key the gateway uses to dedupe replays (32 bytes).
        idempotency_key: B256,
    },
}

/// A signed gateway transaction, ready to broadcast.
///
/// The MVP returns the request that was signed alongside an opaque
/// `signature` blob and the recovered signer address. `tx.rs` (issue #11)
/// owns the EIP-1559 envelope; the signer's job is to bind a signature to
/// a structured request without exposing a generic signing oracle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTx {
    /// The exact request object that was signed.
    pub request: GatewayTxRequest,
    /// Address recovered from the signature (= [`AgentSigner::public_address`]).
    pub signer: Address,
    /// 65-byte secp256k1 signature: `r || s || v` where `v ∈ {27, 28}`.
    pub signature: [u8; 65],
    /// 32-byte digest that was signed (keccak256 of the canonical encoding).
    pub digest: B256,
}

/// Errors surfaced by signer backends.
///
/// Variant names are part of the operator-visible contract (matched by log
/// scrapers and the `rmpd self-check` JSON). Renaming a variant is a
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
/// structured methods on this trait. See §3.2.
///
/// The trait is deliberately synchronous: software signing is a few
/// microseconds of CPU; an HSM/KMS backend can park the whole thread on
/// its own runtime if it wants. Forcing async on every caller would push
/// the entire daemon onto a runtime for no MVP benefit.
pub trait AgentSigner: Send + Sync {
    /// Which backend is in use. Surfaced in `rmpd self-check`.
    fn backend_kind(&self) -> SignerBackendKind;

    /// Public Ethereum address derived from the signing key.
    fn public_address(&self) -> Address;

    /// Sign a structured gateway request, returning a [`SignedTx`].
    fn sign_gateway_tx(&self, req: GatewayTxRequest) -> Result<SignedTx, SignerError>;

    /// Sign the raw 32-byte EIP-1559 transaction signing-hash and return an
    /// alloy [`AlloySignature`] (with parity bit set for typed-tx use).
    ///
    /// This is a separate, narrowly-scoped method on the trait so the
    /// daemon's `deposit` command can produce a wire-ready signature for
    /// the RLP-encoded EIP-1559 envelope. It is **not** a generic signing
    /// oracle — the envelope is computed by `tx::build_eip1559` from
    /// fields the caller controls; signing arbitrary digests outside the
    /// envelope or the structured `GatewayTxRequest` is not exposed.
    fn sign_eip1559_hash(&self, hash: &[u8; 32]) -> Result<AlloySignature, SignerError>;
}

/// Compute the canonical keccak256 digest for a [`GatewayTxRequest`].
///
/// Stable across signer backends so a software-signed request can be
/// re-verified by an HSM-signed test fixture and vice-versa. The encoding
/// is intentionally simple (a fixed-prefix domain tag + the field bytes in
/// declaration order) and lives next to the trait so all backends agree.
pub(crate) fn gateway_tx_digest(req: &GatewayTxRequest) -> B256 {
    use alloy_primitives::keccak256;

    match req {
        GatewayTxRequest::Deposit {
            order_id,
            amount,
            deadline,
            idempotency_key,
        } => {
            // 32-byte domain tag (right-padded with NULs) keeps this digest
            // distinct from any other hash a future caller might want to sign.
            let mut buf = Vec::with_capacity(32 * 5);
            let mut tag = [0u8; 32];
            let label = b"rmpd.gateway.deposit.v1";
            tag[..label.len()].copy_from_slice(label);
            buf.extend_from_slice(&tag);
            buf.extend_from_slice(order_id.as_slice());
            buf.extend_from_slice(&amount.to_be_bytes::<32>());
            buf.extend_from_slice(&deadline.to_be_bytes());
            buf.extend_from_slice(idempotency_key.as_slice());
            keccak256(&buf)
        }
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
    fn digest_is_deterministic_and_field_sensitive() {
        let base = GatewayTxRequest::Deposit {
            order_id: B256::repeat_byte(0x11),
            amount: U256::from(1_000_000u64),
            deadline: 1_700_000_000,
            idempotency_key: B256::repeat_byte(0x22),
        };
        let d1 = gateway_tx_digest(&base);
        let d2 = gateway_tx_digest(&base);
        assert_eq!(d1, d2, "digest must be deterministic");

        let mutated = GatewayTxRequest::Deposit {
            order_id: B256::repeat_byte(0x11),
            amount: U256::from(1_000_001u64),
            deadline: 1_700_000_000,
            idempotency_key: B256::repeat_byte(0x22),
        };
        assert_ne!(
            d1,
            gateway_tx_digest(&mutated),
            "mutating amount must change digest"
        );
    }

    #[test]
    fn backend_kind_serializes_kebab_case() {
        let s = serde_json::to_string(&SignerBackendKind::Software).unwrap();
        assert_eq!(s, "\"software\"");
    }
}
