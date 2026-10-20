# ADR — Dapp credential model, wallet-signing, calldata preview, and config export

> Scope: dev-scout decision record for Phase 6 (Human Dapp for Commands and Credentials) of `Plan tracking issue #109` §12. Resolves the unresolved choices that gate any dapp implementation work: the agent-credential generation policy, the key-custody boundary, the calldata-preview UX requirements, and the `rmpc` config export format.
>
> Closes the open question gate in `Plan tracking issue #109` §12. No frontend code or wallet-adapter selection is produced by this scout.

---

## 1. Status

Accepted. Authored 2026-05-07 against `Plan tracking issue #109` §12 on branch `feat/59-dev-scout-dapp-credential-wallet-signing-model`. No prior ADR exists for this phase.

**Amendment 2026-10-19 (owner decision):** `rmpc`'s only on-chain write is an agent deposit into a single vault through the gateway. Mentions below of `rmpc withdraw`, `withdraw-router`, router deposits by an agent or gateway withdrawals are deprecated.

**Amendment 2026-10-20:** the owner decisions in `docs/architecture.md`
§5.2 and invariant `ACL-9` govern authorization: on-chain agent consent,
owner commit, then a three-argument reveal; owner-only policy updates,
owner or agent self-revoke, and non-empty owner-selected vault
destinations. This supersedes the former EIP-712 consent text in §3.3.
The 2026-10-14 software-keystore decision supersedes the original export
sketch and production restriction; §3.4 now states the flat config contract.
These are specification requirements. The remaining code gaps are tracked
in RS-1019-10 through RS-1019-12 and RS-1019-15, and SS-1019-11.

Companion ADRs:

- `docs/technical/explorer-schema-decisions.md` — locks the explorer as a non-authoritative read source. The dapp consumes the explorer API for history only; every safety-critical read goes to JSON-RPC directly. This ADR honors that separation.
- `docs/technical/rmpc-read-output-contract.md` — defines read envelopes and implementation-pin output. The export format in §3.4 of this ADR follows the config loader and is checked by the dapp TOML round-trip test.
- `docs/technical/security-model.md` — establishes the role-separation invariant (human admin keys vs agent keys) that all four decisions below enforce.

## 2. Context

`Plan tracking issue #109` §12 commits the dapp to eight primary workflows (connect wallet, select chain/env, inspect state, create/register agent credential, configure agent policy, grant/revoke roles, pause/unpause, export `rmpc` config) and names four open choices:

1. **Credential model.** Does the dapp generate agent keys in the browser, only register existing public addresses, or both? Under what conditions?
2. **Key-custody boundary.** Where does the agent's private key live, and what does the dapp ever touch?
3. **Calldata-preview UX.** What must a human see before signing an admin/policy tx? §12 says "target, calldata, role/policy effect, and expected risk" but does not lock the per-action shape.
4. **`rmpc` config export format.** What file does the dapp hand the operator? How is it consumed by `rmpc` (and by OpenCode/OpenClaw downstream)?

Binding constraints:

- **Role separation invariant** (`docs/technical/security-model.md`, contracts `AccessRoles`): the agent key signs its consent, policy-bounded deposit and self-revoke. The depositor's wallet signs registration and policy changes for its own agents. System governance signs role/configuration changes through its Safe and timelock; its roles give it no authority over a depositor's agents. The dapp must not blur these authorities.
- **Phase-6 acceptance criteria** (§12): a human can authorize an agent without touching raw calldata; revocation is observable through `rmpc self-check`; exported config is sufficient for OpenCode/OpenClaw setup.
- **No fast-feedback optimization in the test harness** (user memory): the dapp should not invent a shortcut signer path just to make demos faster.
- **Software-backed key labeling** (§12): "any secret export must be explicit, encrypted where possible, and labeled as unsafe for production if it is software-backed."

**Which system each flow touches (owner decisions 2026-10-19 and 2026-10-20).** Agent registration, policy, revoke, gateway roles and the gateway's deposit pause write to the rmpc gateway system; config export is local. Human deposit, redeem and router flows write to the vaults system directly. The gateway is a client of the vaults system. Human vault/router actions and vaults-system Safe/timelock operations require their own target verification and must work with no gateway configured or verified. Gateway verification applies only to gateway actions (SS-1019-11). There is no on-chain committee policy. The submitter Safe records consensus receipts directly through publish-contracts `record-receipt`; the dapp displays receipts without a receipt-writing action.

