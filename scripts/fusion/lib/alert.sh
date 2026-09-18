#!/usr/bin/env bash
# The ONE alert path for the Fusion shell harnesses (T25).
#
# WHY THIS FILE EXISTS
# --------------------
# Runbook §5.5 said both harnesses raise pages. `submit-receipt-worker.sh` had no
# alerting code at all — its "ALERT" was an `echo … >&2`, which under `nohup`
# reaches nobody. `watch-released-drafts.sh` posted only when FUSION_ALERT_WEBHOOK
# was set AND curl AND jq happened to be on PATH, with no startup validation and
# with delivery failure discarded by `|| true`; both of its conditions shared one
# dedup key, collapsing a quarantined poison range and a wedged cursor into one
# incident, and no resolve was ever sent — against the rule alert.rs enforces for
# the watchdog ("Never silent: if there is nowhere to page, say so every cycle").
#
# THE RULES
#   1. Validate at startup, the way rmpc/cast are validated: webhook set but
#      curl/jq missing is a REFUSAL, not a page discovered to be undeliverable at
#      3am. Webhook unset logs one explicit startup warning.
#   2. One dedup key PER CONDITION. Two different incidents are two incidents.
#   3. A delivery failure is LOGGED, never swallowed.
#   4. Resolve is sent when the condition clears, so a stall that recovered does
#      not sit open forever.

# fusion_alert_startup_check <component>
# Refuses (exit 1 in the caller's shell via `return 1`) when the webhook is set
# but the tools to deliver it are not. Warns exactly once when it is unset.
fusion_alert_startup_check() {
  local component="$1"
  if [[ -n "${FUSION_ALERT_WEBHOOK:-}" ]]; then
    command -v curl >/dev/null || {
      echo "$component: FUSION_ALERT_WEBHOOK is set but curl is not on PATH — pages would be \
silently dropped; refusing to start" >&2
      return 1
    }
    command -v jq >/dev/null || {
      echo "$component: FUSION_ALERT_WEBHOOK is set but jq is not on PATH — pages would be \
silently dropped; refusing to start" >&2
      return 1
    }
    echo "$component: alert webhook configured; pages will be POSTed and echoed to stderr" >&2
    return 0
  fi
  echo "$component: WARNING FUSION_ALERT_WEBHOOK is unset — every page will be STDERR-ONLY and \
will reach nobody under nohup/systemd without a log sink" >&2
  return 0
}

# _fusion_alert_post <component> <dedup_key> <event_action> <summary>
_fusion_alert_post() {
  local component="$1" dedup="$2" action="$3" summary="$4" body rc=0
  [[ -n "${FUSION_ALERT_WEBHOOK:-}" ]] || return 0
  body="$(jq -n --arg s "$summary" --arg k "$dedup" --arg a "$action" --arg c "$component" \
    '{event_action:$a,dedup_key:$k,payload:{summary:$s,severity:"critical",source:$c}}')" || rc=$?
  if (( rc != 0 )); then
    echo "$component: ALERT DELIVERY FAILED — could not build the webhook payload for $dedup" >&2
    return 1
  fi
  curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    --data "$body" "$FUSION_ALERT_WEBHOOK" >/dev/null || rc=$?
  if (( rc != 0 )); then
    # NOT `|| true`. A page that did not arrive is its own incident, and the only
    # place it can still be seen is this line.
    echo "$component: ALERT DELIVERY FAILED (curl exit $rc) for dedup_key=$dedup action=$action; \
the condition below was NOT paged and exists only in this log" >&2
    return 1
  fi
  return 0
}

# fusion_alert <component> <dedup_key> <summary…>
fusion_alert() {
  local component="$1" dedup="$2"; shift 2
  echo "$component: ALERT [$dedup] $*" >&2
  _fusion_alert_post "$component" "$dedup" trigger "$*" || true
}

# fusion_alert_resolve <component> <dedup_key> <summary…>
fusion_alert_resolve() {
  local component="$1" dedup="$2"; shift 2
  echo "$component: RESOLVE [$dedup] $*" >&2
  _fusion_alert_post "$component" "$dedup" resolve "$*" || true
}
