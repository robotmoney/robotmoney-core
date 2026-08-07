//! Canonical: no in-repo doc — the demo protocol this module implements is
//! owned by the sibling `robotmoney-frontend` repo (its README's "Attach a
//! prospective agent" section + `docs/ARCHITECTURE.md` §9). Not the same
//! feature as `docs/product/20260623-product-proposal-investment-committee-v0.md`,
//! which scopes the separate **on-chain** IC v0 that `rmpc committee
//! register`/`vote-submit` implement.
//! Implements: issue #1111 — `rmpc committee-identity`: committee signing identity
//!
//! Encrypted-at-rest Ed25519 identity for the Investment Committee demo's
//! plain-REST flow (`robotmoney-frontend`: public apply -> human approval
//! -> claim via challenge/signature -> participate; no MCP transport is
//! involved). This is a **distinct identity type** from the on-chain EVM
//! signer used by `rmpc committee register` / `vote-submit` (see
//! [`crate::signer`]): the demo's HTTP verifier (`@robotmoney/contract`'s
//! `canonicalizeSubmission` plus `crypto.subtle.verify({name:"Ed25519"})`)
//! expects a **raw 32-byte Ed25519 public key** and a **raw 64-byte
//! Ed25519 signature** over the UTF-8 bytes of the canonical JSON payload,
//! both base64-encoded with the **standard, padded** alphabet — not an EVM
//! key or ECDSA signature of any kind. Matching that wire format exactly is
//! what lets a fresh agent apply/sign/submit without writing custom crypto
//! code (issue #1111 AC-1) and without any change on the frontend side.
//!
//! On-disk layout deliberately mirrors [`crate::signer::software`]'s
//! keystore format (Argon2id KDF + AES-256-GCM, with the public
//! identifier stored in cleartext for inspection) with the key material
//! swapped for a 32-byte Ed25519 seed:
//!
//! ```json
//! {
//!   "version": 1,
//!   "kind": "rmpc-committee-identity-keystore",
//!   "public_key": "<base64, 32-byte raw Ed25519 public key>",
//!   "kdf": {
//!     "name": "argon2id",
//!     "salt": "<hex 16+ bytes>",
//!     "m_cost": 19456, "t_cost": 2, "p_cost": 1
//!   },
//!   "cipher": {
//!     "name": "aes-256-gcm",
//!     "nonce": "<hex 12 bytes>",
//!     "ciphertext": "<hex; 32-byte plaintext seed + 16-byte AEAD tag>"
//!   }
//! }
//! ```
//!
//! `public_key` is stored in cleartext (exactly like the EVM keystore's
//! `address` field) so `rmpc committee-identity show-public-key` never
//! needs the passphrase — only `sign` decrypts the private seed. Ed25519
//! signing (RFC 8032) is deterministic: no external randomness is consumed
//! once the key is loaded, so signing the same payload bytes twice with
//! the same identity always yields the same signature.

use std::path::Path;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

/// Env var carrying the passphrase used to encrypt/decrypt the keystore.
/// Read only from the environment; never accepted on argv (would leak via
/// `ps`) and never prompted on stdin (a non-interactive agent invocation
/// must fail loudly instead of hanging on a TTY read that will never
/// arrive — same rationale as `rmpc committee register`/`vote-submit`'s
/// signer loader).
pub const PASSPHRASE_ENV_VAR: &str = "RMPC_COMMITTEE_IDENTITY_PASSPHRASE";

/// Argon2id parameters baked into the on-disk format. Matches the
/// software EVM keystore's OWASP "second" recommendation.
const ARGON2_M_COST_KIB: u32 = 19_456; // ~19 MiB
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

/// Length of the AES-256 key derived from the passphrase.
const KEY_LEN: usize = 32;
/// AES-GCM standard nonce length.
const NONCE_LEN: usize = 12;
/// Length of an Ed25519 seed / raw public key / raw signature half.
const SEED_LEN: usize = 32;
/// Minimum salt length accepted on load (Argon2 RFC recommends >= 16).
const MIN_SALT_LEN: usize = 16;
/// Discriminator string identifying this keystore format.
const KEYSTORE_KIND: &str = "rmpc-committee-identity-keystore";

