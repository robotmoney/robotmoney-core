"""Self-test for the suite-11b keypair parser and its Foundry pin (issue
#1682, QA plan v1 U2).

Canonical: docs/development/ci-suites.md §11 (opencode-headless) and
"Foundry version".

`parse_cast_wallet_new.py` is what the deposit replay job's "Generate fresh
agent keypair and keystore" step runs on `cast wallet new --json`. cast 1.8
wrapped the wallet in a `schema_version` envelope where cast 1.7.1 printed a
bare array, and the old `jq '.[0].private_key'` read kept the job red from
2026-09-05. These tests pin:

- Every known shape parses to the same address and 0x-prefixed key: the
  cast >= 1.8 envelope, the cast <= 1.7.1 array, and a bare wallet object.
- A missing address or key, a malformed address or key, an empty wallet
  list, an envelope with `success: false`, and non-JSON each exit non-zero
  with a reason, and no reason ever echoes the private key.
- The workflow step reads the wallet through this parser (never `.[0]`), the
  deposit job's twin-publish step runs govern (rmUSDC deploys paused, so
  self-check and deposit refuse with ErrDepositsPaused without it), and the
  job's Foundry install and the twin-fork action pin ONE exact release (a
  floating `stable` is how the shape change arrived unreviewed).

The parser is invoked as a subprocess with the wallet on stdin, the exact
interface the workflow uses.

The wallet is Hardhat/anvil test account #0 (published, allowlisted in
.gitleaks.toml). It guards nothing on any real network.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
PARSER = REPO_ROOT / ".github" / "scripts" / "parse_cast_wallet_new.py"
SUITE_11B = REPO_ROOT / ".github" / "workflows" / "suite-11b-opencode-headless.yml"
TWIN_FORK_ACTION = REPO_ROOT / ".github" / "actions" / "twin-fork" / "action.yml"

ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# cast 1.8 also prints the uncompressed public key. The parser ignores it, so a
# placeholder of the right length keeps the fixture shape real.
PUBLIC_KEY = "0x" + "ab" * 64

EXACT_RELEASE_RE = re.compile(r"^v\d+\.\d+\.\d+$")
FOUNDRY_ACTION = "foundry-rs/foundry-toolchain@"


def _wallet(**overrides: object) -> dict:
    entry: dict = {"address": ADDRESS, "public_key": PUBLIC_KEY, "private_key": KEY}
    for k, v in overrides.items():
        if v is None:
            entry.pop(k, None)
        else:
            entry[k] = v
    return entry


def _envelope(data: object, success: bool = True, errors: list | None = None) -> dict:
    """The cast >= 1.8 shape, as cast 1.8.3 prints it."""
    return {"schema_version": 1, "success": success, "data": data, "errors": errors or [], "warnings": []}


def _run(field: str, text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(PARSER), "--field", field],
        input=text,
        capture_output=True,
        text=True,
    )


def _assert_parses(text: str) -> None:
    addr = _run("address", text)
    assert addr.returncode == 0, f"stdout={addr.stdout}\nstderr={addr.stderr}"
    assert addr.stdout.strip() == ADDRESS
    key = _run("private_key", text)
    assert key.returncode == 0, f"stderr={key.stderr}"
    assert key.stdout.strip() == KEY


def _assert_refused(text: str, reason: str) -> None:
    for field in ("address", "private_key"):
        result = _run(field, text)
        assert result.returncode == 1, f"field={field} exit={result.returncode} stdout={result.stdout}"
        assert result.stdout == "", f"field={field} printed {result.stdout!r} on a refused input"
        assert reason in result.stderr, f"field={field} stderr={result.stderr!r} lacks {reason!r}"
        # No refusal may carry key material: not the key, and not a near-key run of hex either.
        assert KEY[2:].lower() not in result.stderr.lower(), "a refusal echoed the private key"
        assert not re.search(r"[0-9a-fA-F]{60,}", result.stderr), f"a refusal echoed key-length hex: {result.stderr!r}"


# ---- shapes that must parse -------------------------------------------------


def test_envelope_shape_cast_1_8_parses() -> None:
    _assert_parses(json.dumps(_envelope([_wallet()])))


def test_array_shape_cast_1_7_parses() -> None:
    _assert_parses(json.dumps([{"address": ADDRESS, "private_key": KEY}]))


def test_bare_object_shape_parses() -> None:
    _assert_parses(json.dumps({"address": ADDRESS, "private_key": KEY}))


def test_pretty_printed_envelope_parses() -> None:
    _assert_parses(json.dumps(_envelope([_wallet()]), indent=2) + "\n")


def test_key_without_0x_prefix_comes_back_prefixed() -> None:
    _assert_parses(json.dumps(_envelope([_wallet(private_key=KEY[2:])])))


# ---- shapes that must be refused --------------------------------------------


def test_missing_private_key_is_refused() -> None:
    _assert_refused(json.dumps(_envelope([_wallet(private_key=None)])), "no private_key")
    _assert_refused(json.dumps([{"address": ADDRESS}]), "no private_key")


def test_missing_address_is_refused() -> None:
    _assert_refused(json.dumps(_envelope([_wallet(address=None)])), "no address")


def test_malformed_address_is_refused() -> None:
    _assert_refused(json.dumps(_envelope([_wallet(address="0x1234")])), "address is not 0x plus 40 hex digits")
    _assert_refused(json.dumps([{"address": ADDRESS[2:], "private_key": KEY}]), "address is not 0x plus 40 hex digits")


def test_malformed_private_key_is_refused_without_echoing_it() -> None:
    # One hex digit short: close enough to a key that an echo would leak most of it.
    _assert_refused(json.dumps(_envelope([_wallet(private_key=KEY[:-1])])), "value withheld")
    _assert_refused(json.dumps(_envelope([_wallet(private_key=KEY + "00")])), "value withheld")


def test_empty_wallet_list_is_refused() -> None:
    _assert_refused(json.dumps(_envelope([])), "no wallet")
    _assert_refused(json.dumps([]), "no wallet")


def test_envelope_reporting_failure_is_refused() -> None:
    _assert_refused(json.dumps(_envelope([], success=False, errors=["rng unavailable"])), "success=false")


def test_envelope_data_not_a_list_is_refused() -> None:
    _assert_refused(json.dumps(_envelope(_wallet())), "expected a list of wallets")


def test_non_json_is_refused_without_echoing_it() -> None:
    # Truncated output that still carries the key: the reason names the JSON error, never the text.
    truncated = json.dumps(_envelope([_wallet()]))[:-5]
    _assert_refused(truncated, "not JSON")
    _assert_refused("", "not JSON")


def test_scalar_json_is_refused() -> None:
    _assert_refused(json.dumps("0xdeadbeef"), "expected an object or an array")


# ---- the workflow wiring this parser exists for -----------------------------


def _steps(doc: dict) -> list[tuple[str, dict]]:
    """(owner, step) for every step of a workflow's jobs or a composite action."""
    out: list[tuple[str, dict]] = []
    for job_id, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            out.append((f"job {job_id}", step))
    for step in (doc.get("runs") or {}).get("steps") or []:
        out.append(("composite action", step))
    return out