## 3. Decisions

### 3.1 Credential model — **register-only; the dapp never generates or holds private keys**

- **Decision.** The dapp's only credential flow is **register-only**: the operator brings a public address whose private key already lives in the target signer backend (encrypted keystore on disk for the software signer, hardware wallet, or KMS). The dapp captures the public address and policy parameters. The agent consents from its own key, then the depositor's wallet commits and reveals (§3.3). The agent address is produced out-of-band — for first-run setup, the onboarding wizard hands the operator a paste-ready bootstrap prompt (`BOOTSTRAP.md`) so the agent runtime itself generates the key in its own signer backend and prints the public address back to the operator.
- **No browser-generated path.** Earlier revisions of this ADR carved out a fork-mode-only browser-keygen flow gated by a feature flag and a separate security review (`docs/technical/dapp-browser-keygen-review.md`). That carve-out is withdrawn: the dapp must never run keypair generation in its own process. Any historical hooks (`VITE_BROWSER_KEYGEN`, `browserGeneratedCredential` feature flag, in-browser keystore export) are removed.
- **Rationale.** §12 names browser-generated credentials as "considered" and demands a separate design review. Adding any in-browser keygen surface — even fork-only and flag-gated — recreates a custody story `docs/technical/security-model.md` does not cover, and the dapp's role-separation boundary is much easier to keep honest when no code path inside the dapp can produce a private key in the first place. The acceptance walkthrough's "without touching raw calldata" property is preserved by the bootstrap-prompt step, which keeps key creation inside the agent runtime where it already belongs.
- **Rejected alternatives.**
  - *Browser-generated by default.* Fails the role-separation invariant (the dapp temporarily holds an agent key) and creates a new custody story that `docs/technical/security-model.md` does not currently cover.
  - *Browser-generated as a fork-mode-only, flag-gated escape hatch (prior decision).* Withdrawn — the audit and review burden of an "off by default, on by flag" keygen path is not justified once the bootstrap-prompt flow exists.

### 3.2 Key custody — **the dapp never persists a private key; agent secrets live in the target signer backend chosen by the operator**

- **Decision.** The dapp's custody boundary is: **public addresses, policy parameters, and signed-tx payloads cross the dapp/wallet boundary; private keys do not.** Concretely:
  - The agent's private key never enters the dapp process; only its address is collected. There is no in-browser keygen path (see §3.1) — no code in the dapp constructs a `CryptoKey`, holds raw secret bytes, or writes them to `localStorage`, `IndexedDB`, `BroadcastChannel`, a service worker, or `postMessage`.
  - A depositor or Safe owner's key always lives in their wallet (browser wallet extension or hardware wallet). The dapp requests policy transactions or Safe typed-data signatures over EIP-1193; it never holds those keys.
  - Exported `rmpc` config (§3.4) carries public settings plus pointers/identifiers for the signer backend (keystore path, HW device id, KMS arn). The dapp never bundles, decrypts or encrypts an agent keystore; setup in the agent's signer backend owns that file and its passphrase.
- **Rationale.** The register-only decision in §3.1 makes the custody boundary checkable: no dapp module receives agent private bytes, including for an export or a test chain.
- **Constraint cited.** `docs/technical/security-model.md` role-separation invariant; §12 "must not silently take custody of private keys"; "any secret export must be explicit, encrypted where possible."
- **Rejected alternatives.**
  - *Dapp-managed encrypted keystore in IndexedDB.* Re-creates a wallet inside the dapp; doubles the audit surface and blurs the role-separation boundary on which `rmpc`'s self-check relies.
  - *Per-session derived key encrypted with a wallet-signed message.* Cleverness for its own sake; the user already has a wallet, and the agent already has a signer backend. Adding a third custody surface that lives in the dapp is not justified.
