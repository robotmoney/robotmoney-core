# ADR — Dapp browser-keygen security review

> Scope: dev-scout security-review record gating the browser-generated
> agent-credential flow named conditionally in
> `docs/technical/dapp-credential-decisions.md` §3.1. The flow is shipped
> behind a feature flag defaulting to `false`. This ADR is the
> precondition the §3.1 gate names: until it lands as Accepted and a
> downstream UI implementation issue references it, the flag must not be
> enabled in any released build.
>
> No frontend code, no wallet-adapter selection, and no flag flip is
> produced by this scout. The single output is this record plus the
> mechanical drift-catcher in
> `.github/scripts/check_browser_keygen_adr.py`.

---

## 1. Status

Accepted. Authored 2026-05-07 against
`docs/implementation-plan.md` §12 on branch
`feat/84-dev-scout-browser-keygen-security-review-adr`.

Companion ADRs:

- `docs/technical/dapp-credential-decisions.md` — the parent ADR that
  permits the browser-generated path **only as a conditional, labeled
  fork-mode flow** and names this security review as the gate. Every
  decision below tightens or operationalizes a clause from §3.1, §3.2,
  or §3.4 of that document.
- `docs/security-model.md` — establishes the role-separation invariant
  and the per-attack assessment table this ADR's threat model extends.
- `docs/technical/rmpc-read-output-contract.md` §3 — fixes the rmpc
  config schema the export step in §4 below produces.

## 2. Context

`docs/technical/dapp-credential-decisions.md` §3.1 commits the dapp to
ship the browser-generated keypair path only when:

1. The chain-env selector reports `fork` or `devnet` (never mainnet,
   never a known-funds testnet chain id).
2. A red-banner UX label warns "Software-backed credential — unsafe for
   production."
3. The freshly minted keypair is **immediately exported** (§3.4 of the
   parent ADR) and dropped from memory before the registration tx is
   offered.
4. A separate security-review ADR with explicit go/no-go conditions
   exists, and the downstream UI implementation issue references that
   ADR in its `## Canonical docs` section.

This document is item (4). It exists so a reviewer can look at one
file and answer: *under what exact conditions may the feature flag be
flipped on, what are we agreeing to defend against, what are we
explicitly choosing not to defend against, and what events force us to
re-open the review.*

Binding constraints carried forward from the parent ADR:

- The dapp's custody boundary remains: **public addresses, policy
  parameters, and signed-tx payloads cross the dapp/wallet boundary;
  private keys do not persist.**
- The exported `rmpc` config carries `unsafe_for_production = true`
  whenever a software-backed keystore is bundled, and `rmpc` itself
  refuses to start on a non-fork chain id when that flag is set unless
  `--allow-unsafe` is passed.
- "Any secret export must be explicit, encrypted where possible, and
  labeled as unsafe for production if it is software-backed."
  (`docs/implementation-plan.md` §12.)

## 3. Custody boundary

This section pins the exact lifetime and reachability of any private
byte string created by the browser-keygen flow. Anything not listed
here is a violation; the implementation issue carries the matching
test cases.

- **Creation site.** A single audited module (`dapp/keygen/inproc.ts`
  or equivalent) calls `crypto.subtle.generateKey` with a
  non-extractable `CryptoKey` where the curve permits, or — when raw
  bytes are required to format a geth-v3 keystore — uses
  `crypto.getRandomValues` directly into a `Uint8Array` that is
  zero-filled in a `finally` block. The module has no other exports
  that touch private bytes.
- **Lifetime.** The private bytes exist from the moment of generation
  until the encrypted-keystore export (§5) is finalized. After
  finalization the `Uint8Array` is overwritten with zeros and the
  reference is dropped. The module exposes no API that returns the
  raw private bytes outside its own scope.
