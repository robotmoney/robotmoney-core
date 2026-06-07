# Robot Money — Full-Stack Gap Analysis — 2026-06-07

**Date:** 2026-06-07
**Reviewer:** Multi-agent automated gap analysis (169 agents, 6 domains)
**Base branch:** `dev`
**Commit reviewed:** `284c1be7`
**Scope:** PRD, architecture, implementation plan, security model, open questions, CI/infra

---

## Summary

50 confirmed gaps across six domains after adversarial verification (66 candidates found,
53 deduplicated, 50 confirmed). All gaps are tracked as GitHub issues #643–#692.
No existing code was changed by this review — these are missing work items, not bugs in
shipped code. The prior security audit (2026-06-06) fixed shipped bugs; this review
identifies work that was never started or never formally tracked.

**Issues by domain:**

| Domain | Count | Issues |
|--------|-------|--------|
| Security / pre-launch requirements | 17 | #643–#646, #648, #650, #663–#664, #668, #673, #678, #679, #683, #686, #691 |
| CI hardening | 13 | #651–#653, #656–#657, #659–#660, #662, #665, #671, #680–#681, #685, #688 |
| Contracts / architecture | 5 | #655, #669, #677, #687, #692 |
| `rmpc` / explorer / dapp features | 10 | #647, #649, #654, #661, #666–#667, #670, #672, #675–#676 |
| Docs / plan cleanup | 5 | #652, #664, #682, #684, #689 |
| Open questions needing resolution | 5 | #673, #674, #682, #684, #687 |

---

## Critical (risk 5)

### MAINNET-001 — No plan for PortfolioRouter/RouterGovernance mainnet deploy or TimelockController ADMIN_ROLE migration
**Source:** `docs/architecture.md` §10, `docs/implementation-plan.md` (missing)
**Issue:** #655

The architecture specifies a `TimelockController` wrapping `ADMIN_ROLE` for all privileged
contract changes, and the existing single-vault deploy has a timelocked multisig. However,
`PortfolioRouter` and `RouterGovernance` were deployed without a formal mainnet onboarding
checklist: no issue tracks the `ADMIN_ROLE` migration to the new `TimelockController`,
no deploy runbook specifies the ADMIN_ROLE handoff order, and no CI step verifies the
post-deploy ownership invariant. This is the highest-risk gap: a misconfigured
`ADMIN_ROLE` on the router or governance contract at launch leaves the protocol without
a safe key-rotation path.

---

## High (risk 4)

