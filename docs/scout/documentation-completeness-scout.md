# Documentation Completeness — Dev Scout

> Phase: Documentation completeness (`phase/documentation-completeness`)
> Scout issue: #834
> Canonical docs touched by the phase:
> [`docs/development/ci-suites.md`](../development/ci-suites.md),
> [`docs/technical/security-model.md`](../technical/security-model.md),
> [`docs/architecture.md`](../architecture.md),
> [`docs/technical/smart-contracts.md`](../technical/smart-contracts.md),
> [`docs/development/open-questions.md`](../development/open-questions.md)

This is a STUB-ONLY integration scout. It maps the documentation edit surfaces
of the five remaining doc-gap issues filed by the 2026-06-12 gardening sweep so
they can be developed in parallel without merge conflicts. It performs no doc
remediation — each content change is owned by its downstream feature issue.

## 1. Per-issue edit-surface map

Which issue owns which documentation surface. Two issues that touch the **same
file and section** form a conflict group and must serialize; issues that touch
disjoint files (or disjoint sections of a shared file) are parallel-safe.

| Issue | Owned surface | Shared file? | Conflict group |
|-------|---------------|--------------|----------------|
| #828 | `docs/development/ci-suites.md` — add `### 17.`, `### 19.` sections, suite-18-security-gates block, and summary-table rows | sole owner | dc/ci-suites |
| #830 | `clients/dapp/Dockerfile`, `clients/explorer-api/Dockerfile` canonical headers; `.github/scripts/check_canonical_header_staleness.py` scan scope; references `docs/architecture.md` §5.3/§5.4 as link **targets only** (no edits to those sections) | reads architecture.md anchors | dc/headers |
| #831 | Plan tracking issue #109 body (GitHub) — completion-mark sync; no repo files | none (GitHub-only) | dc/plan-sync |
| #832 | `docs/technical/smart-contracts.md` §1 + new contract sections; `docs/architecture.md` §11 Source Coverage **row for smart-contracts.md** | architecture.md §11 (one row) | dc/contracts |
| #833 | `docs/development/open-questions.md` §1.A / §2 — mark §3.9 Resolved | sole owner | dc/open-questions |

### Serialization rules

1. **All five groups are parallel-safe.** No two issues write the same file *and*
   the same section:
   - #828 and #833 own distinct files outright.
   - #830 only *reads* `docs/architecture.md` §5.3/§5.4 (link targets for the
     Dockerfile headers); #832 only writes the `docs/architecture.md` §11 row.
     §5.3/§5.4 and §11 are disjoint sections, so #830 and #832 do not collide.
   - #831 touches only GitHub Plan #109, no repo files.
2. **architecture.md is the one shared repo file** (#830 reads §5.3/§5.4, #832
   writes §11). Because the surfaces are disjoint sections, a plain `git rebase`
   resolves cleanly with no content conflict. Whichever merges second rebases.
3. **No ordering dependency** exists among #828, #830, #831, #832, #833. They may
   be developed and merged in any order.

## 2. Cross-reference verification (against branch tip)

Each canonical doc was checked for the edit anchors the downstream issues rely on,
to confirm the seams exist where the issues assert.

| Doc | Anchor the downstream issue needs | Present? |
|-----|-----------------------------------|----------|
| `docs/development/ci-suites.md` | numbered `###` section style + summary table for suites | ✅ existing `### 17.`/`### 19.`/table conventions present |
| `docs/architecture.md` | `## 11. Source Coverage` table with a `smart-contracts.md` row; `### 5.3`/`### 5.4` link anchors | ✅ §11 table and §5.3/§5.4 headings present |
| `docs/technical/smart-contracts.md` | §1 scope + system diagram, deployed-address table | ✅ present |
| `docs/development/open-questions.md` | §3.9 entry + §2 suggested-resolution-order list | ✅ present |
| `docs/technical/security-model.md` | §4 access-control table | ✅ present (see §3 below for the #829 supersession) |

No cross-reference creates a merge conflict between the parallel issues.

## 3. Security-review integration constraint (supersession of #829, dependency on #835)

The 2026-06-12 revalidation
([`docs/code-review/20260612-code-review-internal-claude.md`](../code-review/20260612-code-review-internal-claude.md))
changes the security surface of this phase:

- **#829 is superseded by #835 and is removed from this documentation phase.**
  The `authorizeAgent` commit/reveal front-running row must NOT be added to
  `security-model.md` §4 as originally specified, because the commitment-clobber
  fix is not safe until #835 lands it atomically.
- **#832 carries a dependency note on #835.** Neutral contract-surface
  documentation (VaultRegistry / PortfolioRouter / RouterGovernance / basket-vault
  roles, caps, and ABI surfaces) may proceed independently. But security claims
  about the following must remain unresolved until #835 closes:
  - gateway authorization (commit/reveal-only first-time authorization),
  - strict rolling-window deposit/withdraw accounting,
  - actual TWAP observation-age coverage and the emergency oracle-failure path,
  - Aerodrome Slipstream routing through the classic Aerodrome Router.

  #832 must not assert pool cardinality alone guarantees TWAP coverage, nor that
  `AerodromeSwapAdapter` correctly routes Slipstream CL swaps, nor that
  commit/reveal-only first-time authorization is shipped/safe — those are tracked
  as unresolved in #835.

## 4. Integration risks

- **architecture.md §11 vs §5.3/§5.4 (low):** #830 and #832 touch the same file
  but disjoint sections; rebase-clean. No serialization required.
- **#831 is GitHub-only (none):** Plan #109 body edits never conflict with repo
  PRs; the only coupling is that #831's completion marks should post-date the
  merges they describe.
- **#832 security claims gated on #835 (tracked):** the dependency above is the
  single ordering constraint that crosses phase boundaries; it is recorded as a
  note on #832 rather than a serialization within this phase.

## 5. Scout outcome

All five parallel doc issues (#828, #830, #831, #832, #833) are confirmed
**safe to develop concurrently**. The only cross-issue coupling is the disjoint
shared file `docs/architecture.md` (rebase-clean) and the #835 security gate on
#832's security claims. #829 is removed from the phase (superseded by #835).