- **Persistence — forbidden surfaces.** No write to `localStorage`,
  `sessionStorage`, `IndexedDB`, the Cache API, the Cookie store, the
  File System Access API, or any service-worker caches at any point
  in the flow. Static analysis in CI (lint rule plus a grep-style
  validator on the dapp source under §10's wiring) enforces these
  forbidden identifiers in the keygen module's import graph.
- **Egress — forbidden channels.** No `postMessage`, no
  `BroadcastChannel`, no `MessageChannel`, no `fetch`/`XMLHttpRequest`
  with a private-bytes payload. The only egress is the operator's
  explicit "Save encrypted keystore" interaction, which writes via the
  browser's standard download channel after passphrase encryption (§5).
- **Cross-process touch.** The browser-extension wallet (MetaMask,
  Rabby, etc.) is **never** offered the agent's private key. The
  agent registration tx is signed by the **human admin** wallet (per
  the role-separation invariant in `docs/security-model.md`); the
  agent's private key is only used later inside the operator's signer
  backend, never inside the dapp.
- **Memory dump exposure.** Documented as accepted residual risk: a
  determined attacker with arbitrary code execution inside the
  browser tab can read the keypair before the export step completes.
  The fork-mode-only constraint is the mitigation — the keypair is by
  policy a demo/devnet credential, not a custodial key for human
  funds.

## 4. Threat model

The model is per-attack rather than per-asset: each row names an
attacker capability, the asset at stake, the mitigation this ADR
commits to, and the explicitly accepted residual risk.

### 4.1 Clipboard exfiltration

- **Capability.** A page or extension reads `navigator.clipboard` while
  the dapp is open.
- **Asset.** The raw private key, if the operator copies it to share
  via password manager.
- **Mitigation.** The flow has **no copy-to-clipboard affordance for
  raw private bytes.** The only exportable artifact containing private
  material is the passphrase-encrypted geth-v3 keystore (§5). The
  passphrase entry field uses `autocomplete="off"`,
  `inputmode="text"`, and `type="password"`; the keystore JSON is
  delivered via the browser's download channel (not the clipboard).
- **Residual risk.** Operator pastes the passphrase into a chat
  window. Out of scope; the encrypted keystore without the passphrase
  is the secret we defend, and passphrase hygiene is a documented
  operator responsibility.

### 4.2 Supply-chain compromise (npm dependency or CDN)

- **Capability.** A transitive npm dependency, or a third-party script
  loaded at runtime, executes attacker-chosen code in the dapp origin.
- **Asset.** The raw private key during its in-memory window.
- **Mitigation.**
  - The keygen module imports **only** from the standard Web Crypto
    API and from a vetted, version-pinned in-tree implementation of
    geth-v3 keystore encoding. No runtime CDN loads. No dynamic
    `import()` from network-derived URLs.
  - A Content Security Policy is required at the dapp origin with
    `script-src 'self'` and no `'unsafe-inline'` / no `'unsafe-eval'`.
  - npm provenance (per the existing rmpc CLI publish workflow) is
    required for any first-party package the dapp depends on; third-
    party packages are pinned by integrity hash in the lockfile.
  - The downstream implementation issue carries an automated check
    that the keygen module's import graph contains zero network-
    resolved specifiers.
- **Residual risk.** A compromised first-party package that ships
  with valid provenance is undetected until the supply-chain alert
  fires. The fork-mode-only gate caps blast radius — a malicious
  build cannot mint usable mainnet credentials because the chain-env
  refusal (§6) is enforced in the same module.

### 4.3 Browser extension exposure

- **Capability.** A malicious or compromised browser extension with
  `<all_urls>` content-script permission injects code into the dapp
  page, hooks `window.crypto`, or scrapes the DOM.
- **Asset.** The raw private key and the operator-supplied passphrase.
- **Mitigation.**
  - The dapp documents — and the in-page banner restates — that the
    browser-keygen flow must be run in a fresh browser profile with
    only the wallet extension installed. The implementation issue
    carries a one-screen pre-flight that names this requirement.
  - The keygen module performs a runtime check that
    `crypto.subtle.generateKey` returns a `CryptoKey` whose
    `[[Class]]` matches the platform expectation; a mismatch is a
    hard refusal.
  - The flow is fork-mode-only; a successful extension attack mints a
    devnet credential, not a key over human funds.
- **Residual risk.** A wallet extension itself can read page DOM and
  hook `window.crypto`. We accept this; the same extension already
  custodies the human admin key, so the trust model does not worsen.

### 4.4 Evil-maid / unattended-machine

- **Capability.** Brief physical access to an unlocked browser
  session after the operator stepped away mid-flow.
- **Asset.** The in-memory keypair before export, or the encrypted
  keystore on disk plus a shoulder-surfed passphrase.
- **Mitigation.**
  - The flow auto-cancels and zeroizes the in-memory keypair on a
    tab-visibility change to `hidden` for longer than 60 seconds.
    Resuming requires re-running keygen.
  - The export download is gated behind an explicit click; no auto-
    download to disk. The passphrase entry field auto-blanks on
    visibility change.
- **Residual risk.** A physically present attacker who watches the
  passphrase entry can decrypt a keystore they later steal. Mitigated
  socially (operator runbook in the implementation issue) and
  mechanically by the fork-only chain-env refusal.

### 4.5 Plausibly-deniable / silent export

- **Capability.** A subtly malicious dapp build smuggles the private
  key out via a side channel disguised as a benign UI event (e.g. an
  analytics ping with the key encoded in a query parameter).
- **Asset.** The raw private key.
- **Mitigation.**
  - The keygen module's outbound network surface is enumerated and
    asserted-zero by the import-graph check named in §4.2.
  - Network calls from the dapp at large are restricted by CSP
    `connect-src` to the configured RPC origin and the configured
    explorer-API origin only. No analytics endpoints, no error-
    reporting SaaS, no font/CDN connect targets.
  - The downstream UI implementation issue must include an automated
    test that boots the dapp under a sniffing proxy, runs the
    browser-keygen flow on a fork env, and asserts that no outbound
    request body or URL contains the generated private bytes or the
    passphrase. (The test seeds a known keypair via a test-only hook
    so the assertion is mechanical.)
- **Residual risk.** A perfect side channel through the wallet
  extension is undetectable from the dapp side; covered by §4.3.

### 4.6 Mainnet-misconfiguration

- **Capability.** The operator's RPC URL points to mainnet (or a
  testnet chain id used for human funds) while the chain-env selector
  is misread as `fork`.
