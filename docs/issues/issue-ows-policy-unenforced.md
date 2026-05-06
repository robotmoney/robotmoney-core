# Issue — OWS policy is load-bearing in the PRD but unenforced in code

> Summary: the PRD's user stories (`docs/prd.md` §4.1, §4.2) and trust model (§3.5, §7) treat OWS policy — per-tx caps, per-day caps, contract allowlists, hardware co-sign thresholds — as the security boundary that makes treasury automation safe. The current codebase does not set, install, verify, or read OWS policy. A user who follows the documented happy path (`create-wallet` → `execute-deposit`) ends up with a hot wallet that signs whatever the agent asks. The trust posture in production is materially weaker than the PRD claims.

## 1. Severity

**High.** This is the gap between an advertised security property and runtime behavior. It does not corrupt funds on its own — it removes the mitigation that the user stories rely on if the agent host is compromised. Stories 4.1 (Moltbook on a VPS) and 4.2 (OpenClaw on an edge device) are the most exposed; story 4.3 (`prepare-*` only) is unaffected because it doesn't use OWS at all.

## 2. Background

The PRD asserts in three places that OWS-held keys sign under policy:

- `docs/prd.md` §3.5 — *"No product surface custodies private keys; signing happens in user-controlled wallets."*
- `docs/prd.md` §4.1 — names a specific policy (per-tx $5k, per-day $10k, contract allowlist of vault/USDC/Permit2/UR, hardware co-sign over $2.5k) as the mechanism that makes a fully autonomous Moltbook deployment safe.
- `docs/prd.md` §4.2 — names a tighter policy (per-tx $100, per-day $500, vault-only allowlist, off-device withdraw key) as the reason a compromised solar-charger device cannot move funds elsewhere.
- `docs/prd.md` §5.7, §7 — repeats "policy-gated signing" as a non-functional and trust-model property.

The CLI's job is to put a thin, auditable layer between the agent and the chain; OWS's job is to enforce policy on signatures. Today only the first half exists.

## 3. Evidence (what the code actually does)

Searched `packages/cli/src/` and `plugins/robotmoney-cli/`:

- **Two** total mentions of the word "policy" in the entire repo:
  - `plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md:18` — descriptive prose: *"OWS does, under its policy-gated signing flow."*
  - `plugins/robotmoney-cli/skills/robotmoney-cli/references/write.md:296` — descriptive prose: *"Sign the returned transactions via your OWS policy flow and broadcast them to Base."*

- **Zero** hits for `policy`, `allowlist`, `template`, `cap` (in the OWS sense), or any policy-template identifier inside `packages/cli/src/`.

- `packages/cli/src/lib/wallet.ts` is the entire OWS interface. It exports four functions: `owsCreateWallet`, `resolveWallet`, `resolvePassphrase`, `owsSignAndSend`. No `getPolicy`, no `applyTemplate`, no `verifyPolicy`, no policy-related types.

- `packages/cli/src/commands/create-wallet.ts` bootstraps a keystore via `owsCreateWallet` and prints funding instructions. The post-creation instruction array goes directly from "fund the wallet" to `execute-deposit` with no policy step. There is no `--policy` flag, no recommended-policy preview, no warning that the wallet is unconstrained.

- The `execute-*` commands call `owsSignAndSend` and trust whatever OWS returns. They do not pre-check that a policy is installed, do not warn if the wallet has full signing authority, and have no UX for policy-refused transactions beyond surfacing the raw OWS error.

Net effect: a user who follows `README.md`'s quickstart or SKILL.md's recommended flow lands on `create-wallet` → fund → `execute-deposit`. At no point does Robot Money's tooling install, suggest, verify, or even mention an OWS policy.

## 4. User impact

| Story | Asserted security boundary | Actual posture today |
|---|---|---|
| §4.1 Moltbook on VPS | OWS denies tx if it exceeds cap, leaves allowlist, or skips hardware co-sign over $2.5k | OWS will sign whatever the harness asks. A compromised Moltbook drains the wallet. |
| §4.2 OpenClaw on solar charger | OWS rejects any contract that isn't the vault | A rooted device can sign arbitrary `transfer` calls and exfiltrate USDC. |
| §4.3 Builder + Claude Code | n/a — uses `prepare-*` and external wallet UI | Unaffected. |

The asymmetry matters: the more autonomous the deployment, the larger the unmitigated exposure.

## 5. Proposed resolution

Two options. They are mutually exclusive — pick one or the PRD and the README continue to disagree.

### Option A — Make Robot Money the source of policy templates; OWS enforces

Add a small command surface to `@robotmoney/cli` that writes recommended policy into OWS and reads it back to verify.

| Command | Behavior |
|---|---|
| `create-wallet --policy <name>` | Bootstrap keystore *and* install a named template (`treasury`, `device-sweep-only`, `none`). |
| `apply-policy --template <name>` / `apply-policy --file <path>` | Install or replace a policy on an existing OWS wallet. |
| `get-policy` | Read the policy currently installed on a wallet, returned as JSON. |
| `policy-diff` | Diff installed policy against a named template; non-zero exit if drift is detected. |

Templates ship in the CLI, sourced from the same address tables (`lib/addresses.ts`, `lib/basket/constants.ts`) the rest of the CLI uses, so an updated address is reflected in the policy without manual edits.

