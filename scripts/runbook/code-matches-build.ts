// scripts/runbook/code-matches-build.ts: proves the runtime code at an address is a build artifact's, with immutables and library
// links masked (publish-contracts/src/verify/codehash.ts compareCode, the comparison deploy-implementation and the verifier use).
//   bun scripts/runbook/code-matches-build.ts --rpc URL --address 0x... --out BUILD/out --contract Name
// Exit 0 when it matches, 1 when it does not (the detail is printed), 2 on a usage error.
// Used by v0.9.0-onevault-upgrade P1.83 (ADR-0019) for the adapter implementation that forge create deploys.
import { parseArgs } from "node:util";
import { compareCode, loadArtifact } from "../../publish-contracts/src/verify/codehash.ts";

export async function codeAt(rpc: string, address: string): Promise<`0x${string}`> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (!j.result) throw new Error(`eth_getCode ${address}: ${j.error?.message ?? "no result"}`);
  return j.result as `0x${string}`;
}

if (import.meta.main) {
  const { values: v } = parseArgs({ options: { rpc: { type: "string" }, address: { type: "string" }, out: { type: "string" }, contract: { type: "string" } } });
  if (!v.rpc || !v.address || !v.out || !v.contract || !/^0x[0-9a-fA-F]{40}$/.test(v.address)) {
    console.error("usage: code-matches-build.ts --rpc URL --address 0x... --out BUILD/out --contract Name");
    process.exit(2);
  }
  const r = compareCode(await codeAt(v.rpc, v.address), loadArtifact(v.out, v.contract));
  console.log(`${v.contract} at ${v.address}: ${r.ok ? "matches the build" : "DIFFERS"} (${r.detail})`);
  process.exit(r.ok ? 0 : 1);
}
