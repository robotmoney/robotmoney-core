#!/usr/bin/env bash
# scripts/natspec/check.sh
#
# NatSpec coverage check for in-scope Solidity contracts.
#
# TOOL:      Custom Python-based static parser (no compilation required).
# THRESHOLD: 100% — every public/external function, event, error, and public
#            state variable in each in-scope file must have @notice.
#            Parameters and return values require @param / @return.
# IN-SCOPE:  Defined by NATSPEC_SCOPE below (relative to repo root).
# CONFIG:    This file is the single source of truth. Do not replicate the
#            scope list or threshold elsewhere.
#
# LOCAL USAGE:
#   bash scripts/natspec/check.sh
#   bash scripts/natspec/check.sh contracts/gateway/RobotMoneyGateway.sol
#
# CI USAGE (see .github/workflows/natspec-coverage.yml):
#   bash scripts/natspec/check.sh
#
# EXIT CODES:
#   0 — all in-scope files pass 100% NatSpec coverage.
#   1 — one or more files are missing required NatSpec tags; a per-file
#       report is printed to stdout.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---------------------------------------------------------------------------
# IN-SCOPE FILE SET — single source of truth
# ---------------------------------------------------------------------------
NATSPEC_SCOPE=(
  "contracts/gateway/RobotMoneyGateway.sol"
  "contracts/gateway/AccessRoles.sol"
  "contracts/gateway/MockVault.sol"
  "contracts/gateway/interfaces/IGateway.sol"
  "contracts/RobotMoneyVault.sol"
  "contracts/interfaces/IStrategyAdapter.sol"
  "contracts/adapters/AaveV3Adapter.sol"
  "contracts/adapters/CompoundV3Adapter.sol"
  "contracts/adapters/MorphoAdapter.sol"
  "contracts/script/Deploy.s.sol"
)

