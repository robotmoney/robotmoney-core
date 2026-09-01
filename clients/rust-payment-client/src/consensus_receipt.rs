//! Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
//! Implements: issue #1247 — anchor the consensus receipt on chain (rmpc side);
//! discharges the second half of issue #1280 (the anchoring path must submit the
//! digest pinned by `tests/fixtures/consensus-receipt.anchor-digest.json`).
//!
//! Canonicalization, digest derivation and Ed25519 verification for the swarm's
//! **consensus recommendation receipt**.
//!
//! The normative specification of these bytes is
//! `tests/fixtures/consensus-receipt.canonicalization.json`, which is
//! **byte-identical** to `contract/src/__fixtures__/` in `robotmoney-frontend`.
//! That byte identity is the cross-repo pin, so nothing in this module may be
//! "improved" independently — a change here that is not also a change there
//! anchors a different digest for the same receipt.
//!
//! # The canonical form
//!
//! ```text
//! robotmoney:consensus-receipt:v1\n<compact RFC 8259 JSON>\n
//! ```
//!
//! * **Compact.** No insignificant whitespace anywhere: no space after `:` or
//!   `,`, no indentation, no newline inside the object. A single trailing
//!   newline closes the preimage and is part of it.
//! * **Escaping.** EXACTLY three things are escaped: `"` -> `\"`, `\` -> `\\`,
//!   and the C0 range U+0000..U+001F (short forms `\b \t \n \f \r` where RFC
//!   8259 defines one, lowercase-hex `\u00XX` otherwise). Everything else is
//!   raw UTF-8 — all non-ASCII, U+007F, U+2028, U+2029, and every astral-plane
//!   code point as its 4-byte UTF-8 sequence, never an escaped surrogate pair.
//!   `/` is never escaped.
//!
//!   `serde_json`'s string serializer implements exactly this rule, which is why
//!   this module can serialize with `serde_json::to_string` rather than hand-roll
//!   an encoder. That is a fact about `serde_json` that the byte-for-byte golden
//!   assertions in `tests/receipt.rs` re-prove on every run; it is not an
//!   assumption this module is allowed to make silently. The two most likely
//!   sibling implementations both diverge here BY DEFAULT while still reproducing
//!   an all-ASCII golden exactly (Go's `encoding/json` escapes `<`, `>`, `&`,
//!   U+2028 and U+2029; Python's `json.dumps` escapes every non-ASCII code
//!   point), which is why `consensus-receipt.escaping.json` exists at all.
//! * **Field order.** Top level is the pinned `field_order` array; every nested
//!   object uses the pinned `nested_field_order` entry for its path. That order
//!   is expressed here as Rust struct field declaration order, because
//!   `serde_json` serializes struct fields in declaration order. **Reordering a
//!   field in this file is a breaking change to every already-anchored digest.**
//! * **`weights` is optional and last.** When absent it is omitted entirely
//!   (`consensus-receipt.valid-no-weights.json`); it is never emitted as `null`
//!   and never emitted short of the canonical four buckets.
//! * **`analyst_signatures` order.** Ascending by `member_id` **Unicode code
//!   point**, which for Rust is ascending UTF-8 byte order.
//!
//! # Validate, then canonicalize — always
//!
//! [`ConsensusReceipt::canonical_bytes`] validates first and refuses rather than
//! emitting bytes with a key missing. A plain `serde_json::to_string` over a
//! partially-populated value would silently omit the key and hand back a digest
//! over a payload that would have failed validation, so the ordering is
//! load-bearing rather than stylistic.
//!
//! # What the signatures prove
//!
//! The chain proves that one submitter attested to the receipt. It does **not**
//! prove each named analyst signed — the EVM has no Ed25519 precompile
//! (ADR-0012 §5), so the analyst signatures ride inside the payload as data
//! verified off-chain. [`ConsensusReceipt::verify_analyst_signatures`] is that
//! check, and `rmpc receipt submit` refuses to broadcast when it fails
//! (docs/architecture.md §4.9.1 answer 1).

use alloy_primitives::{keccak256, B256};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Domain separator prefixing the compact JSON in the canonical preimage.
/// Pinned by `consensus-receipt.canonicalization.json#domain_separator`.
pub const DOMAIN_SEPARATOR: &str = "robotmoney:consensus-receipt:v1\n";

/// Domain separator for the receipt id preimage.
/// Pinned by `consensus-receipt.canonicalization.json#receipt_id_derivation`.
pub const RECEIPT_ID_DOMAIN_SEPARATOR: &str = "robotmoney:consensus-receipt-id:v1\n";

/// The only `schema_version` this module canonicalizes. A verifier picks the
/// schema by the receipt's own `schema_version`, never by "latest".
pub const SCHEMA_VERSION: &str = "1.0";

/// The four buckets, in the pinned canonical order.
/// `consensus-receipt.canonicalization.json#canonical_bucket_order`.
pub const CANONICAL_BUCKET_ORDER: [&str; 4] = [
    "agent_tokens",
    "conservative_defi_yield",
    "protocol_tokens",
    "real_world_assets",
];

