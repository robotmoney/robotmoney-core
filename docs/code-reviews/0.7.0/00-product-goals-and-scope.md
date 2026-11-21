# Product goals and review scope

## Product goals

The root PRD frames Robot Money as hands-off USDC treasury management: users
should get a managed allocation, clear previews and reporting, and bounded
agent access ([`docs/prd.md`](../../prd.md#L5-L18)). Its current success
criteria include synchronous withdrawals from eligible vaults, Safe and
timelock control over allocation changes, explicit failure reasons, and
visible execution results ([`docs/prd.md`](../../prd.md#L64-L86)). The current
canonical product still includes direct vault selection and Portfolio Router
allocation ([`docs/prd.md`](../../prd.md#L35-L44)). The architecture's guardrails
also require custody protections, caps before deposits, visible bounds before
signing, and timelock-only high-risk configuration
([`docs/architecture.md`](../../architecture.md#L1704-L1729)).

The one-vault proposal is an experiment to test the rejection of ADR-0010; it
does not change production or rewrite canonical product documents while the
experiment is open ([`one-vault-rebalancer-proposal.md`](../../technical/one-vault-rebalancer-proposal.md#L3-L9)).
Its product hypothesis is that one share token and receipt-set per-asset
targets can make existing holdings follow committee decisions, with a bounded
rebalance plan and hardened timed flows ([proposal](../../technical/one-vault-rebalancer-proposal.md#L27-L52)).
The timed-flow plan sets the experiment's safety goal: quantity determines
shares, prices only bound trades or block settlement, and the prototype is to
measure attack outcomes, cost, wait time, and block rates ([`one-vault-timed-flows-eng-plan.md`](../../technical/one-vault-timed-flows-eng-plan.md#L18-L35), [§2](../../technical/one-vault-timed-flows-eng-plan.md#L37-L67)).

The product decision is still open: ADR-0010 remains Rejected pending the
experiment, and the proposal says production stays on the existing design
until its gates decide otherwise ([`ADR-0010`](../../adr/ADR-0010-unified-vault-architecture.md#L1-L3), [proposal](../../technical/one-vault-rebalancer-proposal.md#L3-L9)).
The proposal currently reports G1 Pass, G4 Pass (step 3e; historical step 3 failed), G5 not pass, G6 not run, G8
Fail and G9 Pass; these are published experiment outcomes, not findings of
this static review ([proposal §13](../../technical/one-vault-rebalancer-proposal.md#L1184-L1201), [gate results](../../technical/one-vault-rebalancer-proposal.md#L1231-L1243)).

## In scope

- Changes introduced from merge base `42a4d2e1848ca7c412c4e2197b9d693c1ee371b6`
  through reviewed HEAD `17677089268affa3a5efa3d9192bb4f63b6bb605`.
- The new experimental fund, receipt governance, rebalancer, timed-flow queue,
  adapters and libraries under `contracts/test/prototype/`.
- The Deploy 4 publish, verification, receipt, counts, twin-feed and runbook
  path where it provides evidence that the experiment is configured as intended.
- The claim made by the Deploy 4 fund verifier that it checks run postconditions
  against the deployment sheet.
- Whether changed implementation and verification code satisfy requirements
  already stated in the root PRD, architecture guardrails, experiment proposal,
  and timed-flow plan.

## Out of scope

- Production deployment or production readiness. The proposal explicitly keeps
  production on the three-vault design while the gates remain open.
- The unchanged production three-vault contracts, except where the new code
  integrates with or copies their interfaces.
- Unimplemented dapp, `rmpc`, indexer and PRD amendment work. The PRD amendments
  are explicitly draft-only and describe changes required only if the
  experiment proceeds ([`one-vault-prd-amendments.md`](../../technical/one-vault-prd-amendments.md#L1-L12)).
- A future decision to accept or reject the one-vault model. Product trade-offs
  that the experiment discloses—such as one common exposure and queued USDC
  redemption—are not reported as code defects by themselves.

## Review posture

This is an expanded adversarial review with static runtime traces and focused executable verifier, receipt and scorer checks. Findings are limited to
actionable implementation or verification defects, with path and line evidence
and a concrete trigger and consequence. Documented experimental limitations
and unmet product decisions are recorded as scope or coverage limits, not
misstated as implementation findings.