- **Amendment (2026-10-06) — admin writes after the timelock handover.** The decision above still holds. It assumed a human admin key in a browser wallet. That assumption no longer holds:
  - After the vaults-system handover the TimelockController holds its contracts' `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`, and no EOA does (`docs/technical/security-model.md` §4). The only allowed test/mainnet differences are key custody, owner membership, chain and delay value (`docs/technical/governance-isomorphism.md`). Protocol admin changes therefore go through the Safe and timelock. A depositor's own agent registration and policy changes remain direct wallet actions. Gateway governance is decided separately for its release (`docs/architecture.md` §10).
  - The dapp's admin tabs therefore do not send a wallet transaction. They build the governance payload: `timelock.schedule(target, 0, data, predecessor = 0, salt, delay = getMinDelay())` wrapped as a Safe transaction with EIP-712 typed data, which a Safe owner's own wallet signs with `eth_signTypedData_v4` (decision of 2026-10-07, core 1544). The Admin Role and Deposit Pauser Role grant and revoke tabs and the Unpause button read "Create Safe proposal". The `pauseDeposits()` call is not an admin action: it stays a direct `DEPOSIT_PAUSER_ROLE` wallet transaction.
  - **Preview.** The §3.3 block (target with bytecode badge, function, decoded args, role effect, risk class) is kept and extended with the Safe address, threshold, owners, Safe nonce, timelock address, min delay, salt, predecessor and operation id, plus the Safe transaction hash and the typed data the wallet will sign. The salt is deterministic (a digest of the chain, Safe, Safe nonce, target and inner calldata), so a second owner who rebuilds the proposal gets identical bytes.
  - **Refusals, all before the wallet is asked.** The Safe or timelock address is not configured (the preview renders, there is no button); the Safe is not canonical SafeL2 v1.4.1 (version, proxy codehash or singleton differ); the connected address is not a Safe owner; the Safe lacks `PROPOSER_ROLE` on the timelock (`EXECUTOR_ROLE` for execute); the local digest differs from `Safe.getTransactionHash`. The builder itself refuses any `operation` other than 0, any non-zero value, `safeTxGas`, `baseGas`, `gasPrice`, `gasToken` or `refundReceiver`, and any `to` other than the configured timelock, so no typed data exists for them. Never `eth_sign`, `personal_sign` or raw-calldata signing.
  - **Bundle.** The signature bundle is exported as `robotmoney-safe-tx/1` JSON, the same format the publish-contracts Safe tool reads and writes (`publish-contracts/src/safe`). The dapp imports a second owner's bundle after recovering each signature against the transaction hash, packs signatures ascending by owner address, and once the Safe threshold is reached offers `execTransaction` from any connected wallet (gas only, not a signer) or a hand-off to the publish-contracts tool. Bundles move between owners out of band.
  - **Execute.** A ready single-call operation the dapp can decode is offered as an execute proposal from the Timelock panel through the same flow (`timelock.execute(...)`). The panel is read-only otherwise. Readiness comes from the chain (`isOperationReady`), never the browser clock.
  - **Non-goals.** The dapp is not a Safe web app and runs no Safe Transaction Service client or signer service. It holds no private key. MultiSend, `scheduleBatch`, cancel proposals and Safe or timelock self-administration are out of scope. The flow is identical on the Twin chain and Base. The runtime config key is `VITE_SAFE_ADDRESS` (with `VITE_TIMELOCK_ADDRESS`).
  - Agent registration and rotation are depositor actions. A depositor authorizes its own agent with `commitAuthorization` + `revealAuthorization` (no role; the caller must name itself as `shareReceiver`) and becomes `agentOwner`. Only that owner can `setPolicy` while the registration is live. The owner or the agent itself can `revokeAgent`. Ownership never transfers within a registration; a new owner needs a new registration and fresh consent after revoke or expiry (`docs/architecture.md` §5.2). The Rotation tab takes this commit/reveal path for every wallet.
- **Amendment (2026-10-20) — no admin agent registration.** `authorizeAgent` is removed from the design. It let an `ADMIN_ROLE` holder register an agent in one transaction without the agent's consent. End users never need it, and it widens the admin attack surface. Commit and reveal is the only way to register an agent. The dapp has no `authorizeAgent` preview or button. Where today's code still has it is recorded in `docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-rmpc-scope.md` finding 10.

### 3.3 Calldata preview UX — **every admin/policy signing prompt decodes target, function, args, role/policy effect, and risk class before the wallet is invoked**

