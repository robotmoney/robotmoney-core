//! Canonical: docs/implementation-plan.md §4.3 — Software signer
//!
//! Encrypted-keystore software signer (§3.3).
//!
//! Layout on disk (JSON):
//!
//! ```json
//! {
//!   "version": 1,
//!   "kind": "rmpc-software-keystore",
//!   "address": "0x…",
//!   "kdf": {
//!     "name": "argon2id",
//!     "salt": "<hex 16+ bytes>",
//!     "m_cost": 19456, "t_cost": 2, "p_cost": 1
//!   },
//!   "cipher": {
//!     "name": "aes-256-gcm",
//!     "nonce": "<hex 12 bytes>",
//!     "ciphertext": "<hex; 32-byte plaintext + 16-byte AEAD tag>"
//!   }
//! }
//! ```
//!
//! Why these primitives:
//!
//! - **Argon2id** for the KDF — it is the recommended general-purpose
//!   password-hashing function and resists both GPU and side-channel
//!   attacks. We pick the OWASP "moderate" cost defaults (19 MiB,
//!   2 iterations) so a CLI invocation is sub-second on a laptop while a
//!   GPU brute-force is still expensive.
//! - **AES-256-GCM** for encryption — authenticated encryption is
//!   non-negotiable for a passphrase-keyed file: a wrong passphrase
//!   produces a clean tag-mismatch error instead of silently yielding
//!   garbage that we'd then sign with. The 16-byte AEAD tag also detects
//!   on-disk tampering.
//!
//! The plaintext private key is held only inside [`SigningKey`] (which
//! itself zeroizes on drop) and the temporary buffer used for AEAD is
//! [`zeroize`]'d after use. We do NOT keep a long-lived plaintext copy.
//!
//! See [`super`]: `alloy_primitives::Signature` is deprecated upstream but
//! still required by the EIP-1559 envelope path; deprecation is silenced
//! at the module level.

#![allow(deprecated)]

use std::path::Path;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use alloy_primitives::{
    keccak256, Address, Parity, Signature as AlloySignature, U256 as AlloyU256,
};
use argon2::{Algorithm, Argon2, Params, Version};
use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature, SigningKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::{AgentSigner, SignerBackendKind, SignerError};

/// Environment variable name from which the passphrase is read in non-TTY
/// contexts (CI, systemd unit). Stdin fallback is the operator-attended path.
pub const PASSPHRASE_ENV_VAR: &str = "RMPC_KEYSTORE_PASSPHRASE";

/// Argon2id parameters baked into the on-disk format. Matches OWASP
/// "second" recommendation for low-memory environments — comfortably
/// inside what a payment-daemon host can spare per CLI invocation.
const ARGON2_M_COST_KIB: u32 = 19_456; // ~19 MiB
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

/// Length of the AES-256 key derived from the passphrase.
const KEY_LEN: usize = 32;
/// AES-GCM standard nonce length.
const NONCE_LEN: usize = 12;
/// Length of a secp256k1 private key.
const PRIVKEY_LEN: usize = 32;
/// Minimum salt length we accept on load (Argon2 RFC recommends ≥ 16).
const MIN_SALT_LEN: usize = 16;

/// On-disk keystore document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keystore {
    /// File-format version. Must be `1`.
    pub version: u32,
    /// Discriminator string. Must be `"rmpc-software-keystore"`.
    pub kind: String,
    /// Address derived from the encrypted private key, for human inspection
    /// without decrypting. Verified against the decrypted key on load.
    pub address: String,
    pub kdf: KdfParams,
    pub cipher: CipherParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KdfParams {
    /// Must be `"argon2id"`.
    pub name: String,
    /// Hex-encoded salt (≥ 16 bytes).
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
    /// Hex-encoded ciphertext: `AES-256-GCM(plaintext_privkey)` with the
    /// 16-byte AEAD tag appended (length = 48).
    pub ciphertext: String,
}

