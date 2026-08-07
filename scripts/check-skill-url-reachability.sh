#!/usr/bin/env bash
# check-skill-url-reachability.sh — assert every published raw SKILL.md URL
# that an external consumer hardcodes still returns HTTP 200.
#
# Canonical docs: plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
# Filed by:       robotmoney-core#1199
#
# WHY THIS EXISTS
# robotmoney-frontend ships skill-URL constants as literal
# raw.githubusercontent.com URLs into this repo. Nothing in either repo's CI
# ever fetched them, so when this repo's plugin tree was renamed, an operator
# following a stale URL got a 404 and no build ever went red. Renaming a
# directory in this repo is a breaking change to a shipped constant in another
# repo; this script is the only thing that notices.
#
# WHAT IT CHECKS
# Each path in SKILL_PATHS below, fetched at $REF (default: dev), must return
# 200. That includes the deprecation compat stub at the OLD committee path
# (plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md):
# consumers shipped that URL too, and a stub that 404s is exactly the bug this
# check exists to catch.
#
# ONBOARDING IS DELIBERATELY NOT CHECKED HERE
# robotmoney-swarm/skills/swarm-onboarding/SKILL.md and
# robotmoney-committee/skills/committee-onboarding/SKILL.md used to be in
# SKILL_PATHS below. Both were removed from this repo outright: onboarding is
# no longer core's concern. robotmoney-frontend's own copy
# (frontend/public/skills/swarm-onboarding/SKILL.md, served from
# https://robotmoney.net/skills/swarm-onboarding/SKILL.md) is now the single
# source of truth, and core deliberately ships no compat stub pointing at it —
# an old cached URL into core's onboarding paths should 404, not redirect. Do
# not re-add those two paths here: checking their reachability would now be
# meaningless at best (core never serves them again) and actively wrong at
# worst (asserting they return 200 would contradict the deletion). See
# docs/technical/mcp-decision.md for the reasoning.
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
#   1. the live vote-submission skill
#   2. the deprecation compat stub at the pre-#1199 committee path
SKILL_PATHS=(
  "plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md"
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
  echo "       A shipped robotmoney-frontend consumer is 404ing right now." >&2
  echo "       Restore the path or add a compat stub." >&2
  exit 1
fi

echo "All $CHECKED published skill URLs return 200."
