#!/usr/bin/env bun
// scripts/runbook/qa-assert.ts: the small assertions the contract QA runbook (docs/runbooks/contract-qa/) makes between two commands.
//   bun scripts/runbook/qa-assert.ts eq A B                 exit 0 when the two values are equal (case-insensitive, first token of each)
//   bun scripts/runbook/qa-assert.ts ge A B                 exit 0 when integer A >= integer B
//   bun scripts/runbook/qa-assert.ts within-bps A B BPS     exit 0 when |A - B| <= B * BPS / 10000 (integers)
//   bun scripts/runbook/qa-assert.ts receipt-id FILE        prints the receipt id of a consensus receipt file (publish-contracts/src/receipt-digest.ts)
//   bun scripts/runbook/qa-assert.ts receipt-digest FILE    prints its payload digest (domain line plus bytes, never a plain keccak256)
// A value read from `cast call` looks like "1000000 [1e6]": the first whitespace-separated token is the value. Exit 1 is a failed
// assertion, exit 2 a usage error. No secret is read or written.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const VERBS = ["eq", "ge", "within-bps", "receipt-id", "receipt-digest"] as const;

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
    const why = assertion(verb ?? "", args);
    if (why) { console.error(`qa-assert ${verb}: ${why}`); return 1; }
    return 0;
  } catch (e) {
    console.error(`qa-assert: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
