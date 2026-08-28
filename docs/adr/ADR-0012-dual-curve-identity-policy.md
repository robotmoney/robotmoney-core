# ADR-0012: Ed25519 is the default identity algorithm; secp256k1 is confined to the EVM boundary; one keystore primitive serves both curves

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** Product owner
- **Related:**
  - `clients/rust-payment-client/src/signer/software.rs` — the secp256k1
    software signer keystore (`kind: "rmpc-software-keystore"`)
  - `clients/rust-payment-client/src/committee_identity.rs` — the Ed25519
    committee MCP identity keystore
    (`kind: "rmpc-committee-identity-keystore"`)
  - `clients/rust-payment-client/src/bin/rmpc_keystore_import.rs` — the
    test-only secp256k1 import helper whose env-carried-secret pattern the
    committee-identity import subcommand adopts
  - `docs/technical/security-model.md` §4 (access control & admin — role
    separation, hardware-wallet requirement for admin signing)
  - `docs/technical/dapp-browser-keygen-review.md` §5 (key-export UX — the
    geth-v3 keystore spec this decision amends)
  - `robotmoney-frontend` (sibling repo): `backend/src/lib/signing.ts`
    (the Ed25519 verifier), `docs/architecture.md` §9.3 / §9.5.1 (the
    on-chain anchoring seam),
    `frontend/public/assets/js/app/alpine/views/apply-form.js` (the
    browser keygen this decision gives an import path)
  - `docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md` —
    the golden-fixture CI model reused for cross-implementation keystore
    compatibility

## Context

The repository signs with two elliptic curves and has never written down
why — or which one new keys should use.

**Two keystores, one format, zero shared code.** The secp256k1 software
signer (`clients/rust-payment-client/src/signer/software.rs`) and the
Ed25519 committee identity
(`clients/rust-payment-client/src/committee_identity.rs`) implement the
same encrypted-keystore envelope independently: Argon2id at identical
parameters (`m_cost=19456` KiB, `t_cost=2`, `p_cost=1` —
`software.rs:71-73`, `committee_identity.rs:77-79`), AES-256-GCM with a
12-byte nonce, a `version: 1` / `kind` discriminator, and the public
identifier bound as AEAD additional data (the EVM address in
`software.rs:174-186`, the raw Ed25519 public key in the committee
keystore). `derive_key` (`software.rs:416-431`,
`committee_identity.rs:424`) and every constant are duplicated
byte-for-byte; `committee_identity.rs:23-26` even says the layout
"deliberately mirrors" the signer's. Behavioral drift has already begun:
the software signer falls back from `RMPC_KEYSTORE_PASSPHRASE` to a
stdin read (`software.rs:388-414`), while the committee identity is
env-only via `RMPC_COMMITTEE_IDENTITY_PASSPHRASE` by design
(`committee_identity.rs:67-73`). Neither module restricts keystore file
permissions on write (`software.rs:209-212`,
`committee_identity.rs:195-198` — plain `std::fs::write`, no 0600).

**Neither curve choice is justified anywhere.**
`committee_identity.rs:9-21` explains Ed25519 only as wire-format
matching of the `robotmoney-frontend` verifier (raw 32-byte key, raw
64-byte signature, WebCrypto `crypto.subtle.verify({name:"Ed25519"})`);
the frontend's own `backend/src/lib/signing.ts:1-4` says only "Web
Crypto Ed25519 (supported by Bun)"; the frontend decision log
(`robotmoney-frontend/docs/decisions.md`) has no entry on curve or
signing choice at all. secp256k1 is equally unjustified — it is simply
what EVM transaction signing requires.

**An undocumented seam.** `robotmoney-frontend/docs/architecture.md`
§9.3 and §9.5.1 promise the option to "anchor" committee signatures
on-chain later, but never reconcile Ed25519 signatures with the
secp256k1/EVM chain — the EVM has no Ed25519 precompile, so a naive
"verify the signature on-chain" reading of that seam is unimplementable.

**A latent contradiction.** `docs/technical/dapp-browser-keygen-review.md`
§5 specifies a geth-v3 keystore (`scrypt` + `aes-128-ctr`) for the
flag-gated browser-keygen flow and requires that the file "load verbatim
into `geth account import` and into the rmpc software signer" (also its
go-gate item 5). The signer hard-rejects anything but
`argon2id`/`aes-256-gcm` (`software.rs:265-282`); as specified, that
round-trip test can never pass.

**The forcing feature request.** Users onboarding via
`robotmoney-frontend` `/committee/apply` generate an Ed25519 key in the
browser (`apply-form.js:22-36`: WebCrypto `generateKey`, private key
exported as base64 PKCS#8, delivered by clipboard copy only — cleartext,
no file) and cannot import it into the rmpc committee-identity keystore:
the CLI offers only `create` / `show-public-key` / `sign`
(`clients/rust-payment-client/src/cli.rs:449+`), so a browser-applied
user is forced onto a fresh key and an admin re-registration.

## Decision

### 1. Algorithm policy: Ed25519 by default, secp256k1 at the EVM boundary only

Ed25519 is the default signature algorithm for every **new**
key or identity that does not sign EVM transactions. This follows the
settled industry direction for system and service identity — OpenSSH's
preferred key type, TLS 1.3, Signal, age/minisign, FIDO2 — and its
technical grounds: deterministic RFC 8032 signing (no nonce-reuse
failure mode), no signature malleability, fast verification, 32-byte
keys and 64-byte signatures.

