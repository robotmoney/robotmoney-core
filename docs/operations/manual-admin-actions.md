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
the run's deploy manifests (`deployments/<chain>/`), then hand the privileged
roles to the `TimelockController`.

The vaults system's handover covers its eight contracts (`docs/architecture.md`
§4.5). `DeployTimelock.s.sol` hands over:

- `ADMIN_ROLE` on VaultRegistry, PortfolioRouter, RouterGovernance, and every
  vault in `VAULT_ADDRESSES`. The basket vaults (rmPROTO, rmAGENT, rmRWA) are
  in that list alongside rmUSDC. The deployer's vault `EMERGENCY_ROLE` moves
  to the independent `EMERGENCY_ADDRESS` key.
- `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` on the consensus receipt
  (`ConsensusRecommendationReceipt`, `CONSENSUS_RECEIPT_ADDRESS`), revoked from
  the address named by `RECEIPT_ADMIN_ADDRESS`. `ADMIN_ROLE` administers
  `RECEIPT_SUBMITTER_ROLE`, so after handover a submitter grant goes
  Safe -> Timelock -> receipt.

`CONSENSUS_RECEIPT_ADDRESS` and `RECEIPT_ADMIN_ADDRESS` are required on every
chain. The script reverts when one is unset. There is no on-chain committee
contract to hand over.

The gateway belongs to the rmpc gateway system. Its handover is part of its
own release. Who governs it is open (`docs/architecture.md` §10).

> **Deployed release (v0.5.0).** Today's `DeployTimelock` still hands over the
> gateway in the same run, requires `IC_POLICY_ADDRESS`, and hands over the
> retired IC policy. It also requires an `AGENT_ADDRESSES` list and moves
> each listed agent to the timelock with `transferAgentOwnership`. The
> design has no agent transfer (owner decision 2026-10-20). Step 2 below
> describes that tooling. The differences are
> recorded in `docs/code-review/20261019-code-review-internal-claude-opus-5-5-system-split.md`
> and `docs/code-review/20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md`.

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
   with role-acceptance verification. Set `AGENT_ADDRESSES` to every gateway
   agent the deployer still owns, comma-separated, or to `none` when it owns
   none; the script reverts before broadcasting when the variable is unset or
   empty. It hands each listed agent to the timelock with
   `transferAgentOwnership` (issue #1476). The gateway cannot enumerate an
   owner's agents, so derive the list from its logs: every `AgentAuthorized`
   log whose second topic is the deployer, plus every
   `AgentOwnershipTransferred` log whose third topic is the deployer, keeping
   only the agents whose `agentOwner(agent)` is still the deployer (the
   commands below do exactly this). The gateway stage's deploy agent is among them unless it was
   already revoked or handed over.

   ```bash
   cast logs --rpc-url "$BASE_RPC" --address "$GATEWAY_ADDRESS" --from-block "$GATEWAY_DEPLOY_BLOCK" \
     'AgentAuthorized(address indexed agent, address indexed owner, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver)' \
     '' "$DEPLOYER"
   cast logs --rpc-url "$BASE_RPC" --address "$GATEWAY_ADDRESS" --from-block "$GATEWAY_DEPLOY_BLOCK" \
     'AgentOwnershipTransferred(address indexed agent, address indexed previousOwner, address indexed newOwner)' \
     '' '' "$DEPLOYER"
   # for each agent (topic 1) in either list; keep it when this prints $DEPLOYER:
   cast call "$GATEWAY_ADDRESS" 'agentOwner(address)(address)' "$AGENT" --rpc-url "$BASE_RPC"
   ```

   The script stops, before the manifest is written, if any listed agent is
   still deployer-owned after the handover, so a written manifest always
   records `roles.deployer_owns_a_listed_gateway_agent` as `false`. The check
   left to you is the list itself: `roles.gateway_agents_listed_count` in the
   manifest must equal the number of agents found above.
3. Record the resulting `portfolio_router`, `router_governance`, and
   `timelock_controller` addresses in the run's deploy manifests (`deployments/<chain>/`).

**Verify.** For each of the eight vaults-system contracts of `docs/architecture.md`
§4.5 (rmUSDC and each basket vault, the registry, router, governance and the
consensus receipt), confirm the timelock holds `ADMIN_ROLE` and no
EOA does:

```bash
cast call "$CONTRACT" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak256 'ADMIN_ROLE')" "$TIMELOCK_CONTROLLER" \
  --rpc-url "$BASE_RPC"   # expect: true
```

Also confirm the run's merged deploy manifest carries the three new addresses:

```bash
jq 'has("portfolio_router") and has("router_governance") and has("timelock_controller")' \
  deployments/<chain>/<merged manifest>.json   # expect: true
```

**If verify (stage 12) or the postflight fails.** The publish-contracts CLI
pauses deposits on all four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA) by itself
and still exits with the verify failure's code (owner decision 2026-10-07, plan
decision 22, core 1619). rmUSDC is not special. Withdrawals stay open
(`pauseDeposits()` sets `depositsPaused` only). The same step runs by hand with
the `pause-all` verb and the same arguments as the run (the same `--evidence`
directory):

