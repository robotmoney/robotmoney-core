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
import os
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


PLUGIN_DIR_NAME = "plugins/robotmoney-cli"

# Path fragments that identify ambient/global opencode plugin installs.
AMBIENT_PLUGIN_PATTERNS: list[str] = [
    "/.config/opencode/",
    "/.opencode/",
    "/.local/share/opencode/",
    "/usr/local/lib/opencode/",
    "/usr/lib/opencode/",
    "/node_modules/",
    "/.bun/install/global/",
]


def _collect_plugin_paths(obj: object, paths: list[str]) -> None:
    """Walk a parsed JSON event and collect every string value that mentions
    ``plugins/robotmoney-cli`` (the in-repo plugin manifest directory).

    OpenCode's NDJSON schema is not formally versioned; we accept any field
    name and match by substring. See the deposit asserter for the matching
    rationale (issue #461).
    """
    if isinstance(obj, str):
        if PLUGIN_DIR_NAME in obj:
            paths.append(obj)
        return
    if isinstance(obj, dict):
        for value in obj.values():
            _collect_plugin_paths(value, paths)
        return
    if isinstance(obj, list):
        for value in obj:
            _collect_plugin_paths(value, paths)


def assert_plugin_provenance(events: list[dict]) -> list[str]:
    """Assert that the transcript carries a plugin-load event whose resolved
    path equals ``$GITHUB_WORKSPACE/plugins/robotmoney-cli`` (issue #461).
    """
    failures: list[str] = []
    workspace = os.environ.get("GITHUB_WORKSPACE")
    expected = (
        f"{workspace.rstrip('/')}/{PLUGIN_DIR_NAME}" if workspace else None
    )

    found: list[str] = []
    for ev in events:
        _collect_plugin_paths(ev, found)

    if not found:
        failures.append(
            "FAIL (P): no event references the in-repo plugin path "
            f"'{PLUGIN_DIR_NAME}'. The opencode run must be invoked with "
            '--plugin "$PWD/plugins/robotmoney-cli" so CI exercises the '
            "manifest at plugins/robotmoney-cli/plugin.json instead of an "
            "ambient/global opencode plugin."
        )
        return failures

    for path in found:
        for pattern in AMBIENT_PLUGIN_PATTERNS:
            if pattern in path:
                failures.append(
                    f"FAIL (P): plugin path {path!r} matches ambient/global "
                    f"opencode plugin location {pattern!r}. The opencode "
                    "session must load the plugin from the in-repo "
                    f"{PLUGIN_DIR_NAME} directory via "
                    '--plugin "$PWD/plugins/robotmoney-cli".'
                )
                break

    if expected is not None:
        matched = [p for p in found if p.rstrip("/").endswith(expected)]
        if not matched:
            failures.append(
                "FAIL (P): plugin path(s) "
                f"{found!r} do not resolve to $GITHUB_WORKSPACE/"
                f"{PLUGIN_DIR_NAME} (= {expected!r}). The opencode session "
                "loaded the plugin from somewhere other than the repo "
                "checkout (ambient/global)."
            )
    else:
        if not any(p.startswith("/") and p.rstrip("/").endswith(PLUGIN_DIR_NAME) for p in found):
            failures.append(
                "FAIL (P): plugin path(s) "
                f"{found!r} are not absolute paths ending in "
                f"{PLUGIN_DIR_NAME}."
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
    failures += assert_plugin_provenance(events)

    if failures:
        for msg in failures:
            print(msg, file=sys.stderr)
        return 1

    print("OK: rmpc get-vault called with exit 0, valid JSON envelope.")
    print("OK: rmpc get-gateway called with exit 0, partial: true.")
    print("OK: no forbidden explorer/dapp hosts in transcript.")
    print("OK: plugin loaded from $GITHUB_WORKSPACE/plugins/robotmoney-cli.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