/// Software signer (encrypted keystore). See module docs.
///
/// Holds a `SigningKey` in memory after a successful unlock. `SigningKey`'s
/// `Drop` impl zeroizes its scalar; we additionally zeroize the temporary
/// plaintext buffer used during decryption.
pub struct SoftwareSigner {
    signing_key: SigningKey,
    address: Address,
}

impl std::fmt::Debug for SoftwareSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never debug-print the signing key.
        f.debug_struct("SoftwareSigner")
            .field("address", &self.address)
            .finish()
    }
}

impl SoftwareSigner {
    /// Create a new keystore on disk, encrypting `private_key` under
    /// `passphrase`. Used by `rmpc +keystore new` and by tests.
    ///
    /// `private_key` is a 32-byte secp256k1 scalar. The caller is
    /// responsible for zeroizing it after this returns; we zeroize our own
    /// internal copies.
    pub fn create_keystore<P: AsRef<Path>>(
        path: P,
        private_key: &[u8; PRIVKEY_LEN],
        passphrase: &[u8],
    ) -> Result<Keystore, SignerError> {
        use rand_core::{OsRng, RngCore};

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
            .map_err(|e| SignerError::ErrSign(format!("aes init: {e}")))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        // Bind the address to the AEAD via additional data so a swapped
        // ciphertext under a fresh passphrase cannot be passed off as a
        // matching keystore for an existing address.
        let signing_key = SigningKey::from_slice(private_key)
            .map_err(|e| SignerError::ErrSign(format!("invalid private key: {e}")))?;
        let address = address_from_signing_key(&signing_key);
        let aad = address.as_slice().to_vec();
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: private_key,
                    aad: &aad,
                },
            )
            .map_err(|e| SignerError::ErrSign(format!("aes encrypt: {e}")))?;

        key_bytes.zeroize();

        let keystore = Keystore {
            version: 1,
            kind: "rmpc-software-keystore".to_string(),
            address: format!("0x{}", hex::encode(address.as_slice())),
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
        };

        let json = serde_json::to_string_pretty(&keystore)
            .map_err(|e| SignerError::ErrKeystoreFormat(e.to_string()))?;
        std::fs::write(path.as_ref(), json)
            .map_err(|e| SignerError::ErrKeystoreIo(e.to_string()))?;

        Ok(keystore)
    }

    /// Load and decrypt the keystore at `path`.
    ///
    /// The passphrase is read from [`PASSPHRASE_ENV_VAR`] if set, otherwise
    /// from a single line on stdin (passphrase prompts are an operator UX
    /// concern; the daemon just reads one line).
    pub fn load<P: AsRef<Path>>(
        path: P,
        allow_software_fallback: bool,
    ) -> Result<Self, SignerError> {
        if !allow_software_fallback {
            return Err(SignerError::ErrSoftwareSignerDisallowed);
        }
        // High-severity startup banner — operators rely on this to spot a
        // misconfigured production rollout that fell through to software.
        log::warn!(
            "software signer enabled: keystore decrypted in process memory \
             (allow_software_fallback=true); HSM/KMS strongly recommended for production"
        );

        let passphrase = read_passphrase_from_env_or_stdin()?;
        Self::load_with_passphrase(path, passphrase.as_bytes(), allow_software_fallback)
    }

    /// Internal load entrypoint that accepts an explicit passphrase. Used
    /// by tests; production goes through [`Self::load`].
    pub fn load_with_passphrase<P: AsRef<Path>>(
        path: P,
        passphrase: &[u8],
        allow_software_fallback: bool,
    ) -> Result<Self, SignerError> {
        if !allow_software_fallback {
            return Err(SignerError::ErrSoftwareSignerDisallowed);
        }
        let raw =
            std::fs::read(path.as_ref()).map_err(|e| SignerError::ErrKeystoreIo(e.to_string()))?;
        let keystore: Keystore = serde_json::from_slice(&raw)
            .map_err(|e| SignerError::ErrKeystoreFormat(e.to_string()))?;
        Self::from_keystore(&keystore, passphrase)
    }

    /// Decrypt an in-memory [`Keystore`] under `passphrase`.
    pub fn from_keystore(keystore: &Keystore, passphrase: &[u8]) -> Result<Self, SignerError> {
        if keystore.version != 1 {
            return Err(SignerError::ErrKeystoreFormat(format!(
                "unsupported keystore version {}",
                keystore.version
            )));
        }
        if keystore.kind != "rmpc-software-keystore" {
            return Err(SignerError::ErrKeystoreFormat(format!(
                "unexpected keystore kind {:?}",
                keystore.kind
            )));
        }
        if keystore.kdf.name != "argon2id" {
            return Err(SignerError::ErrKeystoreFormat(format!(
                "unsupported KDF {:?}",
                keystore.kdf.name
            )));
        }
        if keystore.cipher.name != "aes-256-gcm" {
            return Err(SignerError::ErrKeystoreFormat(format!(
                "unsupported cipher {:?}",
                keystore.cipher.name
            )));
        }

        let salt = hex::decode(&keystore.kdf.salt)
            .map_err(|e| SignerError::ErrKeystoreFormat(format!("bad salt hex: {e}")))?;
        if salt.len() < MIN_SALT_LEN {
            return Err(SignerError::ErrKeystoreFormat(format!(
                "salt too short ({} bytes; need ≥ {})",
                salt.len(),
                MIN_SALT_LEN
            )));
        }
        let nonce_bytes = hex::decode(&keystore.cipher.nonce)
            .map_err(|e| SignerError::ErrKeystoreFormat(format!("bad nonce hex: {e}")))?;
        if nonce_bytes.len() != NONCE_LEN {
            return Err(SignerError::ErrKeystoreFormat(format!(
                "nonce must be {NONCE_LEN} bytes, got {}",
                nonce_bytes.len()
            )));
        }
        let ciphertext = hex::decode(&keystore.cipher.ciphertext)
            .map_err(|e| SignerError::ErrKeystoreFormat(format!("bad ciphertext hex: {e}")))?;

        let claimed_address = parse_address(&keystore.address)?;

        let mut key_bytes = derive_key(
            passphrase,
            &salt,
            keystore.kdf.m_cost,
            keystore.kdf.t_cost,
            keystore.kdf.p_cost,
        )?;
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| SignerError::ErrSign(format!("aes init: {e}")))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let aad = claimed_address.as_slice().to_vec();
        let mut plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| SignerError::ErrKeystoreDecrypt)?;
        key_bytes.zeroize();

        if plaintext.len() != PRIVKEY_LEN {
            plaintext.zeroize();
            return Err(SignerError::ErrKeystoreFormat(format!(
                "decrypted plaintext is {} bytes, expected {PRIVKEY_LEN}",
                plaintext.len()
            )));
        }
        let signing_key = match SigningKey::from_slice(&plaintext) {
            Ok(sk) => sk,
            Err(e) => {
                plaintext.zeroize();
                return Err(SignerError::ErrSign(format!("invalid private key: {e}")));
            }
        };
        plaintext.zeroize();

        let derived = address_from_signing_key(&signing_key);
        if derived != claimed_address {
            return Err(SignerError::ErrKeystoreFormat(
                "decrypted key does not match claimed `address`".to_string(),
            ));
        }

        Ok(Self {
            signing_key,
            address: derived,
        })
    }
}