/// Errors surfaced by the committee-identity module. Variant names are
/// part of the operator/agent-visible contract (matched by the CLI's JSON
/// `error` field) — renaming a variant is a breaking change.
#[derive(Debug, Error)]
#[allow(clippy::enum_variant_names)]
pub enum CommitteeIdentityError {
    /// `create` was pointed at a path that already has a file. Refusing
    /// to overwrite protects against silently clobbering an existing
    /// identity (and the on-chain/API registrations tied to its public
    /// key).
    #[error("ErrIdentityExists: keystore already exists at {0}; refusing to overwrite")]
    ErrIdentityExists(String),
    /// Keystore file could not be read or written.
    #[error("ErrKeystoreIo: {0}")]
    ErrKeystoreIo(String),
    /// Keystore file was malformed JSON or had wrong fields.
    #[error("ErrKeystoreFormat: {0}")]
    ErrKeystoreFormat(String),
    /// Decryption failed — passphrase wrong, file corrupted, or tampered
    /// with.
    #[error("ErrKeystoreDecrypt: passphrase rejected or keystore tampered")]
    ErrKeystoreDecrypt,
    /// Passphrase source (env var) could not be read.
    #[error("ErrPassphrase: {0}")]
    ErrPassphrase(String),
    /// Underlying Ed25519/AEAD error.
    #[error("ErrSign: {0}")]
    ErrSign(String),
    /// A payload file has bytes that cannot be part of the compact canonical
    /// JSON payload emitted by the committee API. Refuse rather than signing
    /// an almost-correct file whose signature the API will reject.
    #[error("ErrPayloadFormat: {0}")]
    ErrPayloadFormat(String),
}

/// On-disk keystore document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keystore {
    /// File-format version. Must be `1`.
    pub version: u32,
    /// Discriminator string. Must be [`KEYSTORE_KIND`].
    pub kind: String,
    /// Base64 (standard, padded) raw 32-byte Ed25519 public key. Stored
    /// in cleartext so callers can export it without decrypting.
    pub public_key: String,
    pub kdf: KdfParams,
    pub cipher: CipherParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KdfParams {
    /// Must be `"argon2id"`.
    pub name: String,
    /// Hex-encoded salt (>= 16 bytes).
    pub salt: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CipherParams {
    /// Must be `"aes-256-gcm"`.
    pub name: String,
    /// Hex-encoded 12-byte nonce.
    pub nonce: String,
    /// Hex-encoded ciphertext: `AES-256-GCM(plaintext_seed)` with the
    /// 16-byte AEAD tag appended (length = 48).
    pub ciphertext: String,
}

/// A loaded, decrypted committee signing identity.
pub struct CommitteeIdentity {
    signing_key: SigningKey,
}

impl std::fmt::Debug for CommitteeIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never debug-print the signing key.
        f.debug_struct("CommitteeIdentity")
            .field("public_key", &self.public_key_b64())
            .finish()
    }
}

impl CommitteeIdentity {
    /// Generate a fresh Ed25519 identity and write an encrypted keystore
    /// to `path`, encrypted under `passphrase`. Refuses to overwrite an
    /// existing file at `path`.
    pub fn create<P: AsRef<Path>>(
        path: P,
        passphrase: &[u8],
    ) -> Result<Keystore, CommitteeIdentityError> {
        let path = path.as_ref();
        if path.exists() {
            return Err(CommitteeIdentityError::ErrIdentityExists(
                path.display().to_string(),
            ));
        }

        let mut seed = [0u8; SEED_LEN];
        OsRng.fill_bytes(&mut seed);
        let keystore = Self::encrypt_seed(&seed, passphrase)?;
        seed.zeroize();

        let json = serde_json::to_string_pretty(&keystore)
            .map_err(|e| CommitteeIdentityError::ErrKeystoreFormat(e.to_string()))?;
        std::fs::write(path, json)
            .map_err(|e| CommitteeIdentityError::ErrKeystoreIo(e.to_string()))?;

        Ok(keystore)
    }

    fn encrypt_seed(
        seed: &[u8; SEED_LEN],
        passphrase: &[u8],
    ) -> Result<Keystore, CommitteeIdentityError> {
        let signing_key = SigningKey::from_bytes(seed);
        let public_key = signing_key.verifying_key().to_bytes();
        let public_key_b64 = BASE64.encode(public_key);

        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);

