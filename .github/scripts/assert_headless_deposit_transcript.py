#!/usr/bin/env python3
"""Assert that an OpenCode headless deposit transcript meets issue #137/#138 criteria.

Issue #137 acceptance criteria (happy-path mode):

  (A) Transcript contains rmpc get-vault, rmpc get-agent, rmpc get-balance,
      rmpc get-allowance, rmpc self-check in that order, all before deposit.

  (B) Transcript contains rmpc deposit with exit_code 0.

  (C) final-report.json (when present) has outcome == 'deposited' and
      tx_hash is a non-null hex string.

  (D) No event in the transcript references an explorer API or the dapp.

Issue #138 acceptance criteria (refusal mode, --expect-refusal <reason>):

  (A) rmpc deposit is absent from the transcript (agent must not have called it).

  (B) final-report.json (when present) has outcome starting with 'refused:'
      and the outcome string contains the expected reason substring.

  (C) No event in the transcript references an explorer API or the dapp.

Usage:
    python3 assert_headless_deposit_transcript.py <transcript.ndjson> \
        [--final-report <final-report.json>] \
        [--expect-refusal <reason-substring>]

The transcript is the newline-delimited JSON event stream produced by
`opencode run --format json`. Each line is one JSON object. The script
exits 0 on pass, non-zero on any assertion failure.
"""

from __future__ import annotations

import argparse
import json
import os
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


def deposit_present(events: list[dict]) -> bool:
    """Return True if any tool.result event references 'deposit' (any exit code)."""
    for ev in events:
        if ev.get("type") != "tool.result":
            continue
        raw = json.dumps(ev)
        if "deposit" in raw:
            return True
    return False


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


# ── Happy-path assertions (issue #137) ────────────────────────────────────────


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


def assert_final_report_deposited(report_path: Path) -> list[str]:
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
            "FAIL (C): final-report.json tx_hash is null/empty (expected non-null hex string)"
        )
    elif not isinstance(tx_hash, str) or not HEX_TX_HASH_RE.match(tx_hash):
        failures.append(
            f"FAIL (C): final-report.json tx_hash={tx_hash!r} is not a valid 0x-hex-64 string"
        )

    return failures


# ── Refusal assertions (issue #138) ───────────────────────────────────────────


def assert_deposit_absent(events: list[dict]) -> list[str]:
    """Assert rmpc deposit does NOT appear in transcript."""
    if deposit_present(events):
        return [
            "FAIL (A): 'rmpc deposit' found in transcript — agent must not call deposit "
            "when a precondition fails"
        ]
    return []


def assert_final_report_refused(report_path: Path, expected_reason: str) -> list[str]:
    """Assert final-report.json has outcome starting with 'refused:' containing expected_reason."""
    failures: list[str] = []
    if not report_path.is_file():
        failures.append(
            f"FAIL (B): final-report.json not found at {report_path} — "
            f"the agent must write this file per §3.2 step 7"
        )
        return failures

    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        failures.append(f"FAIL (B): final-report.json is not valid JSON: {exc}")
        return failures

    outcome = report.get("outcome", "")
    if not isinstance(outcome, str) or not outcome.startswith("refused:"):
        failures.append(
            f"FAIL (B): final-report.json outcome={outcome!r} does not start with 'refused:'"
        )
        return failures

    if expected_reason not in outcome:
        failures.append(
            f"FAIL (B): final-report.json outcome={outcome!r} does not contain "
            f"expected reason substring {expected_reason!r}"
        )

    return failures


# ── Plugin-provenance assertion (issue #461) ──────────────────────────────────


PLUGIN_DIR_NAME = "plugins/robotmoney-cli"