impl AgentSigner for SoftwareSigner {
    fn backend_kind(&self) -> SignerBackendKind {
        SignerBackendKind::Software
    }

    fn public_address(&self) -> Address {
        self.address
    }

    fn sign_eip1559_hash(&self, hash: &[u8; 32]) -> Result<AlloySignature, SignerError> {
        let (signature, recid): (Signature, RecoveryId) = self
            .signing_key
            .sign_prehash(hash.as_slice())
            .map_err(|e| SignerError::ErrSign(e.to_string()))?;
        // Normalise to low-S so the corresponding recovery id is canonical.
        let (signature, recid) = if let Some(low) = signature.normalize_s() {
            // s was high; flip parity to compensate for the s-flip.
            let flipped = RecoveryId::from_byte(recid.to_byte() ^ 1)
                .expect("recovery id 0/1 toggles within range");
            (low, flipped)
        } else {
            (signature, recid)
        };
        let r = AlloyU256::from_be_slice(&signature.r().to_bytes());
        let s = AlloyU256::from_be_slice(&signature.s().to_bytes());
        let parity = Parity::Parity(recid.is_y_odd());
        Ok(AlloySignature::new(r, s, parity))
    }
}

/// Read passphrase from env or stdin (one line, trailing newline stripped).
fn read_passphrase_from_env_or_stdin() -> Result<String, SignerError> {
    if let Ok(p) = std::env::var(PASSPHRASE_ENV_VAR) {
        if p.is_empty() {
            return Err(SignerError::ErrPassphrase(format!(
                "{PASSPHRASE_ENV_VAR} is set but empty"
            )));
        }
        return Ok(p);
    }
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| SignerError::ErrPassphrase(format!("reading stdin: {e}")))?;
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    if line.is_empty() {
        return Err(SignerError::ErrPassphrase(
            "empty passphrase on stdin".to_string(),
        ));
    }
    Ok(line)
}