        let mut key_bytes = derive_key(
            passphrase,
            &salt,
            ARGON2_M_COST_KIB,
            ARGON2_T_COST,
            ARGON2_P_COST,
        )?;
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| CommitteeIdentityError::ErrSign(format!("aes init: {e}")))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        // Bind the public key to the AEAD via additional data — a swapped
        // ciphertext under a fresh passphrase cannot be passed off as a
        // matching keystore for a different claimed public key.
        let aad = public_key.to_vec();
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: seed.as_slice(),
                    aad: &aad,
                },
            )
            .map_err(|e| CommitteeIdentityError::ErrSign(format!("aes encrypt: {e}")))?;
        key_bytes.zeroize();

        Ok(Keystore {
            version: 1,
            kind: KEYSTORE_KIND.to_string(),
            public_key: public_key_b64,
            kdf: KdfParams {
                name: "argon2id".to_string(),
                salt: hex::encode(salt),
                m_cost: ARGON2_M_COST_KIB,
                t_cost: ARGON2_T_COST,
                p_cost: ARGON2_P_COST,
            },
            cipher: CipherParams {
                name: "aes-256-gcm".to_string(),
                nonce: hex::encode(nonce_bytes),
                ciphertext: hex::encode(&ciphertext),
            },
        })
    }

    /// Read the `public_key` field straight from the on-disk keystore
    /// without decrypting — mirrors the EVM keystore's cleartext
    /// `address` field. No passphrase required.
    pub fn public_key_from_path<P: AsRef<Path>>(path: P) -> Result<String, CommitteeIdentityError> {
        Ok(Self::read_keystore_file(path)?.public_key)
    }

    /// Load and decrypt the keystore at `path` under `passphrase`.
    pub fn load<P: AsRef<Path>>(
        path: P,
        passphrase: &[u8],
    ) -> Result<Self, CommitteeIdentityError> {
        let keystore = Self::read_keystore_file(path)?;
        Self::from_keystore(&keystore, passphrase)
    }

    /// Decrypt an in-memory [`Keystore`] under `passphrase`.
    pub fn from_keystore(
        keystore: &Keystore,
        passphrase: &[u8],
    ) -> Result<Self, CommitteeIdentityError> {
        if keystore.version != 1 {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "unsupported keystore version {}",
                keystore.version
            )));
        }
        if keystore.kind != KEYSTORE_KIND {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "unexpected keystore kind {:?}",
                keystore.kind
            )));
        }
        if keystore.kdf.name != "argon2id" {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "unsupported KDF {:?}",
                keystore.kdf.name
            )));
        }
        if keystore.cipher.name != "aes-256-gcm" {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "unsupported cipher {:?}",
                keystore.cipher.name
            )));
        }

        let salt = hex::decode(&keystore.kdf.salt)
            .map_err(|e| CommitteeIdentityError::ErrKeystoreFormat(format!("bad salt hex: {e}")))?;
        if salt.len() < MIN_SALT_LEN {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "salt too short ({} bytes; need >= {MIN_SALT_LEN})",
                salt.len(),
            )));
        }
        let nonce_bytes = hex::decode(&keystore.cipher.nonce).map_err(|e| {
            CommitteeIdentityError::ErrKeystoreFormat(format!("bad nonce hex: {e}"))
        })?;
        if nonce_bytes.len() != NONCE_LEN {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "nonce must be {NONCE_LEN} bytes, got {}",
                nonce_bytes.len()
            )));
        }
        let ciphertext = hex::decode(&keystore.cipher.ciphertext).map_err(|e| {
            CommitteeIdentityError::ErrKeystoreFormat(format!("bad ciphertext hex: {e}"))
        })?;

        let claimed_public_key = BASE64.decode(&keystore.public_key).map_err(|e| {
            CommitteeIdentityError::ErrKeystoreFormat(format!("bad public_key base64: {e}"))
        })?;
        if claimed_public_key.len() != SEED_LEN {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "public_key must decode to {SEED_LEN} bytes, got {}",
                claimed_public_key.len()
            )));
        }

        let mut key_bytes = derive_key(
            passphrase,
            &salt,
            keystore.kdf.m_cost,
            keystore.kdf.t_cost,
            keystore.kdf.p_cost,
        )?;
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| CommitteeIdentityError::ErrSign(format!("aes init: {e}")))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let aad = claimed_public_key.clone();
        let mut plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| CommitteeIdentityError::ErrKeystoreDecrypt)?;
        key_bytes.zeroize();

        if plaintext.len() != SEED_LEN {
            plaintext.zeroize();
            return Err(CommitteeIdentityError::ErrKeystoreFormat(format!(
                "decrypted plaintext is {} bytes, expected {SEED_LEN}",
                plaintext.len()
            )));
        }
        let mut seed = [0u8; SEED_LEN];
        seed.copy_from_slice(&plaintext);
        plaintext.zeroize();

        let signing_key = SigningKey::from_bytes(&seed);
        seed.zeroize();
        let derived_public_key = signing_key.verifying_key().to_bytes();
        if derived_public_key.as_slice() != claimed_public_key.as_slice() {
            return Err(CommitteeIdentityError::ErrKeystoreFormat(
                "decrypted key does not match claimed public_key".to_string(),
            ));
        }

        Ok(Self { signing_key })
    }

    fn read_keystore_file<P: AsRef<Path>>(path: P) -> Result<Keystore, CommitteeIdentityError> {
        let raw = std::fs::read(path.as_ref())
            .map_err(|e| CommitteeIdentityError::ErrKeystoreIo(e.to_string()))?;
        serde_json::from_slice(&raw)
            .map_err(|e| CommitteeIdentityError::ErrKeystoreFormat(e.to_string()))
    }

    /// Base64 (standard, padded) encoding of the raw 32-byte Ed25519
    /// public key — the exact wire format `POST /api/swarm/apply`'s
    /// `publicKey` field and the submission verifier expect.
    pub fn public_key_b64(&self) -> String {
        BASE64.encode(self.signing_key.verifying_key().to_bytes())
    }

    /// Sign the exact bytes of `payload` — the UTF-8 encoding of the
    /// canonical JSON string for a recommendation submission — and
    /// return the base64 (standard, padded) raw 64-byte Ed25519 signature
    /// the submission endpoint expects.
    ///
    /// Deterministic per RFC 8032: signing the same bytes with the same
    /// identity always yields the same signature.
    pub fn sign_b64(&self, payload: &[u8]) -> String {
        let sig: Signature = self.signing_key.sign(payload);
        BASE64.encode(sig.to_bytes())
    }
}

