#!/usr/bin/env python3
"""Recorded-transcript replay harness for suite-11b's deposit/read jobs
(issue #1210 option C; re-enablement issue #1233).

Canonical: docs/development/ci-suites.md §11,
docs/technical/opencode-headless-invocation.md §12.6.

WHY THIS EXISTS

Issue #1210 found that the hosted anonymous OpenCode tier no longer executes
any model, so `opencode run` cannot drive `rmpc` without a paid
`OPENCODE_API_KEY` (option A) that this repository does not provision. Option
C replaces the live model with a deterministic replay of the SAME rmpc
command sequence the disabled jobs' prompts always named explicitly (see the
now-removed `PROMPT=` strings in git history) — the prompts already fully
determined the command, its flags, and its order; the model's only real job
was reading the prompt and invoking `bash` with that exact string. This
script performs that invocation directly, for real, against the same live
devnet the disabled jobs booted, and emits a transcript in the exact NDJSON
shape `opencode run --format json` produces (see §12.3), so every downstream
assertion script (`assert_headless_live_transcript.py`,
`assert_headless_{deposit,read}_transcript.py`,
`assert_headless_deposit_{delta,sender}.py`) runs completely unchanged
against a genuinely fresh, real transcript every run.

WHAT THIS DOES NOT PROVE

This is a scripted replay, not a live model invocation. It proves the rmpc
CLI contract (syntax, exit codes, output schema) and the full
deploy -> authorize -> deposit pipeline still work end-to-end, but it cannot
prove that an actual LLM, given the natural-language prompt, would still
choose this exact tool sequence — that is model/prompt-adherence coverage,
and it requires a live model (option A). This loss is the accepted cost of
option C (issue #1210).

Usage:
    python3 replay_headless_transcript.py --steps-file <steps.json> --out <transcript.ndjson>

`steps.json` is a JSON list of {"description": str, "command": str} objects,
executed in order via `bash -c <command>`. Each command is captured into a
`tool_use` event matching opencode 1.16.x's real schema. Execution stops at
the first non-zero exit (mirroring an agent that would not proceed past a
failed precondition) and the script exits non-zero — loud-fail, never a
silent partial success.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path


def run_step(description: str, command: str) -> tuple[dict, bool]:
    """Run one replay step and return (tool_use event, ok)."""
    start = time.time()
    proc = subprocess.run(
        ["bash", "-c", command],
        capture_output=True,
        text=True,
    )
    end = time.time()
    ok = proc.returncode == 0

    event = {
        "type": "tool_use",
        "part": {
            "type": "tool",
            "tool": "bash",
            "title": description,
            "state": {
                "status": "completed",
                "input": {"command": command, "description": description},
                "output": proc.stdout,
                "metadata": {
                    "exit": proc.returncode,
                    "output": proc.stdout,
                    "description": description,
                },
            },
            "time": {"start": int(start * 1000), "end": int(end * 1000)},
        },
    }

    print(f"[replay] {description}: exit={proc.returncode}")
    if proc.stderr.strip():
        print(proc.stderr, file=sys.stderr)

    return event, ok


def replay(steps: list[dict], out_path: Path) -> bool:
    """Execute every step in order, writing an NDJSON transcript to out_path.

    Stops at the first failing step. Returns True iff every executed step
    (i.e. all of them) exited 0.
    """
    events: list[dict] = []
    overall_ok = True

    for step in steps:
        description = step["description"]
        command = step["command"]
        event, ok = run_step(description, command)
        events.append(event)
        if not ok:
            overall_ok = False
            print(
                f"FAIL: replay step {description!r} ({command!r}) exited non-zero; "
                "stopping replay — a real agent would not proceed past a failed "
                "precondition either.",
                file=sys.stderr,
            )
            break

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for event in events:
            f.write(json.dumps(event) + "\n")

    print(f"Wrote {len(events)} replayed tool_use event(s) to {out_path}")
    return overall_ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--steps-file",
        required=True,
        type=Path,
        help="JSON file: a list of {description, command} objects, executed in order.",
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Path to write the replayed NDJSON transcript to.",
    )
    args = parser.parse_args()

    if not args.steps_file.is_file():
        print(f"FAIL: steps file not found: {args.steps_file}", file=sys.stderr)
        return 1

    try:
        steps = json.loads(args.steps_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL: steps file is not valid JSON: {exc}", file=sys.stderr)
        return 1

    if not isinstance(steps, list) or not steps:
        print("FAIL: steps file must contain a non-empty JSON list", file=sys.stderr)
        return 1
    for step in steps:
        if (
            not isinstance(step, dict)
            or not isinstance(step.get("description"), str)
            or not isinstance(step.get("command"), str)
        ):
            print(
                f"FAIL: malformed step (expected {{description, command}} strings): {step!r}",
                file=sys.stderr,
            )
            return 1

    ok = replay(steps, args.out)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
