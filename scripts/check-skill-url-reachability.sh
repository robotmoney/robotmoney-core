#!/usr/bin/env bash
# check-skill-url-reachability.sh — assert every published raw SKILL.md URL
# that an external consumer hardcodes still returns HTTP 200.
#
# Canonical docs: plugins/robotmoney-swarm/skills/swarm-onboarding/SKILL.md
# Filed by:       robotmoney-core#1199
#
# WHY THIS EXISTS
# robotmoney-frontend ships SWARM_ONBOARDING_SKILL_URL as a literal
# raw.githubusercontent.com URL. Nothing in either repo's CI ever fetched it, so
# when this repo's plugin tree was named robotmoney-committee and the frontend
# shipped the robotmoney-swarm path, every operator who clicked "onboard" got a
# 404 and no build ever went red. Renaming a directory in this repo is a
# breaking change to a shipped constant in another repo; this script is the only
# thing that notices.
#
# WHAT IT CHECKS
# Each path in SKILL_PATHS below, fetched at $REF (default: dev), must return
# 200. That includes the deprecation compat stubs at the OLD committee paths:
# consumers shipped those URLs too, and a stub that 404s is exactly the bug this
# check exists to catch.
#
# LOUD FAILURE, NEVER SILENT SKIP
# curl is required and network access is required. If either is missing the
# script exits non-zero — it never prints "skipping" and exits 0, because a
# reachability check that quietly no-ops is worse than no check at all.
#
# USAGE
#   scripts/check-skill-url-reachability.sh
#   REF=my-branch scripts/check-skill-url-reachability.sh
#   REPO=owner/name REF=<sha> scripts/check-skill-url-reachability.sh

set -euo pipefail

REPO="${REPO:-robotmoney/robotmoney-core}"
# dev is the ref the frontend's shipped constant points at. Override REF to
# validate a branch or commit before merge.
REF="${REF:-dev}"
BASE="https://raw.githubusercontent.com/${REPO}/${REF}"

# Every raw path an external consumer may have hardcoded.
#   1. the live onboarding skill — the exact constant robotmoney-frontend ships
#   2. the live vote-submission skill
#   3-4. the deprecation compat stubs at the pre-#1199 paths
SKILL_PATHS=(
  "plugins/robotmoney-swarm/skills/swarm-onboarding/SKILL.md"
  "plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md"
  "plugins/robotmoney-committee/skills/committee-onboarding/SKILL.md"
  "plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md"
)

if ! command -v curl &>/dev/null; then
  echo "FATAL: curl is not installed; cannot verify reachability." >&2
  echo "       Refusing to skip — install curl in the job." >&2
  exit 1
fi

echo "=== skill URL reachability ==="
echo "repo: $REPO"
echo "ref:  $REF"
echo ""

CHECKED=0
FAILED=0

for path in "${SKILL_PATHS[@]}"; do
  url="$BASE/$path"
  CHECKED=$((CHECKED + 1))

  # --retry rides out transient raw.githubusercontent hiccups so a flake does
  # not read as a broken URL. A real 404 is not retried.
  status=$(curl --silent --show-error --location \
                --output /dev/null \
                --write-out '%{http_code}' \
                --max-time 20 \
                --retry 3 --retry-delay 2 --retry-connrefused \
                "$url" || echo "000")

  if [[ "$status" == "200" ]]; then
    echo "  200 OK   $url"
  else
    echo "  $status FAIL $url" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "SKILL_URLS_CHECKED=$CHECKED"
echo "SKILL_URLS_FAILED=$FAILED"

# A run that checked nothing is not a pass. Guard against an emptied list.
if [[ "$CHECKED" -eq 0 ]]; then
  echo "FATAL: zero URLs checked — SKILL_PATHS is empty. That is a false green." >&2
  exit 1
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FATAL: $FAILED of $CHECKED published skill URLs did not return 200." >&2
  echo "       A shipped consumer (robotmoney-frontend SWARM_ONBOARDING_SKILL_URL)" >&2
  echo "       is 404ing right now. Restore the path or add a compat stub." >&2
  exit 1
fi

echo "All $CHECKED published skill URLs return 200."
