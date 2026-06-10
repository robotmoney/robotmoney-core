#!/usr/bin/env bash
# Verifies the dapp emits the required Strict-Transport-Security header (issue #671).
#
# Canonical: docs/technical/security-model.md §TLS/cert mis-issuance —
# HSTS preload must be enabled on all dapp domains. The exact directive is:
#   Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
#
# This script builds the production bundle, serves it with `vite preview`,
# then asserts the `Strict-Transport-Security` response header is present and
# contains all three required tokens: max-age=31536000, includeSubDomains,
# and preload.
#
# Run from clients/dapp:  bash scripts/check-hsts.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${HSTS_PREVIEW_PORT:-4174}"
URL="http://localhost:${PORT}"

echo "[check-hsts] building production bundle…"
bun run build

echo "[check-hsts] starting vite preview on ${PORT}…"
bun run preview -- --host 127.0.0.1 --port "${PORT}" --strictPort &
PREVIEW_PID=$!
cleanup() { kill "${PREVIEW_PID}" 2>/dev/null || true; }
trap cleanup EXIT

# Wait for the server to accept connections (up to 30 s).
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${URL}"; then break; fi
  sleep 0.5
done

fail() { echo "[check-hsts] FAIL: $1" >&2; exit 1; }

echo "[check-hsts] checking Strict-Transport-Security response header…"
HEADER="$(curl -sI "${URL}" | grep -i 'strict-transport-security' || true)"
[ -n "${HEADER}" ] || fail "no Strict-Transport-Security response header"

echo "${HEADER}" | grep -qiE 'max-age\s*=\s*31536000' \
  || fail "header max-age is not 31536000; got: ${HEADER}"

echo "${HEADER}" | grep -qi 'includeSubDomains' \
  || fail "header missing includeSubDomains; got: ${HEADER}"

echo "${HEADER}" | grep -qi 'preload' \
  || fail "header missing preload; got: ${HEADER}"

echo "[check-hsts] header OK: ${HEADER}"
echo "[check-hsts] PASS"
