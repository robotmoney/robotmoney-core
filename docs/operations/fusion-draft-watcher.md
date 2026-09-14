<!--
Canonical: docs/technical/consensus-receipt-submitter-runbook.md §5.5
Implements: issue #1248 — (fusion) governance handoff; round-2 review task T09
-->

# Running the Fusion draft watcher under a supervisor

`scripts/fusion/watch-released-drafts.sh` is the persistent, read-only watcher
AC-GOV-01 names. It polls `ReceiptReleased`, drafts a `RouterGovernance.propose`
call for each released receipt, quarantines anything it had to refuse, and
advances a durable block cursor. It **never signs and never broadcasts**.

## Why a supervisor is part of the deliverable

The loop now survives a failed `cast block-number` on its own: the read is
guarded, the value is shape-checked before any arithmetic, the failure is
counted and paged, and the cycle retries. That closes the failure that was
actually reproduced — one failed chain read terminated the loop under
`set -euo pipefail` with no alert, no stall increment, and an exit code
indistinguishable from a config error.

It does not, and cannot, close every way a process ends. OOM, a signal, a host
reboot: for those the answer is a restarter, and §5.5's "restart rule" column
is only true if one exists. Two units ship with the script:

| Unit | Role |
|---|---|
| `scripts/fusion/fusion-draft-watcher.service` | `Restart=always`, `RestartSec=10s`, `StartLimitIntervalSec=0` — it never stops trying. |
| `scripts/fusion/fusion-draft-watcher-failed.service` | The `OnFailure=` target: pages `fusion_draft_watcher_process_down` so a crash loop is an incident, not a quiet journal line. |

## Install

```sh
# 1. The code, read-only to the service account.
install -d -o root -g root /opt/fusion
rsync -a --delete <checkout>/scripts /opt/fusion/scripts

# 2. A service account that can hold no key.
useradd --system --home-dir /var/lib/fusion-draft-watcher --shell /usr/sbin/nologin fusion || true

# 3. The environment. MODE 0640, root:fusion — it names an alert webhook.
install -d -m 0750 -o root -g fusion /etc/fusion
cat >/etc/fusion/draft-watcher.env <<'ENV'
FUSION_RMPC_CONFIG=/etc/fusion/rmpc.toml
FUSION_RPC_URL=http://127.0.0.1:18545
FUSION_RECEIPT_URL_TEMPLATE=https://stage.robotmoney-labs.dev/api/swarm/receipts/{receipt_id}
FUSION_DRAFT_CURSOR=/var/lib/fusion-draft-watcher/cursor
FUSION_DRAFT_QUARANTINE=/var/lib/fusion-draft-watcher/quarantine.tsv
FUSION_DRAFT_RESULT=/var/lib/fusion-draft-watcher/last-result.json
FUSION_START_BLOCK=0
FUSION_CONFIRMATIONS=2
FUSION_POLL_SECS=15
FUSION_STALL_ALERT_CYCLES=3
FUSION_ALERT_WEBHOOK=http://127.0.0.1:9093/alert
RMPC_BIN=/opt/fusion/bin/rmpc
CAST_BIN=/usr/local/bin/cast
ENV
chmod 0640 /etc/fusion/draft-watcher.env
chown root:fusion /etc/fusion/draft-watcher.env

# 4. The units.
install -m 0644 /opt/fusion/scripts/fusion/fusion-draft-watcher.service \
                /opt/fusion/scripts/fusion/fusion-draft-watcher-failed.service \
                /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fusion-draft-watcher.service
```

`FUSION_START_BLOCK` is mandatory and the script refuses to start without it:
an implicit `latest` would silently skip every release that happened before the
watcher first came up.

`jq` is also mandatory. It is what reads the per-receipt `"refused"` entries
out of an `ok:true` range result; without it the watcher would be back to
trusting an exit code, which is the defect T07 exists to close.

## Verifying it is actually supervised

```sh
systemctl show fusion-draft-watcher.service -p Restart -p StartLimitIntervalSec
# Restart=always
# StartLimitIntervalSec=0

# Kill it and watch it come back.
systemctl kill -s KILL fusion-draft-watcher.service
sleep 15
systemctl is-active fusion-draft-watcher.service   # active
```

A restart is safe at any point: the cursor is written atomically and advances
only past a range that was fully examined, and drafts are read-only JSON, so a
rescan costs nothing but RPC.

## What the operator looks at

| File | Meaning |
|---|---|
| `$FUSION_DRAFT_CURSOR` | Next block to scan. Motionless for `FUSION_STALL_ALERT_CYCLES` cycles ⇒ `fusion_draft_watcher_stalled` pages. |
| `$FUSION_DRAFT_QUARANTINE` | One TSV row per receipt the drafter REFUSED: timestamp, range, `receipt_id`, error code, reason. Every row is a receipt a human must look at; the cursor has already passed it. |
| `$FUSION_DRAFT_RESULT` | The last cycle's full draft result, persisted so "what did the watcher see?" survives the journal. |

## Alert keys

| Key | Fires when |
|---|---|
| `fusion_draft_watcher_refused_receipt` | A released receipt could not be drafted for a content reason (tampered bytes, digest mismatch, invalid signature, no eligible vault). |
| `fusion_draft_watcher_stalled` | The cursor has not advanced for `FUSION_STALL_ALERT_CYCLES` cycles — a transport failure that is not clearing. |
| `fusion_draft_watcher_chain_read` | `cast block-number` has failed `FUSION_STALL_ALERT_CYCLES` consecutive times: nothing can be drafted while the chain is unreadable. |
| `fusion_draft_watcher_unreadable_result` | The drafter's output was not JSON, so the range could not be checked for refusals. Treated as unverified, never as clean. |
| `fusion_draft_watcher_process_down` | systemd had to restart the unit. |

Each key is distinct on purpose: one key for all of them would mean resolving
any incident closes all of them, which is the same failure as not paging.
