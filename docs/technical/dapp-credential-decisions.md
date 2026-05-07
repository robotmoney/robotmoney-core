# ADR — Dapp credential model, wallet-signing, calldata preview, and config export

> Scope: dev-scout decision record for Phase 6 (Human Dapp for Commands and Credentials) of `docs/implementation-plan.md` §12. Resolves the unresolved choices that gate any dapp implementation work: the agent-credential generation policy, the key-custody boundary, the calldata-preview UX requirements, and the `rmpc` config export format.
>
> Closes the open question gate in `docs/implementation-plan.md` §12. No frontend code or wallet-adapter selection is produced by this scout.

---

## 1. Status

Accepted. Authored 2026-05-07 against `docs/implementation-plan.md` §12 on branch `feat/59-dev-scout-dapp-credential-wallet-signing-model`. No prior ADR exists for this phase.

Companion ADRs:

- `docs/technical/explorer-schema-decisions.md` — locks the explorer as a non-authoritative read source. The dapp consumes the explorer API for history only; every safety-critical read goes to JSON-RPC directly. This ADR honors that separation.
- `docs/technical/rmpc-read-output-contract.md` §3 — defines the `rmpc` config shape that consumers must produce. The export format in §3.4 of this ADR is constrained by that contract.
- `docs/security-model.md` — establishes the role-separation invariant (human admin keys vs agent keys) that all four decisions below enforce.

## 2. Context

`docs/implementation-plan.md` §12 commits the dapp to eight primary workflows (connect wallet, select chain/env, inspect state, create/register agent credential, configure agent policy, grant/revoke roles, pause/unpause, export `rmpc` config) and names four open choices:

1. **Credential model.** Does the dapp generate agent keys in the browser, only register existing public addresses, or both? Under what conditions?
2. **Key-custody boundary.** Where does the agent's private key live, and what does the dapp ever touch?
3. **Calldata-preview UX.** What must a human see before signing an admin/policy tx? §12 says "target, calldata, role/policy effect, and expected risk" but does not lock the per-action shape.
4. **`rmpc` config export format.** What file does the dapp hand the operator? How is it consumed by `rmpc` (and by OpenCode/OpenClaw downstream)?

Binding constraints:

- **Role separation invariant** (`docs/security-model.md`, contracts `AccessRoles`): the agent key signs `deposit`/policy-bounded calls; the human admin key signs role grants, policy edits, pause, and credential registration. The dapp must not blur this line.
- **Phase-6 acceptance criteria** (§12): a human can authorize an agent without touching raw calldata; revocation is observable through `rmpc self-check`; exported config is sufficient for OpenCode/OpenClaw setup.
- **No fast-feedback optimization in the test harness** (user memory): the dapp should not invent a shortcut signer path just to make demos faster.
- **Software-backed key labeling** (§12): "any secret export must be explicit, encrypted where possible, and labeled as unsafe for production if it is software-backed."

## 3. Decisions

### 3.1 Credential model — **register-only by default; browser-generated permitted only as an explicit, labeled fork-mode flow**

- **Decision.** The dapp's default and only production-eligible credential flow is **register-only**: the operator brings a public address that already has its private key in the target signer backend (encrypted keystore on disk for the software signer, hardware wallet, or KMS). The dapp captures the public address, the chosen policy parameters, and the human admin signs the on-chain registration tx.
- **Conditional path.** A second, **fork-mode-only** flow may generate a fresh secp256k1 keypair in the browser for ephemeral demo agents. This flow is gated by:
  - A chain-env selector value of `fork` or `devnet` (never mainnet, never a known testnet chain id used for human funds).
  - A red-banner UX label: "Software-backed credential — unsafe for production."
  - Mandatory immediate export (§3.4) before the registration tx is offered; the dapp must not retain the private key past the export step, and must not write it to `localStorage`, `IndexedDB`, or any service worker cache.
  - An additional review trigger (see below) before this flow is enabled in code.
