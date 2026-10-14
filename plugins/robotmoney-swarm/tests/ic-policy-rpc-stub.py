#!/usr/bin/env python3
"""ic-policy-rpc-stub.py — a loopback JSON-RPC endpoint for run-tests.sh.

Canonical docs: plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
Review finding: DR-1 (docs/development/qa-plan-v1.md, task U1)

It answers exactly the reads `rmpc committee check-agent` makes, so the suite
can drive check-preflight.sh guard 3 through the REAL rmpc binary with no
chain:

  eth_chainId                                   -> --chain-id
  eth_blockNumber                               -> 0x2a
  eth_call to --ic-policy, COMMITTEE_AGENT_ROLE() -> keccak256("COMMITTEE_AGENT_ROLE")
  eth_call to --ic-policy, hasRole(that role, --agent) -> --has-role

Any other request (another method, another target, another role, another
account) gets a JSON-RPC error. rmpc then exits 3 and the preflight reports
AgentRoleUnreadable, so a stub that was asked the wrong question turns the
suite red; it can never answer "registered" by accident.

The two selectors and the role hash are constants because the Python standard
library has no keccak-256 (hashlib's sha3_256 is a different function). They
were computed with `cast sig` / `cast keccak` and match the forge artifact's
methodIdentifiers. A wrong constant fails closed, for the reason above.

Usage:
  ic-policy-rpc-stub.py --port N --chain-id N --ic-policy 0x.. --agent 0x.. \
                        --has-role true|false
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

COMMITTEE_AGENT_ROLE_SELECTOR = "0x4dfe6443"  # COMMITTEE_AGENT_ROLE()
HAS_ROLE_SELECTOR = "0x91d14854"  # hasRole(bytes32,address)
COMMITTEE_AGENT_ROLE = "fdd24b4fdb8d8be2e088bc71d69963abdfe748c97a21073f7919d8589fdef203"
BLOCK_NUMBER = "0x2a"


def word(value):
    """A 32-byte ABI word, hex without 0x."""
    return format(value, "064x")


def address_word(address):
    """An address as a left-padded 32-byte ABI word, hex without 0x."""
    hex_digits = address.lower()
    if hex_digits.startswith("0x"):
        hex_digits = hex_digits[2:]
    return hex_digits.rjust(64, "0")


def make_handler(args):
    ic_policy = args.ic_policy.lower()
    has_role_call = HAS_ROLE_SELECTOR + COMMITTEE_AGENT_ROLE + address_word(args.agent)
    has_role_answer = "0x" + word(1 if args.has_role == "true" else 0)

    def answer(method, params):
        """Return (result, error message). Exactly one is not None."""
        if method == "eth_chainId":
            return hex(args.chain_id), None
        if method == "eth_blockNumber":
            return BLOCK_NUMBER, None
        if method != "eth_call":
            return None, f"stub does not serve {method}"
        call = params[0] if params and isinstance(params[0], dict) else {}
        to = str(call.get("to", "")).lower()
        data = str(call.get("data", call.get("input", ""))).lower()
        if to != ic_policy:
            return None, f"eth_call to {to}, expected the IC policy {ic_policy}"
        if data == COMMITTEE_AGENT_ROLE_SELECTOR:
            return "0x" + COMMITTEE_AGENT_ROLE, None
        if data == has_role_call:
            return has_role_answer, None
        return None, f"unexpected eth_call data {data}"

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 (http.server naming)
            length = int(self.headers.get("Content-Length", "0"))
            try:
                request = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                request = {}
            result, error = answer(request.get("method"), request.get("params") or [])
            body = {"jsonrpc": "2.0", "id": request.get("id", 1)}
            if error is None:
                body["result"] = result
            else:
                body["error"] = {"code": -32601, "message": error}
            payload = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--chain-id", type=int, required=True)
    parser.add_argument("--ic-policy", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--has-role", choices=["true", "false"], required=True)
    args = parser.parse_args()
    HTTPServer(("127.0.0.1", args.port), make_handler(args)).serve_forever()


if __name__ == "__main__":
    main()