/// Read the passphrase from [`PASSPHRASE_ENV_VAR`]. Never falls back to
/// stdin — see the constant's doc comment.
pub fn read_passphrase_from_env() -> Result<String, CommitteeIdentityError> {
    match std::env::var(PASSPHRASE_ENV_VAR) {
        Ok(p) if !p.is_empty() => Ok(p),
        Ok(_) => Err(CommitteeIdentityError::ErrPassphrase(format!(
            "{PASSPHRASE_ENV_VAR} is set but empty"
        ))),
        Err(_) => Err(CommitteeIdentityError::ErrPassphrase(format!(
            "{PASSPHRASE_ENV_VAR} is unset; refusing to prompt on stdin from a \
             non-interactive command"
        ))),
    }
}

fn derive_key(
    passphrase: &[u8],
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; KEY_LEN], CommitteeIdentityError> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(KEY_LEN)).map_err(|e| {
        CommitteeIdentityError::ErrKeystoreFormat(format!("bad argon2 params: {e}"))
    })?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|e| CommitteeIdentityError::ErrKeystoreFormat(format!("argon2 derive: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};
    use tempfile::TempDir;

    const TEST_PASSPHRASE: &[u8] = b"correct horse battery staple";

    #[test]
    fn create_then_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        let ks = CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();
        assert_eq!(ks.kind, KEYSTORE_KIND);
        assert_eq!(ks.kdf.name, "argon2id");
        assert_eq!(ks.cipher.name, "aes-256-gcm");
        // Public key decodes to exactly 32 bytes.
        assert_eq!(BASE64.decode(&ks.public_key).unwrap().len(), 32);

        let identity = CommitteeIdentity::load(&path, TEST_PASSPHRASE).unwrap();
        assert_eq!(identity.public_key_b64(), ks.public_key);
    }

    #[test]
    fn create_refuses_to_overwrite_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();

        let err = CommitteeIdentity::create(&path, TEST_PASSPHRASE)
            .expect_err("must refuse to overwrite");
        match err {
            CommitteeIdentityError::ErrIdentityExists(_) => {}
            other => panic!("expected ErrIdentityExists, got {other:?}"),
        }
    }

    #[test]
    fn public_key_from_path_matches_loaded_identity_without_passphrase() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        let ks = CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();

        // No passphrase involved here at all.
        let pk = CommitteeIdentity::public_key_from_path(&path).unwrap();
        assert_eq!(pk, ks.public_key);
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();

        let err = CommitteeIdentity::load(&path, b"wrong passphrase")
            .expect_err("wrong passphrase must fail");
        match err {
            CommitteeIdentityError::ErrKeystoreDecrypt => {}
            other => panic!("expected ErrKeystoreDecrypt, got {other:?}"),
        }
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let mut ks: Keystore = serde_json::from_str(&raw).unwrap();
        let mut bytes = hex::decode(&ks.cipher.ciphertext).unwrap();
        bytes[0] ^= 0xff;
        ks.cipher.ciphertext = hex::encode(&bytes);
        std::fs::write(&path, serde_json::to_string(&ks).unwrap()).unwrap();

        let err = CommitteeIdentity::load(&path, TEST_PASSPHRASE)
            .expect_err("tampered ciphertext must fail");
        match err {
            CommitteeIdentityError::ErrKeystoreDecrypt => {}
            other => panic!("expected ErrKeystoreDecrypt, got {other:?}"),
        }
    }

    /// AC-3 (deterministic-signing half): signing the same sample
    /// canonical payload twice with the same identity yields byte-identical
    /// signatures (RFC 8032 determinism, no external randomness consumed).
    #[test]
    fn signing_a_sample_canonical_payload_is_deterministic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();
        let identity = CommitteeIdentity::load(&path, TEST_PASSPHRASE).unwrap();

        // A representative `canonicalizeSubmission` payload shape (see
        // module docs): fixed key order, JSON.stringify whitespace rules.
        let sample_canonical = r#"{"memberId":"agent-1","date":"2026-07-10","subjectId":"vault-a","nonce":"n-1","stance":"overweight","confidence":80,"body":"rationale","memoUrl":""}"#;

        let sig_a = identity.sign_b64(sample_canonical.as_bytes());
        let sig_b = identity.sign_b64(sample_canonical.as_bytes());
        assert_eq!(
            sig_a, sig_b,
            "signing the same payload twice must be deterministic"
        );

        // A different payload must not produce the same signature.
        let sig_c = identity.sign_b64(b"different payload");
        assert_ne!(sig_a, sig_c);
    }

    /// AC-3 (public-key export half) + wire-format compatibility: the
    /// exported base64 public key and base64 signature round-trip through
    /// raw Ed25519 verification exactly as the frontend's
    /// `crypto.subtle.verify({name:"Ed25519"}, ...)` would perform it.
    #[test]
    fn exported_public_key_verifies_the_exported_signature() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();
        let identity = CommitteeIdentity::load(&path, TEST_PASSPHRASE).unwrap();

        let payload = b"the exact canonical payload string";
        let sig_b64 = identity.sign_b64(payload);
        let pk_b64 = identity.public_key_b64();

        let pk_bytes = BASE64.decode(&pk_b64).unwrap();
        assert_eq!(pk_bytes.len(), 32, "public key must be raw 32 bytes");
        let sig_bytes = BASE64.decode(&sig_b64).unwrap();
        assert_eq!(sig_bytes.len(), 64, "signature must be raw 64 bytes");

        let vk = VerifyingKey::from_bytes(&pk_bytes.try_into().unwrap()).unwrap();
        let sig = Signature::from_bytes(&sig_bytes.try_into().unwrap());
        assert!(
            vk.verify(payload, &sig).is_ok(),
            "exported public key must verify the exported signature"
        );
        // A tampered payload must fail verification.
        assert!(vk.verify(b"tampered payload", &sig).is_err());
    }

    #[test]
    fn rejects_unknown_field_in_keystore_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity.json");
        CommitteeIdentity::create(&path, TEST_PASSPHRASE).unwrap();
        let mut text = std::fs::read_to_string(&path).unwrap();
        text = text.replacen('{', "{\n  \"unexpected\": 1,", 1);
        std::fs::write(&path, text).unwrap();
        let err = CommitteeIdentity::load(&path, TEST_PASSPHRASE)
            .expect_err("unknown field must be rejected");
        match err {
            CommitteeIdentityError::ErrKeystoreFormat(_) => {}
            other => panic!("expected ErrKeystoreFormat, got {other:?}"),
        }
    }
}
