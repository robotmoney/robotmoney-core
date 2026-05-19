#!/usr/bin/env python3
"""Cross-system feature flag consistency check.

Canonical source: config/feature-flags.json

Reads the registry JSON and verifies that every remaining cross-system surface
(Solidity, Rust) declares exactly the same flag IDs and names. The dapp
TypeScript bitmap mirror was removed in issue #433; when absent, this script
skips that former surface instead of requiring dapp runtime gates to exist.

Exits 0 when all surfaces are consistent; exits 1 with a diff on any mismatch.

Usage (from repo root):
    python3 .github/scripts/check_feature_flag_consistency.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

REGISTRY_PATH = REPO_ROOT / "config" / "feature-flags.json"
SOLIDITY_PATH = REPO_ROOT / "contracts" / "FeatureFlags.sol"
TYPESCRIPT_PATH = REPO_ROOT / "clients" / "dapp" / "src" / "feature-flags.ts"
RUST_PATH = REPO_ROOT / "services" / "explorer-indexer" / "src" / "feature_flags.rs"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_registry() -> list[dict]:
    with REGISTRY_PATH.open() as fh:
        data = json.load(fh)
    return data["flags"]


def extract_solidity_constants(path: Path) -> dict[str, int]:
    """Parse `uint8 public constant NAME = N;` from FeatureFlags.sol."""
    pattern = re.compile(
        r"uint8\s+public\s+constant\s+(\w+)\s*=\s*(\d+)\s*;"
    )
    result: dict[str, int] = {}
    text = path.read_text()
    for match in pattern.finditer(text):
        result[match.group(1)] = int(match.group(2))
    return result


def extract_typescript_constants(path: Path) -> dict[str, int]:
    """Parse `export const NAME = N as const;` from feature-flags.ts."""
    pattern = re.compile(
        r"export\s+const\s+(\w+)\s*=\s*(\d+)\s+as\s+const\s*;"
    )
    result: dict[str, int] = {}
    text = path.read_text()
    for match in pattern.finditer(text):
        result[match.group(1)] = int(match.group(2))
    return result


def extract_rust_constants(path: Path) -> dict[str, int]:
    """Parse `pub const NAME: u8 = N;` from feature_flags.rs."""
    pattern = re.compile(
        r"pub\s+const\s+(\w+)\s*:\s*u8\s*=\s*(\d+)\s*;"
    )
    result: dict[str, int] = {}
    text = path.read_text()
    for match in pattern.finditer(text):
        result[match.group(1)] = int(match.group(2))
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    errors: list[str] = []

    # Load the canonical registry.
    registry = load_registry()
    registry_by_name = {f["name"]: f["id"] for f in registry}

    # Check Solidity.
    sol = extract_solidity_constants(SOLIDITY_PATH)
    for name, expected_id in registry_by_name.items():
        if name not in sol:
            errors.append(
                f"[Solidity] Missing constant for flag '{name}' (id={expected_id})"
            )
        elif sol[name] != expected_id:
            errors.append(
                f"[Solidity] Flag '{name}': expected id={expected_id}, got id={sol[name]}"
            )
    for name in sol:
        if name not in registry_by_name:
            errors.append(
                f"[Solidity] Undeclared constant '{name}' (not in registry)"
            )

    checked_systems = 2

    # Check TypeScript only if the dapp-side bitmap mirror exists. Issue #433
    # intentionally removed clients/dapp/src/feature-flags.ts so portfolio UI
    # surfaces are no longer gated by VITE_FEATURE_FLAGS.
    if TYPESCRIPT_PATH.exists():
        checked_systems += 1
        ts = extract_typescript_constants(TYPESCRIPT_PATH)
        for name, expected_id in registry_by_name.items():
            if name not in ts:
                errors.append(
                    f"[TypeScript] Missing constant for flag '{name}' (id={expected_id})"
                )
            elif ts[name] != expected_id:
                errors.append(
                    f"[TypeScript] Flag '{name}': expected id={expected_id}, got id={ts[name]}"
                )
        for name in ts:
            if name not in registry_by_name:
                errors.append(
                    f"[TypeScript] Undeclared constant '{name}' (not in registry)"
                )

    # Check Rust.
    rust = extract_rust_constants(RUST_PATH)
    for name, expected_id in registry_by_name.items():
        if name not in rust:
            errors.append(
                f"[Rust] Missing constant for flag '{name}' (id={expected_id})"
            )
        elif rust[name] != expected_id:
            errors.append(
                f"[Rust] Flag '{name}': expected id={expected_id}, got id={rust[name]}"
            )
    for name in rust:
        if name not in registry_by_name:
            errors.append(
                f"[Rust] Undeclared constant '{name}' (not in registry)"
            )

    if errors:
        print("Feature flag consistency check FAILED:")
        for err in errors:
            print(f"  {err}")
        return 1

    print(
        f"Feature flag consistency check passed "
        f"({len(registry)} flags × {checked_systems} systems)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
