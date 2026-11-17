# Deep-dive D — live deployment state and RS-1019-14

Follow-up security-review worker D. Deepens the first-pass limitation at
`docs/code-review/20261117-review-security-opencode.md:139` ("Live deployment state was not
verified"). Read-only: no production code, canonical docs, review artifacts, scripts or
sibling scratch files were modified. The sole write is this file.

## Pin and posture

- repository `git@github.com:robotmoney/robotmoney-core.git`; branch under review `release-0.9.0`;
  work branch `review/security-release-0.9.0-20261117`; pin
  `d4a43e6d21efed208816698d2b32f0decea45451`; reviewed_at `2026-11-17`.
- Worktree `.../adhoc-20261117-145601`; `HEAD` verified at the pin before analysis.
- No RPC endpoint is configured in this environment (verified below), so no
  `cast call` was issued and no external state was queried or changed.

---

## D1 — Find deployment evidence in the repository

VERDICT: blocked

EVIDENCE:
- `deployments/8453/deploy-2/README.md:1,3,5-6,12` — the only committed Base-mainnet manifests are
  "Deploy 2 manifests (Base 8453)"; `README.md:5`: "a verbatim copy of the manifests of devops
  run 2 on Base 8453 ('Deploy 2': release `release/v0.4.0-base.3-rehearsal`, core `78c50cbd`,
  a **rehearsal-kind** deployment)", originals "in run 2's evidence folder on the operator
  machine, `~/robotmoney-evidence/base-mainnet-r900/manifests/`"; `README.md:12`: "a publish run
  on 8453 writes its own manifests flat into `deployments/8453/` (untracked)". Chain 8453,
  release v0.4.0-base.3-**rehearsal** — NOT the live system.
- `deployments/8453/deploy-2/timelock.json:33` `"deployment_kind": "rehearsal"` (chain `8453` at
  `:21`). Role snapshot at `:42-59` (`admin_role_holder`, `governance_has_router_admin_role`,
  timelock/Safe flags) and vault handover at `:65-113` — all rehearsal v0.4.0.
- `deployments/8453/deploy-2/safe.json:1-17` — Safe `0xdFDea0E1...`, version 1.4.1, threshold 2,
  three named owners, factory/singleton/fallback handler, salt nonce `2026101002`, deploy block
  52484018. Rehearsal v0.4.0 on chain 8453.
- `deployments/8453/deploy-2/governance.json:1-10` — "governance" `0x59b593ab...`, "router"
  `0xB3a8e66d...`, admin `0xf3F58246...`, delay 3600. Rehearsal v0.4.0.
- `deployments/8453/deploy-2/ic-policy.json:1-8` — `consensus_receipt` `0xEfEe1c98...` and
  `receipt_admin` `0xf3F58246...` (`:7`). Rehearsal v0.4.0; this is the **only** manifest field
  anywhere that names a receipt-register admin holder, and it is a rehearsal artifact.
- `deployments/8453/deploy-2/{router,registry,vault,gateway,recorder,libs}.json` — further
  rehearsal-v0.4.0 address/code-hash records; `agent-token-vault.json`, `protocol-asset-vault.json`,
  `rwa-basket-vault.json` are empty (0 bytes).
- Non-live labels confirmed for the other deployment trees: `deployments/base-8453-rehearsal/*`
  (deploy-3/deploy-4 **rehearsal** env files), `deployments/twin-918453/*` (Twin chain 918453),
  `deployments/frozen-counts/*`, `deployments/dependency-manifests/*` (example/README only).
- `docs/runbooks/contract-qa/releases/v0.9.0-onevault-upgrade.yaml:1-5,49-50,67` — the LIVE
  system is "the in-place upgrade of the LIVE Deploy 4 fund system on Base 8453"; its record is
  "the Deploy 4 record as the v0.8.0-onevault-upgrade run left it on 8453 (its manifests and
  publish-run.json ... read only)", copied into the run directory which is "outside the core
  checkout" (`:137`). Live manifests/evidence are operator-machine state, not repository files.
- `docs/architecture.md:499,585,838-839,1808`, `docs/prd.md:585` — the deployed live release is
  v0.5.0 (vaults/gateway/registry/router/receipt) and the fund system is Deploy 4; no committed
  v0.5.0/Deploy 4 manifest exists in `deployments/8453/`.