# Path fragments that identify ambient/global opencode plugin installs.
# These are the locations opencode and bun use by convention; any plugin
# resolved from one of these is by definition NOT the in-repo manifest.
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

    OpenCode's NDJSON schema is not formally versioned, so we accept any field
    name. The fixture and CI integration expect a session/startup-style event
    such as ``{"type": "session.created", "plugin_paths": ["..."]}`` or a
    dedicated ``{"type": "plugin.loaded", "path": "..."}`` event; either form
    satisfies provenance as long as one collected string resolves to
    ``$GITHUB_WORKSPACE/plugins/robotmoney-cli``.
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
    path equals ``$GITHUB_WORKSPACE/plugins/robotmoney-cli``.

    Outside CI ``GITHUB_WORKSPACE`` may be unset; in that case we accept any
    absolute path whose trailing segment is ``plugins/robotmoney-cli``. This
    keeps developer-machine reruns workable while still rejecting ambient
    plugin paths in CI (where ``GITHUB_WORKSPACE`` is always populated).
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

    # Always reject any path that lives in an ambient/global plugin location,
    # even when GITHUB_WORKSPACE is set — defence in depth.
    for path in found:
        for pattern in AMBIENT_PLUGIN_PATTERNS:
            if pattern in path:
                failures.append(
                    f"FAIL (P): plugin path {path!r} matches ambient/global "
                    f"opencode plugin location {pattern!r}. The opencode "
                    "session must load the plugin from the in-repo "
                    f"{PLUGIN_DIR_NAME} directory via "
                    '--plugin "$PWD/plugins/robotmoney-cli", not from a '
                    "global install."
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
                "checkout (ambient/global), so this run did not exercise "
                "the in-repo manifest."
            )
    else:
        # No GITHUB_WORKSPACE — at minimum require an absolute path that is
        # not in an ambient location (already enforced above).
        if not any(p.startswith("/") and p.rstrip("/").endswith(PLUGIN_DIR_NAME) for p in found):
            failures.append(
                "FAIL (P): plugin path(s) "
                f"{found!r} are not absolute paths ending in "
                f"{PLUGIN_DIR_NAME}. CI must pass --plugin with an "
                "absolute path."
            )

    return failures


# ── Shared assertion ───────────────────────────────────────────────────────────


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


# ── Entry point ────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert an OpenCode headless deposit transcript (issues #137/#138)."
    )
    parser.add_argument("transcript", help="Path to transcript.ndjson")
    parser.add_argument(
        "--final-report",
        default=None,
        help="Path to final-report.json (optional; skips report check if absent)",
    )
    parser.add_argument(
        "--expect-refusal",
        default=None,
        metavar="REASON",
        help=(
            "Refusal mode (issue #138): assert deposit absent and outcome starts with "
            "'refused:' containing REASON substring."
        ),
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

    if args.expect_refusal is not None:
        # ── Refusal mode (issue #138) ──────────────────────────────────────────
        failures += assert_deposit_absent(events)
        if args.final_report is not None:
            failures += assert_final_report_refused(
                Path(args.final_report), args.expect_refusal
            )
        failures += assert_no_forbidden_hosts(events)
        failures += assert_plugin_provenance(events)

        if failures:
            for msg in failures:
                print(msg, file=sys.stderr)
            return 1

        print("OK: rmpc deposit absent from transcript (agent refused as expected).")
        if args.final_report is not None:
            print(
                f"OK: final-report.json outcome starts with 'refused:' "
                f"and contains {args.expect_refusal!r}."
            )
        print("OK: no forbidden explorer/dapp hosts in transcript.")
        print("OK: plugin loaded from $GITHUB_WORKSPACE/plugins/robotmoney-cli.")

    else:
        # ── Happy-path mode (issue #137) ───────────────────────────────────────
        failures += assert_read_prefix_order(events)
        failures += assert_deposit_exit_zero(events)
        if args.final_report is not None:
            failures += assert_final_report_deposited(Path(args.final_report))
        failures += assert_no_forbidden_hosts(events)
        failures += assert_plugin_provenance(events)

        if failures:
            for msg in failures:
                print(msg, file=sys.stderr)
            return 1

        print(
            "OK: read prefix (get-vault, get-agent, get-balance, get-allowance, self-check) "
            "in order before deposit."
        )
        print("OK: rmpc deposit called with exit 0.")
        if args.final_report is not None:
            print("OK: final-report.json outcome=deposited, tx_hash is non-null hex.")
        print("OK: no forbidden explorer/dapp hosts in transcript.")
        print("OK: plugin loaded from $GITHUB_WORKSPACE/plugins/robotmoney-cli.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
