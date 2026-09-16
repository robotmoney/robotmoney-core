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
install -d -m 0755 /opt/fusion-stage
install -m 0755 "$REPO_ROOT/scripts/stage/fusion-watchdog-supervisor.sh" /opt/fusion-stage/fusion-watchdog-supervisor.sh
install -m 0644 "$REPO_ROOT/scripts/stage/fusion-watchdog.service" "$UNIT_DST"
systemctl daemon-reload
systemctl enable fusion-watchdog.service
systemctl restart fusion-watchdog.service
systemctl is-active --quiet fusion-watchdog.service