def _foundry_pins(path: Path) -> list[tuple[str, object]]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [
        (owner, (step.get("with") or {}).get("version"))
        for owner, step in _steps(doc)
        if str(step.get("uses", "")).startswith(FOUNDRY_ACTION)
    ]


def test_suite_11b_and_twin_fork_pin_one_exact_foundry_release() -> None:
    pins = {path: _foundry_pins(path) for path in (SUITE_11B, TWIN_FORK_ACTION)}
    versions: set[str] = set()
    for path, found in pins.items():
        rel = path.relative_to(REPO_ROOT)
        assert found, f"{rel} installs no Foundry (expected at least one {FOUNDRY_ACTION} step)"
        for owner, version in found:
            assert isinstance(version, str) and EXACT_RELEASE_RE.match(version), (
                f"{rel} ({owner}) installs Foundry version {version!r}; pin an exact release tag like v1.8.5, "
                "never stable, nightly or an omitted version (issue #1682)"
            )
            versions.add(version)
    # The deposit job installs Foundry, then twin-fork installs it again and wins on PATH, so the
    # cast that prints the wallet is twin-fork's. Two different pins would test a version nobody reviewed.
    assert len(versions) == 1, f"suite-11b and twin-fork pin different Foundry releases: {sorted(versions)}"


def test_keypair_step_reads_the_wallet_through_the_parser() -> None:
    doc = yaml.safe_load(SUITE_11B.read_text(encoding="utf-8"))
    steps = {step.get("name"): step for step in doc["jobs"]["deposit"]["steps"]}
    script = steps["Generate fresh agent keypair and keystore"]["run"]
    assert "cast wallet new --json" in script
    assert "parse_cast_wallet_new.py --field private_key" in script
    assert "parse_cast_wallet_new.py --field address" in script
    assert ".[0].private_key" not in script and ".[0].address" not in script, "the step reads the wallet with a shape-bound jq path again"


def test_deposit_job_publish_runs_govern_so_rmusdc_is_unpaused() -> None:
    doc = yaml.safe_load(SUITE_11B.read_text(encoding="utf-8"))
    publish = [s for s in doc["jobs"]["deposit"]["steps"] if s.get("uses") == "./.github/actions/twin-publish"]
    assert len(publish) == 1, f"expected one twin-publish step in the deposit job, found {len(publish)}"
    assert (publish[0].get("with") or {}).get("govern") == "true", (
        "the deposit job's twin-publish step must pass govern: \"true\": every vault deploys paused and "
        "self-check/deposit refuse with ErrDepositsPaused until stage 13 unpauses rmUSDC"
    )
