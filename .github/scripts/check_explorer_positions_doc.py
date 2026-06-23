#!/usr/bin/env python3
"""Issue #1041 — explorer-api positions response-body doc/model drift-catcher.

`GET /v1/accounts/:address/positions` serializes the vault-address field as
`vault` (clients/explorer-api/src/model.rs `VaultPosition.vault`). The dapp
once read a different, client-side field name straight off the API body, which
the API never emits — the root cause of the #1038 `PositionSelector` crash. This
check pins the documented contract to the model so the two cannot drift:

  (A) docs/explorer-api.md documents the positions endpoint with a JSON
      `"vault"` key inside its `GET /v1/accounts/:address/positions` section.

  (B) docs/explorer-api.md does NOT describe the positions API field as
      `vault_addr` anywhere (that token is the dapp's internal client field,
      never a wire field — documenting it as the API field reintroduces the
      #1038 ambiguity).

  (C) clients/explorer-api/src/model.rs `VaultPosition` actually serializes a
      `vault` field (and not a `vault_addr` field), so the documented name
      matches the source of truth.

Exits 0 on success, non-zero on any drift, with a human-readable diagnosis.
No network access required. Wired into
.github/workflows/suite-13-doc-checks.yml.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

DOC_PATH = Path("docs/explorer-api.md")
MODEL_PATH = Path("clients/explorer-api/src/model.rs")

POSITIONS_HEADING = "### `GET /v1/accounts/:address/positions`"


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


def positions_doc_section(doc_text: str) -> str | None:
    """Return the body of the positions endpoint section, or None.

    The section starts at POSITIONS_HEADING and ends at the next `## ` or
    `### ` heading (or end of file).
    """
    start = doc_text.find(POSITIONS_HEADING)
    if start < 0:
        return None
    rest = doc_text[start + len(POSITIONS_HEADING):]
    nxt = re.search(r"^#{2,3}\s", rest, re.MULTILINE)
    if nxt:
        rest = rest[: nxt.start()]
    return rest


def vault_position_struct(model_text: str) -> str | None:
    """Return the body of the `pub struct VaultPosition { ... }` block."""
    m = re.search(
        r"pub struct VaultPosition\s*\{(.*?)\}",
        model_text,
        re.DOTALL,
    )
    return m.group(1) if m else None


def serde_fields(struct_body: str) -> list[str]:
    """Return the serialized field names of a serde struct body.

    Honours `#[serde(rename = "...")]` on the immediately preceding line;
    otherwise uses the Rust field identifier (no rename helpers are used on
    VaultPosition, so the identifier is the wire name).
    """
    fields: list[str] = []
    pending_rename: str | None = None
    for line in struct_body.splitlines():
        s = line.strip()
        rn = re.search(r'#\[serde\(rename\s*=\s*"([^"]+)"\)\]', s)
        if rn:
            pending_rename = rn.group(1)
            continue
        if s.startswith("#") or s.startswith("//") or not s:
            continue
        fm = re.match(r"pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:", s)
        if fm:
            fields.append(pending_rename or fm.group(1))
            pending_rename = None
    return fields


def main() -> int:
    root = repo_root()
    doc_path = root / DOC_PATH
    model_path = root / MODEL_PATH

    failed = False

    if not doc_path.is_file():
        print(f"FAIL: missing {DOC_PATH}", file=sys.stderr)
        return 1
    if not model_path.is_file():
        print(f"FAIL: missing {MODEL_PATH}", file=sys.stderr)
        return 1

    doc_text = doc_path.read_text(encoding="utf-8")
    model_text = model_path.read_text(encoding="utf-8")

    # (A) positions section exists and documents a `"vault"` JSON key.
    section = positions_doc_section(doc_text)
    if section is None:
        print(
            f"FAIL: {DOC_PATH} has no `{POSITIONS_HEADING}` section.",
            file=sys.stderr,
        )
        return 1
    if '"vault"' not in section:
        failed = True
        print(
            f"FAIL: positions section in {DOC_PATH} does not document a "
            f'`"vault"` JSON key (the authoritative vault-address field).',
            file=sys.stderr,
        )
    else:
        print(f'OK: {DOC_PATH} documents the `"vault"` positions field.')

    # (B) the doc never describes the API field as `vault_addr`.
    if "vault_addr" in doc_text:
        failed = True
        bad = [
            f"  {i}: {ln.strip()}"
            for i, ln in enumerate(doc_text.splitlines(), 1)
            if "vault_addr" in ln
        ]
        print(
            f"FAIL: {DOC_PATH} mentions `vault_addr` — that token is the "
            f"dapp's internal client field, never an explorer-api wire field. "
            f"Documenting it as the API field reintroduces the #1038 "
            f"ambiguity. Offending lines:",
            file=sys.stderr,
        )
        print("\n".join(bad), file=sys.stderr)
    else:
        print(f"OK: {DOC_PATH} does not claim a `vault_addr` API field.")

    # (C) the model actually serializes `vault` (and not `vault_addr`).
    struct = vault_position_struct(model_text)
    if struct is None:
        print(
            f"FAIL: could not find `pub struct VaultPosition` in {MODEL_PATH}.",
            file=sys.stderr,
        )
        return 1
    fields = serde_fields(struct)
    if "vault" not in fields:
        failed = True
        print(
            f"FAIL: VaultPosition in {MODEL_PATH} does not serialize a "
            f"`vault` field (found: {fields}). The documented contract and "
            f"the model have drifted.",
            file=sys.stderr,
        )
    elif "vault_addr" in fields:
        failed = True
        print(
            f"FAIL: VaultPosition in {MODEL_PATH} serializes `vault_addr`; "
            f"the documented and code contracts must both use `vault`.",
            file=sys.stderr,
        )
    else:
        print(
            f"OK: VaultPosition serializes `vault` (fields: {fields})."
        )

    if failed:
        print(
            "\nFAIL: explorer-api positions doc/model contract is "
            "inconsistent.",
            file=sys.stderr,
        )
        return 1

    print("\nOK: explorer-api positions response-body contract is consistent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
