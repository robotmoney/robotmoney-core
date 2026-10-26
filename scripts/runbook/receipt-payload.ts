#!/usr/bin/env bun
// scripts/runbook/receipt-payload.ts: the consensus receipt payload a Twin run records and applies (docs/runbooks/contract-qa/, phase 5 and the upgrade flow).
//   bun scripts/runbook/receipt-payload.ts --out FILE [--weights USDC:9500,PROTO:500,RWA:0]
// The envelope is the real production swarm receipt publish-contracts/tests/fixtures/real-consensus-receipt.canonical.json (session, subject, stances, judge,
// analyst signatures), as publish-contracts/src/ci/twin-publish.ts applies it. Its signed weights give the agent_tokens bucket 575 bps; rmAGENT is retired (ADR-0017),
// so the Twin applies the envelope with a three-vault vector (agent_tokens 0) instead. The Twin never verifies the analyst signatures: the receipt contract stores
// the digest and the apply row reads the weights. The file is one compact JSON object followed by exactly one newline (publish-contracts/src/receipt-digest.ts).
// On 8453 no payload is generated: the operator passes the receipt the canonical route serves (README "Placeholders", {receiptFile}). Exit 2 is a usage error.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ENVELOPE = join(ROOT, "publish-contracts", "tests", "fixtures", "real-consensus-receipt.canonical.json");
const BUCKET: Readonly<Record<string, string>> = { USDC: "conservative_defi_yield", PROTO: "protocol_tokens", AGENT: "agent_tokens", RWA: "real_world_assets" };
const ORDER = ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"];

/** PURE. The payload's weights list from `USDC:9500,PROTO:500,RWA:0`: every bucket, in the fixture's order, the unnamed ones at 0; the sum is 10000. */
export function weightsOf(spec: string): { bucket: string; weight_bps: number }[] {
  const bps: Record<string, number> = Object.fromEntries(ORDER.map((b) => [b, 0]));
  for (const part of spec.split(",")) {
    const [key, v] = part.split(":");
    const bucket = BUCKET[key ?? ""];
    if (!bucket || !/^\d+$/.test(v ?? "")) throw new Error(`--weights is KEY:BPS pairs with KEY one of ${Object.keys(BUCKET).join(", ")}, got '${part}'`);
    bps[bucket] = Number(v);
  }
  const sum = Object.values(bps).reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new Error(`--weights sum to ${sum}, not 10000`);
  return ORDER.map((bucket) => ({ bucket, weight_bps: bps[bucket]! }));
}

/** PURE. The canonical payload bytes: the envelope with these weights, compact, one trailing newline. */
export function payloadOf(envelope: Record<string, unknown>, weights: { bucket: string; weight_bps: number }[]): string {
  return `${JSON.stringify({ ...envelope, weights })}\n`;
}

function main(argv: string[]): number {
  try {
    let out: string | undefined, weights = "USDC:9500,PROTO:500,RWA:0";
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--out") out = argv[++i];
      else if (argv[i] === "--weights") weights = argv[++i] ?? "";
      else throw new Error(`unknown argument '${argv[i]}'`);
    }
    if (!out) throw new Error("--out FILE is required");
    writeFileSync(out, payloadOf(JSON.parse(readFileSync(ENVELOPE, "utf8")) as Record<string, unknown>, weightsOf(weights)));
    return 0;
  } catch (e) {
    console.error(`receipt-payload: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