# ---------------------------------------------------------------------------
# Allow caller to pass explicit file(s) as positional args (for testing)
# ---------------------------------------------------------------------------
if [[ $# -gt 0 ]]; then
  NATSPEC_SCOPE=("$@")
fi

# ---------------------------------------------------------------------------
# Python NatSpec checker — inline, no external dependencies
# ---------------------------------------------------------------------------
CHECKER=$(cat <<'PYEOF'
#!/usr/bin/env python3
"""
Inline NatSpec coverage checker.

Rules (matching lintspec / Solidity docs guidance):
- contract/interface/library: must have @notice
- public/external function:   must have @notice; each named param → @param;
                               each named return var → @return (unnamed returns exempt).
- event:                       must have @notice; each param → @param.
- error (custom error):        must have @notice; each param → @param.
- public state variable:       must have @notice.

Exceptions:
- constructor: @notice is recommended but NOT enforced (Solidity style guide).
- Functions that carry @inheritdoc: fully exempt (inherits from interface).
- internal/private functions: not in scope.
- lib/ is never in scope (passed files are trusted).
"""

import re
import sys

def strip_sol_comments(text):
    """Remove // line comments and /* */ block comments (non-NatSpec)."""
    # Remove block comments that are NOT NatSpec (/** ... */ → keep as-is)
    # We only strip // comments that are NOT ///.
    result = []
    i = 0
    in_block = False
    in_natspec = False
    while i < len(text):
        if not in_block:
            if text[i:i+4] == '/**/' :  # empty block comment
                i += 4
                continue
            if text[i:i+3] == '/**':
                in_natspec = True
                in_block = True
                result.append(text[i:i+3])
                i += 3
                continue
            if text[i:i+2] == '/*':
                in_block = True
                in_natspec = False
                i += 2
                continue
            if text[i:i+3] == '///':
                # NatSpec line comment — keep
                result.append(text[i])
                i += 1
                continue
            if text[i:i+2] == '//':
                # Regular line comment — skip to end of line
                while i < len(text) and text[i] != '\n':
                    i += 1
                continue
            result.append(text[i])
            i += 1
        else:
            if text[i:i+2] == '*/':
                in_block = False
                if in_natspec:
                    result.append('*/')
                in_natspec = False
                i += 2
            else:
                if in_natspec:
                    result.append(text[i])
                i += 1
    return ''.join(result)


def extract_natspec_block(lines, func_line_idx):
    """
    Walk backwards from func_line_idx to collect the NatSpec block.
    Returns the combined NatSpec text.
    """
    nat = []
    idx = func_line_idx - 1
    # Skip blank lines between NatSpec and declaration
    while idx >= 0 and lines[idx].strip() == '':
        idx -= 1
    # Collect NatSpec lines going up
    in_block = False
    block_lines = []
    if idx >= 0 and lines[idx].strip() == '*/':
        # Block NatSpec (/** ... */)
        in_block = True
        block_lines.append(lines[idx])
        idx -= 1
        while idx >= 0:
            block_lines.append(lines[idx])
            if '/**' in lines[idx]:
                break
            idx -= 1
        nat = list(reversed(block_lines))
    else:
        # Line NatSpec (/// ...)
        while idx >= 0 and lines[idx].strip().startswith('///'):
            nat.insert(0, lines[idx])
            idx -= 1
    return '\n'.join(nat)


def has_tag(nat_text, tag):
    return bool(re.search(r'@' + re.escape(tag) + r'\b', nat_text))


def check_file(filepath):
    issues = []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
    except FileNotFoundError:
        issues.append(f"  FILE NOT FOUND: {filepath}")
        return issues

    lines = source.splitlines()

    # -----------------------------------------------------------------------
    # Contract / interface / library — must have @title and @notice
    # -----------------------------------------------------------------------
    for m in re.finditer(
        r'^\s*(abstract\s+)?(contract|interface|library)\s+(\w+)',
        source, re.MULTILINE
    ):
        line_idx = source[:m.start()].count('\n')
        nat = extract_natspec_block(lines, line_idx)
        if not has_tag(nat, 'notice') and not has_tag(nat, 'inheritdoc'):
            issues.append(
                f"  line {line_idx+1}: {m.group(2)} {m.group(3)} — missing @notice"
            )

    # -----------------------------------------------------------------------
    # Events — must have @notice; each param → @param
    # -----------------------------------------------------------------------
    for m in re.finditer(r'^\s*event\s+(\w+)\s*\(([^)]*)\)', source, re.MULTILINE):
        line_idx = source[:m.start()].count('\n')
        nat = extract_natspec_block(lines, line_idx)
        name = m.group(1)
        params_raw = m.group(2)
        if not has_tag(nat, 'notice') and not has_tag(nat, 'inheritdoc'):
            issues.append(f"  line {line_idx+1}: event {name} — missing @notice")
        # Check @param for each named parameter
        params = [p.strip() for p in params_raw.split(',') if p.strip()]
        for param in params:
            parts = param.split()
            # Last token that isn't 'indexed' is the name
            parts_filtered = [p for p in parts if p not in ('indexed',)]
            if len(parts_filtered) >= 2:
                pname = parts_filtered[-1]
                if pname and not re.search(r'@param\s+' + re.escape(pname), nat):
                    issues.append(
                        f"  line {line_idx+1}: event {name} — param '{pname}' missing @param"
                    )

    # -----------------------------------------------------------------------
    # Errors — must have @notice; each param → @param
    # -----------------------------------------------------------------------
    for m in re.finditer(r'^\s*error\s+(\w+)\s*\(([^)]*)\)', source, re.MULTILINE):
        line_idx = source[:m.start()].count('\n')
        nat = extract_natspec_block(lines, line_idx)
        name = m.group(1)
        params_raw = m.group(2)
        if not has_tag(nat, 'notice') and not has_tag(nat, 'inheritdoc'):
            issues.append(f"  line {line_idx+1}: error {name} — missing @notice")
        params = [p.strip() for p in params_raw.split(',') if p.strip()]
        for param in params:
            parts = param.split()
            if len(parts) >= 2:
                pname = parts[-1]
                if pname and not re.search(r'@param\s+' + re.escape(pname), nat):
                    issues.append(
                        f"  line {line_idx+1}: error {name} — param '{pname}' missing @param"
                    )

    # -----------------------------------------------------------------------
    # Public state variables — must have @notice
    # -----------------------------------------------------------------------
    # Match: [public] [constant|immutable] type name;  or mapping(...) public name;
    for m in re.finditer(
        r'^\s+(?:(?:\w+[\[\]]*\s+)+)?(?:public)\s+(?:(?:constant|immutable)\s+)?'
        r'(?:(?:\w+[\[\](<>)*, ]*)\s+)?(\w+)\s*(?:=|;)',
        source, re.MULTILINE
    ):
        line_idx = source[:m.start()].count('\n')
        nat = extract_natspec_block(lines, line_idx)
        varname = m.group(1)
        if not has_tag(nat, 'notice') and not has_tag(nat, 'inheritdoc'):
            issues.append(
                f"  line {line_idx+1}: public var '{varname}' — missing @notice"
            )

    # -----------------------------------------------------------------------
    # Public/external functions — must have @notice; @param per named param;
    # @return per named return var.
    # -----------------------------------------------------------------------
    # We match function signatures that appear before a '{' or ';'
    func_pat = re.compile(
        r'^\s*function\s+(\w+)\s*\(([^)]*)\)'
        r'(?:\s+(?:public|external|internal|private|virtual|override|pure|view|payable|'
        r'nonReentrant|onlyRole\([^)]*\)|onlyVault|whenNotPaused|\w+))*'
        r'(?:\s+returns\s*\(([^)]*)\))?'
        r'\s*(?:\{|;)',
        re.MULTILINE | re.DOTALL
    )
    for m in func_pat.finditer(source):
        # Determine visibility
        func_text = m.group(0)
        func_name = m.group(1)
        params_raw = m.group(2) or ''
        returns_raw = m.group(3) or ''

        # constructor is exempt
        if func_name == 'constructor':
            continue

        # Determine visibility from the full match text
        vis_match = re.search(r'\b(public|external|internal|private)\b', func_text)
        if not vis_match:
            # Default visibility in interfaces is external, skip if ambiguous
            # Check if we're in an interface by looking for surrounding context
            continue
        visibility = vis_match.group(1)
        if visibility in ('internal', 'private'):
            continue

        line_idx = source[:m.start()].count('\n')
        nat = extract_natspec_block(lines, line_idx)

        # @inheritdoc exempts entirely
        if has_tag(nat, 'inheritdoc'):
            continue

        if not has_tag(nat, 'notice'):
            issues.append(
                f"  line {line_idx+1}: function {func_name}() [{visibility}] — missing @notice"
            )

        # Check @param for each named parameter
        params = [p.strip() for p in params_raw.split(',') if p.strip()]
        for param in params:
            parts = param.split()
            # Skip type-only params (unnamed) — e.g. "uint256"
            if len(parts) >= 2:
                pname = parts[-1]
                # strip trailing comma, parens
                pname = pname.rstrip(',)')
                if pname and not re.search(r'@param\s+' + re.escape(pname), nat):
                    issues.append(
                        f"  line {line_idx+1}: function {func_name}() — param '{pname}' missing @param"
                    )

        # Check @return for each NAMED return variable
        returns = [r.strip() for r in returns_raw.split(',') if r.strip()]
        for ret in returns:
            parts = ret.split()
            if len(parts) >= 2:
                rname = parts[-1].rstrip(')')
                if rname and not re.search(r'@return\s+' + re.escape(rname), nat):
                    issues.append(
                        f"  line {line_idx+1}: function {func_name}() — return '{rname}' missing @return"
                    )

    return issues


def main():
    files = sys.argv[1:]
    if not files:
        print("Usage: check_natspec.py <file.sol> [file.sol ...]")
        sys.exit(1)

    total_issues = 0
    failed_files = 0
    for filepath in files:
        issues = check_file(filepath)
        if issues:
            print(f"\nFAIL  {filepath}")
            for iss in issues:
                print(iss)
            total_issues += len(issues)
            failed_files += 1
        else:
            print(f"OK    {filepath}")

    print()
    if total_issues > 0:
        print(f"NatSpec check FAILED: {total_issues} issue(s) in {failed_files} file(s).")
        sys.exit(1)
    else:
        print("NatSpec check PASSED: all in-scope files have complete NatSpec.")
        sys.exit(0)


if __name__ == '__main__':
    main()
PYEOF
)

# ---------------------------------------------------------------------------
# Write the checker to a temp file and run it
# ---------------------------------------------------------------------------
CHECKER_FILE="$(mktemp /tmp/natspec_check_XXXXXX.py)"
trap 'rm -f "$CHECKER_FILE"' EXIT
printf '%s\n' "$CHECKER" > "$CHECKER_FILE"

# Resolve files relative to repo root
RESOLVED=()
for f in "${NATSPEC_SCOPE[@]}"; do
  if [[ "$f" = /* ]]; then
    RESOLVED+=("$f")
  else
    RESOLVED+=("$REPO_ROOT/$f")
  fi
done

echo "=== NatSpec coverage check ==="
echo "Tool:      scripts/natspec/check.sh (inline Python parser)"
echo "Threshold: 100% public/external surface"
echo "Files:     ${#RESOLVED[@]}"
echo

python3 "$CHECKER_FILE" "${RESOLVED[@]}"