### BASKET-001 — No production audit gate before basket vaults become router-eligible
**Source:** `docs/technical/security-model.md` §12 ("new vault categories do not enter the
Portfolio Router until their oracle, liquidity, redemption, legal, and disclosure
requirements are specified and audited")
**Issue:** #692

The `PrototypeOverride` mechanism (`setPrototypeOverride`) bypasses the basket vault
prototype gate and makes any basket vault immediately router-eligible. Nothing currently
prevents an admin from calling `setPrototypeOverride(basketVault, true)` before the
required audit has occurred. The security model is explicit: "new vault categories do not
enter the Portfolio Router until their oracle, liquidity, redemption, legal, and
disclosure requirements are specified and audited." An on-chain or CI-level guard is
required.

### BASKET-002 — Basket-vault drawdown redemption policy unresolved
**Source:** `docs/development/open-questions.md` §1.C ("§3.7 — Specify the redemption
policy when a basket vault is in drawdown — forced sale vs. queued withdrawal vs. NAV
haircut — before ADMIN_ROLE marks any basket vault router-eligible")
**Issue:** #687

The open-questions doc explicitly gates basket vault router-eligibility on this decision.
No ADR, no issue, and no plan item covers it. Without a documented redemption policy,
operators cannot know what to expect during a drawdown and ADMIN_ROLE should not mark
basket vaults eligible.

### WATCHDOG-001 — No mint/burn rate watchdog
**Source:** `docs/technical/security-model.md` §13 ("a mint/burn rate monitoring service
must emit an alert and trigger an automatic `pause()` call when the per-block mint or burn
rate exceeds a configurable threshold")
**Issue:** #658

The security model requires an automated circuit breaker for anomalous vault share
velocity. No such service exists in `services/` and no plan item tracks it. This is a
required control for production launch, not a nice-to-have.

### ECONOMIC-AUDIT-001 — No economic-model audit gate for basket vault bucket-B/C tokens
**Source:** `docs/technical/basket-vault-gap-report.md` Appendix C, `docs/technical/security-model.md` §12
**Issue:** #691

The basket vault gap report identifies a required economic-model audit for bucket-B
(protocol-asset) and bucket-C (agent-token) shortlists before router eligibility. No
issue tracks commissioning or completing this audit. The security model names it as a
hard gate.

### GATEWAY-ROUTER-001 — Gateway agent withdrawal does not support Portfolio Router as destination
**Source:** `docs/architecture.md` §5.2 ("agents interact via the gateway for both
deposits into vaults and withdrawals")
**Issue:** #669

`RobotMoneyGateway.withdraw()` requires an explicit `sourceVault` address. An agent that
deposited via the router (funds split across vaults) cannot withdraw via the gateway
without knowing the per-vault share allocation. No architecture or plan item covers this
gap. The gateway's withdraw surface is incomplete for the multi-vault case.

### CSP-001 — No Content Security Policy on dapp
**Source:** `docs/technical/security-model.md` §11 ("CSP must disallow inline scripts and
`eval`; violation reports must be collected")
**Issue:** #665

The security model lists CSP as a required control. No `Content-Security-Policy` header
is set in the dapp's Vite config, nginx config, or Docker image. Inline script injection
into the dapp would allow full wallet compromise.

### DEPLOY-APPROVAL-001 — No human approval gate on deploy workflows
**Source:** `docs/technical/security-model.md` §10 ("deploy pipelines must require a
human approval step before executing any state-changing on-chain transaction")
**Issue:** #660

`.github/workflows/release-rmpc.yml` and `release-dapp.yml` can be triggered by any
push to a matching tag without a required human reviewer step. A compromised CI token
could trigger an unreviewed deploy.

### REAL-ADAPTER-001 — Smoke-test still boots with PassthroughAdapter by default
**Source:** `testing/smoke-test/src/lib.rs:515` — `Fixture::new()` hardcodes
`USE_PASSTHROUGH_ADAPTER=true`
**Issue:** #685

Every smoke-test invocation via `Fixture::new()` deploys a `PassthroughAdapter` instead
of the real Aave V3 / Compound V3 / Morpho adapters. The fork e2e suites have proven the
real adapter stack, but the primary devnet harness never exercises it. Production
incidents involving real adapter behavior would not be caught by the standard suite.

---

## Medium (risk 3)

### SECURITY-001 — No `SECURITY.md` at repo root
**Source:** `docs/technical/security-model.md` §14
**Issue:** #643

The security model requires `SECURITY.md` with a disclosure address and maximum
response-time commitment. No such file exists at the repo root.

### SECURITY-002 — No bug-bounty program or scope doc
**Source:** `docs/technical/security-model.md` §14 ("a bug-bounty program with a published
scope must be live before the public dapp launch")
**Issue:** #644

Required pre-launch. No program exists, no scope doc, no CI gate enforcing scope updates
within 72 hours of new contract deployments.

### SECURITY-003 — No audit ledger (`docs/audits.md`)
**Source:** `docs/technical/security-model.md` §14 — referenced three times as a required
artifact
**Issue:** #645

The security model mandates a disposition log for every audit finding, an audit-scope
ledger mapping every contract to its report(s), and a finding register with a
"checked against" field. Four code reviews exist in `docs/code-reviews/` but no
`docs/audits.md` ledger exists.

### SECURITY-004 — No on-call rotation or on-chain event alert system
**Source:** `docs/technical/security-model.md` §14 ("SECURITY.md must be monitored with
an on-call rotation")
**Issue:** #646

No runbook, rotation schedule, or automated alert system (PagerDuty, OpsGenie, or
equivalent) is documented or wired to on-chain events.

### SECURITY-005 — Read-only reentrancy adapter-path analysis not published
**Source:** `docs/technical/security-model.md` §2 ("All adapter call paths that read
balances of external contracts must be enumerated and verified to be free of callback
surfaces that could be queried mid-state. This analysis must be published and kept
current as adapters are added.")
**Issue:** #648

The security model requires a published analysis for all three adapters (Aave V3,
Compound V3, Morpho). No such document exists.

### SECURITY-006 — Fee-accrual rounding analysis not published
**Source:** `docs/technical/security-model.md` §3 ("A published rounding analysis must
confirm no dust-siphon path exists")
**Issue:** #650

Required control explicitly cited in the security model. No analysis document exists.

### SECURITY-007 — No multisig signer playbook
**Source:** `docs/technical/security-model.md` §10 ("a multisig signer playbook covering
all privileged operations must exist and be tested")
**Issue:** #663

No signer playbook for the Safe multisig exists. Operators have no documented procedure
for `TimelockController` queue, cancellation, or emergency pause flows.

### PAYMENTID-001 — `paymentId` hash does not include an op-kind discriminator
**Source:** `docs/technical/security-model.md` §4 ("deposit and withdrawal idempotency
keys must be namespace-separated to prevent cross-operation replay")
**Issue:** #679

`RobotMoneyGateway` uses the same `keccak256(orderId, depositor, ...)` hash structure for
both `deposit` and `withdraw` idempotency keys. A deposit `paymentId` can collide with a
withdrawal `paymentId` for the same `orderId`. Adding an op-kind byte to the hash
eliminates the cross-operation replay surface.

### CI-DEP-001 — No dependency vulnerability scanning (cargo audit / bun audit)
**Source:** `docs/technical/security-model.md` §11
**Issue:** #651

No CI step runs `cargo audit` or `bun audit`. A known CVE in a transitive dependency
would not be caught before merge.

### CI-SECRETS-001 — No secrets-scanning step in PR workflow
**Source:** `docs/technical/security-model.md` §11
**Issue:** #653

No `gitleaks`, `truffleHog`, or equivalent step runs on PRs. A committed private key
would not be caught by CI.

### CI-CODEOWNERS-001 — No `CODEOWNERS` for contracts and deploy scripts
**Source:** `docs/technical/security-model.md` §10 ("contract changes require two-reviewer
sign-off")
**Issue:** #657

No `CODEOWNERS` file exists. A single reviewer can merge changes to `contracts/` or
`contracts/script/` without a second approver.

### CI-SIGN-001 — No release tag signing or build provenance attestation
**Source:** `docs/technical/security-model.md` §11
**Issue:** #659

`release-rmpc.yml` and `release-dapp.yml` produce unsigned binaries and Docker images.
No SLSA provenance attestation is generated. A supply-chain attack on the build outputs
cannot be detected.

### CI-BASESCAN-001 — No BaseScan source verification step in deploy pipeline
**Source:** `docs/technical/security-model.md` §10
**Issue:** #662

Contract source verification on BaseScan is not automated. Users cannot independently
verify deployed bytecode matches the published source.

### HSTS-001 — No HSTS preload enforcement for dapp domains
**Source:** `docs/technical/security-model.md` §11
**Issue:** #671

No `Strict-Transport-Security` header with `includeSubDomains; preload` is enforced in
the dapp Docker image or nginx config.

### RMPC-ROUTER-001 — `rmpc deposit` has no `--destination router` path
**Source:** `docs/prd.md` §8 ("rmpc must support router deposits"), `docs/architecture.md` §5.1
**Issue:** #649

`rmpc deposit` only targets a single vault address. The PRD requires routing through the
`PortfolioRouter` as a first-class deposit mode. No plan item tracks this.

### RMPC-DEADLINE-001 — `rmpc` uses wall-clock time for deadline computation
**Source:** `docs/technical/security-model.md` §6 ("safety-critical signing data comes
from live chain reads, not cached UI state or agent planner text")
**Issue:** #672

`rmpc` computes transaction deadlines from `std::time::SystemTime::now()` rather than
fetching the current EVM `block.timestamp` via `eth_getBlockByNumber`. On a clock-skewed
host or a lagging L2, the signed deadline can be in the past before the tx lands.

### RMPC-POSITION-001 — No `rmpc get-position` command
**Source:** `docs/prd.md` §8 ("rmpc must expose per-address vault positions"), `docs/architecture.md` §5.1
**Issue:** #666

Agents have no single command to query their position across all registered vaults.
`rmpc get-balance` returns a single vault balance; `rmpc get-vaults` returns metadata.
A `get-position` aggregation command is a PRD requirement.

### RMPC-RPC-001 — No multi-RPC failover
**Source:** `docs/architecture.md` §5.1 ("the client must tolerate RPC endpoint failures")
**Issue:** #667

`rmpc` connects to a single RPC endpoint. A node outage causes a hard failure. The
architecture requires a failover list.

### RMPC-CONFIRM-001 — No confirmation-depth policy per operation class
**Source:** `docs/technical/security-model.md` §6 ("L1 finality vs L2 soft confirmation
must be distinguished per operation class")
**Issue:** #676

`rmpc` treats all transactions as confirmed after a single block. High-value operations
(vault deposits > policy cap, withdrawal of full balance) should wait for L2 finality
(`safe` or `finalized` tag) rather than trusting a single L2 block.

### INDEXER-HISTORY-001 — Account history endpoint missing event types
**Source:** `docs/architecture.md` §6 ("account history must include withdrawals, policy
changes, fee events, and governance votes")
**Issue:** #654

`GET /v1/accounts/:address/history` returns deposit events only. Withdrawals, policy
`AuthorizeAgent`/`SetPolicy` events, fee collection, and governance votes are indexed but
not surfaced in this endpoint.

### INDEXER-VAULT-001 — Vault detail endpoint missing allocation and fee history
**Source:** `docs/architecture.md` §6
**Issue:** #675

`GET /v1/vaults/:address` omits adapter allocation history (how USDC is split across
Aave/Compound/Morpho over time), the deposit/withdrawal log, and fee collection history.
All three are indexed; none are exposed.

### DAPP-TIMELOCK-001 — No timelocked proposals panel in dapp
**Source:** `docs/architecture.md` §5.3 ("the action layer includes governance voting,
including pending timelocked proposals")
**Issue:** #647

`GovernancePanel.tsx` renders the active proposal voting UI but has no view for pending
`TimelockController` queued executions. Users cannot see or cancel queued governance
operations.

### DAPP-RWA-RISK-001 — No issuer freeze-control risk disclosure on RWA vault
**Source:** `docs/adr/ADR-0006-despxa-rwa-vault-design.md` §Freeze risk ("the dapp must
surface the issuer's freeze authority prominently on the vault detail page")
**Issue:** #652

ADR-0006 explicitly requires the dapp to disclose that deSPXA tokens can be frozen by
the issuer. No disclosure UI exists on the vault detail page.

### REASON-CODE-001 — Incomplete reason-code layer
**Source:** `docs/architecture.md` §5.1 ("all policy violations and RPC errors must surface
a stable machine-readable reason code to the calling agent")
**Issue:** #670

`rmpc` and the dapp return raw revert strings from the contract. Agents need stable
`reason: string` fields in the `Envelope<T>` response; humans need readable error
summaries. The reason-code mapping is partially implemented but not complete or stable.

### ERC4626-SEED-001 — ERC-4626 seed deposit precondition not enforced in fork tests
**Source:** `docs/technical/security-model.md` §3 ("the deploy runbook must require a seed
deposit of ≥ 1,000 USDC before the vault is opened to the public. This must be verified
in CI fork tests.")
**Issue:** #656

The security model explicitly requires a CI fork test that verifies the seed deposit
precondition. No such test exists; the CI invariant is not enforced.

### FORCEREMOVE-001 — `forceRemoveAdapter` loss-acceptance path untested
**Source:** `docs/technical/security-model.md` §3 ("forceRemoveAdapter must accept explicit
loss write-off")
**Issue:** #677

No forge test exercises the `forceRemoveAdapter` code path that writes off partial USDC
loss. The security model names this as a required control and the code path is untested.

### CI-SUITE14-001 — `full_stack_demo_tvl` not in suite-14 smoke-test matrix
**Source:** `.github/workflows/suite-14-smoke-test.yml`, `agent-warnings.md`
**Issue:** #680

`agent-warnings.md` documents that `demo_seeding` and `full_stack_demo_tvl` tests are
not run by any CI workflow. The acceptance criteria for several shipped issues (e.g.
#563) are not verified by CI. Adding these to suite-14 closes the gap.

### CI-PATHS-001 — `paths:` filters prevent unconditional suite runs on dev push
**Source:** `docs/implementation-plan.md` ("CI: run all suites unconditionally on push to
`dev` — suite-01-02 and others still gated by `paths:` filters")
**Issue:** #681

---

## Low (risk 1–2)

### EXPLORER-POLICY-001 — No policy owner-lookup endpoint
**Source:** `docs/architecture.md` §6
**Issue:** #661

`GET /v1/accounts/:address/policies` does not exist. Agents and dapp components have no
way to query which agents are authorized for a given depositor without parsing raw
on-chain events.

### RMPC-FAILOVER-001 — Multi-RPC failover not implemented
**Source:** `docs/architecture.md` §5.1
**Issue:** #667 (see above under Medium — elevated due to operational impact)

### DNS-001 — No canonical domain list or DNS security controls published
**Source:** `docs/technical/security-model.md` §11
**Issue:** #668

### SYBIL-DISCLOSE-001 — Per-deposit-cap Sybil bypass not in public risk doc
**Source:** `docs/technical/security-model.md` §3 ("must be documented in the public risk
disclosure")
**Issue:** #678

The security model explicitly accepts this limitation but requires it to be disclosed
publicly. No entry exists at `robotmoney.net/smart-contract-risks`.

### MEV-THRESHOLD-001 — Acceptable MEV sandwich loss threshold on rebalance undocumented
**Source:** `docs/technical/security-model.md` §8
**Issue:** #673

### FORCE-INCLUSION-001 — Force-inclusion via L1 not in user playbook
**Source:** `docs/technical/security-model.md` §9
**Issue:** #664

### RETIREMENT-001 — Depositor migration on vault retirement not decided
**Source:** `docs/development/open-questions.md` §1.C
**Issue:** #682

### TRADING-AUTHORITY-001 — AgentTokenVault trading authority not reframed with product owner
**Source:** `docs/development/open-questions.md` §1.B
**Issue:** #684

### SOLIDITY-BUGS-001 — No Solidity known-bug review process for production deployments
**Source:** `docs/technical/security-model.md` §2
**Issue:** #683

### UPSTREAM-MONITOR-001 — No upstream contract monitoring (Compound/Aave governance, Circle)
**Source:** `docs/technical/security-model.md` §13
**Issue:** #686

### BASKET-FORK-E2E-001 — No fork e2e multi-vault round-trip for basket vaults
**Source:** `docs/implementation-plan.md` ("Fork e2e: multi-vault round-trip including
basket vaults" — unchecked)
**Issue:** #690

### PLAN-STALE-001 — Several completed checkboxes not ticked in implementation-plan.md
**Source:** `docs/implementation-plan.md`
**Issue:** #689

### OPENQ-ROUTER-WEIGHTS-001 — open-questions.md §1.A not marked Resolved
**Source:** `docs/development/open-questions.md` §1.A — ADR-0002 resolved this
**Issue:** #674

### SUITE05-001 — suite-05 duplicate test audit not verified complete
**Source:** `docs/implementation-plan.md`
**Issue:** #688

---

## Critique and known limitations of this review

### 1. Domain table double-counts five issues

The summary table lists 17+13+5+10+5+5 = 55 total, but only 50 issues were created.
Five issues appear in two domain rows each: #652, #664, #682, #684 (both "Docs/plan
cleanup" and "Open questions") and #673, #687 (both "Security" and "Open questions").
The table is a navigational aid, not a precise count. The canonical count is 50 issues,
#643–#692.

### 2. RMPC-FAILOVER-001 listed twice

RMPC-RPC-001 (#667, Multi-RPC failover) appears under Medium with full description.
RMPC-FAILOVER-001 in the Low section is a stub for the same issue. The Low entry should
be removed; the Medium entry is the authoritative one. The stub survives in this doc as
a record of the error.

### 3. CI-PATHS-001 finding body is empty

The Medium entry for CI-PATHS-001 (#681) has no description paragraph — it ends
immediately after the issue number. The finding is real but the documentation is
incomplete. The implementation plan is the authoritative source for this one.

### 4. PAYMENTID-001 is likely underrated

Cross-operation `paymentId` collision (#679) is rated Medium (risk 3). A deposit
`paymentId` that collides with a withdrawal `paymentId` for the same `orderId` could
allow an agent to replay a deposit record as a withdrawal or vice versa. The gateway's
idempotency key is the sole replay-prevention mechanism; a collision bypasses it. Risk 4
(High) is a defensible alternative rating. The issue is filed at risk 3; this should be
reconsidered during triage.

### 5. `db::count()` SQL type-guard not captured as a finding

The implementation plan (line 134) has an unchecked item: "Indexer: restrict or
type-guard `db::count()` to prevent dynamic SQL expansion." This gap was identified
manually before the workflow ran but does not appear as a finding or GH issue in this
review. It should be filed separately. The adversarial verifiers may have dismissed it
as already partially mitigated, or it fell through the gap-finder prompts.

### 6. Review is docs-vs-docs only; no code-vs-spec verification

The workflow compared documentation (PRD, architecture, security model, open questions,
plan) against each other. It did not verify that the shipped code matches the specs — for
example, whether `BasketVault.rebalance()` implements ADR-0003's exact trigger/target/
cost-disclosure requirements, or whether the actual `paymentId` computation matches the
security model's namespace requirement. A follow-on code-vs-spec audit pass is needed
before production launch.

### 7. PRD section references may be approximate

Several findings cite `docs/prd.md §8` for `rmpc` requirements (RMPC-ROUTER-001,
RMPC-POSITION-001). Multiple gaps sharing one section number is a signal the agents used
a fuzzy match rather than a precise quote. The requirements exist; the section references
should be verified against the actual PRD before these issues are worked.

### 8. No triage or dependency ordering

The 50 issues have no explicit dependency graph. Several are load-bearing for others:
BASKET-002 (#687) and BASKET-001 (#692) both gate basket vault production eligibility;
MAINNET-001 (#655) must land before any production deploy; the security disclosure docs
(#643–#645) are pre-launch gates. A triage pass to establish the dependency order and
a pre-launch vs. post-launch split would sharpen the backlog.

---

## What this review does NOT cover

- Findings already fixed by the 2026-06-06 security deep clean (#641)
- Shipped features working correctly (all [x] items in the implementation plan)
- Business, legal, tokenomics, and go-to-market decisions (out of scope per
  `docs/implementation-plan.md` Non-goals)
- Upstream Aave V3 / Compound V3 / Morpho smart contract risk (accepted by design)
