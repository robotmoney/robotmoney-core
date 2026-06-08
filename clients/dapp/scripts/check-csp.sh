#!/usr/bin/env bash
# Verifies the dapp emits a strict Content-Security-Policy (issue #665).
#
# Canonical: docs/implementation-plan.md "Backend and dapp hardening".
#
# Builds the production bundle, serves it with `vite preview`, then asserts the
# `Content-Security-Policy` response header is present and contains `script-src`
# but neither `unsafe-inline` nor `unsafe-eval`. The same policy is also baked
# into index.html as a <meta http-equiv> tag (checked here too).
#
# Run from clients/dapp:  bash scripts/check-csp.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${CSP_PREVIEW_PORT:-4173}"
URL="http://localhost:${PORT}"

echo "[check-csp] building production bundle…"
bun run build

echo "[check-csp] starting vite preview on ${PORT}…"
bun run preview -- --host 127.0.0.1 --port "${PORT}" --strictPort &
PREVIEW_PID=$!
cleanup() { kill "${PREVIEW_PID}" 2>/dev/null || true; }
trap cleanup EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${URL}"; then break; fi
  sleep 0.5
done

fail() { echo "[check-csp] FAIL: $1" >&2; exit 1; }

echo "[check-csp] checking response header…"
HEADER="$(curl -sI "${URL}" | grep -i 'content-security-policy' || true)"
[ -n "${HEADER}" ] || fail "no Content-Security-Policy response header"
echo "${HEADER}" | grep -qi 'script-src' || fail "header missing script-src"
# unsafe-eval is forbidden in every directive.
if echo "${HEADER}" | grep -qi 'unsafe-eval'; then fail "header contains unsafe-eval"; fi
# unsafe-inline is forbidden specifically for script-src (style-src may keep it
# for Tailwind / Google Fonts — that does not relax the script policy).
SCRIPT_SRC="$(echo "${HEADER}" | tr ';' '\n' | grep -i 'script-src' || true)"
if echo "${SCRIPT_SRC}" | grep -qi 'unsafe-inline'; then fail "script-src contains unsafe-inline"; fi
echo "[check-csp] header OK: ${HEADER}"

echo "[check-csp] checking baked-in meta tag…"
BODY="$(curl -s "${URL}")"
echo "${BODY}" | grep -qi 'http-equiv="Content-Security-Policy"' \
  || fail "index.html missing CSP meta tag"

echo "[check-csp] PASS"