```bash
bun publish-contracts/src/cli.ts pause-all --chain 8453 --rpc "$BASE_RPC" --sheet "$SHEET"   --signer "$DEPLOYER_SIGNER" --emergency-signer "$EMERGENCY_SIGNER"   --core-sha "$DEPLOY_SHA" --evidence "$EVIDENCE_DIR"
```

Run the CLI from a checkout of `DEPLOY_SHA` (the same checkout `--core-dir`
names). A CLI from another sha still pauses: `pause-all` reads no per-vault
rule, so it logs one `vault_rules.mismatch` warning naming both stage tables
and runs. Every other verb refuses that mismatch with `INPUT_MISSING`
(issue 1851).

A verify whose only failures are reads the RPC refused (it could not serve a
deploy transaction's receipt) exits 30 (`RPC_REFUSED`) and pauses nothing:
rerun verify against an RPC that serves `eth_getTransactionReceipt` for the
run's deploy transactions. No archive node is needed. Exit 30 means the
deployment is NOT verified: do not proceed to govern until verify passes.

The signer follows the stage. Before the stage 11 handover the deployer signs
(it still holds `EMERGENCY_ROLE` on every vault). After it, the EMERGENCY key
signs (`--emergency-signer`, never defaulted on mainnet). The CLI reads
`depositsPaused` back on every vault and writes each vault's paused state to
`rollout-report-<chain>.json` in the evidence directory. Exit 25 means a vault
is not confirmed paused: pause it by hand now. Only the deployer is funded,
so fund the emergency key when you need to pause: if the key that must send
holds no ETH, `pause-all` stops before the first send, exits 25 and names the
address to fund (then run it again). Unpausing is a different
operation (`ADMIN_ROLE` through the timelock). The fix then follows the release
runbook fix loop: merge the fix on `dev`, redeploy to fresh addresses.

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

## 5. Retired v1 vault — indefinite feed + pool-liquidity maintenance

**What.** After a v1 vault is retired when the v2 core stack replaces it
(ADR-0010, the unified-Vault proposal, is Rejected), keep every dependency its redemptions need — the Chronicle deSPXA feed
and the Aerodrome/execution-pool liquidity — funded and live until that vault's
`totalSupply()` reaches zero.

**Why.** Retirement (ADR-0009) halts new deposits but leaves redemption open
**indefinitely**, and there is no assisted migration — the only exit is a
depositor's own signed `redeem`, which they may take at any time. A retired
priced-asset vault therefore cannot have its feed decommissioned or its execution
pool drained while any share is outstanding without stranding a still-redeemable
holder (invariants `INV-2`, `SUP-5`, `ORA-2`).

**Steps, monitoring, and the `totalSupply() == 0` decommission checklist are in
the dedicated runbook:** [`retired-v1-vault-maintenance.md`](retired-v1-vault-maintenance.md).

---

## Closing note

This document covers **only the manual actions** above. Automatable *gates* —
for example a CODEOWNERS lint, or a future bug-bounty-scope freshness CI check —
may be built separately and live in CI. They verify outcomes; they do not perform
the privileged action itself, which remains a deliberate human step.

Related issues for context: #657 (branch protection / CODEOWNERS), #655 (mainnet
deployment + ADMIN_ROLE migration), #644 (bug-bounty program), #663 / #414
(multisig signer playbook / timelock).