- **Asset.** A registration tx that grants AGENT_ROLE to a software-
  backed credential on a chain that holds real value.
- **Mitigation.** §6 below — chain-id verification is performed
  against the live RPC immediately before the registration prompt is
  shown, not just at flow start.
- **Residual risk.** RPC-spoofing by a compromised local network can
  return a forged `eth_chainId`; partially mitigated by also checking
  that the gateway contract code-hash at the configured address
  matches a known fork/devnet deployment recorded in the harness
  fixtures. A forged RPC that also serves a matching code-hash is
  treated as out of scope (it requires the attacker to have already
  deployed a perfect mirror, at which point the operator has bigger
  problems).

## 5. Key-export UX

The exportable artifact is a passphrase-encrypted geth-v3 keystore
JSON, paired with the TOML config bundle defined in
`docs/technical/dapp-credential-decisions.md` §3.4. This section pins
the UX surface around that artifact.

- **Encrypted file format.** geth-v3 keystore JSON
  (`crypto.cipher = "aes-128-ctr"`, `crypto.kdf = "scrypt"` with
  `n = 262144`, `r = 8`, `p = 1`, `dklen = 32`). The `address` field
  matches the freshly generated public address. The `id` field is a
  fresh random UUIDv4. No additional fields are added; the file must
  load verbatim into `geth account import` and into the rmpc software
  signer.