`SKILL.md` is updated so the agent runs `get-policy` before any `execute-*` and refuses to proceed if the policy is `none` or has drifted from the recommended template.

**Pros.** Preserves §3.4 ("no-config defaults") — one flag during `create-wallet` is the entire user experience. Makes the security claims in §4.1 / §4.2 true by default, not by operator diligence. Robot Money keeps owning what it knows (which addresses to allowlist, what caps are sane); OWS keeps owning what it owns (key material and signature authorization).

**Cons.** New surface in the CLI; non-trivial work to define the policy schema in a way that survives OWS's evolution; templates are opinionated and may not fit every deployment. The `get-policy` round-trip needs OWS to expose policy reads in a stable format.

### Option B — Stop claiming policy is part of Robot Money's security model

Demote the policy language in `docs/prd.md` §4.1, §4.2, §5.7, §7 to "operator may configure separately via OWS." Add a prominent README and SKILL.md note that wallets created by `create-wallet` are unconstrained signers and that operators running autonomous deployments must configure OWS policy out of band before pointing real revenue at the harness. Link to OWS's own policy documentation.

**Pros.** Zero code changes. Honest about current behavior.

**Cons.** Significantly weakens the product story. Story 4.2's whole security argument disappears (a rooted edge device with a Robot Money wallet has no protection). The "two-audience parity" goal is undermined: humans get the wallet UI's confirmation flow, agents get nothing. Most operators will not configure OWS policy out of band, so the production posture stays as it is today.

## 6. Recommended option

**Option A.** The PRD's central claim is that Robot Money is safe for *autonomous* operation. That claim is only true if the path of least resistance produces a constrained wallet. Option B documents the gap; Option A closes it. The work is bounded — four commands, a JSON policy schema, a SKILL.md update — and lands in territory the CLI is already authoritative about (Robot Money's own contract addresses).

## 7. Acceptance criteria (for Option A)

- `create-wallet --policy treasury` produces a wallet whose installed OWS policy matches the §4.1 description (per-tx cap, per-day cap, contract allowlist of `[vault, USDC, Permit2, UniversalRouter]`, hardware co-sign over a configurable threshold).
- `create-wallet --policy device-sweep-only` produces a wallet whose installed policy matches §4.2 (vault-only allowlist, no transfer authority).
- `get-policy` returns the installed policy as decoded JSON without invoking the signer.
- `policy-diff` exits 0 when the wallet matches the named template and non-zero with a JSON diff otherwise.
- `execute-*` calls `get-policy` first; if the policy is `none` or drifts from the recommended template, the command refuses with a named error (`PolicyMissing`, `PolicyDrift`) and a remediation hint. A `--allow-unconstrained-wallet` escape hatch exists for operators who genuinely want one.
- `SKILL.md` instructs the agent to surface policy state to the user before any `execute-*` and to refuse if `PolicyMissing` is returned.
- `create-wallet` post-creation instructions surface the installed policy and document how to inspect it later.
- Tests: a unit test per template asserting the policy JSON matches a snapshot; a fork test asserting that an `execute-deposit` against a `device-sweep-only` wallet succeeds, and an `execute-deposit` whose calldata targets a non-allowlisted contract fails with the expected `OwsPolicyRejected` error.

## 8. Open questions

- **OWS policy schema stability.** Does `@open-wallet-standard/core` expose a stable JSON shape for policy read/write across versions, or do we need a thin adapter layer in `packages/cli/src/lib/policy/`?
- **Hardware co-sign primitive.** Story 4.1 calls for a per-tx-amount-gated co-sign requirement. Does OWS support amount-conditional co-sign, or only flat multisig? If only flat multisig, the §4.1 policy needs to be either flat multisig (worse UX) or amount-conditional implemented in a Robot Money pre-flight (worse trust model).
- **Policy versioning.** Templates will change as the address set or the basket evolves. How does an existing wallet learn its policy is stale? `policy-diff` covers detection; what's the operator-friendly upgrade path?
- **Migration.** Existing wallets created before this lands have no policy. Should `apply-policy` work on them, or do we require a re-bootstrap? (`apply-policy` is the obvious answer, but worth confirming OWS allows post-hoc policy install.)
- **Default-on vs. opt-in.** Should `create-wallet` install `treasury` by default and require `--policy none` to opt out, or default to `none` and require `--policy treasury` to opt in? Defaulting to `treasury` aligns with §3.4's "no-config defaults" but breaks any existing scripts; defaulting to `none` preserves current behavior but bakes in the gap.

## 9. References

- PRD claims: [`../prd.md`](../prd.md) §3.5, §4.1, §4.2, §5.7, §7.
- CLI OWS surface: [`../../packages/cli/src/lib/wallet.ts`](../../packages/cli/src/lib/wallet.ts).
- Wallet bootstrap: [`../../packages/cli/src/commands/create-wallet.ts`](../../packages/cli/src/commands/create-wallet.ts).
- Skill prose mentioning policy: [`../../plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`](../../plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md), [`../../plugins/robotmoney-cli/skills/robotmoney-cli/references/write.md`](../../plugins/robotmoney-cli/skills/robotmoney-cli/references/write.md).