secp256k1 is a **historical artifact of the EVM** (inherited from
Bitcoin). We use it because the chain forces ECDSA-secp256k1 for
transaction signing and address derivation — a compatibility
requirement, not a preference. It appears only at the EVM boundary
(transaction signing, address derivation) and nowhere else. Any
proposal to use secp256k1 for a non-EVM purpose, or Ed25519 for an
EVM-transaction purpose, needs a new ADR.

### 2. One keystore primitive, two curves

The shared encrypted-keystore envelope — Argon2id KDF + AES-256-GCM,
`version`/`kind` discriminator, public identifier as AAD — is extracted
into a shared crate (e.g. `crates/rmpc-keystore`), parameterized over
curve, `kind` string, and AAD derivation. Both existing modules become
consumers; the on-disk formats (both `kind` strings, all field names,
the AAD bindings) are unchanged, so existing keystore files load
without migration.

The primitive implements **import / create / show / export** once.
Passphrase sourcing becomes a single policy with one explicit,
per-domain switch: env-only (the committee identity's non-interactive
posture) or env-or-stdin (the operator-attended signer posture) — the
current split stops being accidental drift and becomes a declared
parameter. The missing `0600` file-permission restriction is fixed once,
in the shared write path.

### 3. Domain namespaces stay; a generic key CLI is deferred

`rmpc committee-identity` and the signer keystore surface remain thin
bindings of a key to a **role**: each owns its defaults, env var names,
and guardrails (e.g. the committee identity's refuse-to-overwrite and
env-only passphrase). A generic `rmpc key` CLI namespace is deferred
until a third key kind actually exists — two consumers do not justify
an abstraction users would have to learn.

### 4. Security invariant: the curves never swap roles

Promoted from accident to rule: the Ed25519 committee identity carries
**no on-chain authority** — compromise of a committee key MUST NOT
enable moving funds; and the secp256k1 signer key never doubles as an
off-chain identity. Role separation between the two curves mirrors the
role-separation discipline of `docs/technical/security-model.md` §4
(no account holds more than one authority; admin signing is segregated
from agent signing). Any change that would let one key act in the other
key's domain is a security-model change and requires review against
that document.

### 5. The anchoring seam is resolved: commitments on-chain, verification off-chain

Ed25519 committee signatures are verified **off-chain** (by the
frontend verifier today, by any future consumer tomorrow). If and when
the anchoring option in `robotmoney-frontend/docs/architecture.md`
§9.3/§9.5.1 is exercised, the chain stores a **commitment** — e.g. a
`bytes32` hash of the canonical payload plus signature — and never
performs Ed25519 verification on-chain. There is no Ed25519 precompile
on the EVM; this ADR closes the seam so no future design assumes one.

### 6. The browser-keygen spec is amended to the rmpc keystore format

`docs/technical/dapp-browser-keygen-review.md` §5's geth-v3
(scrypt + aes-128-ctr) export format contradicts the software signer's
hard rejection of anything but argon2id/aes-256-gcm
(`software.rs:265-282`). That spec must be amended to emit the rmpc
keystore v1 format — or explicitly marked incompatible with the rmpc
signer and its "loads verbatim into the rmpc software signer" claim and
go-gate item 5 dropped. Silent contradiction is not an option.

## Consequences

- **`rmpc committee-identity import` becomes implementable** as a thin
  binding over the shared primitive: raw-seed hex is the primary input
  format; base64 PKCS#8 is accepted as a **transition** format for
  existing browser-apply users (the current `apply-form.js` export).
  The private key is never accepted on argv — file or env var only,
  mirroring the test-only `rmpc-keystore-import` pattern
  (`rmpc_keystore_import.rs:20-25`: env-carried secret, scrubbed on
  entry). A required `--public-key` cross-check rejects an import whose
  derived public key does not match the one the user registered.
- **Recommendation to `robotmoney-frontend`** (follow-up in the sibling
  repo, not done here): the apply page should emit the rmpc keystore v1
  **file** directly — passphrase entry plus Argon2id via WASM, AES-GCM
  via native WebCrypto — so no cleartext private key ever reaches the
  clipboard. Cross-implementation compatibility is locked by a
  checked-in golden fixture (a keystore generated by one implementation,
  decrypted by the other in CI), in the style of ADR-0011. The frontend
  should also record its own decision-log entry for its curve choice —
  `robotmoney-frontend/docs/decisions.md` currently has none.
- **De-duplication with no format break.** Both modules shed their
  copied KDF/AEAD code; drift like the passphrase-sourcing split becomes
  an explicit parameter, and the 0600 fix lands everywhere at once.
  Existing keystores keep loading unchanged.
- **A documented default for the next key.** Future identities (service
  identities, attestation keys, agent-to-agent auth) default to Ed25519
  without re-litigating the choice; only an EVM-transaction-signing need
  justifies secp256k1.
- **Accepted cost:** a new crate boundary and the migration of two
  working modules onto it — refactoring risk in security-sensitive
  code, mitigated by keeping the on-disk formats byte-identical and by
  the existing round-trip/tamper test suites in both modules.
- `docs/technical/dapp-browser-keygen-review.md` must be updated (its
  §5 format table and go-gate item 5) before the browser-keygen flag
  flip; until then that document is known-stale on the export format.

## Out of scope of this decision

- HSM/KMS signer backends and the `allow_software_fallback` posture
  (`software.rs:222-238`) — unchanged.
- The on-chain Investment Committee v0 (`rmpc committee register` /
  `vote-submit`), which correctly uses the EVM signer — unchanged.
- Any change to the frontend verifier's wire format (raw key, raw
  signature, standard padded base64) — the committee identity continues
  to match it exactly.
- Actually building the anchoring feature; only its verification model
  is fixed here.
