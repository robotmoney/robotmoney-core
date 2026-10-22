#!/usr/bin/env bash
# check-skill-url-reachability.sh — assert every published raw SKILL.md URL
# that an external consumer hardcodes still returns HTTP 200.
#
# Canonical docs: plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md
# Filed by:       robotmoney-core#1199, amended by robotmoney-core#1888
#
# WHY THIS EXISTS
# robotmoney-frontend ships skill-URL constants as literal
# raw.githubusercontent.com URLs into this repo. Renaming or deleting a file in
# this repo is a breaking change to a shipped constant in another repo; this
# script is the only thing that notices.
#
# COMPATIBILITY MAPPING (selected in robotmoney-core#1888, swarm plugin retired)
# The swarm plugin is deleted, so core can no longer serve
#   plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
# (raw.githubusercontent.com cannot redirect). The decided mapping is:
#   - the LEGACY swarm URL is served by robotmoney-frontend, which maps it to
#     the content of the retained committee stub; core must answer 404 for the
#     legacy path (a 200 would mean the plugin crept back);
#   - the committee stub URL
#       plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md
#     stays served by core and must answer 200 (a 404 is a hard failure);
#   - when FRONTEND_SKILL_URL is set, that frontend URL must answer 200 with
#     bytes identical to the committee stub, which proves the mapping.
# Product-owner note: the frontend URL itself is owned by robotmoney-frontend,
# so CI leaves FRONTEND_SKILL_URL unset until that URL is recorded.
# The mapping is asserted without network by
# scripts/check-skill-url-reachability.test.sh (local HTTP fixture server).
#
# ONBOARDING IS DELIBERATELY NOT CHECKED HERE
# Core ships no onboarding skills (robotmoney-frontend owns them). Do not
# re-add those paths: see docs/technical/mcp-decision.md.
#
# LOUD FAILURE, NEVER SILENT SKIP
# curl is required and network access is required. If either is missing, or a
# path answers anything other than its expected status, the script exits non-zero — it never prints "skipping" and exits 0, because a
# reachability check that quietly no-ops is worse than no check at all.
#
# USAGE
#   scripts/check-skill-url-reachability.sh
#   REF=my-branch scripts/check-skill-url-reachability.sh
#   REPO=owner/name REF=<sha> scripts/check-skill-url-reachability.sh
#   RAW_BASE=http://127.0.0.1:PORT scripts/check-skill-url-reachability.sh  (tests)
#   FRONTEND_SKILL_URL=https://... scripts/check-skill-url-reachability.sh

set -euo pipefail

REPO="${REPO:-robotmoney/robotmoney-core}"
# dev is the ref the frontend's shipped constant points at. Override REF to
# validate a branch or commit before merge.
REF="${REF:-dev}"
BASE="${RAW_BASE:-https://raw.githubusercontent.com/${REPO}/${REF}}"
FRONTEND_SKILL_URL="${FRONTEND_SKILL_URL:-}"

COMMITTEE_STUB="plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md"
LEGACY_SWARM="plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md"

# "<expected status> <path>". See COMPATIBILITY MAPPING above.
SKILL_PATHS=(
  "200 $COMMITTEE_STUB"
  "404 $LEGACY_SWARM"
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

fetch_status() {
  # Prints the HTTP status, or 000 when curl itself fails.
  curl --silent --show-error --location \
       --output /dev/null \
       --write-out '%{http_code}' \
       --max-time 20 \
       --retry 3 --retry-delay 2 --retry-connrefused \
       "$1" || echo "000"
}

for entry in "${SKILL_PATHS[@]}"; do
  want="${entry%% *}"
  path="${entry#* }"
  url="$BASE/$path"
  CHECKED=$((CHECKED + 1))

  # --retry rides out transient hiccups. A real 404 is not retried.
  status=$(fetch_status "$url")

  if [[ "$status" == "$want" ]]; then
    echo "  $status OK   (expected $want) $url"
  else
    echo "  $status FAIL (expected $want) $url" >&2
    FAILED=$((FAILED + 1))
  fi
done

if [[ -n "$FRONTEND_SKILL_URL" ]]; then
  CHECKED=$((CHECKED + 1))
  stub_body=$(curl --silent --show-error --location --max-time 20 \
                   --retry 3 --retry-delay 2 --retry-connrefused \
                   --fail "$BASE/$COMMITTEE_STUB" || echo "__FETCH_FAILED__")
  front_body=$(curl --silent --show-error --location --max-time 20 \
                    --retry 3 --retry-delay 2 --retry-connrefused \
                    --fail "$FRONTEND_SKILL_URL" || echo "__FETCH_FAILED__")
  if [[ "$stub_body" != "__FETCH_FAILED__" && "$stub_body" == "$front_body" ]]; then
    echo "  200 OK   frontend legacy URL serves the committee stub: $FRONTEND_SKILL_URL"
  else
    echo "  FAIL frontend legacy URL does not serve the committee stub: $FRONTEND_SKILL_URL" >&2
    FAILED=$((FAILED + 1))
  fi
fi

echo ""
echo "SKILL_URLS_CHECKED=$CHECKED"
echo "SKILL_URLS_FAILED=$FAILED"

# A run that checked nothing is not a pass. Guard against an emptied list.
if [[ "$CHECKED" -eq 0 ]]; then
  echo "FATAL: zero URLs checked — SKILL_PATHS is empty. That is a false green." >&2
  exit 1
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FATAL: $FAILED of $CHECKED published skill URLs did not return its expected status." >&2
  echo "       A shipped robotmoney-frontend consumer may be broken right now." >&2
  echo "       Restore the committee stub or fix the frontend mapping." >&2
  exit 1
fi

echo "All $CHECKED published skill URLs returned their expected status."
