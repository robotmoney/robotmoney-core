<!--
  Canonical: docs/technical/security-model.md §14
  Feature work: issue #1010 (Security disclosure ledger phase)

  security-model.md §14 row "Disclosure-handling failure":
    "SECURITY.md must exist at the repo root with a disclosure address and a
     maximum response-time commitment. The disclosure address must be monitored
     with an on-call rotation."

  Structural enforcement: scripts/check-audit-ledger.sh asserts this file exists
  at the repo root and contains the 'Disclosure address' and maximum
  'response time' sections with non-placeholder values. DO NOT rename a section
  heading without updating that script in lockstep.

  Values:
    - Disclosure address: GitHub private security advisory (GHSA) for this
      repository is the monitored, on-call-rotated intake channel. It is a real
      mechanism that exists for the repo today and requires no separately stood-up
      inbox; reports are visible only to maintainers on the security on-call
      rotation. This is the defensible disclosure address available from the repo
      itself (no security contact email is configured anywhere in-repo as of #1010).
    - Maximum response time: a 72-hour acknowledgement commitment, aligned with
      the security-model.md §14 72-hour bug-bounty / new-deployment cadence. This
      is the disclosure-handling SLA and is distinct from the watchdog's
      operational breach-to-pause SLA (sla.max_response_secs = 300, architecture.md §5).
-->

# Security Policy

> Canonical requirements: `docs/technical/security-model.md` §14
> (row "Disclosure-handling failure"). This file is mandated to exist at the
> repository root with a disclosure address and a maximum response-time
> commitment, and the disclosure address must be monitored with an on-call
> rotation.

## Disclosure address

Report security vulnerabilities **privately** through this repository's GitHub
private vulnerability reporting channel (GitHub Security Advisories):

- **<https://github.com/robotmoney/robotmoney-monorepo/security/advisories/new>**

This GHSA intake is the monitored disclosure address required by §14. It is
visible only to the maintainers on the security on-call rotation, so reports
reach an on-call responder without exposing the vulnerability publicly. Do **not**
open a public issue or pull request for a suspected vulnerability, and do not
disclose it publicly until a fix has shipped and the reporter has been notified.

When reporting, include: the affected contract/component, the commit or
deployed address, a reproduction or proof-of-concept, and the impact you
observed. Findings accepted into this repository's disposition ledger are
tracked in [`docs/audits.md`](docs/audits.md).

## Maximum response time

We commit to **acknowledging a security report within 72 hours** of submission
through the disclosure address above. This acknowledgement SLA is aligned with
the 72-hour cadence in `docs/technical/security-model.md` §14.

This disclosure-handling SLA is distinct from the protocol's automated
operational SLA: the on-chain watchdog's maximum breach-to-pause/alert response
is `sla.max_response_secs = 300` (five minutes), documented in
`docs/architecture.md` §5 and exercised by CI suite-20.
