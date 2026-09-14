# Cross-repo fixture vendoring: what the drift check proves, and what it does not

**Canonical script:** [`.github/scripts/check_cross_repo_fixture_drift.py`](../../.github/scripts/check_cross_repo_fixture_drift.py)
**Manifest:** `shared-fixtures/vendored/robotmoney-frontend.manifest.json`
**Workflow:** `.github/workflows/fusion-cross-repo-drift.yml`
**Criterion:** §9A R4 / AC-FMT-01

## The problem this replaced

`check_consensus_receipt_schema.py` re-hashes the shared consensus-receipt
fixtures against `tests/fixtures/consensus-receipt.anchor-digest.json` — a
manifest authored **in this repo**. That comparison is self-referential by
construction. At `v0.4.0-rc.3` eight of the nine shared fixtures had drifted
away from robotmoney-frontend and the check exited 0 with
`ok: all 9 cross-repo shared fixtures reproduce their committed sha256`. The two
repos were hashing different preimages while both CIs were green.

## What the vendored manifest does prove

`shared-fixtures/vendored/robotmoney-frontend.manifest.json` holds
robotmoney-frontend's **own bytes**, read out of a robotmoney-frontend checkout
at a pinned commit. As of this change all 11 rows are genuinely foreign: the two
that were `pending_frontend_adoption` (the T24 envelope fixture and the R27
unknown-field vector, authored here and handed upstream in the same cycle) have
landed in robotmoney-frontend byte-identically, and the manifest is re-vendored
at `c8c85ec01a219ef7a990ab37303c7dde4973a59a`.

So a **one-sided fixture edit** — by a wide margin the likeliest accident, and
the precise shape of the rc.3 failure — now fails. That is real and it is
independently verifiable: re-hash any row against the upstream repo.

`--regenerate` also refuses to **self-pin**. It used to fall back to core's own
bytes when the frontend did not carry a file, flagging the row
`pending_frontend_adoption`. A core-authored row in a manifest whose entire
purpose is to hold bytes core does not author is a contradiction, and it was the
soft spot the bypass below landed on. A fixture with no counterpart upstream is
now an **error**: either wait for the frontend to land it, or declare it
`core_only_not_shared` because it is not shared.

## The residual: the manifest is NOT authenticated at check time

**Nothing in CI contacts robotmoney-frontend.** `frontend_commit` is a string in
a JSON file in this repo, and the `sha256` column beside it is a string in the
same file. A single commit that drifts a fixture **and** edits its matching row
exits 0 and prints `ok: 11 shared fixtures are byte-identical to
robotmoney-frontend @ c8c85ec01a21`.

This is demonstrated, not hypothetical. Two independent adversarial verifiers
performed it against this tree:

- `fusion-evidence/20260914T-run2/phase2-ci/VERIFY/R4-core-refuter2.md` DEFECT 1
- `fusion-evidence/20260914T-run2/phase2-ci/VERIFY/T24-refuter2.md` ATTACK B

§9A R4 explicitly permits "the other repo's manifest vendored at a pinned
commit", so this is a **documented residual, not a criterion failure**. But a
green from this script must never be cited as a cryptographic guarantee that
the two repos agree. It is evidence that nobody edited one side *alone*.

## The control: review of the manifest diff

**State of enforcement today, exactly:** this repository has no
`.github/CODEOWNERS` file. The control is therefore ordinary pull-request
review, and it is only as strong as whether the reviewer runs the re-derivation
in "For the reviewer" below.

**Outstanding follow-up**, one line in a CODEOWNERS file that does not yet exist:

```
/shared-fixtures/vendored/   @<the team that owns cross-repo releases>
```

That is named as a gap rather than asserted as a control, because claiming an
enforcement that is not configured is the same false green this check exists to
close.

**Closing the residual for real** needs a CI step that re-fetches
robotmoney-frontend at `frontend_commit` and re-runs `--regenerate` to a zero
diff. That needs cross-repo read credentials in core's CI, which this branch
does not have.

## For the author: what a re-vendor MUST do

Every clause is load-bearing.

1. **Land the coordinated change in robotmoney-frontend first**, and let it
   merge. Re-vendoring from an unmerged branch pins bytes that may never exist.
2. **Re-vendor only by running the script** against a real checkout:
   ```
   .github/scripts/check_cross_repo_fixture_drift.py --regenerate \
     --frontend <robotmoney-frontend checkout> --frontend-ref <full commit sha>
   ```
   Never hand-edit a `sha256`, a `byte_length`, or `frontend_commit`. The sha
   column is **output**, never input.
3. **Use a full 40-character commit sha** as `--frontend-ref` — never a branch
   name, never a tag. Branches move and tags can be re-pointed; a commit sha is
   the only ref that pins bytes.
4. **Confirm the checkout's remote** is the real upstream repository. The script
   reads via `git show <ref>:<path>`, so a dirty worktree cannot leak in, but a
   fork or a rewritten history can.
5. **Commit the manifest change in the same commit as the core fixture change**
   it accompanies, and name the upstream PR that landed the other half in the
   message. A manifest-only commit, or a fixture-only commit, is the exact shape
   of the bypass.
6. **A refused row is an error.** If `--regenerate` refuses because the frontend
   does not carry the file, do not re-add `pending_frontend_adoption` by hand.
   Wait for the frontend, or add the file to `core_only_not_shared`.

## For the reviewer: the one question with a mechanical answer

For **every** changed row in the diff, independently re-derive the hash from the
upstream repository and compare it to the diff:

```
git -C <robotmoney-frontend> show <frontend_commit>:contract/src/__fixtures__/<file> \
  | sha256sum
```

If that does not reproduce the `sha256` in the diff, the manifest is forged or
stale — **reject it**. Do not take the author's word for it, and do not take the
check's exit code: the check cannot make this comparison.

Also confirm `frontend_commit` is reachable on an upstream branch or tag
(`git -C <robotmoney-frontend> merge-base --is-ancestor <commit> origin/<branch>`),
not an orphaned or force-pushed sha.

## Related

- [`ci-suites.md`](./ci-suites.md) — the workflows that run the check
- [`false-green-shapes.md`](./false-green-shapes.md) — the family this belongs to
- [`fusion-devnet-ci.md`](./fusion-devnet-ci.md)
