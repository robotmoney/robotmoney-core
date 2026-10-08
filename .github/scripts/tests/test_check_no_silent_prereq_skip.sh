#!/usr/bin/env bash
# Self-test for check_no_silent_prereq_skip.sh: clean tree passes, each skip shape fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/../check_no_silent_prereq_skip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '#[test]\nfn t() {\n    require_prereqs("t");\n}\n' > "$tmp/ok.rs"
bash "$guard" "$tmp" >/dev/null || { echo "FAIL: clean file rejected"; exit 1; }

printf 'fn skip_if_no_prereqs(n: &str) -> bool { true }\n' > "$tmp/bad.rs"
if bash "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: helper definition accepted"; exit 1; fi

printf '#[test]\nfn t() {\n    if !prerequisites_available() {\n        return;\n    }\n}\n' > "$tmp/bad.rs"
if bash "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: inline early return accepted"; exit 1; fi

bash "$guard" >/dev/null || { echo "FAIL: real tree rejected"; exit 1; }
echo "ok: check_no_silent_prereq_skip self-test"
