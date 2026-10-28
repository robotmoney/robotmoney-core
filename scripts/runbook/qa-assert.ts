#!/usr/bin/env bun
// scripts/runbook/qa-assert.ts: the small assertions the contract QA runbook (docs/runbooks/contract-qa/) makes between two commands.
//   bun scripts/runbook/qa-assert.ts eq A B                 exit 0 when the two values are equal (case-insensitive, first token of each)
//   bun scripts/runbook/qa-assert.ts ge A B                 exit 0 when integer A >= integer B
//   bun scripts/runbook/qa-assert.ts within-bps A B BPS     exit 0 when |A - B| <= B * BPS / 10000 (integers)
//   bun scripts/runbook/qa-assert.ts receipt-id FILE        prints the receipt id of a consensus receipt file (publish-contracts/src/receipt-digest.ts)
//   bun scripts/runbook/qa-assert.ts receipt-digest FILE    prints its payload digest (domain line plus bytes, never a plain keccak256)
//   bun scripts/runbook/qa-assert.ts sub A B                prints A - B (integers); exit 1 when A < B (a share balance that fell)
//   bun scripts/runbook/qa-assert.ts router-legs DEPOSIT WEIGHTS TOPIC
//                                                           exit 0 when the router deposit receipt DEPOSIT (cast send --json) is status 0x1 and its RouterDeposit
//                                                           logs (topic0 TOPIC) are exactly one per non-zero weight of WEIGHTS (cast call getEffectiveWeights()), each
//                                                           naming that vault with that weightBps and minting shares; prints the legs
//   bun scripts/runbook/qa-assert.ts legs-differ PRE POST TOPIC
//                                                           exit 0 when the legs (vault and weightBps) of two router deposit receipts differ: the split changed
//   bun scripts/runbook/qa-assert.ts receipt-changes-split RECEIPT WEIGHTS
//                                                           exit 0 when the receipt file's vault vector (agent_tokens dropped, bucket order) differs from the bps of
//                                                           WEIGHTS (the effective vector before the rebalance; another length differs), so applying it changes the router split (issue 1984)
// A value read from `cast call` looks like "1000000 [1e6]": the first whitespace-separated token is the value. Exit 1 is a failed
// assertion, exit 2 a usage error. No secret is read or written.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const VERBS = ["eq", "ge", "within-bps", "receipt-id", "receipt-digest", "sub", "router-legs", "legs-differ", "receipt-changes-split"] as const;

/** The first token of a value as cast prints it ("1000000 [1e6]" is 1000000). */
export const firstToken = (s: string): string => s.trim().split(/\s+/)[0] ?? "";

const big = (s: string, what: string): bigint => {
  const t = firstToken(s);
  if (!/^-?[0-9]+$/.test(t)) throw new Error(`${what} is not an integer: '${s}'`);
  return BigInt(t);
};

/** PURE. Why the assertion fails, or undefined when it holds. Throws on a usage error. */
export function assertion(verb: string, args: string[]): string | undefined {
  if (verb === "eq") {
    if (args.length !== 2) throw new Error("eq needs A B");
    const [a, b] = args.map((x) => firstToken(x).toLowerCase());
    return a === b ? undefined : `${a} != ${b}`;
  }
  if (verb === "ge") {
    if (args.length !== 2) throw new Error("ge needs A B");
    const [a, b] = [big(args[0]!, "A"), big(args[1]!, "B")];
    return a >= b ? undefined : `${a} < ${b}`;
  }
  if (verb === "within-bps") {
    if (args.length !== 3) throw new Error("within-bps needs A B BPS");
    const [a, b, bps] = [big(args[0]!, "A"), big(args[1]!, "B"), big(args[2]!, "BPS")];
    if (a === b) return undefined;
    const diff = a > b ? a - b : b - a;
    return diff * 10000n <= (b < 0n ? -b : b) * bps ? undefined : `|${a} - ${b}| exceeds ${bps} bps of ${b}`;
  }
  throw new Error(`unknown verb '${verb}'`);
}

/** PURE. The vaults and bps of a `cast call ... "getEffectiveWeights()(address[],uint256[])"` answer: the address list, then the bps list (cast may annotate a
 *  value of 10000 or more as "10000 [1e4]"). Throws when it is not two parallel lists. */
export function parseWeights(text: string): { vaults: string[]; bps: bigint[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length !== 2) throw new Error(`a weights answer is two lines (vaults, bps), got ${lines.length}`);
  const vaults = [...lines[0]!.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());
  const inner = lines[1]!.replace(/^\[/, "").replace(/\]$/, "").replace(/\s*\[[^\]]*\]/g, "");
  const bps = inner.split(",").map((x) => x.trim()).filter((x) => x !== "").map((x) => { if (!/^[0-9]+$/.test(x)) throw new Error(`a weight is not an integer: '${x}'`); return BigInt(x); });
  if (vaults.length === 0 || vaults.length !== bps.length) throw new Error(`a weights answer names ${vaults.length} vaults and ${bps.length} weights`);
  return { vaults, bps };
}