ANALYSIS:
The repository contains deployment evidence, but every committed manifest is explicitly a
rehearsal (v0.4.0 Deploy 2, chain 8453), a Twin-fork config, a frozen-count snapshot or an
example — none describes the LIVE v0.5.0 / Deploy 4 system. The live manifests and
`publish-run.json` are, by the runbooks' own statement, kept on the operator machine and copied
into an out-of-repo run directory for each run. Therefore D1 cannot produce a citable, in-repo
role snapshot of the live system; the addresses in `deploy-2/` must not be substituted for live
ones. Observed facts (manifest contents and labels) are cited above; the mapping of "live =
v0.5.0 / Deploy 4" is an observed canonical statement (`architecture.md:838-839,1808`, v0.9.0
runbook header), not reviewer inference.

SEVERITY IF PROMOTED:
None. This is an evidence-availability limitation, not a demonstrated defect; no finding is
promoted. The risk created is that a reviewer could mistake rehearsal `deploy-2/` values for live
state — guarded here by explicit per-artifact chain/release labels.

RECOMMENDATION:
Do not treat `deployments/8453/deploy-2/*` as live evidence. To close D1, obtain the operator's
Deploy 4 / live v0.5.0 manifest set and `publish-run.json` (the out-of-repo `{liveManifestDir}`
and `{liveEvidenceDir}` named in `v0.9.0-onevault-upgrade.yaml:49-50`) and cite them with their
chain and release, or run the verifier against a live RPC (see D2/D3).

---

## D2 — RS-1019-14 specifically

VERDICT: blocked

EVIDENCE:
Ledger disposition — `docs/audits.md:656`: RS-1019-14, Low, `accepted-with-rationale`, Open:
"RouterGovernance holds the receipt's ADMIN_ROLE instead of a narrow release role. Today's receipt
has no RECEIPT_SUBMITTER_ROLE and today's governance exposes no submitter-grant or arbitrary-call
path; broader submitter authority is a migration hazard once that role is added, not a
demonstrated current grant capability."

