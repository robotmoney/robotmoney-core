#!/usr/bin/env python3
"""Assert that the on-chain vault balance delta matches the deposit amount
reported in the opencode headless transcript (issue #461).

Canonical: docs/development/headless-opencode-tests.md.

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
3. Asserts ``post - pre`` is the deposit amount within a small tolerance.
   On the real Aave V3 / Compound V3 / Morpho vault (issue #912 removed the
   no-yield PassthroughAdapter), ``total_assets`` is not a static balance:
   it accrues yield every block, and adapters lose a few integer-division
   dust units round-tripping USDC through yield-bearing tokens. So the
   measured delta is ``deposit_amount + accrued_yield - rounding_dust`` and
   never lands on the exact deposit amount. We therefore require the delta to
   sit within ``[deposit - DELTA_LOWER_BPS, deposit + DELTA_UPPER_BPS]`` — the
   lower bound still proves the deposit fully landed (no silent gateway
   no-op), the upper bound still catches a gross wrong-vault / double-count
   bug, while tolerating real yield + rounding.
4. Exits 0 on match, non-zero otherwise.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


DEPOSIT_AMOUNT_KEYS = ("amount", "deposit_amount", "assets", "value")
TOTAL_ASSETS_KEYS = ("total_assets", "totalAssets", "vault_balance", "assets")

# Tolerance band for the on-chain totalAssets delta vs the deposit amount on a
# real-yield vault (issue #912). Lower bound: at most 10 bps short, covering
# adapter integer-division rounding dust (Deploy.s.sol's seed deposit allows a
# comparable 1 bps loss). Upper bound: at most 100 bps over, covering yield
# accrued between the pre/post snapshots while still catching gross
# double-count / wrong-vault errors.
DELTA_LOWER_BPS = 10
DELTA_UPPER_BPS = 100
BPS_DENOMINATOR = 10_000


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


def _deposit_event(ev: dict) -> dict | None:
    """Return the `part.state` of a completed `rmpc deposit` bash tool_use event
    (exit 0), matching opencode 1.16.x's real schema. Returns None otherwise.

    opencode emits `{"type": "tool_use", "part": {"tool": "bash", "state":
    {"status": "completed", "input": {"command": "rmpc deposit ..."},
    "metadata": {"exit": 0}, "output": "<rmpc stdout>"}}}`.
    """
    if ev.get("type") != "tool_use":
        return None
    part = ev.get("part")
    if not isinstance(part, dict) or part.get("tool") != "bash":
        return None
    state = part.get("state")
    if not isinstance(state, dict):
        return None
    inp = state.get("input")
    cmd = inp.get("command") if isinstance(inp, dict) else None
    if not isinstance(cmd, str) or "rmpc" not in cmd or "deposit" not in cmd:
        return None
    if state.get("status") != "completed":
        return None
    meta = state.get("metadata")
    if not isinstance(meta, dict) or meta.get("exit") != 0:
        return None
    return state


def deposit_amount_from_transcript(events: list[dict]) -> int | None:
    """Return the deposit amount (smallest unit) reported in the transcript.

    Looks for the completed `rmpc deposit` bash tool_use event and extracts a
    numeric ``amount`` (or equivalent key) from the rmpc result JSON in its
    stdout (``part.state.output``).
    """
    for ev in events:
        state = _deposit_event(ev)
        if state is None:
            continue
        for val in (state.get("output"), (state.get("metadata") or {}).get("output")):
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
    lower = amount - (amount * DELTA_LOWER_BPS) // BPS_DENOMINATOR
    upper = amount + (amount * DELTA_UPPER_BPS) // BPS_DENOMINATOR
    if not (lower <= delta <= upper):
        print(
            f"FAIL: on-chain delta {delta} outside tolerance "
            f"[{lower}, {upper}] for transcript-reported deposit amount "
            f"{amount} (pre={pre}, post={post}).",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: on-chain delta {delta} within tolerance [{lower}, {upper}] of "
        f"transcript-reported deposit amount {amount} (pre={pre}, post={post})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
