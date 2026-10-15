<!--
Canonical: docs/technical/consensus-receipt-submitter-runbook.md §5.5
Implements: issue #1248 — (fusion) governance handoff; round-2 review task T09
Retired by: issue #1698 (QA plan v1 C1); files deleted by QA plan v1 leftovers L1
-->

# The Fusion draft watcher (retired)

> **Deleted by issue 1698 (QA plan v1 C1, leftovers L1).** A receipt is now
> released only inside `RouterGovernance.applyReceipt`, the one timelock call
> that also writes its weights. A `ReceiptReleased` log therefore marks a
> receipt that is already applied, and there is no proposal left to draft: the
> contract has no proposal, vote or execute function. `rmpc governance
> draft-proposal` is deleted, so the watcher had no command to run.
> `scripts/fusion/watch-released-drafts.sh`, `fusion-draft-watcher.service` and
> `fusion-draft-watcher-failed.service` are deleted from the repository. The
> Safe applies a receipt with `govern --row apply-receipt`
> (`docs/technical/router-governance-handoff-runbook.md` §2).

## What it was

`scripts/fusion/watch-released-drafts.sh` was the persistent, read-only watcher
AC-GOV-01 named. It polled `ReceiptReleased`, drafted a weight-setter call for
each released receipt with `rmpc governance draft-proposal`, quarantined
anything it had to refuse, and advanced a durable block cursor. It never signed
and never broadcast. A systemd unit restarted it (`Restart=always`,
`StartLimitIntervalSec=0`) and an `OnFailure=` unit paged
`fusion_draft_watcher_process_down`.

## Decommission a host that still runs it

A host installed from an older checkout still has the units. The watcher there
fails every cycle, because its rmpc has no `draft-proposal` subcommand, and it
pages `fusion_draft_watcher_stalled`. Stop it and remove it:

```sh
systemctl disable --now fusion-draft-watcher.service
rm -f /etc/systemd/system/fusion-draft-watcher.service \
      /etc/systemd/system/fusion-draft-watcher-failed.service
systemctl daemon-reload
# The env file names an alert webhook; remove it with the state directory.
rm -f /etc/fusion/draft-watcher.env
rm -rf /var/lib/fusion-draft-watcher
```

Resolve any open `fusion_draft_watcher_*` incident in the alert receiver by
hand. Nothing will send a resolve for those keys again.

## What replaced it

- **The apply path.** `govern --row apply-receipt` checks the payload digest
  against the anchored one before it schedules, and `applyReceipt` reverts
  `ReceiptDigestMismatch` on chain. That digest binding is what the watcher's
  refusal of tampered bytes used to stand for.
- **The acceptance harnesses.** The `govern` stage of
  `scripts/fusion/devnet-acceptance.sh` proves, with `eth_call` only, that the
  weight setter applies receipts from this register, that only the timelock
  can apply, and that a released receipt can never be applied later.
  `scripts/fusion/cross-repo-acceptance.sh` checks the same register binding.
- **Paging.** The submit worker (`scripts/fusion/submit-receipt-worker.sh`) is
  the Fusion harness that still pages, through `scripts/fusion/lib/alert.sh`.
  The watchdog pages when the router's weight-setter path changes
  (`weight_setter_path_drift`, `docs/architecture.md` §5.6).