- **Decision.** The dapp must render a structured preview block before opening the wallet's signing modal. The preview has a fixed shape per action class (role grant, role revoke, agent registration, policy edit, pause, unpause, config export commit). Each preview row has the following required fields:
  - **Target.** Contract address plus a verified-by-bytecode-hash badge (matching the deployed code hash recorded in the harness fixtures or `docs/technical/smart-contracts.md`). Unknown bytecode hash is a hard refusal — the preview shows red and the wallet button is disabled.
  - **Function.** Human-readable selector (`grantRole(bytes32,address)`, `setPolicy(...)`, `pauseDeposits()`, etc.) plus the raw 4-byte selector.
  - **Decoded args.** Each argument printed as both its raw ABI-decoded value and a human gloss (e.g. `role = DEPOSIT_PAUSER_ROLE`, `cap = 100 USDC (6dp)`, `valid_until = 2026-06-01 UTC`).
  - **Role/policy effect.** A one-line sentence stating the post-state delta. For a pauser grant: "Address `0xabc…` will hold DEPOSIT_PAUSER_ROLE; this lets it pause deposits." For policy edits: "Per-deposit cap rises from 50 USDC to 100 USDC; per-window cap unchanged." `AGENT_ROLE` has no grant, revoke or renounce UI; registration and `revokeAgent` manage it internally.
  - **Risk class.** One of `low` / `medium` / `high` / `unsafe` based on a fixed table:
    - `unsafe`: pause/unpause on a non-fork env without a recent rmpc self-check; granting a role to an EOA whose code-hash check has failed; software-backed credential export on a non-fork env.
    - `high`: granting any admin role; revoking the only remaining holder of an admin role; setting policy caps above an env-specific threshold.
    - `medium`: registering an agent with consent; raising a policy cap below threshold; rotating an existing agent's policy.
    - `low`: owner revoke or agent self-revoke through `revokeAgent`; lowering a policy cap; pausing on a fork.
  - **Calldata.** The raw hex calldata, copy-able, with the selector highlighted. This is shown so a paranoid operator can paste into a second tool (`cast 4byte`, etherscan, etc.) and verify before signing.
- **Behavior.** If any required field cannot be filled (decoder failure, unknown contract, ABI mismatch, RPC unreachable), the preview is **blocking**: the wallet signing button is disabled and the preview surfaces the missing field. The dapp must not fall back to "sign raw calldata" mode.
- **The previewed call is the signed call (QA plan U4; amended 2026-10-20).** The preview and wallet request are built from one object (`clients/dapp/src/lib/commitReveal.ts`). Authorize, onboarding and rotation freeze the agent, owner, salt and policy, including a non-empty list of owner-selected ERC-4626 vault destinations, `shareReceiver == owner`, and zero values in all retired withdrawal fields. The owner chooses those contracts offline; the gateway checks policy membership without a registry-membership gate.
  - Build the exact three-argument `revealAuthorization(agent, salt, policy)` calldata. For a distinct agent key, the agent first calls `commitAuthorization(keccak256(abi.encode(owner, keccak256(revealCalldata))))` from its own signer backend. The dapp displays the exact consent hash and confirms that commitment on-chain before enabling the owner's commit. It never requests the agent's private key. The former EIP-712 consent signature, nonce and `rmpc agent-consent` command are superseded; there is no fourth reveal argument.
  - The owner then calls `commitAuthorization(keccak256(abi.encode(agent, owner, salt)))`. The owner reveals in a later block, within `COMMIT_EXPIRY_BLOCKS` (256 blocks) of both commitments. Both must still be live; the reveal consumes them. Changing a bound input requires fresh consent. A self-registration consents by calling and needs no separate consent commitment.
  - Preview the policy before the consent and again before reveal. Each transaction shows its own receipt; the flow completes only when reveal is mined with status success (QA plan U5). The target badge is the target's own pin: a vault or router with no code-hash pin reads `[bytecode UNVERIFIED]` even when the gateway hash matched.
  - **Implementation gaps at `48923e37`:** Authorize and onboarding ask for consent after the owner commits (RS-1019-12); their policy builders and rotation use empty destination lists (RS-1019-15). These requirements describe the target flow, not completed implementation.
