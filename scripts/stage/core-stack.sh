#!/usr/bin/env bash
# Shim. The stage verbs are Bun TypeScript: scripts/stage/core-stack.ts. No logic lives here.
# Callers that still say `core-stack.sh <noun> <verb>` keep working.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
exec "${BUN:-bun}" "$(cd "$(dirname "$0")" && pwd)/core-stack.ts" "$@"
