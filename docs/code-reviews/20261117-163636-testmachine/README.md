# TestMachine scan reproduction — 17 November 2026

**Status:** verification pass complete. An automated TestMachine scan of
`robotmoney/robotmoney-core` produced 23 findings (19 Low, 4 Info) at
`2026-11-17T03:48:00Z`. This folder records an independent attempt to reproduce
or reject each finding against the actual `release-0.9.0` source.

**Reviewed source:** `d4a43e6d21efed208816698d2b32f0decea45451` (the `release-0.9.0` review pin; the branch later advanced to `da7594306` with fund upgrade-library tooling changes only)
**Verification branch:** `audit/reproduce-findings-0.9.0`
**Verdicts:** 2 REJECTED · 12 REPRODUCED · 9 PARTIAL (bounded / by-design / premise overstated).

1. [Scan and verdicts](00-scan-and-verdicts.md)
2. [Reproduced findings](01-reproduced-findings.md)
3. [Rejected and partial findings](02-rejected-and-partial-findings.md)
4. [Method and reproduction evidence](03-method-and-reproduction.md)
5. [Cross-review addendum — second security review, same pin](04-cross-review-addendum.md)
6. [Raw scan snapshot](05-raw-scan.md)

A second security review of the same pin promoted one medium `TEST_COVERAGE_GAP`
(fund timelock Safe-only executor has no executed-in-CI assertion) and four
advisories. All five were independently verified and are recorded in chapter 5;
none changes the 23-finding verdicts above.

No production source was changed; this is an analysis-only verification. The
canonical summary is
[docs/code-review/20261117-review-testmachine-verification.md](../../code-review/20261117-review-testmachine-verification.md);
this folder holds the full evidence and the raw scan snapshot.
