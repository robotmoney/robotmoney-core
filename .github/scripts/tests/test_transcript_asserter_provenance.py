"""rmpc-provenance unit tests for the headless opencode asserter scripts.

Canonical: docs/technical/opencode-headless-invocation.md (issues #908/#909).

These tests pin the positive and negative branches of the reconciled
provenance check in both ``assert_headless_deposit_transcript.py`` and
``assert_headless_read_transcript.py``. The old check required an in-repo
``--plugin`` path event that opencode never emits (the in-repo bundle is a
SKILL bundle, not an opencode JS plugin) and matched a ``tool.result`` schema
opencode does not produce. The reconciled asserters instead verify that the
required reads — and, for the deposit, the broadcast — were genuinely driven
through the ``rmpc`` binary via opencode's real ``tool_use`` (bash) events.

All fixtures are real ``opencode run --format json`` transcripts:
- ``headless-read-rmpc.json`` / ``headless-deposit-rmpc.json``: captured from
  runs whose explicit prompt drove rmpc; these MUST pass.
- ``headless-read-improvised.json`` / ``headless-deposit-improvised.json``:
  captured from the original vague-prompt CI runs where the agent improvised
  with task/read tools and never ran rmpc; these MUST fail provenance.
- ``headless-read-forbidden-host.json``: a positive read transcript with an
  explorer host injected into tool output; MUST fail the forbidden-host check.

The asserters are invoked as subprocesses (rather than imported) so the tests
exercise the exact CLI contract that CI runs.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / ".github" / "scripts"
FIXTURES = SCRIPTS_DIR / "tests" / "fixtures"

DEPOSIT = SCRIPTS_DIR / "assert_headless_deposit_transcript.py"
READ = SCRIPTS_DIR / "assert_headless_read_transcript.py"


def _run(script: Path, fixture: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run an asserter script against a fixture and capture stdout/stderr."""
    full_env = os.environ.copy()
    full_env.pop("GITHUB_WORKSPACE", None)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(script), str(FIXTURES / fixture)],
        capture_output=True,
        text=True,
        env=full_env,
    )


# ── Read asserter ──────────────────────────────────────────────────────────────


def test_read_rmpc_transcript_passes() -> None:
    """A real read transcript that drove rmpc via the bash tool must pass."""
    result = _run(READ, "headless-read-rmpc.json")
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "driven through the rmpc binary" in result.stdout


def test_read_improvised_transcript_fails() -> None:
    """An improvised transcript (task/read tools, no rmpc) must fail provenance."""
    result = _run(READ, "headless-read-improvised.json")
    assert result.returncode != 0
    # The agent never ran rmpc, so at least get-vault provenance must fail.
    assert "rmpc get-vault" in result.stderr


def test_read_forbidden_host_fails() -> None:
    """A read transcript that references an explorer host must be rejected."""
    result = _run(READ, "headless-read-forbidden-host.json")
    assert result.returncode != 0
    assert "forbidden host" in result.stderr


# ── Deposit asserter ───────────────────────────────────────────────────────────


def test_deposit_rmpc_transcript_passes() -> None:
    """A real deposit transcript (read prefix in order + rmpc deposit success)
    must satisfy every deposit assertion."""
    result = _run(DEPOSIT, "headless-deposit-rmpc.json")
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "rmpc deposit broadcast a real tx" in result.stdout


def test_deposit_improvised_transcript_fails() -> None:
    """An improvised deposit transcript (no rmpc deposit) must fail."""
    result = _run(DEPOSIT, "headless-deposit-improvised.json")
    assert result.returncode != 0
    # No rmpc read prefix and no rmpc deposit were run.
    assert "rmpc" in result.stderr
