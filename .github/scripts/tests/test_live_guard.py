"""Unit tests for the headless live-transcript loud-fail guard (issue #1151).

Canonical: docs/technical/opencode-headless-invocation.md §12.6.

`assert_headless_live_transcript.py` runs immediately after `opencode run` in the
suite-11b "Headless … run" steps. It exists because `opencode run` exits 0 even
when the hosted model session dies in a provider error with zero tool calls, so
the old `test -s` guard green-lit a dead transcript and the outage only surfaced
three steps later at the assert step. These tests pin BOTH branches so the guard
provably turns the step RED on a broken model path (loud-skip policy) and stays
green on a real, rmpc-driving session — the negative branches are what make this
an executed-in-CI guard rather than a silent green.

Fixtures (real `opencode run --format json` transcripts unless noted):
- ``headless-read-rmpc.json`` / ``headless-deposit-rmpc.json``: alive sessions
  that drove rmpc via the bash tool; the guard MUST pass.
- ``headless-error-only.json``: the exact single-`error` APIError transcript from
  the 2026-07-01 outage (issue #1151); the guard MUST fail on the error branch.
- ``headless-read-improvised.json``: an alive session that improvised with
  task/read tools and never ran rmpc; the guard MUST fail on the zero-rmpc branch.
- an empty transcript (written at runtime); the guard MUST fail.

The guard is invoked as a subprocess so the tests exercise the exact CLI contract
CI runs.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / ".github" / "scripts"
FIXTURES = SCRIPTS_DIR / "tests" / "fixtures"
GUARD = SCRIPTS_DIR / "assert_headless_live_transcript.py"


def _run(transcript: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GUARD), str(transcript)],
        capture_output=True,
        text=True,
    )


def test_alive_read_session_passes() -> None:
    """A read transcript that drove rmpc via bash must pass the guard."""
    result = _run(FIXTURES / "headless-read-rmpc.json")
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "rmpc bash invocation" in result.stdout


def test_alive_deposit_session_passes() -> None:
    """A deposit transcript that drove rmpc via bash must pass the guard."""
    result = _run(FIXTURES / "headless-deposit-rmpc.json")
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )


def test_error_only_transcript_fails_loudly() -> None:
    """The real APIError-only outage transcript must red the step."""
    result = _run(FIXTURES / "headless-error-only.json")
    assert result.returncode != 0, (
        "an error-only transcript MUST fail the guard (loud-skip policy)"
    )
    assert "error" in result.stderr.lower()
    assert "APIError" in result.stderr


def test_zero_rmpc_transcript_fails_loudly() -> None:
    """An alive-but-improvised session with zero rmpc calls must red the step."""
    result = _run(FIXTURES / "headless-read-improvised.json")
    assert result.returncode != 0, (
        "a zero-rmpc transcript MUST fail the guard (loud-skip policy)"
    )
    assert "zero" in result.stderr.lower()


def test_empty_transcript_fails_loudly(tmp_path: Path) -> None:
    """An empty transcript (no events at all) must red the step."""
    empty = tmp_path / "empty.json"
    empty.write_text("", encoding="utf-8")
    result = _run(empty)
    assert result.returncode != 0
    assert "empty" in result.stderr.lower()