- **Passphrase entry.** Two-field entry (passphrase + confirm), both
  `type="password"`, both `autocomplete="off"`. A live strength meter
  is shown (zxcvbn or equivalent) and entry is **blocked** below a
  documented minimum strength score; the implementation issue pins
  the exact threshold. The dapp does not auto-generate, suggest, or
  store the passphrase. The passphrase string never leaves the
  keygen module's scope and is zero-filled after the keystore JSON
  is produced.
- **No auto-download to disk.** The keystore JSON is exposed only
  through an explicit "Download encrypted keystore" button click that
  triggers a `Blob`-backed `<a download>` interaction. There is no
  automatic save, no `showSaveFilePicker` pre-flight that fires on
  mount, and no fallback "we saved it for you" affordance. If the
  operator dismisses the export step, the keypair is zeroized and the
  flow restarts from scratch.
- **Companion TOML.** A second download exposes the
  `rmpc-config.toml` file with `unsafe_for_production = true` and
  `signer.kind = "encrypted_keystore"` per the parent ADR §3.4.
- **Confirmation gate.** The registration tx prompt is **not** shown
  until the operator has acknowledged a checkbox stating: "I have
  saved the encrypted keystore and the passphrase. The dapp does not
  retain either." Acknowledging the checkbox triggers the in-memory
  zeroization of the raw private bytes (only the public address
  remains in scope to populate the registration calldata).
- **No clipboard, no QR, no print.** The flow exposes neither a
  copy-to-clipboard button for any private material nor a QR / print
  affordance. Private material leaves the dapp exclusively as the
  encrypted keystore download.

## 6. Fork-vs-mainnet gate

The hard refusal of mainnet keygen is the single mechanical control
that makes the rest of this ADR a security boundary instead of a
suggestion. It is implemented at the keygen module's entry point and
re-checked immediately before the registration prompt.

- **UI hard-refusal — mainnet env.** When the chain-env selector
  reports any value other than `fork` or `devnet`, the keygen UI
  surface is **not rendered**. The route returns a refusal page
  naming this ADR and the §3.1 gate from the parent ADR. There is no
  "are you sure" override in the UI at all.
- **Live chain-id verification.** Before the registration prompt is
  shown, the keygen module issues an `eth_chainId` call to the
  configured RPC and compares the result against an allow-list of
  known fork/devnet chain ids recorded in the dapp config (sourced
  from `testing/ethereum-testnet/` plus any explicitly-named local
  Anvil chain ids). A mismatch is a hard refusal; the in-memory
  keypair is zeroized and the flow exits.
- **Live code-hash verification.** Alongside the chain-id check, the
  keygen module fetches the bytecode at the configured gateway
  address and compares the keccak hash against the fork-deployment
  hash recorded in the harness fixtures. A mismatch is a hard
  refusal. (Same mechanism the calldata-preview UX uses in the
  parent ADR §3.3.)
- **Unlock mechanism for the feature flag.** The browser-keygen
  feature flag (`DAPP_BROWSER_KEYGEN_ENABLED`, default `false`) may be
  flipped to `true` in a released build only when **all** of:
  1. This ADR exists at `docs/technical/dapp-browser-keygen-review.md`
     with the headings asserted by
     `.github/scripts/check_browser_keygen_adr.py` and is in
     `Status: Accepted`.
  2. The downstream UI implementation issue references this ADR in
     its `## Canonical docs` section (mechanically asserted by the
     same validator once the issue exists).
  3. The PR that flips the default carries an explicit named review
     by a human admin role-holder, captured in the PR's review log
     (squash-merge metadata).
  4. The runtime chain-env refusal in this section is covered by an
     automated test in the dapp's test suite that asserts the
     refusal page renders for every non-fork, non-devnet chain id in
     a fixed corpus including `1`, `5`, `10`, `137`, `42161`, and
     `8453`.
  Any one of (1)–(4) failing is a no-go. The feature flag remains
  `false` by default in the codebase even after the unlock; per-
  deployment opt-in is the intended pattern for fork demos.
