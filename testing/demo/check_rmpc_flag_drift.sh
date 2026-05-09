#!/usr/bin/env bash
# Canonical: docs/technical/demo-runbook.md §6 (open follow-ups / drift check)
# Implements: docs/implementation-plan.md §13 — Phase 7 acceptance criterion 6.
# Issue: #151.
#
# Parity / drift check: fail if demo-runbook.md, skill reference examples,
# or testing/demo/demo.sh cite rmpc flags that do not appear in `rmpc --help`.
#
# Usage:
#   testing/demo/check_rmpc_flag_drift.sh [--rmpc-bin <path>]
#
# The check works in two passes:
#   1. Build a canonical flag set from `rmpc --help` output (all long flags).
#   2. Scan the target documents for rmpc invocations that use --<flag> tokens
#      and verify each token is present in the canonical set.
#
# Exit codes:
#   0  — no drift detected.
#   1  — one or more stale flags found; report is written to stderr.
#   3  — required tooling missing (rmpc binary not found or --help fails).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Prefer the workspace-root target (produced by cargo build in the workspace
# root or via --manifest-path on a member crate).  Fall back to the
# package-local target for standalone (non-workspace) builds.
if [[ -x "${REPO_ROOT}/target/debug/rmpc" ]]; then
    RMPC_BIN="${REPO_ROOT}/target/debug/rmpc"
else
    RMPC_BIN="${REPO_ROOT}/clients/rust-payment-client/target/debug/rmpc"
fi

# Allow caller to override the rmpc binary path.
while [[ $# -gt 0 ]]; do
    case "$1" in
        --rmpc-bin) RMPC_BIN="$2"; shift 2 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

# ----- documents to scan --------------------------------------------------
# Maps a label to the file path checked for stale rmpc flag usage.
declare -A SCAN_TARGETS
SCAN_TARGETS=(
    ["demo-runbook.md"]="${REPO_ROOT}/docs/technical/demo-runbook.md"
    ["examples.md"]="${REPO_ROOT}/plugins/robotmoney-cli/skills/robotmoney-cli/references/examples.md"
    ["demo.sh"]="${REPO_ROOT}/testing/demo/demo.sh"
    ["test_failure_cases.sh"]="${REPO_ROOT}/testing/demo/test_failure_cases.sh"
)

# ----- build canonical flag set from rmpc --help --------------------------
if [[ ! -x "$RMPC_BIN" ]]; then
    echo "[drift-check] rmpc binary not found or not executable: ${RMPC_BIN}" >&2
    echo "[drift-check] build rmpc first: cargo build --manifest-path clients/rust-payment-client/Cargo.toml --bin rmpc" >&2
    exit 3
fi

# Collect all --<flag> tokens emitted by `rmpc --help` and each
# subcommand's --help output.  Flags are normalized to lowercase with
# leading `--` stripped.
CANONICAL_FLAGS_FILE="$(mktemp)"
cleanup() { rm -f "$CANONICAL_FLAGS_FILE"; }
trap cleanup EXIT

collect_flags_from_help() {
    local help_text="$1"
    # Extract --<word>[-<word>]* tokens; strip leading dashes.
    echo "$help_text" | grep -oE '\-\-[a-z][a-z0-9-]+' | sed 's/^--//' >> "$CANONICAL_FLAGS_FILE" || true
}

# Top-level help.
TOP_HELP="$("$RMPC_BIN" --help 2>&1 || true)"
collect_flags_from_help "$TOP_HELP"

# Subcommand help (extract subcommand names from top-level help, then query each).
SUBCOMMANDS="$(echo "$TOP_HELP" | grep -E '^\s+(deposit|status|self-check|get-[a-z-]+)' | awk '{print $1}' || true)"
for subcmd in $SUBCOMMANDS; do
    SUB_HELP="$("$RMPC_BIN" "$subcmd" --help 2>&1 || true)"
    collect_flags_from_help "$SUB_HELP"
done

# Deduplicate.
sort -u "$CANONICAL_FLAGS_FILE" -o "$CANONICAL_FLAGS_FILE"
FLAG_COUNT="$(wc -l < "$CANONICAL_FLAGS_FILE" | tr -d ' ')"
echo "[drift-check] canonical flag set: ${FLAG_COUNT} flags from rmpc --help" >&2

if [[ "$FLAG_COUNT" -eq 0 ]]; then
    echo "[drift-check] WARN: no flags extracted from rmpc --help; check binary output" >&2
fi

# ----- scan documents for rmpc flag usage ---------------------------------
# We look for lines that contain `rmpc ` (the binary name) followed by
# long flags. We extract each --<flag> token from those lines and check
# against the canonical set.
# Flags that are universal (--config, --pretty, --help, --version) are
# in the canonical set already, so no special-casing is needed.

fail_count=0
declare -A reported  # avoid duplicate reports per (file, flag)

for label in "${!SCAN_TARGETS[@]}"; do
    file="${SCAN_TARGETS[$label]}"
    if [[ ! -f "$file" ]]; then
        echo "[drift-check] SKIP: file not found: ${file}" >&2
        continue
    fi

    # Extract lines that reference `rmpc ` (as invocation context).
    while IFS= read -r line; do
        # Extract all --<flag> tokens from the line.
        while IFS= read -r flag_token; do
            [[ -z "$flag_token" ]] && continue
            key="${label}:${flag_token}"
            if [[ -n "${reported[$key]:-}" ]]; then continue; fi
            if ! grep -qx "$flag_token" "$CANONICAL_FLAGS_FILE" 2>/dev/null; then
                echo "[drift-check] STALE FLAG: '${flag_token}' in ${label} (not in rmpc --help)" >&2
                reported[$key]=1
                fail_count=$(( fail_count + 1 ))
            fi
        done < <(echo "$line" | grep -oE '\-\-[a-z][a-z0-9-]+' | sed 's/^--//' || true)
    done < <(grep -E '\brmpc\b' "$file" 2>/dev/null | grep -vE '(^\s*#|--bin\s+rmpc|\bcargo\b)' || true)
done

echo >&2
if [[ $fail_count -gt 0 ]]; then
    echo "[drift-check] FAILED: ${fail_count} stale flag(s) detected. Update docs/demo to use current rmpc flags." >&2
    exit 1
fi

echo "[drift-check] OK: no stale rmpc flags detected in scanned documents." >&2
exit 0
