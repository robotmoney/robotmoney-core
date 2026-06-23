#!/usr/bin/env python3
"""Issue #1044 — committee vote schema validation.

Validates the committee vote JSON fixtures against the committed schema:
  tests/fixtures/committee-vote.schema.json

Checks:
  1. tests/fixtures/committee-vote.valid.json must pass schema validation.
  2. tests/fixtures/committee-vote.invalid.json must FAIL schema validation
     (at least one error); if it passes we have a broken schema or fixture.

Exits non-zero on any failure. Requires the `jsonschema` package
(installed via `pip install jsonschema` or already present in Python 3.x
environments from setup-python@v5 with the install step).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "tests" / "fixtures" / "committee-vote.schema.json"
VALID_PATH = REPO_ROOT / "tests" / "fixtures" / "committee-vote.valid.json"
INVALID_PATH = REPO_ROOT / "tests" / "fixtures" / "committee-vote.invalid.json"


def _load_json(path: Path) -> dict:
    try:
        with path.open() as f:
            return json.load(f)
    except Exception as exc:
        print(f"ERROR: could not load {path.relative_to(REPO_ROOT)}: {exc}", file=sys.stderr)
        sys.exit(1)


def _validate(instance: dict, schema: dict) -> list[str]:
    """Return a list of validation error messages (empty = valid)."""
    try:
        import jsonschema  # type: ignore[import]
    except ImportError:
        print(
            "ERROR: jsonschema package not installed. Run: pip install jsonschema",
            file=sys.stderr,
        )
        sys.exit(2)

    validator = jsonschema.Draft7Validator(schema)
    return [str(e) for e in sorted(validator.iter_errors(instance), key=lambda e: list(e.path))]


def main() -> int:
    failures: list[str] = []

    # Verify all fixture files exist.
    for path in (SCHEMA_PATH, VALID_PATH, INVALID_PATH):
        if not path.is_file():
            failures.append(f"missing fixture: {path.relative_to(REPO_ROOT)}")
    if failures:
        for f in failures:
            print(f"ERROR: {f}", file=sys.stderr)
        return 1

    schema = _load_json(SCHEMA_PATH)
    valid_doc = _load_json(VALID_PATH)
    invalid_doc = _load_json(INVALID_PATH)

    # 1. Valid fixture must pass.
    valid_errors = _validate(valid_doc, schema)
    if valid_errors:
        failures.append(
            f"{VALID_PATH.name} FAILED schema validation "
            f"({len(valid_errors)} error(s)):\n  " + "\n  ".join(valid_errors)
        )
    else:
        print(f"ok: {VALID_PATH.name} passes schema validation")

    # 2. Invalid fixture must fail.
    invalid_errors = _validate(invalid_doc, schema)
    if not invalid_errors:
        failures.append(
            f"{INVALID_PATH.name} unexpectedly PASSED schema validation — "
            "the invalid fixture must trigger at least one schema error. "
            "Either the fixture is actually valid or the schema is too permissive."
        )
    else:
        print(
            f"ok: {INVALID_PATH.name} correctly rejected "
            f"({len(invalid_errors)} error(s) found)"
        )

    if failures:
        for f in failures:
            print(f"ERROR: {f}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