- **Refusal copy.** The mainnet refusal page names this ADR by URL
  and includes a one-line "why" so an operator who hits it
  understands the constraint instead of routing around it.

## 7. Go/no-go conditions

This section is the bulleted reviewer-facing summary of §6's unlock
mechanism. A reviewer enabling the feature flag must be able to
answer each item with a yes; any no is a no-go.

- **Go.**
  1. ADR is Accepted and validator-clean.
  2. Downstream UI implementation issue exists and references this
     ADR in `## Canonical docs`.
  3. Mainnet-refusal automated test passes against the chain-id
     corpus in §6.
  4. CSP / import-graph automated checks (§4.2, §4.5) pass on the
     dapp build.
  5. Encrypted-keystore export round-trips: a generated keystore
     loads into `geth account import` and into the rmpc software
     signer in a CI test.
  6. Named human-admin sign-off recorded on the flag-flip PR.
- **No-go.** Any of: validator failure, missing downstream-issue
  cross-link, mainnet-refusal test missing or failing, CSP / import-
  graph check missing or failing, keystore round-trip failing, or
  absent named review on the flag-flip PR.

## 8. Re-evaluation triggers

This ADR is re-opened (status moves from Accepted to Under-Review,
the feature flag is forced back to `false`, and a new dev-scout issue
is filed) on any of:

- A CVE or advisory affecting `crypto.subtle`, the in-tree geth-v3
  keystore implementation, scrypt at the chosen parameters, or the
  CSP enforcement model in any browser the dapp claims support for.
- A change to `docs/technical/dapp-credential-decisions.md` §3.1, §3.2,
  or §3.4 — the parent constraints this ADR depends on.
- A change to the role-separation invariant in
  `docs/security-model.md`, or to the rmpc software-signer behavior
  documented in `docs/technical/rmpc-read-output-contract.md` §3.
- Any incident report — internal or external — describing a
  browser-side key extraction in a comparable dapp (MetaMask Snaps,
  WalletConnect modal, etc.).
- A request to extend the flow beyond fork/devnet, including any
  request to allow it on a "test" mainnet that holds non-zero
  human-controlled balances.
- The downstream UI implementation issue's acceptance criteria
  changing in a way that loosens any item in §6.

## 9. Out of scope

- HSM or hardware-wallet integration for the agent key. Tracked
  separately if/when ADR'd; the register-only path in the parent ADR
  already supports hardware/KMS signers without a new ADR.
- The wallet-adapter / framework selection (covered by the parent
  ADR §5).
- Mobile browsers. The flow is desktop-only at flag flip; mobile
  support is a separate ADR.
- A trusted-execution-environment (TEE) signer path. Considered and
  rejected as overbuilt for fork-only demo credentials.
- Auditing the browser extension's source code. The extension is
  trusted to the same level as the wallet that custodies the human
  admin key.

## 10. Validation

A drift-catcher (`.github/scripts/check_browser_keygen_adr.py`,
wired into `.github/workflows/docs-validators.yml`) asserts:

- This ADR exists and contains a heading per scope item enumerated by
  issue #84 (custody boundary, threat model, key-export UX, fork-vs-
  mainnet gate, go/no-go conditions).
- `docs/implementation-plan.md` §12 cross-links to this ADR.
- `docs/technical/dapp-credential-decisions.md` cross-links to this
  ADR (the §3.1 gate names this document).
- Any downstream UI implementation issue listed in the validator
  references this ADR in its `## Canonical docs` section. The
  downstream-issue list is empty at ADR acceptance time and is
  populated when the UI implementation issue is filed; until then the
  validator no-ops on the downstream check (consistent with the
  pattern in `.github/scripts/check_dapp_credential_adr.py`).

The validator replaces every reviewer-facing checklist item that
would otherwise live on issue #84.