/// Raw Ed25519 public key length.
const ED25519_PUBLIC_KEY_LEN: usize = 32;
/// Raw Ed25519 signature length.
const ED25519_SIGNATURE_LEN: usize = 64;

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Errors surfaced by this module. The [`ReceiptError::code`] strings are part
/// of the agent-visible CLI contract (`rmpc receipt`'s JSON `error` field) —
/// renaming one is a breaking change.
#[derive(Debug, Error)]
pub enum ReceiptError {
    /// The bytes are not JSON, or are JSON of the wrong shape (including a
    /// missing required field, which must be an error and never a silently
    /// omitted key).
    #[error("ErrReceiptParse: {0}")]
    ErrReceiptParse(String),

    /// The receipt parsed but violates `consensus-receipt.schema.json` or one
    /// of the assembler obligations recomputed here.
    #[error("ErrReceiptSchema: {0}")]
    ErrReceiptSchema(String),

    /// One `analyst_signatures[]` entry failed Ed25519 verification, or its key
    /// or signature could not be decoded.
    #[error("ErrReceiptSignatureInvalid: analyst_signatures[member_id={member_id}]: {reason}")]
    ErrReceiptSignatureInvalid {
        /// The failing entry's `member_id`, so an operator knows which analyst
        /// to chase without re-deriving anything.
        member_id: String,
        /// Why it failed.
        reason: String,
    },
}

impl ReceiptError {
    /// Stable machine-readable code for the CLI's JSON `error` field.
    pub fn code(&self) -> &'static str {
        match self {
            ReceiptError::ErrReceiptParse(_) => "ErrReceiptParse",
            ReceiptError::ErrReceiptSchema(_) => "ErrReceiptSchema",
            ReceiptError::ErrReceiptSignatureInvalid { .. } => "ErrReceiptSignatureInvalid",
        }
    }
}

// ─── Payload model ───────────────────────────────────────────────────────────
//
// FIELD DECLARATION ORDER IS THE CANONICAL FIELD ORDER. `serde_json`
// serializes struct fields in declaration order, so every struct below is
// written in the order pinned by `field_order` / `nested_field_order` in
// `consensus-receipt.canonicalization.json`. Do not reorder, rename, remove or
// retype a field: within schema 1.0 that is a major bump, and it changes bytes
// that are already anchored on chain.

/// `quorum` — `["active","submitted","absent","participation_bps"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quorum {
    /// Active committee members at session time. At least 1.
    pub active: u64,
    /// Members who submitted a take. At least 1.
    pub submitted: u64,
    /// `active - submitted`.
    pub absent: u64,
    /// `floor((submitted / active) * 10000 + 0.5)` — round HALF UP, computed
    /// from the two integers rather than a stored float.
    pub participation_bps: u32,
}

/// `stances` — a FIXED FIVE-KEY object; the assembler zero-fills the stances
/// the sparse rollup never set, so a short object is never emitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stances {
    /// Count of bearish takes.
    pub bearish: u64,
    /// Count of cautious takes.
    pub cautious: u64,
    /// Count of neutral takes.
    pub neutral: u64,
    /// Count of constructive takes.
    pub constructive: u64,
    /// Count of bullish takes.
    pub bullish: u64,
}

/// `judge.disagreements[].positions[]` — `["member_id","view"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    /// The member this view is attributed to.
    pub member_id: String,
    /// The member's own words, filled from their take body by the producer.
    pub view: String,
}

/// `judge.disagreements[]` — `["topic","positions","what_settles"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Disagreement {
    /// What the members disagree about.
    pub topic: String,
    /// At least one attributed position.
    pub positions: Vec<Position>,
    /// What would resolve the disagreement.
    pub what_settles: String,
}

/// `judge.release_safety` —
/// `["release","thinly_supported","take_count","min_takes","concerns"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseSafety {
    /// `"safe"` or `"hold"`. Advice only — nothing refuses to publish on hold.
    pub release: String,
    /// Arithmetic, never the model's call: `take_count < min_takes`.
    pub thinly_supported: bool,
    /// Size of the frozen take set the judge read. Equals `quorum.submitted`.
    pub take_count: u64,
    /// The `min_takes` threshold in force when the opinion was formed.
    pub min_takes: u64,
    /// Ordered as the producer emits them; each entry is non-empty.
    pub concerns: Vec<String>,
}

/// `judge` — `["rationale","disagreements","release_safety","source"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Judge {
    /// Judge-authored explanation. Never empty.
    pub rationale: String,
    /// The judge's disagreement list, verbatim.
    pub disagreements: Vec<Disagreement>,
    /// The shipped release-safety block, carried whole.
    pub release_safety: ReleaseSafety,
    /// `"model"` or `"fallback"` — the ONLY field separating model prose from
    /// template prose.
    pub source: String,
}

/// `analyst_signatures[]` —
/// `["member_id","public_key","canonical_submission","signature"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalystSignature {
    /// The signing member.
    pub member_id: String,
    /// Standard padded base64 of the raw 32-byte Ed25519 public key.
    pub public_key: String,
    /// The exact UTF-8 JSON bytes the member signed. Carried as a string so a
    /// verifier never re-serializes float weights before checking a signature.
    pub canonical_submission: String,
    /// Standard padded base64 of the raw 64-byte Ed25519 signature over
    /// `canonical_submission`.
    pub signature: String,
}