- **Additional review trigger.** Enabling the browser-generated flow in any released build requires a named review on a follow-up issue with the label `security-review` and explicit sign-off from a human admin role-holder. The downstream implementation issue (#60) carries this gate in its acceptance criteria; without that review the dapp ships with the flow disabled by feature flag (default off).
- **Rationale.** §12 names browser-generated credentials as "considered" and demands a separate design review. The default register-only path keeps the agent's private key in a signer backend that already exists in the rmpc trust model (encrypted keystore, hardware, KMS) — no new custody surface. The fork-mode escape hatch exists because the §12 acceptance criteria require a humans-only walkthrough that authorizes an agent on a fork; without an in-browser keygen, the walkthrough requires a separate CLI step and breaks the "without touching raw contract calldata" criterion.
- **Rejected alternatives.**
  - *Browser-generated by default.* Fails the role-separation invariant (the dapp temporarily holds an agent key) and creates a new custody story that `docs/security-model.md` does not currently cover.
  - *No browser-generated path at all.* Forces the §12 acceptance walkthrough to bounce through `rmpc keygen` mid-flow; loses the "without touching raw calldata" property for fork demos.

### 3.2 Key custody — **the dapp never persists a private key; agent secrets live in the target signer backend chosen by the operator**

- **Decision.** The dapp's custody boundary is: **public addresses, policy parameters, and signed-tx payloads cross the dapp/wallet boundary; private keys do not.** Concretely:
  - For register-only flows, the agent's private key never enters the dapp process; only its address is collected.
  - For the fork-mode browser-generated flow (§3.1), the keypair exists in a single in-memory `CryptoKey` (or equivalent JS-VM-local secret) for the duration of the export step and is dropped immediately after. No `localStorage`, `IndexedDB`, `BroadcastChannel`, service worker, or `postMessage` egress is permitted.
  - The human admin's key always lives in their wallet (browser wallet extension or hardware wallet). The dapp signs admin/policy transactions by sending an EIP-1193 request to that wallet — never by holding the admin key.
  - Exported `rmpc` config (§3.4) carries only the **public** agent address plus pointers/identifiers for the signer backend (keystore path, HW device id, KMS arn). When the export bundles a software keystore, that keystore is encrypted with an operator-supplied passphrase before it leaves the dapp.
- **Rationale.** §12 says: "the dapp may help generate a new agent public address or register an existing one, but it must not silently take custody of private keys." This decision converts that statement into a checkable boundary: every code path that touches a private byte string must terminate inside a single, audited module that has no persistence and no postMessage egress.
- **Constraint cited.** `docs/security-model.md` role-separation invariant; §12 "must not silently take custody of private keys"; "any secret export must be explicit, encrypted where possible."
- **Rejected alternatives.**
  - *Dapp-managed encrypted keystore in IndexedDB.* Re-creates a wallet inside the dapp; doubles the audit surface and blurs the role-separation boundary on which `rmpc`'s self-check relies.
  - *Per-session derived key encrypted with a wallet-signed message.* Cleverness for its own sake; the user already has a wallet, and the agent already has a signer backend. Adding a third custody surface that lives in the dapp is not justified.

### 3.3 Calldata preview UX — **every admin/policy signing prompt decodes target, function, args, role/policy effect, and risk class before the wallet is invoked**

- **Decision.** The dapp must render a structured preview block before opening the wallet's signing modal. The preview has a fixed shape per action class (role grant, role revoke, agent registration, policy edit, pause, unpause, config export commit). Each preview row has the following required fields:
  - **Target.** Contract address plus a verified-by-bytecode-hash badge (matching the deployed code hash recorded in the harness fixtures or `docs/technical/smart-contracts.md`). Unknown bytecode hash is a hard refusal — the preview shows red and the wallet button is disabled.
  - **Function.** Human-readable selector (`grantRole(bytes32,address)`, `setAgentPolicy(...)`, `pause()`, etc.) plus the raw 4-byte selector.
  - **Decoded args.** Each argument printed as both its raw ABI-decoded value and a human gloss (e.g. `role = AGENT_ROLE`, `cap = 100 USDC (6dp)`, `valid_until = 2026-06-01 UTC`).
  - **Role/policy effect.** A one-line sentence stating the post-state delta. For role grants: "Address `0xabc…` will hold AGENT_ROLE; this lets it call `deposit` within policy caps." For policy edits: "Per-deposit cap rises from 50 USDC to 100 USDC; per-window cap unchanged."
  - **Risk class.** One of `low` / `medium` / `high` / `unsafe` based on a fixed table:
    - `unsafe`: pause/unpause on a non-fork env without a recent rmpc self-check; granting a role to an EOA whose code-hash check has failed; software-backed credential export on a non-fork env.
    - `high`: granting any admin role; revoking the only remaining holder of an admin role; setting policy caps above an env-specific threshold.
    - `medium`: granting AGENT_ROLE; raising a policy cap below threshold; rotating an existing agent's policy.
    - `low`: revoking AGENT_ROLE; lowering a policy cap; pausing on a fork.
  - **Calldata.** The raw hex calldata, copy-able, with the selector highlighted. This is shown so a paranoid operator can paste into a second tool (`cast 4byte`, etherscan, etc.) and verify before signing.
- **Behavior.** If any required field cannot be filled (decoder failure, unknown contract, ABI mismatch, RPC unreachable), the preview is **blocking**: the wallet signing button is disabled and the preview surfaces the missing field. The dapp must not fall back to "sign raw calldata" mode.
- **Rationale.** §12 names the four required preview fields ("target, calldata, role/policy effect, expected risk"). This decision pins their shape and adds a hard refusal on decoder failure, so a rendering bug never silently degrades to a raw-calldata signing prompt — that degradation is the exact failure mode `docs/security-model.md` flags as "operator misled into signing arbitrary calldata."
- **Rejected alternatives.**
  - *Free-form preview that varies per action.* Loses the shape contract that lets reviewers and screenshot-based audits check completeness.
  - *Best-effort preview with fall-through to raw calldata when decoding fails.* The fall-through is the failure mode we are trying to prevent.

### 3.4 `rmpc` config export — **TOML bundle with a fixed schema; software-backed exports include an encrypted keystore and an `unsafe_for_production = true` marker**

- **Decision.** The dapp exports a single TOML file, `rmpc-config.toml`, with the following top-level shape (concrete field names tracked alongside the rmpc crate's existing config loader):

  ```toml
  schema_version = "1"
  unsafe_for_production = false        # true iff signer.kind = "encrypted_keystore"

  [chain]
  chain_id = 11155111
  name = "sepolia-fork"
  rpc_url = "http://localhost:8545"

  [contracts]
  gateway = "0x…"
  vault   = "0x…"
  gateway_code_hash = "0x…"            # pinned hash for rmpc preflight

  [agent]
  address = "0x…"

  [signer]
  kind = "encrypted_keystore" | "hardware" | "kms"
  # kind-specific fields:
  #   encrypted_keystore: keystore_path, keystore_format = "geth-v3"
  #   hardware:           device, derivation_path
  #   kms:                provider, key_id, region

  [policy]
  per_deposit_cap = "100000000"        # uint256 string, USDC 6dp
  per_window_cap  = "1000000000"
  window_seconds  = 86400
  valid_until     = "2026-06-01T00:00:00Z"
  ```

- **Companion file.** When `signer.kind = "encrypted_keystore"`, the export also includes `agent-keystore.json` (geth v3 keystore JSON), encrypted with an operator-supplied passphrase. The dapp must show the operator the passphrase entry UI, must not auto-generate a passphrase, and must not store the passphrase anywhere — the encrypted keystore leaves the browser, the passphrase stays in the operator's head or password manager.
- **Hardware/KMS exports.** For `hardware` and `kms` signer kinds, the export contains only public information and is safe to commit to a secret manager. `unsafe_for_production = false`.
- **Software-backed exports.** When `signer.kind = "encrypted_keystore"`, `unsafe_for_production = true` is mandatory, and the dapp displays the same red-banner label from §3.1. `rmpc` itself must refuse to start on a non-fork chain id when this flag is set unless an explicit `--allow-unsafe` flag is passed; that refusal is implemented in the `rmpc` binary, not the dapp, but is named here so the cross-cutting contract is visible.
- **Rationale.** A fixed schema means the OpenCode and OpenClaw walkthroughs (`docs/skills/`, `docs/openclaw-config.md`) can paste the file into their own setup without bespoke parsing. TOML matches the `rmpc` config loader already in use. The `unsafe_for_production` marker is the mechanical enforcement of §12's "labeled as unsafe for production if it is software-backed" rule.
- **Rejected alternatives.**
  - *JSON.* The `rmpc` loader already accepts TOML; introducing a second format costs a parser and a docs split.
  - *A single signed bundle (zip + manifest signature).* Adds a custody story (signing key for the bundle) that does not exist yet. The TOML + optional encrypted-keystore pair already gives the operator everything they need; bundle signing can be a later ADR if it pays for itself.

## 4. Consequences

- **Phase 6 implementation (#60)** inherits a credential model, a custody boundary, a preview shape, and an export schema. The follow-on issue can be implemented without re-litigating any of the four.
- **Browser-generated credentials are off by default** behind a feature flag. Enabling them ships with a security-review gate so the additional review trigger named in §3.1 is mechanically visible.
- **The `rmpc` binary** owes a refusal path for `unsafe_for_production = true` configs on non-fork chain ids. That refusal is named here but tracked separately (rmpc startup preflight already handles code-hash and role checks; the unsafe-flag check is one more line in that preflight).
- **The explorer dapp surface** is unaffected: the explorer is read-only and the dapp consumes it through the public HTTP API.

## 5. Out of scope

- Wallet adapter selection (WalletConnect v2, RainbowKit, raw EIP-1193, etc.). Picked at implementation time on #60.
- Frontend framework choice (Next.js vs Vite vs SvelteKit). Picked at implementation time on #60.
- Mobile UX. §12 marks this out of scope.
- Cross-chain admin batching. §12 marks this out of scope.
- Automated end-to-end browser tests of the dapp. The validator at `.github/scripts/check_dapp_credential_adr.py` covers ADR/issue alignment only; behavioral tests land with the implementation issue.

## 6. Validation

A drift-catcher (`.github/scripts/check_dapp_credential_adr.py`, wired into `.github/workflows/docs-validators.yml`) asserts:

- This ADR exists and has a heading addressing each of the four scope items (credential model, custody, calldata preview, config export).
- `docs/implementation-plan.md` §12 cross-links to this ADR.
- Downstream issue #60's `## Canonical docs` section references this ADR.

The validator replaces the two manual review items previously on issue #59. It mirrors the pattern in `.github/scripts/check_explorer_adr.py` (ADR #56 / issues #57, #58).
