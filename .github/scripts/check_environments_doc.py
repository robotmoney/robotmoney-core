#!/usr/bin/env python3
"""Issue #380 — environments.md integrity checks.

Two invariants are enforced:

1. Script-path check: every `bash <path>` call inside a fenced code block in
   docs/development/environments.md must point to a file that exists in the repository.

2. Env-var coverage check: every environment-variable name that appears in the
   Required-env-vars tables of docs/development/environments.md must have a corresponding
   definition in at least one of the canonical config sources:
   - clients/dapp/.env.example
   - testing/ethereum-testnet/config/docker-compose.dapp.yaml

   Vars that are intentionally out-of-scope for .env.example / compose (e.g.
   low-level Geth port overrides, forge/rmpc runtime vars that live nowhere in
   the dapp config) are listed in KNOWN_INFRA_VARS and are skipped.

Wired into .github/workflows/suite-13-doc-checks.yml.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENVIRONMENTS_MD = REPO_ROOT / "docs" / "development" / "environments.md"
DAPP_ENV_EXAMPLE = REPO_ROOT / "clients" / "dapp" / ".env.example"
DAPP_COMPOSE = REPO_ROOT / "testing" / "ethereum-testnet" / "config" / "docker-compose.dapp.yaml"

# Vars that are Geth/CL node / forge / rmpc runtime configuration — they are
# not expected to appear in the dapp .env.example or the dapp compose file.
KNOWN_INFRA_VARS: frozenset[str] = frozenset(
    {
        # Geth / Lighthouse node overrides
        "GETH_RPC_PORT",
        "GETH_WS_PORT",
        "GETH_AUTHRPC_PORT",
        "GENESIS_TIMESTAMP",
        "SMOKE_GENESIS_ALLOC_FILE",
        # Fork / Anvil test-only vars
        "RMPC_FORK_RPC_URL",
        "RMPC_FORK_BLOCK",
        # rmpc client runtime vars (not dapp)
        "RMPC_CONFIG",
        "RMPC_ALLOW_MAINNET",
        "RMPC_KEYSTORE_PASSPHRASE",
        "RMPC_STATE_DIR",
        "RMPC_NETWORK",
        "RMPC_MONITOR_COMMAND",
    }
)


def _read_text(path: Path) -> str:
    if not path.is_file():
        print(f"ERROR: required file missing: {path.relative_to(REPO_ROOT)}", file=sys.stderr)
        sys.exit(2)
    return path.read_text(encoding="utf-8")


def check_script_paths(md_text: str) -> list[str]:
    """Return error strings for every `bash <path>` that points to a missing file."""
    errors: list[str] = []
    # Match lines of the form:  bash <relative-path>  (optional leading whitespace / args)
    # Only look inside fenced code blocks to avoid false positives in prose.
    in_block = False
    for lineno, line in enumerate(md_text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_block = not in_block
            continue
        if not in_block:
            continue
        # Capture:  bash path/to/script.sh [optional-extra]
        m = re.match(r"bash\s+([\w./\-]+\.sh)", stripped)
        if not m:
            continue
        script_rel = m.group(1)
        script_path = REPO_ROOT / script_rel
        if not script_path.is_file():
            errors.append(
                f"line {lineno}: script referenced in environments.md does not exist: {script_rel}"
            )
    return errors


def _collect_env_var_names_from_tables(md_text: str) -> list[tuple[int, str]]:
    """Return (lineno, var_name) for every var in a Required-env-vars table row.

    Table rows look like:  | `VAR_NAME` | ... | ... |
    or simply:             | VAR_NAME | ... | ... |
    """
    results: list[tuple[int, str]] = []
    in_required_section = False
    var_pattern = re.compile(r"^\|\s*`?([A-Z][A-Z0-9_]+)`?\s*\|")

    for lineno, line in enumerate(md_text.splitlines(), start=1):
        # Enter a "Required env vars" subsection (any heading level).
        if re.search(r"(?i)required env var", line):
            in_required_section = True
            continue
        # Any heading ends the required-env-vars section.
        if line.startswith("#") and in_required_section:
            in_required_section = False
            continue
        if not in_required_section:
            continue
        m = var_pattern.match(line)
        if m:
            results.append((lineno, m.group(1)))
    return results


def _defined_var_names(file_text: str) -> frozenset[str]:
    """Extract every VAR_NAME that appears as a key in an .env or YAML compose file."""
    names: set[str] = set()
    # .env style:  VAR_NAME=...
    for m in re.finditer(r"^([A-Z][A-Z0-9_]+)\s*=", file_text, re.MULTILINE):
        names.add(m.group(1))
    # YAML compose style:  VAR_NAME: ... or  VAR_NAME:
    for m in re.finditer(r"^\s+([A-Z][A-Z0-9_]+)\s*:", file_text, re.MULTILINE):
        names.add(m.group(1))
    # Compose shell substitution:  ${VAR_NAME:-...} or ${VAR_NAME:?...}
    for m in re.finditer(r"\$\{([A-Z][A-Z0-9_]+)[:\}]", file_text):
        names.add(m.group(1))
    return frozenset(names)


def check_env_var_coverage(md_text: str) -> list[str]:
    """Return error strings for every env var not found in the canonical config sources."""
    env_text = _read_text(DAPP_ENV_EXAMPLE)
    compose_text = _read_text(DAPP_COMPOSE)
    defined = _defined_var_names(env_text) | _defined_var_names(compose_text)

    errors: list[str] = []
    for lineno, var in _collect_env_var_names_from_tables(md_text):
        if var in KNOWN_INFRA_VARS:
            continue
        if var not in defined:
            errors.append(
                f"line {lineno}: env var '{var}' listed in environments.md but not found in "
                f"clients/dapp/.env.example or testing/ethereum-testnet/config/docker-compose.dapp.yaml"
            )
    return errors


def main() -> int:
    md_text = _read_text(ENVIRONMENTS_MD)

    all_errors: list[str] = []
    all_errors.extend(check_script_paths(md_text))
    all_errors.extend(check_env_var_coverage(md_text))

    if all_errors:
        for err in all_errors:
            print(f"ERROR: {err}", file=sys.stderr)
        print(
            "\ndocs/development/environments.md integrity check failed.\n"
            "- For script paths: ensure the bash script exists at the listed path.\n"
            "- For env vars: add the var to clients/dapp/.env.example or\n"
            "  testing/ethereum-testnet/config/docker-compose.dapp.yaml,\n"
            "  or add it to KNOWN_INFRA_VARS in .github/scripts/check_environments_doc.py\n"
            "  if it is intentionally out-of-scope for those files.",
            file=sys.stderr,
        )
        return 1

    print("docs/development/environments.md: all script paths and env-var coverage checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