/// `weights[]` — `["bucket","weight_bps"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BucketWeight {
    /// One of [`CANONICAL_BUCKET_ORDER`].
    pub bucket: String,
    /// 0..=10000.
    pub weight_bps: u32,
}

/// A consensus recommendation receipt, schema 1.0.
///
/// Unknown input fields are dropped rather than refused, matching the
/// canonicalization contract's `evolution_rule` ("Unknown input fields are
/// never serialized"). An explicit `"weights": null` IS refused — omitting the
/// key and nulling it would otherwise canonicalize identically, which is the
/// silently-omitted-key failure mode the contract exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsensusReceipt {
    /// Always [`SCHEMA_VERSION`] for this document.
    pub schema_version: String,
    /// The frontend swarm session, lowercase UUID.
    pub session_id: String,
    /// The session-scoped subject.
    pub subject_id: String,
    /// Seconds-precision UTC with a literal trailing `Z`.
    pub created_at: String,
    /// 0x-prefixed lowercase keccak/sha digest of the judge instruction template.
    pub prompt_hash: String,
    /// 0x-prefixed lowercase digest of the brief and frozen take set.
    pub inputs_digest: String,
    /// Participation block.
    pub quorum: Quorum,
    /// Fixed five-key stance histogram.
    pub stances: Stances,
    /// The judge opinion, field for field.
    pub judge: Judge,
    /// At least one analyst signature. Sorted by `member_id` at canonicalization
    /// time, so an unsorted input still produces canonical bytes.
    pub analyst_signatures: Vec<AnalystSignature>,
    /// Optional and LAST. Omitted entirely when the session produced no vector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights: Option<Vec<BucketWeight>>,
}

/// One entry's Ed25519 verification result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignatureCheck {
    /// The entry's `member_id`.
    pub member_id: String,
    /// True when `signature` verifies against `public_key` over the UTF-8 bytes
    /// of `canonical_submission`.
    pub verified: bool,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// `payload_digest(bytes) = keccak256(bytes)`.
///
/// The preimage is the canonical bytes exactly as produced by
/// [`ConsensusReceipt::canonical_bytes`] — already domain-separated by their own
/// first line. Nothing is prepended, appended, trimmed or re-encoded; the
/// trailing newline is part of the preimage.
pub fn payload_digest(bytes: &[u8]) -> B256 {
    keccak256(bytes)
}

/// `receipt_id = keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id +
/// "\n" + subject_id)`.
///
/// The contract accepts at most one row per `receipt_id`, which is what enforces
/// one receipt per session per subject.
pub fn derive_receipt_id(session_id: &str, subject_id: &str) -> B256 {
    let mut preimage = String::with_capacity(
        RECEIPT_ID_DOMAIN_SEPARATOR.len() + session_id.len() + 1 + subject_id.len(),
    );
    preimage.push_str(RECEIPT_ID_DOMAIN_SEPARATOR);
    preimage.push_str(session_id);
    preimage.push('\n');
    preimage.push_str(subject_id);
    keccak256(preimage.as_bytes())
}

impl ConsensusReceipt {
    /// Parse a receipt from raw JSON bytes.
    ///
    /// A missing required field is an error here, never a silently omitted key
    /// later. An explicit `"weights": null` is refused for the same reason.
    pub fn from_json_slice(raw: &[u8]) -> Result<Self, ReceiptError> {
        let value: serde_json::Value = serde_json::from_slice(raw)
            .map_err(|e| ReceiptError::ErrReceiptParse(format!("not valid JSON: {e}")))?;

        if matches!(value.get("weights"), Some(serde_json::Value::Null)) {
            return Err(ReceiptError::ErrReceiptSchema(
                "`weights` is present but null; it must be omitted entirely when \
                 the session produced no allocation vector"
                    .to_string(),
            ));
        }

        serde_json::from_value(value)
            .map_err(|e| ReceiptError::ErrReceiptParse(format!("not a schema-1.0 receipt: {e}")))
    }

    /// Parse, validate and canonicalize in one step, returning the exact bytes
    /// whose keccak256 is anchored on chain.
    pub fn canonical_bytes_from_json_slice(raw: &[u8]) -> Result<Vec<u8>, ReceiptError> {
        Self::from_json_slice(raw)?.canonical_bytes()
    }

    /// The canonical preimage bytes.
    ///
    /// Validates first and refuses rather than emitting bytes with a key
    /// missing (`assembler_obligations#order`: VALIDATE, THEN CANONICALIZE,
    /// ALWAYS).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ReceiptError> {
        self.validate()?;

        // `analyst_signatures` is sorted by `member_id` ascending by Unicode
        // code point. UTF-8 preserves code point order, so a byte compare over
        // the UTF-8 encoding IS the code-point compare — unlike JavaScript's
        // default `Array.prototype.sort`, which compares UTF-16 code units and
        // disagrees for every code point above U+FFFF.
        let mut ordered = self.clone();
        ordered
            .analyst_signatures
            .sort_by(|a, b| a.member_id.as_bytes().cmp(b.member_id.as_bytes()));

        let json = serde_json::to_string(&ordered).map_err(|e| {
            ReceiptError::ErrReceiptParse(format!("canonical serialization failed: {e}"))
        })?;

