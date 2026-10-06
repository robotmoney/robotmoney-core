#!/usr/bin/env bun
// Operator helpers that used to be shell scripts. No secret is read or written.
//   bun src/ops/cli.ts derive-agents --rpc URL --gateway 0x.. --deployer 0x.. --from-block N
//   bun src/ops/cli.ts fee-estimate  --rpc URL --broadcast-dir DIR [--margin 5] [--balance NAME=0x..]...
//   bun src/ops/cli.ts sourcify-submit --core-dir DIR [--broadcast-dir DIR]
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { deriveAgents } from "./derive-agents.ts";
import { balanceShort, estimateFees } from "./fee-estimate.ts";
import { submitToSourcify } from "./sourcify-submit.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values: v } = parseArgs({
  args: rest,
  options: { rpc: { type: "string" }, gateway: { type: "string" }, deployer: { type: "string" }, "from-block": { type: "string" }, "broadcast-dir": { type: "string" },
    margin: { type: "string" }, balance: { type: "string", multiple: true }, "core-dir": { type: "string" } },
});
const need = (k: string) => { const x = (v as Record<string, unknown>)[k]; if (!x) { console.error(`missing --${k}`); process.exit(2); } return x as string; };

if (cmd === "derive-agents") {
  const list = await deriveAgents({ rpc: need("rpc"), gateway: getAddress(need("gateway")), deployer: getAddress(need("deployer")), fromBlock: BigInt(need("from-block")) });
  console.log(list.length ? list.join(",") : "none");
} else if (cmd === "fee-estimate") {
  const e = await estimateFees({ rpc: need("rpc"), broadcastDir: need("broadcast-dir"), margin: v.margin ? BigInt(v.margin) : undefined });
  console.log(`live prices: L2 gas price ${e.gasPrice} wei; L1 base fee ${e.l1BaseFee} wei; blob base fee ${e.blobBaseFee} wei`);
  for (const s of e.stages) console.log(`${s.stage.padEnd(34)} ${String(s.txs).padStart(4)} ${s.gas} ${s.l2Wei} ${s.l1Wei}`);
  console.log(`TOTAL ${e.totalWei} wei; RECOMMEND ${e.recommendWei} wei (margin ${e.margin}x)`);
  const accounts: Record<string, `0x${string}`> = {};
  for (const b of v.balance ?? []) { const [n, a] = b.split("="); accounts[n!] = getAddress(a!); }
  const short = await balanceShort(need("rpc"), accounts, e.recommendWei);
  if (short.length) { console.error(`balance short: ${short.join(", ")}`); process.exit(1); }
} else if (cmd === "sourcify-submit") {
  const r = await submitToSourcify({ coreDir: need("core-dir"), broadcastDir: v["broadcast-dir"] });
  console.log(`submitted ${r.submitted}`);
  for (const f of r.failed) console.error(`FAILED: ${f}`);
  process.exit(r.failed.length ? 1 : 0);
} else { console.error("usage: derive-agents | fee-estimate | sourcify-submit"); process.exit(2); }
