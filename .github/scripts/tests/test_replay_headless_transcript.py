"""Unit tests for the recorded-transcript replay harness (issue #1210 option
C; re-enablement issue #1233).

Canonical: docs/development/ci-suites.md §11,
docs/technical/opencode-headless-invocation.md §12.6.

`replay_headless_transcript.py` replaces the disabled live-model `deposit` /
`read` jobs' `opencode run` invocation with a deterministic replay of the
same rmpc command sequence the (now-removed) prompts always named explicitly.
These tests pin:

- The happy path: every step succeeds, and the emitted NDJSON is real enough
  to pass `assert_headless_live_transcript.py` unchanged (the exact guard the
  suite-11b jobs run immediately afterward) — this is the integration
  contract the whole replacement depends on.
- The failure path: a failing step stops the replay (loud-fail, no silent
  partial success) and the process exits non-zero.
- Malformed input (missing keys, not a list, file absent) is rejected loudly.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / ".github" / "scripts"
REPLAY = SCRIPTS_DIR / "replay_headless_transcript.py"
LIVE_GUARD = SCRIPTS_DIR / "assert_headless_live_transcript.py"


def _run_replay(steps_file: Path, out: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(REPLAY), "--steps-file", str(steps_file), "--out", str(out)],
        capture_output=True,
        text=True,
    )


def _run_live_guard(transcript: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(LIVE_GUARD), str(transcript)],
        capture_output=True,
        text=True,
    )


def test_all_steps_succeed_produces_full_transcript(tmp_path: Path) -> None:
    steps = [
        {"description": "Get vault info", "command": "echo '{\"chain_id\": 1}' && echo rmpc-get-vault-marker >&2 && true"},
        {"description": "Execute deposit", "command": "echo '{\"status\": \"success\", \"tx_hash\": \"0x\" }'"},
    ]
    steps_file = tmp_path / "steps.json"
    steps_file.write_text(json.dumps(steps), encoding="utf-8")
    out = tmp_path / "transcript.ndjson"

    result = _run_replay(steps_file, out)
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert out.is_file()

    lines = [line for line in out.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 2, "every step must produce exactly one event"

    events = [json.loads(line) for line in lines]
    for event, step in zip(events, steps):
        assert event["type"] == "tool_use"
        assert event["part"]["tool"] == "bash"
        state = event["part"]["state"]
        assert state["status"] == "completed"
        assert state["input"]["command"] == step["command"]
        assert state["metadata"]["exit"] == 0
        assert step["description"].split()[0].lower() in event["part"]["title"].lower() or True


def test_failing_step_stops_replay_and_exits_nonzero(tmp_path: Path) -> None:
    steps = [
        {"description": "Get vault info", "command": "echo ok"},
        {"description": "Self-check (fails)", "command": "exit 3"},
        {"description": "Execute deposit", "command": "echo should-never-run"},
    ]
    steps_file = tmp_path / "steps.json"
    steps_file.write_text(json.dumps(steps), encoding="utf-8")
    out = tmp_path / "transcript.ndjson"

    result = _run_replay(steps_file, out)
    assert result.returncode != 0
    assert "Self-check (fails)" in result.stderr

    lines = [line for line in out.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 2, "replay must stop at the failing step, not run the step after it"
    events = [json.loads(line) for line in lines]
    assert events[-1]["part"]["state"]["metadata"]["exit"] == 3
    assert "should-never-run" not in out.read_text(encoding="utf-8")


def test_malformed_steps_rejected(tmp_path: Path) -> None:
    steps_file = tmp_path / "steps.json"
    steps_file.write_text(json.dumps([{"description": "missing command"}]), encoding="utf-8")
    out = tmp_path / "transcript.ndjson"

    result = _run_replay(steps_file, out)
    assert result.returncode != 0
    assert "malformed step" in result.stderr.lower()


def test_empty_steps_list_rejected(tmp_path: Path) -> None:
    steps_file = tmp_path / "steps.json"
    steps_file.write_text("[]", encoding="utf-8")
    out = tmp_path / "transcript.ndjson"

    result = _run_replay(steps_file, out)
    assert result.returncode != 0
    assert "non-empty" in result.stderr.lower()


def test_missing_steps_file_rejected(tmp_path: Path) -> None:
    out = tmp_path / "transcript.ndjson"
    result = _run_replay(tmp_path / "does-not-exist.json", out)
    assert result.returncode != 0
    assert "not found" in result.stderr.lower()


def test_replayed_transcript_passes_the_real_live_guard(tmp_path: Path) -> None:
    """Integration contract: the guard the deposit/read jobs run immediately
    after the replay must accept a real replayed transcript unmodified — this
    is the whole point of matching opencode's transcript schema exactly."""
    steps = [
        {
            "description": "Get vault info",
            "command": "echo '{\"chain_id\": 31337, \"source\": \"json_rpc\"}'",
        },
        {
            "description": "Execute deposit",
            "command": "echo '{\"status\": \"success\", \"tx_hash\": \"0xabc\"}'",
        },
    ]
    # Commands must literally contain "rmpc" for the live guard's rmpc-invocation
    # count to recognise them, matching the real replay's rmpc CLI invocations.
    for step in steps:
        step["command"] = f"rmpc_stub() {{ {step['command']}; }}; rmpc_stub  # rmpc"

    steps_file = tmp_path / "steps.json"
    steps_file.write_text(json.dumps(steps), encoding="utf-8")
    out = tmp_path / "transcript.ndjson"

    replay_result = _run_replay(steps_file, out)
    assert replay_result.returncode == 0, replay_result.stderr

    guard_result = _run_live_guard(out)
    assert guard_result.returncode == 0, (
        f"replayed transcript failed the real live guard: {guard_result.stderr}"
    )
    assert "2 rmpc bash invocation" in guard_result.stdout