        let mut out = Vec::with_capacity(DOMAIN_SEPARATOR.len() + json.len() + 1);
        out.extend_from_slice(DOMAIN_SEPARATOR.as_bytes());
        out.extend_from_slice(json.as_bytes());
        out.push(b'\n');
        Ok(out)
    }

    /// `keccak256` of [`Self::canonical_bytes`] — the `payloadDigest` a
    /// `consensusRecordReceipt` call must carry.
    pub fn payload_digest(&self) -> Result<B256, ReceiptError> {
        Ok(payload_digest(&self.canonical_bytes()?))
    }

    /// The `receiptId` for this receipt's session and subject.
    pub fn receipt_id(&self) -> B256 {
        derive_receipt_id(&self.session_id, &self.subject_id)
    }

    /// Verify EVERY embedded analyst Ed25519 signature.
    ///
    /// Returns `Err` naming the first failing `member_id`. On success every
    /// returned [`SignatureCheck`] has `verified == true`; the vector is
    /// returned so a caller can report per-analyst results without re-running
    /// the check.
    ///
    /// `verify_strict` is used rather than `verify`: it rejects small-order
    /// public keys, so a receipt cannot carry a key under which many messages
    /// verify.
    pub fn verify_analyst_signatures(&self) -> Result<Vec<SignatureCheck>, ReceiptError> {
        let mut out = Vec::with_capacity(self.analyst_signatures.len());
        for entry in &self.analyst_signatures {
            let fail = |reason: String| ReceiptError::ErrReceiptSignatureInvalid {
                member_id: entry.member_id.clone(),
                reason,
            };

            let pk_bytes = BASE64
                .decode(entry.public_key.as_bytes())
                .map_err(|e| fail(format!("public_key is not standard base64: {e}")))?;
            let pk: [u8; ED25519_PUBLIC_KEY_LEN] = pk_bytes.try_into().map_err(|v: Vec<u8>| {
                fail(format!(
                    "public_key decodes to {} bytes, expected {ED25519_PUBLIC_KEY_LEN}",
                    v.len()
                ))
            })?;

            let sig_bytes = BASE64
                .decode(entry.signature.as_bytes())
                .map_err(|e| fail(format!("signature is not standard base64: {e}")))?;
            let sig: [u8; ED25519_SIGNATURE_LEN] = sig_bytes.try_into().map_err(|v: Vec<u8>| {
                fail(format!(
                    "signature decodes to {} bytes, expected {ED25519_SIGNATURE_LEN}",
                    v.len()
                ))
            })?;

            let verifying_key = VerifyingKey::from_bytes(&pk)
                .map_err(|e| fail(format!("public_key is not a valid Ed25519 point: {e}")))?;
            let signature = Signature::from_bytes(&sig);

            verifying_key
                .verify_strict(entry.canonical_submission.as_bytes(), &signature)
                .map_err(|e| {
                    fail(format!(
                        "Ed25519 signature does not verify over canonical_submission: {e}"
                    ))
                })?;

            out.push(SignatureCheck {
                member_id: entry.member_id.clone(),
                verified: true,
            });
        }
        Ok(out)
    }

    /// Structural + semantic validation against `consensus-receipt.schema.json`
    /// and the assembler obligations that are recomputable from the payload.
    ///
    /// Runs before canonicalization, never after.
    pub fn validate(&self) -> Result<(), ReceiptError> {
        let bad = |m: String| ReceiptError::ErrReceiptSchema(m);

        if self.schema_version != SCHEMA_VERSION {
            return Err(bad(format!(
                "schema_version must be {SCHEMA_VERSION:?}, got {:?} — a verifier picks the \
                 schema by the receipt's own schema_version, never by \"latest\"",
                self.schema_version
            )));
        }
        if !is_lowercase_uuid(&self.session_id) {
            return Err(bad(format!(
                "session_id {:?} is not a lowercase UUID (uppercase hex is the same \
                 identifier but different canonical bytes, so exactly one spelling is admitted)",
                self.session_id
            )));
        }
        if !is_slug(&self.subject_id) {
            return Err(bad(format!(
                "subject_id {:?} does not match ^[a-z0-9][a-z0-9_-]{{0,127}}$",
                self.subject_id
            )));
        }
        if !is_seconds_precision_utc(&self.created_at) {
            return Err(bad(format!(
                "created_at {:?} is not seconds-precision UTC with a literal trailing Z \
                 (fractional seconds, a numeric offset, a lowercase z and a space in place \
                 of T are all refused — three spellings of one instant would be three \
                 anchored digests for one session)",
                self.created_at
            )));
        }
        if !is_hash32(&self.prompt_hash) {
            return Err(bad(format!(
                "prompt_hash {:?} is not 0x + 64 lowercase hex digits",
                self.prompt_hash
            )));
        }
        if !is_hash32(&self.inputs_digest) {
            return Err(bad(format!(
                "inputs_digest {:?} is not 0x + 64 lowercase hex digits",
                self.inputs_digest
            )));
        }

        // ── quorum ───────────────────────────────────────────────────────────
        let q = &self.quorum;
        if q.active < 1 {
            return Err(bad("quorum.active must be at least 1".to_string()));
        }
        if q.submitted < 1 {
            return Err(bad("quorum.submitted must be at least 1".to_string()));
        }
        if q.submitted > q.active {
            return Err(bad(format!(
                "quorum.submitted ({}) exceeds quorum.active ({})",
                q.submitted, q.active
            )));
        }
        if q.absent != q.active - q.submitted {
            return Err(bad(format!(
                "quorum.absent ({}) must equal active - submitted ({})",
                q.absent,
                q.active - q.submitted
            )));
        }
        let expected_bps = participation_bps(q.submitted, q.active);
        if q.participation_bps != expected_bps {
            return Err(bad(format!(
                "quorum.participation_bps is {} but floor((submitted / active) * 10000 + 0.5) \
                 is {expected_bps} — round HALF UP over the two integers, not half-even and \
                 not from a stored float",
                q.participation_bps
            )));
        }

        // ── judge ────────────────────────────────────────────────────────────
        if self.judge.rationale.is_empty() {
            return Err(bad("judge.rationale must be non-empty".to_string()));
        }
        for (i, d) in self.judge.disagreements.iter().enumerate() {
            if d.topic.is_empty() {
                return Err(bad(format!(
                    "judge.disagreements[{i}].topic must be non-empty"
                )));
            }
            if d.positions.is_empty() {
                return Err(bad(format!(
                    "judge.disagreements[{i}].positions must name at least one member"
                )));
            }
            for (j, p) in d.positions.iter().enumerate() {
                if !is_slug(&p.member_id) {
                    return Err(bad(format!(
                        "judge.disagreements[{i}].positions[{j}].member_id {:?} does not match \
                         ^[a-z0-9][a-z0-9_-]{{0,127}}$",
                        p.member_id
                    )));
                }
                if p.view.is_empty() {
                    return Err(bad(format!(
                        "judge.disagreements[{i}].positions[{j}].view must be non-empty"
                    )));
                }
            }
            if d.what_settles.is_empty() {
                return Err(bad(format!(
                    "judge.disagreements[{i}].what_settles must be non-empty"
                )));
            }
        }

        let rs = &self.judge.release_safety;
        if rs.release != "safe" && rs.release != "hold" {
            return Err(bad(format!(
                "judge.release_safety.release must be \"safe\" or \"hold\", got {:?}",
                rs.release
            )));
        }
        if rs.min_takes < 1 {
            return Err(bad(
                "judge.release_safety.min_takes must be at least 1".to_string()
            ));
        }
        if rs.take_count != q.submitted {
            return Err(bad(format!(
                "judge.release_safety.take_count ({}) must equal quorum.submitted ({}) for the \
                 same session",
                rs.take_count, q.submitted
            )));
        }
        // Recomputable, so recomputed: the point of carrying take_count and
        // min_takes beside the flags is that a verifier never has to trust them.
        let expected_thin = rs.take_count < rs.min_takes;
        if rs.thinly_supported != expected_thin {
            return Err(bad(format!(
                "judge.release_safety.thinly_supported is {} but take_count < min_takes is \
                 {expected_thin}",
                rs.thinly_supported
            )));
        }
        for (i, c) in rs.concerns.iter().enumerate() {
            if c.is_empty() {
                return Err(bad(format!(
                    "judge.release_safety.concerns[{i}] must be non-empty"
                )));
            }
        }
        let expected_release = if !expected_thin && rs.concerns.is_empty() {
            "safe"
        } else {
            "hold"
        };
        if rs.release != expected_release {
            return Err(bad(format!(
                "judge.release_safety.release is {:?} but must be {expected_release:?} — \
                 release is \"safe\" iff (!thinly_supported and concerns is empty)",
                rs.release
            )));
        }

        if self.judge.source != "model" && self.judge.source != "fallback" {
            return Err(bad(format!(
                "judge.source must be \"model\" or \"fallback\", got {:?}",
                self.judge.source
            )));
        }

        // ── analyst_signatures ───────────────────────────────────────────────
        if self.analyst_signatures.is_empty() {
            return Err(bad(
                "analyst_signatures must carry at least one entry".to_string()
            ));
        }
        let mut seen: Vec<&str> = Vec::with_capacity(self.analyst_signatures.len());
        for (i, s) in self.analyst_signatures.iter().enumerate() {
            if !is_slug(&s.member_id) {
                return Err(bad(format!(
                    "analyst_signatures[{i}].member_id {:?} does not match \
                     ^[a-z0-9][a-z0-9_-]{{0,127}}$",
                    s.member_id
                )));
            }
            if seen.contains(&s.member_id.as_str()) {
                return Err(bad(format!(
                    "analyst_signatures names member_id {:?} twice; the canonical order would \
                     be ambiguous",
                    s.member_id
                )));
            }
            seen.push(&s.member_id);
            if !is_base64_body(&s.public_key, 43, 1) {
                return Err(bad(format!(
                    "analyst_signatures[{i}].public_key does not match ^[A-Za-z0-9+/]{{43}}=$ \
                     (standard padded base64 of a raw 32-byte Ed25519 public key)"
                )));
            }
            if s.canonical_submission.len() < 2 {
                return Err(bad(format!(
                    "analyst_signatures[{i}].canonical_submission must be at least 2 characters"
                )));
            }
            if !is_base64_body(&s.signature, 86, 2) {
                return Err(bad(format!(
                    "analyst_signatures[{i}].signature does not match ^[A-Za-z0-9+/]{{86}}==$ \
                     (standard padded base64 of a raw 64-byte Ed25519 signature)"
                )));
            }
        }

        // ── weights (optional, last) ─────────────────────────────────────────
        if let Some(weights) = &self.weights {
            if weights.len() != CANONICAL_BUCKET_ORDER.len() {
                return Err(bad(format!(
                    "weights must carry EXACTLY the {} canonical buckets, got {} — a vector \
                     that is not the canonical four is a REFUSAL, never a silent omission",
                    CANONICAL_BUCKET_ORDER.len(),
                    weights.len()
                )));
            }
            let mut sum: u64 = 0;
            for (i, w) in weights.iter().enumerate() {
                if w.bucket != CANONICAL_BUCKET_ORDER[i] {
                    return Err(bad(format!(
                        "weights[{i}].bucket is {:?} but canonical_bucket_order requires {:?}",
                        w.bucket, CANONICAL_BUCKET_ORDER[i]
                    )));
                }
                if w.weight_bps > 10_000 {
                    return Err(bad(format!(
                        "weights[{i}].weight_bps ({}) exceeds 10000",
                        w.weight_bps
                    )));
                }
                sum += u64::from(w.weight_bps);
            }
            if sum != 10_000 {
                return Err(bad(format!("weights sum to {sum} bps, must sum to 10000")));
            }
        }

        Ok(())
    }
}

