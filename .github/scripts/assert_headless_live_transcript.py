#!/usr/bin/env python3
"""Loud-fail guard for the headless opencode "run" steps (issue #1151).

Canonical: docs/technical/opencode-headless-invocation.md §12.6.

WHY THIS GUARD EXISTS
`opencode run` exits 0 even when the model session dies in a provider/API error
with zero tool calls, and that error-only transcript is a non-empty NDJSON line,
so the previous `test -s <transcript>` guard passed a completely broken run. The
model outage then only surfaced three steps later at the transcript-assert step
(`assert_headless_{read,deposit}_transcript.py`), reading as an assertion failure
rather than what it is: the agent never drove rmpc at all.

That is a loud-skip violation: a broken external model path must red the agent
step itself, not slide a zero-rmpc transcript downstream. This guard runs
immediately after `opencode run` and turns the "Headless … run" step RED when the
session is dead:

  (1) the transcript has no parseable events (empty / truncated), OR
  (2) the transcript contains an `error` event (APIError / provider 400 —
      the hosted zen provider rejecting the request, the exact 2026-07-01
      failure mode), OR
  (3) the transcript contains ZERO `rmpc …` bash tool invocations (the agent
      never ran the client, so nothing downstream can possibly assert on it).

This guard deliberately does NOT check command order, exit codes, or output
envelopes — those remain the job of the unchanged transcript asserters. Its sole
job is to distinguish "the model path is alive and drove rmpc" from "the model
path is broken and produced a dead transcript", and to fail loudly on the latter.

Usage:
    python3 assert_headless_live_transcript.py <transcript.ndjson>

Exits 0 when the session is alive and invoked rmpc at least once; non-zero (with
a diagnostic on stderr) otherwise.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


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


def error_events(events: list[dict]) -> list[dict]:
    """Return every top-level `error` event (opencode emits these for APIError /
    provider rejections). Shape (issue #1151):
        {"type": "error", "error": {"name": "APIError", "data": {...}}}
    """
    return [e for e in events if isinstance(e, dict) and e.get("type") == "error"]


def describe_error(event: dict) -> str:
    """Best-effort one-line description of an opencode error event."""
    err = event.get("error")
    if isinstance(err, dict):
        name = err.get("name", "error")
        data = err.get("data")
        msg = None
        if isinstance(data, dict):
            msg = data.get("message")
        return f"{name}: {msg}" if msg else str(name)
    return json.dumps(event)[:300]


def rmpc_invocations(events: list[dict]) -> int:
    """Count bash tool_use events whose command invokes the rmpc binary.

    Presence (not exit code) is what matters here: a dead-model transcript has
    ZERO such events. Whether an rmpc call then exited 0 with the right envelope
    is the transcript asserter's concern, not this guard's.
    """
    count = 0
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "tool_use":
            continue
        part = e.get("part")
        if not isinstance(part, dict) or part.get("tool") != "bash":
            continue
        state = part.get("state")
        if not isinstance(state, dict):
            continue
        inp = state.get("input")
        cmd = inp.get("command") if isinstance(inp, dict) else None
        if isinstance(cmd, str) and "rmpc" in cmd:
            count += 1
    return count


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <transcript.ndjson>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"FAIL: transcript file not found: {path}", file=sys.stderr)
        return 1

    events = load_events(path)
    if not events:
        print(
            "FAIL: headless transcript is empty or contains no parseable JSON "
            "events — the opencode session produced no output (dead model path).",
            file=sys.stderr,
        )
        return 1

    errs = error_events(events)
    if errs:
        print(
            "FAIL: the opencode session ended in an error — the hosted model path "
            "is broken (a model outage reds THIS step, not the later assert step):",
            file=sys.stderr,
        )
        for e in errs:
            print(f"  - {describe_error(e)}", file=sys.stderr)
        return 1

    n = rmpc_invocations(events)
    if n == 0:
        print(
            "FAIL: the opencode session produced zero `rmpc …` bash tool "
            "invocations — the agent never drove the rmpc client, so the "
            "transcript is empty of the behaviour under test (loud-skip guard). "
            f"Loaded {len(events)} events but none invoked rmpc.",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: opencode session is alive — {len(events)} events, no error event, "
        f"{n} rmpc bash invocation(s). Handing off to the transcript asserter."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
