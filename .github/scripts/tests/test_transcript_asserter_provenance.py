"""Plugin-provenance unit tests for the headless opencode asserter scripts.

Canonical: docs/testing/headless-opencode-tests.md (issue #461).

These tests pin the positive and negative branches of the new plugin-path
provenance check in both ``assert_headless_deposit_transcript.py`` and
``assert_headless_read_transcript.py``. The asserters are invoked as
subprocesses (rather than imported) so the tests exercise the exact CLI
contract that CI runs.
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
    # Drop GITHUB_WORKSPACE so tests are deterministic regardless of the
    # invoking shell — individual tests opt in to setting it.
    full_env.pop("GITHUB_WORKSPACE", None)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(script), str(FIXTURES / fixture)],
        capture_output=True,
        text=True,
        env=full_env,
    )


def test_deposit_repo_plugin_passes() -> None:
    """The in-repo plugin fixture must satisfy every deposit assertion."""
    result = _run(DEPOSIT, "headless-deposit-repo-plugin.json")
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "plugin loaded from" in result.stdout


def test_deposit_ambient_plugin_fails() -> None:
    """An ambient (~/.config/opencode/...) plugin path must be rejected."""
    result = _run(DEPOSIT, "headless-deposit-ambient-plugin.json")
    assert result.returncode != 0
    assert "ambient/global" in result.stderr


def test_read_repo_plugin_passes() -> None:
    """The in-repo plugin fixture must satisfy every read assertion."""
    result = _run(READ, "headless-read-repo-plugin.json")
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "plugin loaded from" in result.stdout


def test_read_ambient_plugin_fails() -> None:
    """An ambient (~/.config/opencode/...) plugin path must be rejected."""
    result = _run(READ, "headless-read-ambient-plugin.json")
    assert result.returncode != 0
    assert "ambient/global" in result.stderr


def test_deposit_workspace_strict_match() -> None:
    """When GITHUB_WORKSPACE is set, a path outside it must be rejected even
    though it ends in ``plugins/robotmoney-cli``.
    """
    # The repo fixture path is /workspace/plugins/robotmoney-cli; setting
    # GITHUB_WORKSPACE to a different root should fail the strict match.
    result = _run(
        DEPOSIT,
        "headless-deposit-repo-plugin.json",
        env={"GITHUB_WORKSPACE": "/some/other/root"},
    )
    assert result.returncode != 0
    assert "do not resolve to $GITHUB_WORKSPACE" in result.stderr


def test_deposit_workspace_strict_match_positive() -> None:
    """When GITHUB_WORKSPACE matches the fixture path prefix, the run passes."""
    result = _run(
        DEPOSIT,
        "headless-deposit-repo-plugin.json",
        env={"GITHUB_WORKSPACE": "/workspace"},
    )
    assert result.returncode == 0, (
        f"expected exit 0, got {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
    )
