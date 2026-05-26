#!/usr/bin/env python3
"""Assert that the headless deposit transaction was signed by the
freshly-generated agent EOA (issue #469).

Canonical: docs/testing/headless-opencode-tests.md (G12).

Issue #469 acceptance criterion: the deposit's on-chain ``from`` address
must equal the generated key. Without this script, the suite passes even
if the deposit rides on a pre-baked Anvil account that happens to share
``AGENT_ROLE`` from a separate authorization — which would silently break
the proof that the create-key -> authorize -> deposit path uses one
identity end-to-end.

Inputs:
- ``--transcript``: NDJSON transcript from ``opencode run --format json``.
- ``--expected-sender``: 0x-prefixed 40-hex address that MUST equal the
  ``from`` field of the deposit transaction.
- ``--rpc-url``: JSON-RPC endpoint (typically the Anvil devnet) used to
  fetch the transaction by hash via ``eth_getTransactionByHash``.

The script:
1. Walks every NDJSON event in the transcript looking for a 0x-prefixed
   66-char hex string under any of the keys ``tx_hash``, ``txHash``,
   ``transaction_hash``, or ``hash`` that is associated with a deposit
   tool call (event body contains ``deposit`` somewhere). The first such
   hash is the deposit tx.
2. Queries ``eth_getTransactionByHash`` against ``--rpc-url`` to fetch
   the transaction's ``from`` field.
3. Case-insensitively compares ``from`` against ``--expected-sender``.
4. Exits 0 on match, non-zero otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path


HEX_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
HEX_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
TX_HASH_KEYS = ("tx_hash", "txHash", "transaction_hash", "hash")


def load_events(path: Path) -> list[dict]:
    """Load NDJSON events; skip blank/unparseable lines."""
    events: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def event_mentions_deposit(event: object) -> bool:
    """Return True if the event payload (as a serialized JSON string) contains
    the substring ``deposit`` — covers tool-call names, command lines, and
    final-report outcomes without binding to a specific schema."""
    return "deposit" in json.dumps(event).lower()


def find_deposit_tx_hash(events: list[dict]) -> str | None:
    """Scan transcript events for a 0x66-char tx hash on a deposit event."""
    for ev in events:
        if not event_mentions_deposit(ev):
            continue
        found = _find_hash(ev)
        if found is not None:
            return found
    return None


def _find_hash(obj: object) -> str | None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in TX_HASH_KEYS and isinstance(v, str) and HEX_TX_HASH_RE.match(v):
                return v
            found = _find_hash(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_hash(v)
            if found is not None:
                return found
    return None


def fetch_tx_sender(rpc_url: str, tx_hash: str) -> str:
    """Call eth_getTransactionByHash and return the ``from`` field."""
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getTransactionByHash",
            "params": [tx_hash],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if "error" in body:
        raise SystemExit(f"FAIL: eth_getTransactionByHash error: {body['error']}")
    result = body.get("result")
    if not isinstance(result, dict):
        raise SystemExit(
            f"FAIL: eth_getTransactionByHash returned no transaction for {tx_hash}"
        )
    sender = result.get("from")
    if not isinstance(sender, str) or not HEX_ADDR_RE.match(sender):
        raise SystemExit(f"FAIL: tx {tx_hash} has invalid 'from' field: {sender!r}")
    return sender


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transcript", required=True, type=Path)
    parser.add_argument("--expected-sender", required=True)
    parser.add_argument("--rpc-url", required=True)
    args = parser.parse_args(argv)

    if not HEX_ADDR_RE.match(args.expected_sender):
        print(
            f"FAIL: --expected-sender is not a 0x-prefixed 40-hex address: {args.expected_sender}",
            file=sys.stderr,
        )
        return 2

    if not args.transcript.is_file():
        print(f"FAIL: transcript file not found: {args.transcript}", file=sys.stderr)
        return 2

    events = load_events(args.transcript)
    if not events:
        print(f"FAIL: transcript has no events: {args.transcript}", file=sys.stderr)
        return 1

    tx_hash = find_deposit_tx_hash(events)
    if tx_hash is None:
        print("FAIL: no deposit tx hash found in transcript", file=sys.stderr)
        return 1

    sender = fetch_tx_sender(args.rpc_url, tx_hash)
    if sender.lower() != args.expected_sender.lower():
        print(
            f"FAIL: deposit tx {tx_hash} sender = {sender}, expected {args.expected_sender}",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: deposit tx {tx_hash} was signed by expected agent {args.expected_sender}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