// ─── Pinned pattern helpers ──────────────────────────────────────────────────
//
// Hand-rolled rather than `regex`-backed: the crate has no regex dependency and
// each pattern below is a fixed-shape check that a byte walk expresses exactly.

/// `floor((submitted / active) * 10000 + 0.5)` computed on integers — ROUND HALF
/// UP, not half-even, and never from a stored float. The two differ at an exact
/// .5 boundary (1 of 8 members is 1250 either way; 1 of 16 is 625), and a
/// receipt that disagrees on one is a receipt that fails to reproduce.
pub fn participation_bps(submitted: u64, active: u64) -> u32 {
    debug_assert!(active >= 1, "quorum.active must be at least 1");
    if active == 0 {
        return 0;
    }
    // (submitted * 10000 + active/2) / active  ==  floor(ratio * 10000 + 0.5)
    // for the half-up rule, in exact integer arithmetic.
    ((submitted * 10_000 + active / 2) / active) as u32
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
fn is_lowercase_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *c != b'-' {
                    return false;
                }
            }
            14 => {
                if !(b'1'..=b'5').contains(c) {
                    return false;
                }
            }
            19 => {
                if !matches!(c, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            _ => {
                if !is_lower_hex(*c) {
                    return false;
                }
            }
        }
    }
    true
}