export interface RouterLeg { vault: string; amount: bigint; shares: bigint; weightBps: bigint }
/** PURE. The RouterDeposit legs of a `cast send --json` receipt: topic0 is the event, topic2 the vault, the data amount, shares and weightBps. Throws unless status is 0x1. */
export function routerLegsOf(receiptJson: string, topic: string): RouterLeg[] {
  const r = JSON.parse(receiptJson) as { status?: string; logs?: { topics?: string[]; data?: string }[] };
  if (r.status !== "0x1") throw new Error(`the router deposit receipt has status ${String(r.status)}, not 0x1`);
  const t = topic.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error(`the RouterDeposit topic is not a 32-byte hash: '${topic}'`);
  return (r.logs ?? []).filter((l) => (l.topics?.[0] ?? "").toLowerCase() === t).map((l) => {
    const data = (l.data ?? "").replace(/^0x/, "");
    const vaultTopic = (l.topics?.[2] ?? "").toLowerCase();
    if (data.length !== 192 || !/^0x[0-9a-f]{64}$/.test(vaultTopic)) throw new Error("a RouterDeposit log is not (depositor, vault; amount, shares, weightBps)");
    const word = (i: number): bigint => BigInt(`0x${data.slice(i * 64, (i + 1) * 64)}`);
    return { vault: `0x${vaultTopic.slice(26)}`, amount: word(0), shares: word(1), weightBps: word(2) };
  });
}

const legKey = (vault: string, bps: bigint): string => `${vault.toLowerCase()}:${bps}`;

/** PURE. Why the legs of a router deposit do not follow the weights: one leg per non-zero weight, that vault at that weight, none for a zero weight, shares minted. */
export function routerLegProblems(legs: RouterLeg[], w: { vaults: string[]; bps: bigint[] }): string[] {
  const out: string[] = [];
  const want = w.vaults.map((v, i) => legKey(v, w.bps[i]!)).filter((_, i) => w.bps[i]! !== 0n).sort();
  const got = legs.map((l) => legKey(l.vault, l.weightBps)).sort();
  if (want.join(",") !== got.join(",")) out.push(`the router deposit legs [${got.join(", ")}] are not the non-zero effective weights [${want.join(", ")}]`);
  for (const l of legs) if (l.amount === 0n || l.shares === 0n) out.push(`the leg into ${l.vault} moved ${l.amount} USDC for ${l.shares} shares`);
  return out;
}

/** PURE. The vault vector of a receipt payload: its weights in file order, agent_tokens dropped (the order P5.04 and P8.24 compare with the router's). */
export function receiptVector(receiptText: string): bigint[] {
  const r = JSON.parse(receiptText) as { weights?: { bucket?: string; weight_bps?: number }[] };
  if (!Array.isArray(r.weights)) throw new Error("the receipt has no weights list");
  return r.weights.filter((x) => x.bucket !== "agent_tokens").map((x) => BigInt(x.weight_bps ?? Number.NaN));
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...args] = argv;
  try {
    if (verb === "receipt-id" || verb === "receipt-digest") {
      if (args.length !== 1) throw new Error(`${verb} needs FILE`);
      const lib = await import(resolve(import.meta.dir, "../../publish-contracts/src/receipt-digest.ts"));
      const bytes = new Uint8Array(readFileSync(args[0]!));
      const out = verb === "receipt-id" ? lib.receiptIdOfBytes(bytes) : lib.receiptPayloadDigest(bytes);
      if (!out) throw new Error(`${args[0]} carries no session_id and subject_id`);
      console.log(out);
      return 0;
    }
    if (verb === "sub") {
      if (args.length !== 2) throw new Error("sub needs A B");
      const [a, b] = [big(args[0]!, "A"), big(args[1]!, "B")];
      if (a < b) { console.error(`qa-assert sub: ${a} < ${b}`); return 1; }
      console.log((a - b).toString());
      return 0;
    }
    if (verb === "router-legs") {
      if (args.length !== 3) throw new Error("router-legs needs DEPOSIT WEIGHTS TOPIC");
      const legs = routerLegsOf(readFileSync(args[0]!, "utf8"), args[2]!);
      const why = routerLegProblems(legs, parseWeights(readFileSync(args[1]!, "utf8")));
      for (const l of legs) console.log(`leg ${l.vault} weightBps ${l.weightBps} amount ${l.amount} shares ${l.shares}`);
      if (why.length > 0) { for (const w of why) console.error(`qa-assert router-legs: ${w}`); return 1; }
      return 0;
    }
    if (verb === "legs-differ") {
      if (args.length !== 3) throw new Error("legs-differ needs PRE POST TOPIC");
      const [pre, post] = [args[0]!, args[1]!].map((f) => routerLegsOf(readFileSync(f, "utf8"), args[2]!).map((l) => legKey(l.vault, l.weightBps)).sort().join(","));
      console.log(`before ${pre}`);
      console.log(`after ${post}`);
      if (pre === "" || post === "") { console.error("qa-assert legs-differ: a router deposit has no RouterDeposit leg"); return 1; }
      if (pre === post) { console.error(`qa-assert legs-differ: the router split did not change across the rebalance (${pre})`); return 1; }
      return 0;
    }
    if (verb === "receipt-changes-split") {
      if (args.length !== 2) throw new Error("receipt-changes-split needs RECEIPT WEIGHTS");
      const want = receiptVector(readFileSync(args[0]!, "utf8"));
      const have = parseWeights(readFileSync(args[1]!, "utf8")).bps;
      console.log(`receipt ${want.join(",")} router ${have.join(",")}`);
      // A vector of another length is another split: the receipt's legs cannot be the router's (P5.04 and P8.24 then read the applied vector back).
      if (want.length !== have.length) { console.log(`the receipt weights ${want.length} vault buckets, the router's vector has ${have.length} legs: the split changes`); return 0; }
      if (want.join(",") === have.join(",")) { console.error(`qa-assert receipt-changes-split: the receipt's vector ${want.join(",")} is the router's effective vector before the rebalance, so applying it cannot show the split change; get a receipt with another vector before it is recorded`); return 1; }
      return 0;
    }
    const why = assertion(verb ?? "", args);
    if (why) { console.error(`qa-assert ${verb}: ${why}`); return 1; }
    return 0;
  } catch (e) {
    console.error(`qa-assert: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
