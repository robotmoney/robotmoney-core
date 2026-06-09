# Manual admin actions

This document is a **recommendations registry** of actions a human repository or
protocol administrator must perform manually. They are deliberately **out of
scope for automation**.

## Why these are manual

Each action below touches one or more of the following:

- **GitHub repository settings** (branch protection, required reviews) — privileged
  org/repo configuration that should reflect an explicit human decision.
- **Mainnet** — irreversible on-chain transactions against real value on Base
  (chain `8453`).
- **Real keys** — production deployer keys and multisig signer devices.
- **External program registration** — third-party platforms (bug-bounty providers)
  whose terms and scope are a launch-time business decision.

Because of this, the automated development loop (the "auto-loop") **must not**
perform any of these actions, and **must not** carry them as automated acceptance
criteria. Issues that previously listed these as ACs have had them removed and
replaced with a pointer to this document. Automatable *gates* that merely check
the result (for example a CODEOWNERS lint) may still live in CI; the privileged
action itself stays manual.

---

## 1. Branch protection on production-reachable branches

**What.** Require at least **2 approving reviews** and enable
`require_code_owner_reviews` on every branch that can reach production.

**Why.** The security model (§13) requires that CODEOWNERS be configured for
`contracts/**` and `scripts/**`, that at least two reviewers approve any merge to
a branch that can reach production, and that branch protection be enforced. The
two-reviewer + code-owner gate makes a single compromised or careless account
insufficient to land changes to the contract or deploy-script surface.

**Important notes before acting.**

- `dev`-branch protection was **already applied by automation earlier**. Review it
  for intent — confirm the approving-review count and `require_code_owner_reviews`
  match policy, and that the configuration was an intentional decision rather than
  an automation side effect.
- A `main` branch **does not currently exist** — all work targets `dev`. Decide
  whether `main` should exist as a production-reachable branch **before** applying
  protection to it. Do not create or protect `main` reflexively.

**Manual steps (reference `gh api` commands for a human to run — not for automation).**

Inspect current protection on `dev`:

```bash
gh api repos/lucky-tensor/robotmoney-monorepo/branches/dev/protection
```

Apply protection (adjust the JSON to the agreed policy):

```bash
gh api -X PUT repos/lucky-tensor/robotmoney-monorepo/branches/dev/protection \
  --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 2,
    "require_code_owner_reviews": true
  },
  "restrictions": null
}
JSON
```

If, and only if, a `main` branch is created and designated production-reachable,
repeat the `PUT` for `main`.

**Verify.**

```bash
gh api repos/lucky-tensor/robotmoney-monorepo/branches/dev/protection \
  --jq '.required_pull_request_reviews
        | select(.required_approving_review_count >= 2
                 and .require_code_owner_reviews == true)'
```

A non-empty result confirms the gate is in place.

---

## 2. Mainnet deployment and ADMIN_ROLE migration

**What.** Deploy `PortfolioRouter`, `RouterGovernance`, and `TimelockController`
to **Base mainnet (chain `8453`)**, record their addresses in
`deployments/full-stack.json`, then transfer `ADMIN_ROLE` to the
`TimelockController` across **all five protocol contracts**: Gateway, Vault,
VaultRegistry, PortfolioRouter, and RouterGovernance.

**Why.** Architecture §8 requires that `ADMIN_ROLE` on all protocol contracts be
held by the deployed `TimelockController` in production — no EOA may hold
`ADMIN_ROLE` directly. §10 resolves this as required before mainnet scale, and
§4.2 flags PortfolioRouter mainnet onboarding as remaining work. Routing admin
through the timelock makes multisig quorum and the time-delay window
contract-enforced rather than operational convention.

**Manual steps.**

1. Deploy the router stack using the existing script
   `contracts/script/DeployPortfolioRouter.s.sol` against the Base mainnet RPC,
   broadcasting with the production deployer key.
2. Deploy and migrate using `contracts/script/DeployTimelock.s.sol`, which deploys
   the `TimelockController` and performs the per-contract `ADMIN_ROLE` transfer
   with role-acceptance verification.
3. Record the resulting `portfolio_router`, `router_governance`, and
   `timelock_controller` addresses in `deployments/full-stack.json`.

**Verify.** For each of the five contracts, confirm the timelock holds
`ADMIN_ROLE` and no EOA does:

```bash
cast call "$CONTRACT" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak256 'ADMIN_ROLE')" "$TIMELOCK_CONTROLLER" \
  --rpc-url "$BASE_RPC"   # expect: true
```

Also confirm `deployments/full-stack.json` carries the three new addresses:

```bash
jq 'has("portfolio_router") and has("router_governance") and has("timelock_controller")' \
  deployments/full-stack.json   # expect: true
```

---

## 3. Bug-bounty program registration

**What.** Register a bug-bounty program with an external provider (for example
Immunefi or HackerOne) using the project's published scope document, and keep the
program scope in sync with the live contract surface.

**Why.** The security model (§14) requires that a bug-bounty program with a
published scope be live before the public dApp launch, and that scope and
exclusions be updated within 72 hours of any new contract deployment. This is a
**launch-time action** — it requires committing to a provider's terms and a
funded reward pool, which is a business decision.

**Manual steps.**

1. Choose a provider and create the program account.
2. Import the in-scope contracts and exclusions from the canonical scope document,
   referencing the deployed addresses in `deployments/`.
3. After any new mainnet deployment, update the program scope within 72 hours.

**Verify.** Confirm the program is publicly listed on the provider, and that the
listed in-scope addresses match the current `deployments/` manifest. A future
CI freshness check (see closing note) can flag scope drift, but program
publication itself is verified manually on the provider's dashboard.

---

## 4. Multisig signer onboarding

**What.** Onboard the Safe multisig signers per the multisig signer playbook.

**Why.** The security model (§4) requires a published signer playbook covering
independent simulation, calldata-diff review, a minimum deliberation time, and
device separation (no signer approves on the proposer's device). Correctly
onboarded signers are what makes the timelock's proposer/executor quorum
meaningful in practice.

**Manual steps.**

1. Add each signer to the Safe and confirm the agreed threshold.
2. Walk every signer through the playbook procedures: how to independently
   simulate a proposed operation, how to review the calldata diff against the
   expected effect, the minimum deliberation time, and the device-separation rule.

**Verify.** Confirm the on-chain Safe owner set and threshold match the intended
roster, and that each signer has acknowledged the playbook.

---

## Closing note

This document covers **only the manual actions** above. Automatable *gates* —
for example a CODEOWNERS lint, or a future bug-bounty-scope freshness CI check —
may be built separately and live in CI. They verify outcomes; they do not perform
the privileged action itself, which remains a deliberate human step.

Related issues for context: #657 (branch protection / CODEOWNERS), #655 (mainnet
deployment + ADMIN_ROLE migration), #644 (bug-bounty program), #663 / #414
(multisig signer playbook / timelock).
