#!/usr/bin/env python3
"""Assert that an OpenCode headless read transcript contains required rmpc tool calls.

Issue #908/#909 — reconciled with the REAL opencode `run --format json`
transcript schema (opencode 1.16.x). The previous version of this script
asserted against a `tool.result`/`exit_code`/`partial: true` shape and an
`--plugin "$PWD/..."` provenance event that opencode never emits. opencode's
actual NDJSON stream uses `tool_use` events whose payload lives under
`part.state` (see `find_rmpc_call`), and the in-repo SKILL bundle is NOT an
opencode JS plugin (opencode logs `Plugin export is not a function`), so no
in-repo plugin path can ever appear in stdout. The agent therefore drives
rmpc through the `bash` tool, which is what this asserter now verifies.

Acceptance criteria (reconciled):

  (A) Transcript contains an `rmpc get-vault` bash tool call that completed
      with exit 0 and stdout that parses as valid JSON with chain_id,
      block_number, source keys (the §9 read envelope).

  (B) Transcript contains an `rmpc get-gateway` bash tool call that completed
      with exit 0 and stdout that parses as a §9 read envelope whose
      `source == "json_rpc"` (proves the read came from rmpc's direct
      JSON-RPC reader, not an explorer or improvised tool).

  (C) No event in the transcript references an explorer API or the dapp
      (guards against the skill leaking outside the json_rpc source).

  (P) Provenance: every required read was actually performed by invoking the
      `rmpc` binary via the bash tool (not improvised with glob/read/web),
      and the rmpc output envelope carries `source: "json_rpc"`. This is the
      reconciled, opencode-real replacement for the old in-repo-plugin-path
      check — it proves the agent genuinely ran rmpc against the live chain.

Usage:
    python3 assert_headless_read_transcript.py <transcript.ndjson>

The transcript is the newline-delimited JSON event stream produced by
`opencode run --format json`. Each line is one JSON object. The script
exits 0 on pass, non-zero on any assertion failure.
"""

from __future__ import annotations

import json
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


def tool_command(event: dict) -> str | None:
    """Return the shell command string for an opencode `tool_use` bash event.

    opencode 1.16.x emits `{"type": "tool_use", "part": {"tool": "bash",
    "state": {"status": "completed", "input": {"command": "..."},
    "metadata": {"exit": 0, "output": "..."}, "output": "..."}}}`.
    """
    if event.get("type") != "tool_use":
        return None
    part = event.get("part")
    if not isinstance(part, dict) or part.get("tool") != "bash":
        return None
    state = part.get("state")
    if not isinstance(state, dict):
        return None
    inp = state.get("input")
    if isinstance(inp, dict):
        cmd = inp.get("command")
        if isinstance(cmd, str):
            return cmd
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


def find_rmpc_call(events: list[dict], command_fragment: str) -> dict | None:
    """Return the first completed `rmpc <command_fragment>` bash tool_use event
    with exit code 0.

    Matches opencode's real `tool_use` schema (not the non-existent
    `tool.result`/`exit_code` shape). Requires the command to actually invoke
    the `rmpc` binary so an improvised glob/read/web tool can never satisfy
    the assertion.
    """
    for ev in events:
        cmd = tool_command(ev)
        if cmd is None or "rmpc" not in cmd or command_fragment not in cmd:
            continue
        state = ev.get("part", {}).get("state", {})
        if state.get("status") != "completed":
            continue
        if tool_exit_code(ev) != 0:
            continue
        return ev
    return None


def extract_stdout(event: dict) -> str | None:
    """Return the bash tool stdout from `part.state.output` (or metadata.output)."""
    state = event.get("part", {}).get("state", {})
    if not isinstance(state, dict):
        return None
    for val in (state.get("output"), state.get("metadata", {}).get("output")
                if isinstance(state.get("metadata"), dict) else None):
        if isinstance(val, str) and val.strip():
            return val
    return None