/// `^[a-z0-9][a-z0-9_-]{0,127}$` — the pinned shape of `subject_id` and every
/// `member_id`. Constraining the character set is what makes the analyst order
/// unambiguous: over these ids, code-point order, UTF-8 byte order and
/// JavaScript's UTF-16 default sort are the same order.
fn is_slug(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 128 {
        return false;
    }
    if !(b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
        return false;
    }
    b[1..]
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// `^0x[0-9a-f]{64}$` — lowercase hex only.
fn is_hash32(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 66 && &b[..2] == b"0x" && b[2..].iter().all(|c| is_lower_hex(*c))
}

fn is_lower_hex(c: u8) -> bool {
    c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
}

/// `^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$`
///
/// Deliberately NOT an RFC 3339 parse: RFC 3339 admits fractional seconds and
/// numeric offsets, and three spellings of one instant would be three sets of
/// canonical bytes and three anchored digests for one session.
fn is_seconds_precision_utc(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 20 {
        return false;
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return false;
    }
    if b[19] != b'Z' {
        return false;
    }
    for i in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !b[i].is_ascii_digit() {
            return false;
        }
    }
    let two = |i: usize| (b[i] - b'0') * 10 + (b[i + 1] - b'0');
    let month = two(5);
    let day = two(8);
    let hour = two(11);
    let minute = two(14);
    let second = two(17);
    (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

/// `^[A-Za-z0-9+/]{body}={pad}$` — standard padded base64 of a fixed-length
/// payload. The URL-safe alphabet is deliberately rejected: the frontend
/// verifier reads standard base64 and a `-`/`_` spelling of the same key is
/// different canonical bytes.
fn is_base64_body(s: &str, body: usize, pad: usize) -> bool {
    let b = s.as_bytes();
    if b.len() != body + pad {
        return false;
    }
    b[..body]
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
        && b[body..].iter().all(|c| *c == b'=')
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Repo root, located by walking up from `CARGO_MANIFEST_DIR` until we find
    /// a `plugins/` directory next to `clients/`. Copied from
    /// `tests/skill_docs_parity.rs` so the in-crate tests reach the same
    /// repo-root fixtures the integration tests do.
    fn repo_root() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut cur: &Path = &manifest;
        loop {
            if cur.join("plugins").is_dir() && cur.join("clients").is_dir() {
                return cur.to_path_buf();
            }
            cur = cur.parent().expect(
                "walked past filesystem root without finding repo root \
                 (expected sibling `plugins/` and `clients/` directories)",
            );
        }
    }

    /// Read a repo-root fixture. A missing fixture PANICS — the cross-repo pin
    /// is the whole subject here, so a skipped assertion would be a false green.
    fn fixture(name: &str) -> Vec<u8> {
        let path = repo_root().join("tests/fixtures").join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn valid_receipt() -> ConsensusReceipt {
        ConsensusReceipt::from_json_slice(&fixture("consensus-receipt.valid.json"))
            .expect("the valid fixture parses")
    }

    #[test]
    fn valid_fixture_canonicalizes_to_the_committed_golden_bytes() {
        let produced = valid_receipt().canonical_bytes().expect("canonicalizes");
        let golden = fixture("consensus-receipt.valid.canonical.txt");
        assert_eq!(golden.len(), 2818, "golden length pinned by #1244");
        assert_eq!(
            produced, golden,
            "canonical bytes diverged from the committed golden"
        );
    }

    #[test]
    fn escaping_fixture_canonicalizes_to_the_committed_golden_bytes() {
        let receipt =
            ConsensusReceipt::from_json_slice(&fixture("consensus-receipt.escaping.json"))
                .expect("the escaping fixture parses");
        let produced = receipt.canonical_bytes().expect("canonicalizes");
        let golden = fixture("consensus-receipt.escaping.canonical.txt");
        assert_eq!(golden.len(), 3046, "golden length pinned by #1244");
        assert_eq!(
            produced, golden,
            "non-ASCII canonical bytes diverged from the committed golden"
        );
    }

    #[test]
    fn no_weights_fixture_omits_the_weights_key_entirely() {
        let receipt =
            ConsensusReceipt::from_json_slice(&fixture("consensus-receipt.valid-no-weights.json"))
                .expect("the no-weights fixture parses");
        assert!(receipt.weights.is_none());
        let bytes = receipt.canonical_bytes().expect("canonicalizes");
        let text = std::str::from_utf8(&bytes).expect("canonical bytes are utf-8");
        assert!(
            !text.contains("\"weights\""),
            "an absent weights vector must be omitted, never emitted as null or empty"
        );
        assert!(
            text.ends_with("}\n"),
            "trailing newline is part of the preimage"
        );
    }

    #[test]
    fn invalid_fixture_is_refused_by_validation() {
        let raw = fixture("consensus-receipt.invalid.json");
        let err = ConsensusReceipt::from_json_slice(&raw)
            .and_then(|r| r.canonical_bytes())
            .expect_err("the invalid fixture must be refused");
        assert_eq!(err.code(), "ErrReceiptSchema", "unexpected error: {err}");
    }

    #[test]
    fn analyst_signatures_verify_for_every_golden_fixture() {
        for name in [
            "consensus-receipt.valid.json",
            "consensus-receipt.escaping.json",
            "consensus-receipt.valid-no-weights.json",
        ] {
            let receipt = ConsensusReceipt::from_json_slice(&fixture(name))
                .unwrap_or_else(|e| panic!("{name} parses: {e}"));
            let checks = receipt
                .verify_analyst_signatures()
                .unwrap_or_else(|e| panic!("{name} signatures verify: {e}"));
            assert!(!checks.is_empty(), "{name} carries signatures");
            assert!(checks.iter().all(|c| c.verified), "{name}");
        }
    }

    #[test]
    fn a_corrupted_signature_is_refused_and_names_the_member() {
        let mut receipt = valid_receipt();
        // Flip one base64 character of the first signature, preserving the
        // pinned ^[A-Za-z0-9+/]{86}==$ shape so validation still passes and the
        // refusal comes from Ed25519 rather than from the pattern check.
        let sig = &mut receipt.analyst_signatures[0].signature;
        let first = if sig.starts_with('A') { 'B' } else { 'A' };
        sig.replace_range(0..1, &first.to_string());

        let err = receipt
            .verify_analyst_signatures()
            .expect_err("a corrupted signature must be refused");
        assert_eq!(err.code(), "ErrReceiptSignatureInvalid");
        assert!(
            err.to_string().contains("analyst-alpha"),
            "the error must name the failing member_id: {err}"
        );
    }

    #[test]
    fn analyst_signatures_are_sorted_by_member_id_before_serialization() {
        let mut receipt = valid_receipt();
        receipt.analyst_signatures.reverse();
        assert_eq!(receipt.analyst_signatures[0].member_id, "analyst-beta");
        let produced = receipt.canonical_bytes().expect("canonicalizes");
        assert_eq!(
            produced,
            fixture("consensus-receipt.valid.canonical.txt"),
            "an unsorted input must still canonicalize to the pinned order"
        );
    }

    #[test]
    fn a_missing_required_field_is_an_error_not_a_silently_omitted_key() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fixture("consensus-receipt.valid.json")).unwrap();
        value.as_object_mut().unwrap().remove("created_at");
        let raw = serde_json::to_vec(&value).unwrap();
        let err = ConsensusReceipt::from_json_slice(&raw).expect_err("must refuse");
        assert_eq!(err.code(), "ErrReceiptParse", "{err}");
        assert!(err.to_string().contains("created_at"), "{err}");
    }

    #[test]
    fn an_explicit_null_weights_is_refused() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fixture("consensus-receipt.valid.json")).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("weights".to_string(), serde_json::Value::Null);
        let raw = serde_json::to_vec(&value).unwrap();
        let err = ConsensusReceipt::from_json_slice(&raw).expect_err("must refuse");
        assert_eq!(err.code(), "ErrReceiptSchema", "{err}");
    }

    #[test]
    fn unknown_input_fields_are_dropped_not_serialized() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fixture("consensus-receipt.valid.json")).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("model".to_string(), serde_json::json!("gpt-nonexistent"));
        let raw = serde_json::to_vec(&value).unwrap();
        let produced = ConsensusReceipt::from_json_slice(&raw)
            .expect("unknown fields are ignored")
            .canonical_bytes()
            .expect("canonicalizes");
        assert_eq!(
            produced,
            fixture("consensus-receipt.valid.canonical.txt"),
            "an unknown input field must never reach the canonical bytes"
        );
    }

    #[test]
    fn created_at_admits_exactly_one_spelling() {
        assert!(is_seconds_precision_utc("2026-08-26T16:00:00Z"));
        // Every one of these denotes a legal RFC 3339 instant and every one is
        // refused: three spellings would be three anchored digests.
        for bad in [
            "2026-08-26T16:00:00.000Z",  // fractional seconds
            "2026-08-26T18:00:00+02:00", // numeric offset
            "2026-08-26T16:00:00z",      // lowercase z
            "2026-08-26 16:00:00Z",      // space in place of T
            "2026-08-26T16:00:00",       // no zone
            "2026-13-26T16:00:00Z",      // month 13
            "2026-08-26T24:00:00Z",      // hour 24
            "2026-08-00T16:00:00Z",      // day 0
        ] {
            assert!(!is_seconds_precision_utc(bad), "must refuse {bad:?}");
        }
    }

    #[test]
    fn participation_bps_rounds_half_up_not_half_even() {
        // The boundary cases named in the canonicalization contract.
        assert_eq!(participation_bps(1, 8), 1250);
        assert_eq!(participation_bps(1, 16), 625);
        // The fixtures.
        assert_eq!(participation_bps(2, 3), 6667);
        assert_eq!(participation_bps(1, 3), 3333);
        assert_eq!(participation_bps(2, 2), 10_000);
        // Half-up and half-even disagree here: 3/8 = 3750 exactly, 1/8 = 1250
        // exactly. An exact .5 in the bps product rounds UP.
        assert_eq!(participation_bps(1, 800), 13);
    }

    #[test]
    fn receipt_id_is_domain_separated_and_session_subject_bound() {
        let receipt = valid_receipt();
        let expected = keccak256(
            format!(
                "{RECEIPT_ID_DOMAIN_SEPARATOR}{}\n{}",
                receipt.session_id, receipt.subject_id
            )
            .as_bytes(),
        );
        assert_eq!(receipt.receipt_id(), expected);
        // One receipt per session PER SUBJECT: changing either half changes the id.
        assert_ne!(
            derive_receipt_id(&receipt.session_id, "position-review"),
            expected
        );
        assert_ne!(
            derive_receipt_id("12440000-0000-4000-8000-000000000002", &receipt.subject_id),
            expected
        );
    }

    #[test]
    fn payload_digest_is_keccak256_over_the_untouched_golden_bytes() {
        let golden = fixture("consensus-receipt.valid.canonical.txt");
        assert_eq!(
            valid_receipt().payload_digest().expect("digest"),
            keccak256(&golden),
            "nothing may be prepended, appended, trimmed or re-encoded"
        );
        // The trailing newline is part of the preimage.
        assert_ne!(
            keccak256(&golden[..golden.len() - 1]),
            keccak256(&golden),
            "a trimmed preimage must not collide with the real one"
        );
    }

    #[test]
    fn pattern_helpers_pin_the_schema_shapes() {
        assert!(is_lowercase_uuid("12440000-0000-4000-8000-000000000001"));
        assert!(!is_lowercase_uuid("12440000-0000-4000-8000-00000000000A"));
        assert!(!is_lowercase_uuid("not-a-session-id"));
        assert!(is_slug("analyst-alpha"));
        assert!(is_slug("a"));
        assert!(!is_slug(""));
        assert!(!is_slug("-leading-dash"));
        assert!(!is_slug("Uppercase"));
        assert!(!is_slug(&"a".repeat(129)));
        assert!(is_hash32(&format!("0x{}", "1".repeat(64))));
        assert!(!is_hash32("0x1111"));
        assert!(!is_hash32(&format!("0x{}", "A".repeat(64))));
        assert!(is_base64_body(
            "T5RBDrNc2aEMfLwkqjIGTP/znuEyqJfXEgiDp+tI++E=",
            43,
            1
        ));
        assert!(!is_base64_body(
            "T5RBDrNc2aEMfLwkqjIGTP_znuEyqJfXEgiDp-tI++E=",
            43,
            1
        ));
    }
}
