#!/usr/bin/env bash
# Install the repo-owned service unit without ever copying secrets into it.
# /etc/fusion-watchdog.env is provisioned host-locally with mode 0600 by the
# deployment environment; this installer only validates its required names.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${FUSION_WATCHDOG_ENV_FILE:-/etc/fusion-watchdog.env}"
UNIT_DST="/etc/systemd/system/fusion-watchdog.service"
[[ $EUID -eq 0 ]] || { echo "install-fusion-watchdog: must run as root" >&2; exit 64; }
[[ -f "$ENV_FILE" ]] || { echo "install-fusion-watchdog: missing $ENV_FILE" >&2; exit 65; }
for key in WATCHDOG_BIN WATCHDOG_CONFIG WATCHDOG_DATABASE_URL WATCHDOG_CHAIN_ID WATCHDOG_ALERT_WEBHOOK; do
  grep -q "^${key}=" "$ENV_FILE" || { echo "install-fusion-watchdog: $key absent from $ENV_FILE" >&2; exit 65; }
done
# The supervisor's liveness check (issue #1378) runs `watchdog-liveness`, built by
# the same `cargo build -p watchdog --release` as WATCHDOG_BIN. Refuse to install
# a supervisor that would page "liveness unknown" on every check.
# Read the two paths by key, never by sourcing: an EnvironmentFile is not shell,
# and an unquoted `&` in a webhook URL would execute.
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
liveness_bin="$(env_value WATCHDOG_LIVENESS_BIN)"
[[ -n "$liveness_bin" ]] || liveness_bin="$(dirname "$(env_value WATCHDOG_BIN)")/watchdog-liveness"
[[ -x "$liveness_bin" ]] || { echo "install-fusion-watchdog: watchdog-liveness not executable at $liveness_bin" >&2; exit 65; }
# fusion-watchdog-supervisor-failed-alert.sh (the OnFailure= pager) builds its
# JSON payload with jq; refuse to install a pager that cannot run.
command -v jq >/dev/null || { echo "install-fusion-watchdog: jq not found on PATH" >&2; exit 65; }
install -d -m 0755 /opt/fusion-stage
install -m 0755 "$REPO_ROOT/scripts/stage/fusion-watchdog-supervisor.sh" /opt/fusion-stage/fusion-watchdog-supervisor.sh
install -m 0755 "$REPO_ROOT/scripts/stage/fusion-watchdog-supervisor-failed-alert.sh" /opt/fusion-stage/fusion-watchdog-supervisor-failed-alert.sh
install -m 0644 "$REPO_ROOT/scripts/stage/fusion-watchdog.service" "$UNIT_DST"
install -m 0644 "$REPO_ROOT/scripts/stage/fusion-watchdog-failed.service" /etc/systemd/system/fusion-watchdog-failed.service
systemctl daemon-reload
systemctl enable fusion-watchdog.service
systemctl restart fusion-watchdog.service
systemctl is-active --quiet fusion-watchdog.service
