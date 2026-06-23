#!/usr/bin/env bash
# Canonical: docs/code-review/external-scan-verification-20260619.md
# Feature work: issue #1040 (retire stale scan_residual_seams.rs scout modules)
#
# ============================================================================
# SEAM-MAP DRIFT GUARD (issue #1040 — present-tense-after-landing drift)
# ============================================================================
# The dev-scout seam-map modules (pub mod scan_residual_seams) document bugs
# that a later remediation phase fixes. Once the fixes land, the scout prose
# must be rewritten to past tense; if it still claims a bug is "still present
# at HEAD" or "hands off" in future tense to an already-merged issue, the
# module misleads any reader into believing the bug is unfixed.
#
# This is the exact drift that #1017/#1019 fixed for scan_remediation_seams.rs
# and that #1040 fixed for scan_residual_seams.rs. This guard fails (non-zero)
# if any scan_residual_seams.rs module reintroduces that stale wording, so the
# regression cannot silently reappear.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FILES=(
  services/watchdog/src/scan_residual_seams.rs
  services/explorer-indexer/src/scan_residual_seams.rs
  clients/rust-payment-client/src/scan_residual_seams.rs
)

status=0

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    # Retirement is allowed: a removed module cannot carry stale prose.
    continue
  fi
  if grep -n "still present at HEAD" "$f"; then
    echo "ERROR: $f still claims a residual bug is 'still present at HEAD' — the fix has landed; rewrite to past tense." >&2
    status=1
  fi
  if grep -nE "hands off to|owned by #102[1-4]" "$f"; then
    echo "ERROR: $f hands off in future tense to an already-merged issue (#1021-#1024) — rewrite to 'Resolved (#N)'." >&2
    status=1
  fi
done

if [[ "$status" -eq 0 ]]; then
  echo "OK: no scan_residual_seams.rs module carries stale present-tense-after-landing drift."
fi

exit "$status"
