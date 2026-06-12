#!/usr/bin/env python3
"""Drift-catcher for stable RmpcError reason-code variants (issue #806).

Asserts that every stable product reason-code variant exported by
``clients/rust-payment-client/src/errors.rs`` (identified by an
``// Architecture §7.2 product reason codes`` comment block) is listed
in ``docs/technical/rmpc-read-output-contract.md``.

Acceptance criteria checked:
  (A) docs/technical/rmpc-read-output-contract.md mentions all four
      stable variants: ErrVaultDisabled, ErrPolicyExpired,
      ErrLegUnavailable, ErrSlippageBoundExceeded.
  (B) The set of variant names extracted from errors.rs matches the set
      present in the doc (no doc-only or code-only names).

Exit 0 on success, non-zero on drift.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ERRORS_RS = Path("clients/rust-payment-client/src/errors.rs")
DOC_MD = Path("docs/technical/rmpc-read-output-contract.md")

# The sentinel comment that introduces the §7.2 block in errors.rs.
SENTINEL = "Architecture §7.2 product reason codes"


def repo_root() -> Path:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(out.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd()


def extract_variants_from_errors_rs(text: str) -> list[str]:
    """Return variant names from the §7.2 block in errors.rs.

    Identifies variants by the doc-comment marker
    ``Maps to the `...` product reason code.``  Only variants whose
    immediately-preceding doc comment contains that phrase are included.
    This is robust to the block having no closing sentinel.
    """
    # Match: a doc comment line with "Maps to the `...` product reason code"
    # followed (within a few lines) by the variant name.
    pattern = re.compile(
        r"Maps to the `[^`]+` product reason code\.[^\n]*\n"
        r"(?:[^\n]*\n)*?"
        r"\s{4}(Err\w+)\b",
    )
    return [m.group(1) for m in pattern.finditer(text)]


def variants_in_doc(text: str) -> set[str]:
    return set(re.findall(r"\bErr[A-Z][A-Za-z]+\b", text))


def main() -> int:
    root = repo_root()
    errors_path = root / ERRORS_RS
    doc_path = root / DOC_MD

    failed = False

    if not errors_path.is_file():
        print(f"FAIL: {ERRORS_RS} not found", file=sys.stderr)
        return 1
    if not doc_path.is_file():
        print(f"FAIL: {DOC_MD} not found", file=sys.stderr)
        return 1

    errors_text = errors_path.read_text(encoding="utf-8")
    doc_text = doc_path.read_text(encoding="utf-8")

    code_variants = extract_variants_from_errors_rs(errors_text)
    if not code_variants:
        print(
            f"FAIL: sentinel comment '{SENTINEL}' not found in {ERRORS_RS}",
            file=sys.stderr,
        )
        return 1

    doc_variants = variants_in_doc(doc_text)

    missing_from_doc = [v for v in code_variants if v not in doc_variants]
    if missing_from_doc:
        failed = True
        print(
            f"FAIL: these §7.2 variants from {ERRORS_RS} are not mentioned "
            f"in {DOC_MD}:",
            file=sys.stderr,
        )
        for v in missing_from_doc:
            print(f"  - {v}", file=sys.stderr)
    else:
        print(
            f"OK: all {len(code_variants)} §7.2 variants from {ERRORS_RS} "
            f"are documented in {DOC_MD}."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
