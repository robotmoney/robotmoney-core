#!/usr/bin/env python3
"""Assert that an OpenCode headless read transcript contains required tool calls.

Issue #136 acceptance criteria:

  (A) Transcript contains rmpc get-vault with exit_code 0 and stdout
      that parses as valid JSON with chain_id, block_number, source keys.

  (B) Transcript contains rmpc get-gateway with exit_code 0 and stdout
      that includes partial: true.

  (C) No event in the transcript references an explorer API or the dapp
      (guards against the skill leaking outside the json_rpc source).

Usage:
    python3 assert_headless_read_transcript.py <transcript.ndjson>

The transcript is the newline-delimited JSON event stream produced by
`opencode run --format json`. Each line is one JSON object. The script
exits 0 on pass, non-zero on any assertion failure.
"""

from __future__ import annotations

import json
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


def extract_stdout(event: dict) -> str | None:
    """Return the tool stdout from a tool.result event, trying several field names."""
    for key in ("stdout", "output", "content", "result", "text"):
        val = event.get(key)
        if isinstance(val, str) and val.strip():
            return val
    # Some schemas nest content under a list
    content = event.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                for key in ("text", "output", "stdout"):
                    val = item.get(key)
                    if isinstance(val, str) and val.strip():
                        return val
    return None


def assert_get_vault(events: list[dict]) -> list[str]:
    failures: list[str] = []
    ev = find_tool_result(events, "get-vault")
    if ev is None:
        failures.append(
            "FAIL (A): no tool.result event for 'rmpc get-vault' with exit_code 0 found"
        )
        return failures

    stdout = extract_stdout(ev)
    if stdout is None:
        failures.append(
            "FAIL (A): rmpc get-vault result event has no recognisable stdout field"
        )
        return failures

    # The stdout from rmpc --pretty is a JSON object; it may be prefixed
    # with human-readable text when --pretty is set. Scan for the JSON
    # portion.
    parsed = parse_json_from_output(stdout)
    if parsed is None:
        failures.append(
            f"FAIL (A): rmpc get-vault stdout does not contain valid JSON.\n"
            f"  stdout preview: {stdout[:200]!r}"
        )
        return failures

    for key in ("chain_id", "block_number", "source"):
        if key not in parsed:
            failures.append(
                f"FAIL (A): rmpc get-vault JSON envelope missing required key '{key}'"
            )

    return failures


def assert_get_gateway(events: list[dict]) -> list[str]:
    failures: list[str] = []
    ev = find_tool_result(events, "get-gateway")
    if ev is None:
        failures.append(
            "FAIL (B): no tool.result event for 'rmpc get-gateway' with exit_code 0 found"
        )
        return failures

    stdout = extract_stdout(ev)
    if stdout is None:
        failures.append(
            "FAIL (B): rmpc get-gateway result event has no recognisable stdout field"
        )
        return failures

    parsed = parse_json_from_output(stdout)
    if parsed is None:
        failures.append(
            f"FAIL (B): rmpc get-gateway stdout does not contain valid JSON.\n"
            f"  stdout preview: {stdout[:200]!r}"
        )
        return failures

    if parsed.get("partial") is not True:
        failures.append(
            f"FAIL (B): rmpc get-gateway JSON does not have partial: true "
            f"(got partial={parsed.get('partial')!r})"
        )

    return failures


def assert_no_forbidden_hosts(events: list[dict]) -> list[str]:
    failures: list[str] = []
    full_transcript = json.dumps(events)
    for host in FORBIDDEN_HOSTS:
        if host in full_transcript:
            failures.append(
                f"FAIL (C): transcript references forbidden host '{host}' — "
                f"skill must use json_rpc source only"
            )
    return failures


def parse_json_from_output(text: str) -> dict | None:
    """Attempt to extract a JSON object from tool output text.

    rmpc --pretty may prepend a short description before the JSON block.
    We scan for the first '{' and try to parse from there.
    """
    start = text.find("{")
    if start < 0:
        return None
    try:
        return json.loads(text[start:])
    except json.JSONDecodeError:
        pass
    # Try stripping trailing non-JSON text
    end = text.rfind("}")
    if end >= start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print(
            f"Usage: {sys.argv[0]} <transcript.ndjson>", file=sys.stderr
        )
        return 1

    transcript_path = Path(sys.argv[1])
    if not transcript_path.is_file():
        print(
            f"FAIL: transcript file not found: {transcript_path}", file=sys.stderr
        )
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
    failures += assert_get_vault(events)
    failures += assert_get_gateway(events)
    failures += assert_no_forbidden_hosts(events)

    if failures:
        for msg in failures:
            print(msg, file=sys.stderr)
        return 1

    print("OK: rmpc get-vault called with exit 0, valid JSON envelope.")
    print("OK: rmpc get-gateway called with exit 0, partial: true.")
    print("OK: no forbidden explorer/dapp hosts in transcript.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
