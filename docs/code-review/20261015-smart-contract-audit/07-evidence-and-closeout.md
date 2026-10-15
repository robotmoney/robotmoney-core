# Evidence and closeout

## Audit completeness and reporting gates

- Produce a contract/entrypoint inventory, trust-boundary and asset-flow map, invariant-to-evidence matrix, tool-output triage, and historical-finding disposition table. Mark each item covered, not applicable with a reason, or unverified; an unchecked item is a scope gap.
- Give each material finding a reproducible attack sequence and deployment-realistic impact bound. Explain attacker cost, required privilege, affected holders, liveness or loss, and any cap or time-window assumptions.
- Review every proposed fix and its new call paths, then rerun the relevant reproduction and invariant checks at the final review commit. If code changes after sign-off, assess the delta and update the verdict.
- Separate code correctness, deployment/config correctness, and operational assumptions in the final verdict. List blockers, accepted risks with an explicit decision owner, and checks still required before release.
- Use the [OWASP Smart Contract Security Verification Standard](https://scs.owasp.org/SCSVS/) and [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) as secondary checklists; explain any applicable control not covered by the project-specific review.
## Required finding record

For every candidate, record a stable ID, title, severity, affected contracts and lines at the pinned commit, assets and trust boundary, prerequisites and attacker authority, concrete call sequence, impact, reproduction/evidence, root cause, recommended change, regression test, disposition, and links to related historical findings. For refuted candidates, preserve the claim, the decisive counter-evidence, and why the proposed impact does not follow.
## Review closeout

- [ ] Summarize target commit, exact scope, method, commands, and evidence level.
- [ ] Publish findings with severity and disposition; cross-link prior IDs and update the audit ledger only when the evidence supports it.
- [ ] List regression coverage, failed/skipped checks, deployment-specific assumptions, and residual risks.
- [ ] State merge/release blockers and required follow-up owners without treating intended remediation or documentation alone as proof.
