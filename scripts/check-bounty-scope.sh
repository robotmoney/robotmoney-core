#!/usr/bin/env bash
# Canonical: docs/bug-bounty.md and docs/technical/security-model.md section 14.
#
# Fails when committed deployment artifacts are more than 72 hours newer than
# docs/bug-bounty.md. This keeps the public bounty scope aligned with newly
# deployed contracts before launch and after every deployment update.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$REPO_ROOT/docs/bug-bounty.md"
DEPLOYMENTS_DIR="$REPO_ROOT/deployments"
MAX_AGE_SECONDS=$((72 * 60 * 60))

last_changed_ts() {
  local path="$1"
  local rel="${path#$REPO_ROOT/}"
  local ts=""

  ts="$(git -C "$REPO_ROOT" log -1 --format=%ct -- "$rel" 2>/dev/null || true)"
  if [ -n "$ts" ]; then
    printf '%s\n' "$ts"
    return 0
  fi

  # Local self-tests may use untracked temporary files.
  stat -c %Y "$path"
}

if [ ! -f "$DOC" ]; then
  echo "ERROR: missing $DOC" >&2
  exit 1
fi

if [ ! -d "$DEPLOYMENTS_DIR" ]; then
  echo "[check-bounty-scope] OK: no deployments/ directory is committed yet"
  exit 0
fi

newest_deployment=""
newest_deployment_ts=0
while IFS= read -r -d '' file; do
  case "$(basename "$file")" in
    .gitkeep|README.md)
      continue
      ;;
  esac

  file_ts="$(last_changed_ts "$file")"
  if [ -z "$newest_deployment" ] || [ "$file_ts" -gt "$newest_deployment_ts" ]; then
    newest_deployment="$file"
    newest_deployment_ts="$file_ts"
  fi
done < <(find "$DEPLOYMENTS_DIR" -type f -print0)

if [ -z "$newest_deployment" ]; then
  echo "[check-bounty-scope] OK: deployments/ contains no deployment manifests"
  exit 0
fi

doc_ts="$(last_changed_ts "$DOC")"
deployment_ts="$newest_deployment_ts"

if [ "$doc_ts" -ge "$deployment_ts" ]; then
  echo "[check-bounty-scope] OK: docs/bug-bounty.md is newer than deployment manifests"
  exit 0
fi

age_seconds=$((deployment_ts - doc_ts))
if [ "$age_seconds" -le "$MAX_AGE_SECONDS" ]; then
  echo "[check-bounty-scope] OK: docs/bug-bounty.md is within 72 hours of newest deployment manifest"
  exit 0
fi

echo "ERROR: docs/bug-bounty.md is more than 72 hours older than $newest_deployment" >&2
echo "Update docs/bug-bounty.md with the new deployment scope and exclusions." >&2
exit 1
