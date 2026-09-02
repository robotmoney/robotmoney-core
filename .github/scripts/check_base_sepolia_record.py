#!/usr/bin/env python3
"""Validate the Base Sepolia deployment record format (issue #1303).

The ceremony writes the Base Sepolia deployment record to
`deployments/base-sepolia.json`. This validator enforces the record contract:

* `chain_id` is exactly `84532` (Base Sepolia) — never the devnet id or mainnet.
* Every address field is present, lowercase `0x`-prefixed, and a valid 20-byte
  address.
* The record carries a `rehearsal: true` marker, so it can never be mistaken
  for, or point at, a mainnet "live" deployment.
* A `deployed_at` timestamp and `rpc`/`network` fields are mandatory, so the
  record is auditable.
* No field text contains a forbidden "live"/"mainnet"/"production" claim about
  the deployment itself.

Exits non-zero on any violation. Called by `suite-13-doc-checks.yml` (or the
rehearsal suite) so a malformed or false-green record cannot merge silently.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CHAIN_ID = 84532
CANONICAL_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
ADDRESS_RE = re.compile(r"^0x[0-9a-f]{40}$")
HEX_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# Address fields that must be present, in addition to the scalar fields.
REQUIRED_ADDRESS_FIELDS = [
    "admin",
    "pauser",
    "agent",
    "share_receiver",
    "usdc",
    "vault",
    "gateway",
    "registry",
    "portfolio_router",
    "router_governance",
    "aave_adapter",
    "compound_adapter",
    "morpho_adapter",
    "timelock",
    "ic_policy",
    "consensus_receipt",
]

# Phrases that would imply this rehearsal is a live/mainnet/production system.
FORBIDDEN_CLAIM_WORDS = ["mainnet", "production", " live ", "live funds", "real funds"]


def fail(msg: str) -> None:
    print(f"FAIL: base-sepolia record: {msg}", file=sys.stderr)
    raise SystemExit(1)


def validate(path: Path) -> None:
    if not path.is_file():
        fail(f"record not found at {path}; has the ceremony been run?")

    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON: {exc}")

    if not isinstance(data, dict):
        fail("record must be a JSON object")

    chain_id = data.get("chain_id")
    if chain_id != CHAIN_ID:
        fail(f"chain_id {chain_id!r} != {CHAIN_ID} (Base Sepolia)")

    if data.get("rehearsal") is not True:
        fail("record must set \"rehearsal\": true to be distinguishable from a live deployment")

    network = data.get("network")
    if network not in ("base-sepolia", "base_sepolia"):
        fail(f"network {network!r} must be base-sepolia")

    for field in ("deployed_at", "rpc"):
        if not data.get(field):
            fail(f"missing required scalar field '{field}'")

    usdc = data.get("usdc")
    if usdc and usdc.lower() != CANONICAL_USDC:
        print(
            f"WARN: usdc {usdc} != canonical Base Sepolia USDC {CANONICAL_USDC}; "
            "proceed only if you intentionally bound a non-canonical token",
            file=sys.stderr,
        )

    for field in REQUIRED_ADDRESS_FIELDS:
        if field not in data:
            fail(f"missing required address field '{field}'")
        value = data[field]
        if not isinstance(value, str) or not HEX_ADDRESS_RE.match(value):
            fail(f"field '{field}' = {value!r} is not a valid 0x hex address")
        if value != value.lower():
            fail(f"field '{field}' must be lowercase hex (got mixed-case {value!r})")

    # Any non-address, non-scalar claims field must not contain forbidden phrasing.
    raw = path.read_text().lower()
    for word in FORBIDDEN_CLAIM_WORDS:
        if word in raw:
            fail(f"record text contains forbidden claim word {word!r}")

    print(f"OK: base-sepolia record at {path} is well-formed and rehearsal-marked")


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    default = repo_root / "deployments" / "base-sepolia.example.json"
    rec = Path(sys.argv[1]) if len(sys.argv) > 1 else default
    validate(rec)


if __name__ == "__main__":
    main()