- **Rationale.** §12 names the four required preview fields ("target, calldata, role/policy effect, expected risk"). This decision pins their shape and adds a hard refusal on decoder failure, so a rendering bug never silently degrades to a raw-calldata signing prompt — that degradation is the exact failure mode `docs/technical/security-model.md` flags as "operator misled into signing arbitrary calldata."
- **Rejected alternatives.**
  - *Free-form preview that varies per action.* Loses the shape contract that lets reviewers and screenshot-based audits check completeness.
  - *Best-effort preview with fall-through to raw calldata when decoding fails.* The fall-through is the failure mode we are trying to prevent.

### 3.4 `rmpc` config export — **flat TOML with public settings and a pointer to an existing signer**

- **Decision (2026-10-14 amendment, reconciled 2026-10-20).** Export
  `rmpc-config.toml` in the flat schema loaded by
  `clients/rust-payment-client/src/config.rs` and generated by
  `clients/dapp/src/lib/configExport.ts`. `Config` denies unknown fields.
  This illustrative shape uses placeholders for deployment values:

  ```toml
  chain_id = 8453
  rpc_url = "https://<rpc>"
  gateway_address = "0x<gateway>"
  usdc_address = "0x<usdc>"
  vault_address = "0x<owner-selected-vault>"
  gateway_runtime_hash = "0x<reviewed-gateway-runtime-hash>"
  share_receiver = "0x<depositor>"
  agent_owner = "0x<depositor>"
  # Proxied deployments also require reviewed implementation pins.

  [signer]
  allow_software_fallback = true
  keystore_path = "/path/to/existing-agent-keystore.json"
  ```

- **Custody.** The encrypted keystore is created and managed in the agent's
  signer backend. Export references its path; the dapp never generates,
  imports, encrypts or bundles its private bytes or asks for its passphrase.
- **Software-backed exports.** A software keystore may sign the agent
  deposit on every chain, including Base, after the production warning
  (owner decision 2026-10-06, issue #1545). Hardware, HSM or KMS is optional
  (owner decision 2026-10-14). There is no `unsafe_for_production` config key
  or `--allow-unsafe` flag. The export's explanatory comment block is checked
  by `clients/rust-payment-client/tests/dapp_toml_roundtrip.rs`. Deprecated
  withdrawal, router-deposit and receipt-write commands are not authorized
  by this custody decision; receipts use the submitter Safe on every chain.
- **Hardware/KMS exports.** They carry only public backend identifiers.
  At `48923e37` the exporter labels them as reference templates for future
  backends, not directly loadable signer configurations.
- **Binding and implementation pins.** Export `share_receiver` and
  `agent_owner` as the depositor's address. Include reviewed gateway and
  destination-vault implementation pins for proxies, from release records
  or the build's reviewed pins. Never approve whatever implementation is
  live merely by copying its hash into the allowlist.
- **Destination migration.** The current flat config names one selected
  `vault_address`. Retirement of the gateway's fixed vault pin must update
  preflight and export together so they check the actual selected
  destination against the owner's policy (RS-1019-15). Do not add an
  unrecognized config field to represent the destination list; evolve the
  loader, exporter and round-trip coverage together if the schema changes.
- **Rationale.** A directly loadable TOML file lets the OpenCode and
  OpenClaw setup flows consume the same config contract without giving the
  dapp custody of an agent key.
- **Rejected alternatives.**
  - *The original nested schema and unsafe flag.* They conflict with the
    flat loader and the later software-keystore decision.
  - *Browser-generated companion keystore.* It violates §3.1 and §3.2.
  - *JSON or a signed archive.* Neither is needed by the TOML loader.

## 4. Consequences

- **Phase 6 implementation (#60)** inherits a credential model, a custody boundary, a preview shape, and an export schema. The follow-on issue can be implemented without re-litigating any of the four.
- **Browser-generated credentials are prohibited** on every chain, consistent with the register-only decision in §3.1. There is no feature-flag exception.
- **The `rmpc` binary** accepts the flat config and may use an existing software keystore for the agent deposit on every chain; it owes no unsafe-flag refusal. See §3.4.
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
- `Plan tracking issue #109` §12 cross-links to this ADR.
- Downstream issue #60's `## Canonical docs` section references this ADR.

The validator replaces the two manual review items previously on issue #59. It mirrors the pattern in `.github/scripts/check_explorer_adr.py` (ADR #56 / issues #57, #58).