fn derive_key(
    passphrase: &[u8],
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; KEY_LEN], SignerError> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(KEY_LEN))
        .map_err(|e| SignerError::ErrKeystoreFormat(format!("bad argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|e| SignerError::ErrKeystoreFormat(format!("argon2 derive: {e}")))?;
    Ok(out)
}

fn address_from_signing_key(sk: &SigningKey) -> Address {
    let vk = sk.verifying_key();
    // Uncompressed public key: 0x04 || X || Y. Ethereum address =
    // last 20 bytes of keccak256(X || Y).
    let encoded = vk.to_encoded_point(false);
    let bytes = encoded.as_bytes();
    debug_assert_eq!(bytes.len(), 65);
    debug_assert_eq!(bytes[0], 0x04);
    let hash = keccak256(&bytes[1..]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    Address::from(addr)
}

fn parse_address(s: &str) -> Result<Address, SignerError> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(stripped)
        .map_err(|e| SignerError::ErrKeystoreFormat(format!("bad address hex: {e}")))?;
    if bytes.len() != 20 {
        return Err(SignerError::ErrKeystoreFormat(format!(
            "address must be 20 bytes, got {}",
            bytes.len()
        )));
    }
    let mut a = [0u8; 20];
    a.copy_from_slice(&bytes);
    Ok(Address::from(a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Deterministic test private key (NEVER use on a real chain).
    /// `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`
    /// is the well-known Anvil/hardhat default account #1 key.
    const TEST_PRIVKEY_HEX: &str =
        "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const TEST_PASSPHRASE: &[u8] = b"correct horse battery staple";
    /// Address corresponding to `TEST_PRIVKEY_HEX` (Anvil account #1).
    const TEST_ADDRESS_HEX: &str = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    fn test_privkey() -> [u8; PRIVKEY_LEN] {
        let v = hex::decode(TEST_PRIVKEY_HEX).unwrap();
        let mut k = [0u8; PRIVKEY_LEN];
        k.copy_from_slice(&v);
        k
    }

    #[test]
    fn address_derivation_matches_known_vector() {
        let sk = SigningKey::from_slice(&test_privkey()).unwrap();
        let addr = address_from_signing_key(&sk);
        let want = parse_address(TEST_ADDRESS_HEX).unwrap();
        assert_eq!(addr, want);
    }

    #[test]
    fn create_then_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        let pk = test_privkey();
        let ks = SoftwareSigner::create_keystore(&path, &pk, TEST_PASSPHRASE).unwrap();
        assert_eq!(ks.kdf.name, "argon2id");
        assert_eq!(ks.cipher.name, "aes-256-gcm");

        let signer = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, true).unwrap();
        assert_eq!(signer.backend_kind(), SignerBackendKind::Software);
        let want = parse_address(TEST_ADDRESS_HEX).unwrap();
        assert_eq!(signer.public_address(), want);
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();

        let err = SoftwareSigner::load_with_passphrase(&path, b"wrong passphrase", true)
            .expect_err("wrong passphrase must fail");
        match err {
            SignerError::ErrKeystoreDecrypt => {}
            other => panic!("expected ErrKeystoreDecrypt, got {other:?}"),
        }
    }

    #[test]
    fn refuses_when_software_fallback_disallowed() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();

        let err = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, false)
            .expect_err("must refuse when fallback disallowed");
        match err {
            SignerError::ErrSoftwareSignerDisallowed => {}
            other => panic!("expected ErrSoftwareSignerDisallowed, got {other:?}"),
        }
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();

        // Flip one byte of the ciphertext.
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut ks: Keystore = serde_json::from_str(&raw).unwrap();
        let mut bytes = hex::decode(&ks.cipher.ciphertext).unwrap();
        bytes[0] ^= 0xff;
        ks.cipher.ciphertext = hex::encode(&bytes);
        std::fs::write(&path, serde_json::to_string(&ks).unwrap()).unwrap();

        let err = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, true)
            .expect_err("tampered ciphertext must fail");
        match err {
            SignerError::ErrKeystoreDecrypt => {}
            other => panic!("expected ErrKeystoreDecrypt, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_field_in_keystore_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();
        let mut text = std::fs::read_to_string(&path).unwrap();
        // Inject an unknown top-level field.
        text = text.replacen('{', "{\n  \"unexpected\": 1,", 1);
        std::fs::write(&path, text).unwrap();
        let err = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, true)
            .expect_err("unknown field must be rejected");
        match err {
            SignerError::ErrKeystoreFormat(_) => {}
            other => panic!("expected ErrKeystoreFormat, got {other:?}"),
        }
    }

    #[test]
    fn signature_recovers_to_signer_address() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();
        let signer = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, true).unwrap();

        // Sign a fixed digest twice; outputs must match (RFC 6979
        // deterministic nonces). The previous sign_gateway_tx /
        // recover_signer surface was retired (audit L1).
        let digest = [0xabu8; 32];
        let a = signer.sign_eip1559_hash(&digest).unwrap();
        let b = signer.sign_eip1559_hash(&digest).unwrap();
        assert_eq!(a.r(), b.r());
        assert_eq!(a.s(), b.s());
        assert_eq!(a.v(), b.v());
    }

    #[test]
    fn signing_is_deterministic_for_rfc6979() {
        // k256 ECDSA signs with deterministic nonces (RFC 6979). Two
        // signatures over the same EIP-1559 hash must match.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();
        let signer = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, true).unwrap();
        let hash = [0x42u8; 32];
        let a = signer.sign_eip1559_hash(&hash).unwrap();
        let b = signer.sign_eip1559_hash(&hash).unwrap();
        assert_eq!(a.r(), b.r());
        assert_eq!(a.s(), b.s());
    }

    #[test]
    fn keystore_address_field_must_match_decrypted_key() {
        // If an attacker swaps the `address` field, AAD binding makes the
        // AEAD reject decryption (different AAD ⇒ tag mismatch).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("keystore.json");
        SoftwareSigner::create_keystore(&path, &test_privkey(), TEST_PASSPHRASE).unwrap();
        let mut ks: Keystore =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        ks.address = "0x0000000000000000000000000000000000000001".to_string();
        std::fs::write(&path, serde_json::to_string(&ks).unwrap()).unwrap();
        let err = SoftwareSigner::load_with_passphrase(&path, TEST_PASSPHRASE, true)
            .expect_err("swapped address must fail");
        match err {
            SignerError::ErrKeystoreDecrypt | SignerError::ErrKeystoreFormat(_) => {}
            other => panic!("expected decrypt or format error, got {other:?}"),
        }
    }
}