def assert_get_vault(events: list[dict]) -> list[str]:
    failures: list[str] = []
    ev = find_rmpc_call(events, "get-vault")
    if ev is None:
        failures.append(
            "FAIL (A): no completed 'rmpc get-vault' bash tool_use event with "
            "exit 0 found"
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
    ev = find_rmpc_call(events, "get-gateway")
    if ev is None:
        failures.append(
            "FAIL (B): no completed 'rmpc get-gateway' bash tool_use event with "
            "exit 0 found"
        )
        return failures

    stdout = extract_stdout(ev)
    if stdout is None:
        failures.append(
            "FAIL (B): rmpc get-gateway tool_use event has no recognisable stdout"
        )
        return failures

    parsed = parse_json_from_output(stdout)
    if parsed is None:
        failures.append(
            f"FAIL (B): rmpc get-gateway stdout does not contain valid JSON.\n"
            f"  stdout preview: {stdout[:200]!r}"
        )
        return failures

    # The §9 read envelope marks every direct-chain read with
    # source == "json_rpc". This is the real, opencode-emitted signal that the
    # gateway state was read from chain by rmpc (not an explorer or improvised
    # tool). The old `partial: true` requirement was wrong: a single-snapshot
    # gateway read with no failed sub-reads returns partial == false.
    if parsed.get("source") != "json_rpc":
        failures.append(
            f"FAIL (B): rmpc get-gateway JSON source={parsed.get('source')!r} "
            f"(expected 'json_rpc')"
        )
    for key in ("chain_id", "block_number"):
        if key not in parsed:
            failures.append(
                f"FAIL (B): rmpc get-gateway JSON envelope missing required key '{key}'"
            )

    return failures


# Reads the agent must have driven through the rmpc binary for this run to
# count as a genuine rmpc exercise (not improvised glob/read/web tools).
REQUIRED_RMPC_READS: list[str] = ["get-vault", "get-gateway", "get-balance"]


def assert_rmpc_provenance(events: list[dict]) -> list[str]:
    """Reconciled provenance check (replaces the old in-repo-plugin-path assert).

    The in-repo ``plugins/robotmoney-user`` bundle is a SKILL bundle, not an
    opencode JS plugin, so opencode cannot register it as a tool and never
    emits an in-repo plugin path in the ``--format json`` stdout. Asserting on
    that path was structurally unsatisfiable. The real, opencode-observable
    proof that this run exercised rmpc is: every required read was issued as a
    completed ``rmpc <cmd>`` bash tool call (exit 0) whose stdout is a §9
    ``source: "json_rpc"`` envelope. That proves the agent actually ran the
    rmpc binary against the live chain rather than improvising with generic
    tools or an explorer.
    """
    failures: list[str] = []
    for cmd in REQUIRED_RMPC_READS:
        ev = find_rmpc_call(events, cmd)
        if ev is None:
            failures.append(
                f"FAIL (P): no completed 'rmpc {cmd}' bash tool_use event with "
                f"exit 0 — the agent did not drive rmpc for this read (it must "
                f"invoke the rmpc binary, not improvise with glob/read/web)."
            )
            continue
        stdout = extract_stdout(ev)
        parsed = parse_json_from_output(stdout) if stdout else None
        if parsed is None or parsed.get("source") != "json_rpc":
            failures.append(
                f"FAIL (P): 'rmpc {cmd}' stdout is not a json_rpc read envelope "
                f"(source={parsed.get('source') if parsed else None!r}); cannot "
                f"confirm rmpc read the live chain."
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
    failures += assert_rmpc_provenance(events)

    if failures:
        for msg in failures:
            print(msg, file=sys.stderr)
        return 1

    print("OK: rmpc get-vault called with exit 0, valid JSON envelope.")
    print("OK: rmpc get-gateway called with exit 0, source=json_rpc envelope.")
    print("OK: no forbidden explorer/dapp hosts in transcript.")
    print("OK: required reads driven through the rmpc binary (json_rpc source).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
