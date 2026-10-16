#!/usr/bin/env python3
"""Read the agent keypair out of `cast wallet new --json` for suite-11b's
deposit replay job (issue #1682, QA plan v1 U2).

Canonical: docs/development/ci-suites.md §11 (opencode-headless) and
"Foundry version".

WHY THIS EXISTS

Foundry changed the shape of `cast wallet new --json` with no change in this
repository:

    cast <= 1.7.1   [{"address": "0x…", "private_key": "0x…"}]
    cast >= 1.8     {"schema_version": 1, "success": true,
                     "data": [{"address": "0x…", "public_key": "0x…",
                               "private_key": "0x…"}],
                     "errors": [], "warnings": []}

The workflow read the key with `jq -r '.[0].private_key'`. On the 1.8
envelope jq exits 5 ("Cannot index object with number"), so the step
"Generate fresh agent keypair and keystore" was red on every run from
2026-09-05 (the first run on cast 1.8.1). This script accepts the envelope,
the old array and a bare wallet object, and fails loudly on anything else.
The job now also pins Foundry at an exact release (see the self-test), so a
future shape change arrives through a reviewed pin bump, not a silent
`stable` release.

WHAT IT CHECKS

- The input is JSON, and the envelope (when present) does not report
  `success: false`.
- There is at least one wallet entry. The first one is used, the same entry
  the old `.[0]` read.
- `address` is 0x plus 40 hex digits.
- `private_key` is 32 bytes of hex (0x prefix optional on input, always
  present on output).

It does not prove the key derives the address (the standard library has no
secp256k1). The workflow proves that right after: `rmpc-keystore-import`
derives the address from the key, and the step fails unless it equals the
address this script printed.

SECRET HANDLING

The key is read from stdin, never from an argument or a file. It is printed
only as the requested field on stdout, which the caller captures and masks.
No error message contains it.

Usage:
    cast wallet new --json | python3 parse_cast_wallet_new.py --field address
    cast wallet new --json | python3 parse_cast_wallet_new.py --field private_key

Exit 0 with the field on stdout. Exit 1 with a reason on stderr.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
PRIVATE_KEY_RE = re.compile(r"^(?:0x)?[0-9a-fA-F]{64}$")


class WalletParseError(ValueError):
    """The cast output is not a usable wallet. The message never holds the key."""


def _wallet_entries(doc: Any) -> list:
    """Return the wallet list from any of the three known shapes."""
    if isinstance(doc, list):
        # cast <= 1.7.1: a bare array of wallets.
        return doc
    if isinstance(doc, dict) and "data" in doc:
        # cast >= 1.8: the schema_version envelope.
        if doc.get("success") is False:
            errors = doc.get("errors")
            raise WalletParseError(f"cast reported success=false (errors: {json.dumps(errors)})")
        entries = doc["data"]
        if not isinstance(entries, list):
            raise WalletParseError(f"envelope `data` is a {type(entries).__name__}, expected a list of wallets")
        return entries
    if isinstance(doc, dict):
        # A bare wallet object (the shape issue #1682 first suspected).
        return [doc]
    raise WalletParseError(f"top-level JSON is a {type(doc).__name__}, expected an object or an array")


def parse_wallet(text: str) -> tuple[str, str]:
    """Return (address, 0x-prefixed private key) or raise WalletParseError."""
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        # exc.msg and the position only: the raw text may hold a key.
        raise WalletParseError(f"output is not JSON ({exc.msg} at line {exc.lineno} column {exc.colno})") from None

    entries = _wallet_entries(doc)
    if not entries:
        raise WalletParseError("output holds no wallet (empty list)")
    entry = entries[0]
    if not isinstance(entry, dict):
        raise WalletParseError(f"wallet entry is a {type(entry).__name__}, expected an object")

    address = entry.get("address")
    if not isinstance(address, str) or not address:
        raise WalletParseError("wallet entry has no address")
    if not ADDRESS_RE.match(address):
        raise WalletParseError(f"address is not 0x plus 40 hex digits: {address!r}")

    key = entry.get("private_key")
    if not isinstance(key, str) or not key:
        raise WalletParseError("wallet entry has no private_key")
    if not PRIVATE_KEY_RE.match(key):
        raise WalletParseError("private_key is not 32 bytes of hex (value withheld)")
    if not key.startswith("0x"):
        key = "0x" + key
    return address, key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print one field of `cast wallet new --json` read from stdin.")
    parser.add_argument("--field", required=True, choices=("address", "private_key"))
    args = parser.parse_args(argv)
    try:
        address, key = parse_wallet(sys.stdin.read())
    except WalletParseError as exc:
        print(f"FAIL: cast wallet new --json: {exc}", file=sys.stderr)
        return 1
    print(address if args.field == "address" else key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
