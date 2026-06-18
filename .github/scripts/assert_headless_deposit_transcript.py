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

Issue #908/#909 reconciliation: this script now matches the REAL opencode
1.16.x transcript schema. opencode emits `tool_use` events whose payload lives
under `part.state` (command at `part.state.input.command`, exit code at
`part.state.metadata.exit`, stdout at `part.state.output`) — NOT the
`tool.result`/`exit_code` shape the original script assumed. The in-repo
`plugins/robotmoney-user` bundle is a SKILL bundle, not an opencode JS plugin,
so opencode never registers it as a tool and never emits an in-repo plugin
path in stdout; the old `--plugin "$PWD/..."` provenance assert was therefore
unsatisfiable and is replaced by a check that the deposit and its read prefix
were genuinely driven through the `rmpc` binary via the bash tool.
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


def tool_command(event: dict) -> str | None:
    """Return the shell command string for an opencode `tool_use` bash event."""
    if event.get("type") != "tool_use":
        return None
    part = event.get("part")
    if not isinstance(part, dict) or part.get("tool") != "bash":
        return None
    state = part.get("state")
    if not isinstance(state, dict):
        return None
    inp = state.get("input")
    if isinstance(inp, dict) and isinstance(inp.get("command"), str):
        return inp["command"]
    return None


def tool_exit_code(event: dict) -> int | None:
    """Return the bash tool exit code from `part.state.metadata.exit`."""
    state = event.get("part", {}).get("state", {})
    if not isinstance(state, dict):
        return None
    meta = state.get("metadata")
    if isinstance(meta, dict) and isinstance(meta.get("exit"), int):
        return meta["exit"]
    return None


def _is_rmpc_call(event: dict, command_fragment: str) -> bool:
    cmd = tool_command(event)
    return cmd is not None and "rmpc" in cmd and command_fragment in cmd


def find_tool_result(events: list[dict], command_fragment: str) -> dict | None:
    """Return the first completed `rmpc <command_fragment>` bash event, exit 0.

    Matches opencode's real `tool_use` schema. ``command_fragment`` must appear
    in the literal command line that invoked the rmpc binary.
    """
    for ev in events:
        if not _is_rmpc_call(ev, command_fragment):
            continue
        if ev.get("part", {}).get("state", {}).get("status") != "completed":
            continue
        if tool_exit_code(ev) != 0:
            continue
        return ev
    return None


def deposit_present(events: list[dict]) -> bool:
    """Return True if any bash tool_use event ran `rmpc deposit` (any exit)."""
    for ev in events:
        if _is_rmpc_call(ev, "deposit"):
            return True
    return False


def find_tool_result_index(events: list[dict], command_fragment: str) -> int | None:
    """Return the index of the first completed `rmpc <fragment>` event (exit 0)."""
    for i, ev in enumerate(events):
        if not _is_rmpc_call(ev, command_fragment):
            continue
        if ev.get("part", {}).get("state", {}).get("status") != "completed":
            continue
        if tool_exit_code(ev) != 0:
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
            if not _is_rmpc_call(candidate, "deposit"):
                continue
            exit_code = tool_exit_code(candidate)
            failures.append(
                f"FAIL (B): 'rmpc deposit' found in transcript but exit={exit_code!r} "
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


# ── rmpc-provenance assertion (reconciled for #908/#909) ──────────────────────


def assert_rmpc_provenance(events: list[dict]) -> list[str]:
    """Reconciled provenance check (replaces the old in-repo-plugin-path assert).

    The in-repo ``plugins/robotmoney-user`` bundle is a SKILL bundle, not an
    opencode JS plugin, so opencode cannot register it as a tool and never
    emits an in-repo plugin path in the ``--format json`` stdout. Asserting on
    that path was structurally unsatisfiable. The real, opencode-observable
    proof that the deposit run exercised rmpc is: the ``rmpc deposit`` was a
    completed ``bash`` tool call (exit 0) whose stdout reports
    ``status: "success"`` and a 0x-hex ``tx_hash``. That proves the agent
    actually ran the rmpc binary to broadcast a real signed deposit rather than
    improvising with generic tools or fabricating a result.
    """
    failures: list[str] = []
    ev = find_tool_result(events, "deposit")
    if ev is None:
        failures.append(
            "FAIL (P): no completed 'rmpc deposit' bash tool_use event with "
            "exit 0 — the agent did not drive rmpc to broadcast the deposit."
        )
        return failures

    state = ev.get("part", {}).get("state", {})
    stdout = state.get("output") if isinstance(state, dict) else None
    if not isinstance(stdout, str) or not stdout.strip():
        failures.append("FAIL (P): 'rmpc deposit' tool_use event has no stdout")
        return failures

    start = stdout.find("{")
    parsed = None
    if start >= 0:
        try:
            parsed = json.loads(stdout[start:])
        except json.JSONDecodeError:
            parsed = None
    if not isinstance(parsed, dict):
        failures.append(
            f"FAIL (P): 'rmpc deposit' stdout is not a JSON result envelope "
            f"(preview: {stdout[:160]!r})"
        )
        return failures

    if parsed.get("status") != "success":
        failures.append(
            f"FAIL (P): 'rmpc deposit' result status={parsed.get('status')!r} "
            f"(expected 'success')"
        )
    tx_hash = parsed.get("tx_hash")
    if not isinstance(tx_hash, str) or not HEX_TX_HASH_RE.match(tx_hash):
        failures.append(
            f"FAIL (P): 'rmpc deposit' result tx_hash={tx_hash!r} is not a "
            f"0x-hex-64 string; cannot confirm a real broadcast."
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
        # No rmpc-provenance check here: refusal mode proves the negative
        # (deposit absent), so there is no deposit tool call to attest.

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

    else:
        # ── Happy-path mode (issue #137) ───────────────────────────────────────
        failures += assert_read_prefix_order(events)
        failures += assert_deposit_exit_zero(events)
        if args.final_report is not None:
            failures += assert_final_report_deposited(Path(args.final_report))
        failures += assert_no_forbidden_hosts(events)
        failures += assert_rmpc_provenance(events)

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
        print("OK: rmpc deposit broadcast a real tx (status=success, tx_hash present).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
