#!/usr/bin/env python3
"""Assert that an OpenCode headless deposit transcript meets issue #137 criteria.

Issue #137 acceptance criteria:

  (A) Transcript contains rmpc get-vault, rmpc get-agent, rmpc get-balance,
      rmpc get-allowance, rmpc self-check in that order, all before deposit.

  (B) Transcript contains rmpc deposit with exit_code 0.

  (C) final-report.json (when present) has outcome == 'deposited' and
      tx_hash is a non-null hex string.

  (D) No event in the transcript references an explorer API or the dapp.

Usage:
    python3 assert_headless_deposit_transcript.py <transcript.ndjson> \
        [--final-report <final-report.json>]

The transcript is the newline-delimited JSON event stream produced by
`opencode run --format json`. Each line is one JSON object. The script
exits 0 on pass, non-zero on any assertion failure.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Explorer / dapp hostnames that must never appear in the transcript.
FORBIDDEN_HOSTS: list[str] = [
    "etherscan.io",
    "basescan.org",
    "blockscout.com",
    "api.etherscan.io",
    "api.basescan.org",
    "robotmoney.xyz",
    "app.robotmoney",
]

# Required read-prefix commands in required order before deposit.
READ_PREFIX: list[str] = [
    "get-vault",
    "get-agent",
    "get-balance",
    "get-allowance",
    "self-check",
]

HEX_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


def load_events(path: Path) -> list[dict]:
    events: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            print(
                f"WARNING: line {lineno} is not valid JSON (skipping): {exc}",
                file=sys.stderr,
            )
    return events


def find_tool_result(events: list[dict], command_fragment: str) -> dict | None:
    """Return the first tool.result event that mentions command_fragment.

    Searches the raw JSON serialisation of each event so we are resilient
    to schema variations across OpenCode versions.  The exit_code must be 0.
    """
    for ev in events:
        if ev.get("type") != "tool.result":
            continue
        raw = json.dumps(ev)
        if command_fragment not in raw:
            continue
        if ev.get("exit_code") != 0:
            continue
        return ev
    return None


def find_tool_result_index(events: list[dict], command_fragment: str) -> int | None:
    """Return the index of the first tool.result event for command_fragment (exit 0)."""
    for i, ev in enumerate(events):
        if ev.get("type") != "tool.result":
            continue
        raw = json.dumps(ev)
        if command_fragment not in raw:
            continue
        if ev.get("exit_code") != 0:
            continue
        return i
    return None


def assert_read_prefix_order(events: list[dict]) -> list[str]:
    """Assert READ_PREFIX commands appear in order before deposit."""
    failures: list[str] = []
    indices: dict[str, int | None] = {}

    for cmd in READ_PREFIX + ["deposit"]:
        indices[cmd] = find_tool_result_index(events, cmd)

    for cmd in READ_PREFIX:
        if indices[cmd] is None:
            failures.append(
                f"FAIL (A): no tool.result event for 'rmpc {cmd}' with exit_code 0 found"
            )

    if failures:
        return failures

    # Verify ordering: each successive read-prefix command must appear after
    # the previous one.
    for i in range(1, len(READ_PREFIX)):
        prev = READ_PREFIX[i - 1]
        curr = READ_PREFIX[i]
        if indices[prev] is not None and indices[curr] is not None:
            if indices[curr] <= indices[prev]:
                failures.append(
                    f"FAIL (A): 'rmpc {curr}' (event #{indices[curr]}) does not appear "
                    f"after 'rmpc {prev}' (event #{indices[prev]}) — read prefix out of order"
                )

    # Verify all read-prefix commands appear before deposit.
    if indices["deposit"] is not None:
        for cmd in READ_PREFIX:
            if indices[cmd] is not None and indices[cmd] >= indices["deposit"]:
                failures.append(
                    f"FAIL (A): 'rmpc {cmd}' (event #{indices[cmd]}) does not appear "
                    f"before 'rmpc deposit' (event #{indices['deposit']})"
                )

    return failures


def assert_deposit_exit_zero(events: list[dict]) -> list[str]:
    """Assert rmpc deposit appears in transcript with exit_code 0."""
    failures: list[str] = []
    ev = find_tool_result(events, "deposit")
    if ev is None:
        # Also check for a deposit event with non-zero exit to give a better error.
        for candidate in events:
            if candidate.get("type") != "tool.result":
                continue
            raw = json.dumps(candidate)
            if "deposit" not in raw:
                continue
            exit_code = candidate.get("exit_code")
            failures.append(
                f"FAIL (B): 'rmpc deposit' found in transcript but exit_code={exit_code!r} "
                f"(expected 0)"
            )
            return failures
        failures.append(
            "FAIL (B): no tool.result event for 'rmpc deposit' with exit_code 0 found"
        )
    return failures


def assert_final_report(report_path: Path) -> list[str]:
    """Assert final-report.json has outcome=='deposited' and non-null tx_hash."""
    failures: list[str] = []
    if not report_path.is_file():
        failures.append(
            f"FAIL (C): final-report.json not found at {report_path} — "
            f"the agent must write this file per §3.2 step 7"
        )
        return failures

    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        failures.append(f"FAIL (C): final-report.json is not valid JSON: {exc}")
        return failures

    outcome = report.get("outcome")
    if outcome != "deposited":
        failures.append(
            f"FAIL (C): final-report.json outcome={outcome!r} (expected 'deposited')"
        )

    tx_hash = report.get("tx_hash")
    if tx_hash is None or tx_hash == "null" or tx_hash == "":
        failures.append(
            f"FAIL (C): final-report.json tx_hash is null/empty (expected non-null hex string)"
        )
    elif not isinstance(tx_hash, str) or not HEX_TX_HASH_RE.match(tx_hash):
        failures.append(
            f"FAIL (C): final-report.json tx_hash={tx_hash!r} is not a valid 0x-hex-64 string"
        )

    return failures


def assert_no_forbidden_hosts(events: list[dict]) -> list[str]:
    failures: list[str] = []
    full_transcript = json.dumps(events)
    for host in FORBIDDEN_HOSTS:
        if host in full_transcript:
            failures.append(
                f"FAIL (D): transcript references forbidden host '{host}' — "
                f"skill must use json_rpc source only"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert an OpenCode headless deposit transcript (issue #137)."
    )
    parser.add_argument("transcript", help="Path to transcript.ndjson")
    parser.add_argument(
        "--final-report",
        default=None,
        help="Path to final-report.json (optional; skips (C) check if absent)",
    )
    args = parser.parse_args()

    transcript_path = Path(args.transcript)
    if not transcript_path.is_file():
        print(f"FAIL: transcript file not found: {transcript_path}", file=sys.stderr)
        return 1

    events = load_events(transcript_path)
    if not events:
        print(
            "FAIL: transcript is empty or contains no parseable JSON events",
            file=sys.stderr,
        )
        return 1

    print(f"Loaded {len(events)} events from {transcript_path}.")

    failures: list[str] = []
    failures += assert_read_prefix_order(events)
    failures += assert_deposit_exit_zero(events)
    if args.final_report is not None:
        failures += assert_final_report(Path(args.final_report))
    failures += assert_no_forbidden_hosts(events)

    if failures:
        for msg in failures:
            print(msg, file=sys.stderr)
        return 1

    print("OK: read prefix (get-vault, get-agent, get-balance, get-allowance, self-check) in order before deposit.")
    print("OK: rmpc deposit called with exit 0.")
    if args.final_report is not None:
        print("OK: final-report.json outcome=deposited, tx_hash is non-null hex.")
    print("OK: no forbidden explorer/dapp hosts in transcript.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
