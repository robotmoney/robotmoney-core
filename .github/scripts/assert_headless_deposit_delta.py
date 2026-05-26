#!/usr/bin/env python3
"""Assert that the on-chain vault balance delta matches the deposit amount
reported in the opencode headless transcript (issue #461).

Canonical: docs/testing/headless-opencode-tests.md.

This is the round-trip check that ties the agent transcript to actual
on-chain state. The deposit transcript step records ``tx_hash`` but says
nothing about whether the vault total assets actually increased. Without
this script the suite passes even if the gateway silently no-ops the
deposit.

Inputs:
- ``--transcript``: NDJSON transcript from ``opencode run``.
- ``--vault-pre``: ``rmpc get-vault --pretty`` JSON captured before the
  headless deposit step.
- ``--vault-post``: ``rmpc get-vault --pretty`` JSON captured after the
  headless deposit step.

The script:
1. Parses the transcript and extracts the deposit amount from the
   ``rmpc deposit`` ``tool.result`` event (looks for ``amount``,
   ``deposit_amount``, or ``assets`` in the event payload).
2. Parses pre and post vault state, extracting ``total_assets`` (or
   equivalent: ``totalAssets``, ``vault_balance``).
3. Asserts ``post - pre == deposit_amount``.
4. Exits 0 on match, non-zero otherwise.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


DEPOSIT_AMOUNT_KEYS = ("amount", "deposit_amount", "assets", "value")
TOTAL_ASSETS_KEYS = ("total_assets", "totalAssets", "vault_balance", "assets")


def load_ndjson(path: Path) -> list[dict]:
    """Load newline-delimited JSON events; skip blank/unparseable lines."""
    events: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def _find_in_dict(obj: object, keys: tuple[str, ...]) -> int | None:
    """Recursively search a parsed JSON structure for an integer-coercible
    value under any of the given keys. Returns the first match as int.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys:
                try:
                    return int(str(v))
                except (TypeError, ValueError):
                    pass
            found = _find_in_dict(v, keys)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_in_dict(v, keys)
            if found is not None:
                return found
    return None


def deposit_amount_from_transcript(events: list[dict]) -> int | None:
    """Return the deposit amount (smallest unit) reported in the transcript.

    Looks for the first ``tool.result`` event whose serialized form mentions
    ``deposit`` and ``exit_code == 0`` and extracts a numeric ``amount``
    (or equivalent key) from anywhere inside the event payload, including
    the parsed ``stdout`` JSON.
    """
    for ev in events:
        if ev.get("type") != "tool.result":
            continue
        raw = json.dumps(ev)
        if "deposit" not in raw:
            continue
        if ev.get("exit_code") != 0:
            continue
        amount = _find_in_dict(ev, DEPOSIT_AMOUNT_KEYS)
        if amount is not None:
            return amount
        # Try parsing stdout as JSON.
        for key in ("stdout", "output", "result", "text"):
            val = ev.get(key)
            if isinstance(val, str) and val.strip():
                start = val.find("{")
                if start >= 0:
                    try:
                        parsed = json.loads(val[start:])
                    except json.JSONDecodeError:
                        continue
                    amount = _find_in_dict(parsed, DEPOSIT_AMOUNT_KEYS)
                    if amount is not None:
                        return amount
    return None


def total_assets_from_vault(path: Path) -> int | None:
    """Extract total assets from an ``rmpc get-vault --pretty`` JSON file."""
    text = path.read_text(encoding="utf-8")
    start = text.find("{")
    if start < 0:
        return None
    try:
        parsed = json.loads(text[start:])
    except json.JSONDecodeError:
        end = text.rfind("}")
        if end < start:
            return None
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return _find_in_dict(parsed, TOTAL_ASSETS_KEYS)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert opencode deposit transcript matches on-chain delta."
    )
    parser.add_argument("--transcript", required=True, type=Path)
    parser.add_argument("--vault-pre", required=True, type=Path)
    parser.add_argument("--vault-post", required=True, type=Path)
    args = parser.parse_args()

    if not args.transcript.is_file():
        print(f"FAIL: transcript not found: {args.transcript}", file=sys.stderr)
        return 1
    if not args.vault_pre.is_file():
        print(f"FAIL: vault-pre not found: {args.vault_pre}", file=sys.stderr)
        return 1
    if not args.vault_post.is_file():
        print(f"FAIL: vault-post not found: {args.vault_post}", file=sys.stderr)
        return 1

    events = load_ndjson(args.transcript)
    amount = deposit_amount_from_transcript(events)
    if amount is None:
        print(
            "FAIL: could not extract deposit amount from transcript "
            f"(searched keys {DEPOSIT_AMOUNT_KEYS!r}).",
            file=sys.stderr,
        )
        return 1

    pre = total_assets_from_vault(args.vault_pre)
    post = total_assets_from_vault(args.vault_post)
    if pre is None:
        print(
            f"FAIL: could not extract total assets from {args.vault_pre} "
            f"(searched keys {TOTAL_ASSETS_KEYS!r}).",
            file=sys.stderr,
        )
        return 1
    if post is None:
        print(
            f"FAIL: could not extract total assets from {args.vault_post} "
            f"(searched keys {TOTAL_ASSETS_KEYS!r}).",
            file=sys.stderr,
        )
        return 1

    delta = post - pre
    if delta != amount:
        print(
            f"FAIL: on-chain delta {delta} does not equal transcript-reported "
            f"deposit amount {amount} (pre={pre}, post={post}).",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: on-chain delta {delta} matches transcript-reported deposit "
        f"amount {amount} (pre={pre}, post={post})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