1. Manifest / verification output recording the live receipt's role holders:
   - No committed artifact records the **live** receipt register's `ADMIN_ROLE` /
     `RECEIPT_RELEASER_ROLE` holders. The only receipt-admin field in any manifest is
     `deployments/8453/deploy-2/ic-policy.json:7` `receipt_admin = 0xf3F58246...`, a rehearsal
     v0.4.0 value, and it names only an ADMIN holder (no releaser/submission role snapshot).
   - `publish-contracts/tests/verify/fixtures/expected-labels.json:95-97` states the **expected**
     live shape ("receipt: RECEIPT_RELEASER_ROLE held by governance (applyReceipt releases)",
     "receipt: ADMIN_ROLE not held by governance", "receipt: RECEIPT_RELEASER_ROLE not held by
     timelock"). This is a test fixture of desired labels consumed by the verifier at run time,
     **not** a captured result for the live 8453 register. No committed evidence/ directory or
     label output exists (`find . -type d -name evidence` → none; only `evidence.example.json`,
     `evidence-check.ts`, the fixture, and a doc page).
2. Migration script / completed migration record:
   - Tooling and proof exist but **no completed live migration record**. Contract migration
     function `contracts/ConsensusRecommendationReceipt.sol:126-140` (`migrateToSubmitterRoles`,
     `reinitializer(2)`, timelock-only; grants releaser the narrow role and revokes its ADMIN_ROLE).
     Typed govern row `publish-contracts/src/upgrade-rows.ts:54-57` and
     `publish-contracts/src/cli.ts:145-146`; runbook reference `publish-contracts/README.md:144`
     and `docs/operations/contract-release-runbooks.md` (runbook 4.15); Twin proof
     `publish-contracts/src/ci/twin-upgrade-lifecycle.ts:11-12,165-240` and Solidity proof
     `contracts/test/ConsensusReceiptMigration.t.sol`. Audit group
     `docs/audits.md:688-696` (RM-1022) reviews the **tooling**.
     `docs/code-review/20261022-code-review-internal-claude-receipt-migration-tooling.md:18-20`:
     the row "does not read the live proxy's initialized version or who holds ADMIN_ROLE";
     "The pre-state of the live proxy is read from the chain by the operator before the schedule".
     No commit, manifest, `proxy_upgrades` entry or runbook completion record in this repo records
     that migration executing on live 8453. `git log --all --grep='RS-1019-14'` → no matches.
3. RPC availability — exact commands and output (names only; no secret values printed):
   ```
   $ printenv | grep -iE 'RPC|ALCHEMY|INFURA|WEB3_PROVIDER|ETH_URL|BASE_URL' | cut -d= -f1 | sort
   (no output)
   $ printenv | grep -icE 'RPC|ALCHEMY|INFURA|WEB3_PROVIDER'
   0
   $ command -v cast
   /drive2/home/lucas/.foundry/bin/cast
   ```
   `cast` is installed but **no RPC URL is configured** (no `BASE_RPC_URL`, `FORK_RPC_URL`,
   `TWIN_RPC_URL`, `FUSION_RPC_URL`, `*_FORK_RPC_URL`, `ALCHEMY*`, `INFURA*` or equivalent in the
   environment). Per the assignment's MAY condition, no `cast call` was issued. Repository docs
   reference these as externally supplied secrets (e.g. `BASE_RPC_URL`, `BASE_FORK_RPC_URL`,
   `FORK_RPC_URL`, `CONFIG_CHECK_RPC_URL`), confirming they are not expected in-repo.
4. Canonical statements about the deployed (live) register:
   - `docs/architecture.md:817` target vs deployed: "`RECEIPT_RELEASER_ROLE` ... held by
     `RouterGovernance` ... (target; the deployed release v0.5.0 gates release on `ADMIN_ROLE`)".
   - `docs/architecture.md:838-842`: "The deployed release (v0.5.0) instead grants
     `RouterGovernance` the receipt's `ADMIN_ROLE`".
   - `docs/architecture.md:1808`: owner decision 2026-10-20 keeps ADMIN_ROLE with the timelock,
     but "the deployed release v0.5.0 grants `RouterGovernance` the receipt `ADMIN_ROLE` instead".
   - New-deploy guards (first-pass verified): `contracts/script/DeployTimelock.s.sol:557-568`
     requires governance to hold `RECEIPT_RELEASER_ROLE` and NOT `ADMIN_ROLE`;
     `contracts/script/DeployFundTimelock.s.sol:167-178` requires the timelock to hold
     `ADMIN_ROLE`/`DEFAULT_ADMIN` and governance NOT to hold `ADMIN_ROLE`.

ANALYSIS:
- The ledger disposition (RS-1019-14 Open) is **not contradicted** by any repository evidence.
  On the contrary, the canon (`architecture.md:817,838-842,1808`) explicitly asserts that the
  deployed live v0.5.0 register grants `RouterGovernance` the receipt `ADMIN_ROLE` — exactly the
  shape RS-1019-14 describes. The narrow-release shape exists only as (a) the target design,
  (b) enforced guards in the NEW deploy scripts, and (c) a migration TOOL plus Twin/Solidity
  proofs; there is no record that the tool was executed against the live register.
- The disposition also cannot be **confirmed by live evidence**: there is no committed live
  verification output, no live manifest of the role holders, no completed live migration record,
  and no RPC endpoint to read `getRoleMember(ADMIN_ROLE, …)` / `getRoleMember(RECEIPT_RELEASER_ROLE, …)`
  or the proxy implementation slot from Base mainnet.
- Verdict rationale: "genuinely unverifiable from available evidence" is the accurate outcome for
  the live state. The repository's own documented position is that the live register is still in
  the RS-1019-14 shape, so the "Open" disposition is consistent and stands; nothing here would
  justify flipping it to fixed, and nothing here contradicts it. This deepens — but does not
  overturn — the first pass. The first-pass recommendation #5
  (`20261117-review-security-opencode.md:123`) remains the correct follow-up.

SEVERITY IF PROMOTED:
No finding is promoted, so no severity token applies. For context only: the ledger already
classifies RS-1019-14 as **Low / accepted-with-rationale / Open**, and its rationale bounds the
exposure — the deployed register has no `RECEIPT_SUBMITTER_ROLE` and the deployed governance has
no submitter-grant or arbitrary-call path, so there is no demonstrated current capability to
mint submitter authority. Per the review contract, no higher severity is asserted without live
evidence, and none was sought by speculation.

RECOMMENDATION:
1. Keep RS-1019-14 Open; do not reclassify it as fixed on the strength of the new deploy guards
   or the migration tooling — those cover NEW deploys and a capability, not a completed live
   migration. Distinguish "new-deploy shape enforced" (`DeployTimelock.s.sol:557-568`,
   `DeployFundTimelock.s.sol:167-178`) from "live register migrated".
2. To actually close the item, supply a live RPC endpoint (e.g. `BASE_RPC_URL`) and issue read-only
   `cast call` checks against the live receipt register for `ADMIN_ROLE` and
   `RECEIPT_RELEASER_ROLE` holders, and against the register/governance proxies for their
   implementation slots — preserving exact commands and outputs. Alternatively, provide the
   operator's live manifest/`publish-run.json` `proxy_upgrades` entry for the
   `receipt-submitter-roles` migration (runbook 4.15).
3. Reconcile the canonical text so the reader can tell target from deployed state at a glance
   (already largely done at `architecture.md:817,838-842,1808`); no canonical change is required by
   this review.

---

## D3 — Other live-state limitations

VERDICT: blocked

EVIDENCE (each first-pass limitation at `20261117-review-security-opencode.md:139`, plus `:141`
and `:140`):
- **Deployed proxy implementation vs pin.** No committed record of the live proxy implementation
  addresses/slots. The only proxy code hashes in-repo are rehearsal v0.4.0
  (`deployments/8453/deploy-2/timelock.json:22-32`, gateway runtime hash
  `deployments/8453/deploy-2/gateway.json:6`). `docs/explorer-api.md:53` describes how the indexer
  would read `Upgraded(implementation)` / `UpgradesFrozen` events from the chain — i.e. live reads,
  not a committed snapshot. The verifier compares live code to a build only when run with an RPC
  (`publish-contracts/README.md:144`, `verify/codehash.ts`, `verify/upgradeability.ts`).
- **Safe / timelock configuration.** Only rehearsal snapshots exist
  (`deployments/8453/deploy-2/safe.json:1-17`, `timelock.json:20,35-41` — min_delay 900,
  executorPolicy open, quorum 2; deployment_kind rehearsal). Live Deploy 4 Safe/timelock config is
  described narratively in `v0.9.0-onevault-upgrade.yaml:21-33,72-78` (Safe-only executor as of
  v0.8.0-onevault-upgrade 2026-11-14; minHold 1 h; epochLength 3600/settleWindow 720), but the
  authoritative values are stated to be read from the live chain at run time (`:44-45,72,100-102`),
  not committed. The fund deploy's on-chain `_check` execution in CI also remains an open
  limitation (`lane-5-deploy-composition.md:140`, synthesized report `:140`).
- **Implementation bytecode matching the pin.** No live bytecode or bytecode-vs-pin comparison
  result is committed. `deploy-2/timelock.json:22-32` code hashes are rehearsal. The comparison is
  a verifier capability requiring a build and RPC (`publish-contracts/README.md:144`: "verify
  compares the upgraded proxy with its recorded build"); the v0.9.0 runbook masks runtime code
  and compares against the live baseline build at run time (`:21-23,54`). `RM-1022-3`
  (`docs/audits.md:696`) notes the Twin proof uses a source-level copy, with live byte comparison
  delegated to verify — again a run-time, not recorded, check.
- **Upgrade freeze state.** No committed live freeze reading. Freeze state is read on-chain at
  run time: `publish-contracts/README.md:144` refuses a row when the proxy "reads
  `upgradesFrozen()` true"; `docs/architecture.md` / ADR-0014 (`docs/adr/ADR-0014...:130`) and
  `docs/explorer-api.md:53` describe freeze events as chain-derived. No manifest records a live
  `upgradesFrozen()` value.
- **RPC availability:** same verified result as D2 — zero RPC env vars, `cast` present, no call
  issued. Every D3 item would require a live RPC or the operator's out-of-repo evidence set.

ANALYSIS:
None of the four limitations can be closed with repository artifacts. Each is a chain-derived
fact (or an operator-machine record) that the repository's own tooling and runbooks treat as
read-at-run-time. The committed deployment evidence is uniformly rehearsal/Twin/example and is
explicitly labelled as such, so it cannot be substituted. These remain genuine limitations of a
static review at the pin; they are not evidence of a defect, and no severity is assigned.

SEVERITY IF PROMOTED:
None. No finding is promoted from D3; these are unverified surfaces, not demonstrated wrong or
falsely-verified state.

RECOMMENDATION:
Provide a Base-mainnet RPC endpoint and run the repository's verifier / read-only `cast` checks to
capture, with exact commands and outputs: (a) each live proxy's implementation slot vs the pinned
build hash, (b) the live Safe threshold/owners and timelock delay/executor/proposers, (c) the
live implementation bytecode hash vs pin, and (d) `upgradesFrozen()` for each watched proxy.
Absent that, carry these four items forward as explicit limitations in the release owner's
pre-flight checklist.

---

## Limitations

- Static review at pin `d4a43e6d2`; no fork/devnet/on-chain transaction executed. No CI logs or
  run artifacts were inspected; green-gate claims in the first pass rest on workflow configuration.
- No RPC endpoint configured (`printenv` RPC/ALCHEMY/INFURA/WEB3 count = 0), so no live `cast call`
  was issued. `cast` is installed at `/drive2/home/lucas/.foundry/bin/cast` but has no URL to use.
- Live Deploy 4 / v0.5.0 manifests and `publish-run.json` are operator-machine state outside the
  checkout (`v0.9.0-onevault-upgrade.yaml:49-50,137`; `deploy-2/README.md:5,12`) and were not
  available; the only committed deployment artifacts are rehearsal/Twin/example.
- The historical 2026-10-15 review and the large ledger were searched by finding ID, disposition
  and targeted phrases, not read in full; "deployed v0.5.0" statements are taken from canonical
  docs at the pin.
- No attempt was made to determine whether the live register was actually migrated, beyond
  establishing that the repository contains no record of such a migration. Observed facts are
  cited; the "live = v0.5.0 / Deploy 4" mapping is an observed canonical statement, not inference.

## checked_shapes

Catalogue: `docs/development/false-green-shapes.md` (present at the pin). Stable names evaluated
and ruled out for this deep-dive:
- `doc-contradicts-guard-invariant` — evaluated: the stale RS-1019-14 **ledger disposition** is
  contrasted against the enforcing deploy guards (`DeployTimelock.s.sol:557-568`,
  `DeployFundTimelock.s.sol:167-178`) and the expected-labels fixture
  (`expected-labels.json:95-97`); canon (`architecture.md:817,838-842,1808`) resolves the
  apparent contradiction by distinguishing target from deployed v0.5.0. Ruled out as a guard
  regression; the discrepancy is a documentation-tracking item, not a weakened guard.
- `missing-evidence-script` / `uninvoked-evidence-script` — evaluated: verifier, evidence-check
  and migration tooling exist and are invoked by the runbooks/workflows
  (`publish-contracts/README.md:144`, `evidence-check.ts`, `twin-upgrade-lifecycle.ts`); none is a
  stub. Ruled out; their limitation is that they need a live RPC, not that they are absent.
- `fixture-shape-blind-selftest` / `starved-guard-input` — evaluated: `expected-labels.json:95-97`
  encodes the correct role shape, and the Twin harness asserts the post-migration roles
  (`twin-upgrade-lifecycle.ts:229`); no empty/starved assertion was found that would fake a green
  role check. Ruled out for this scope (the wrapper's internal parsing was not re-audited here —
  consistent with the first pass, which marked `starved-guard-input` partial).
- `stale-cache-embedded-artefact` — evaluated: `cache/solidity-files-cache.json` and the
  `deploy-2/` manifests are cached/committed snapshots; I did not treat them as live state and
  labelled each by chain and release. Ruled out as a source of a false live-state claim.
- `abi-drift-gate` / `artifact-guard-runs-before-build` — evaluated: implementation-vs-pin and
  bytecode checks are run-time verifier checks over live chain data, not doc/ABI greps; no
  artifact-existence guard was mistaken for coverage here. Ruled out.
