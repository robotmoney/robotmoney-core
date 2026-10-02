#!/usr/bin/env bun
/**
 * Assert the nightly snapshot really is fresh (core issue 1496, job (b)).
 *
 * Reads snapshot-manifest.json written by nightly-fresh-snapshot.ts and fails
 * unless the snapshot block's own timestamp is within MAX_AGE_SECONDS (default
 * 3600, one hour) of now. It also checks the manifest carries a block number,
 * a 32-byte block hash and a timestamp, and, when --suite-results DIR is given,
 * that each expected suite wrote a result file and none of them failed.
 * Replaces what would have been a shell check; no network, no secret.
 *
 * Usage:
 *   bun scripts/devnet/check-nightly-fresh-snapshot.ts --manifest FILE
 *        [--max-age-seconds N] [--now EPOCH] [--suite-results DIR]
 *
 * Exit: 0 fresh; 1 stale or malformed; 2 bad usage.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const manifestPath = opt("--manifest");
if (!manifestPath) {
  console.error("usage: check-nightly-fresh-snapshot.ts --manifest FILE [--max-age-seconds N] [--now EPOCH] [--suite-results DIR]");
  process.exit(2);
}
const maxAge = Number(opt("--max-age-seconds") ?? process.env.MAX_AGE_SECONDS ?? 3600);
const now = Number(opt("--now") ?? Math.floor(Date.now() / 1000));

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

if (!existsSync(manifestPath)) fail(`manifest ${manifestPath} does not exist`);
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Number.isInteger(m.block_number) || m.block_number <= 0) fail("manifest has no block_number");
if (!/^0x[0-9a-fA-F]{64}$/.test(String(m.block_hash))) fail("manifest block_hash is not a 32-byte hex hash");
if (!Number.isInteger(m.block_timestamp) || m.block_timestamp <= 0) fail("manifest has no block_timestamp");

const age = now - m.block_timestamp;
if (age < -300) fail(`block ${m.block_number} is ${-age}s in the future; clock or manifest is wrong`);
if (age > maxAge) fail(`block ${m.block_number} is ${age}s old, older than the ${maxAge}s limit; the snapshot is not at the latest block`);
console.log(`OK: block ${m.block_number} (${m.block_hash}) is ${age}s old, within ${maxAge}s`);

const dir = opt("--suite-results");
if (dir) {
  const expected = ["5", "7", "8", "10", "11b", "14"];
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const bad: string[] = [];
  for (const s of expected) {
    const f = files.find((n) => n === `suite-${s}.json`);
    if (!f) {
      bad.push(`suite ${s}: no result file`);
      continue;
    }
    const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (r.result !== "success") bad.push(`suite ${s}: ${r.result}`);
  }
  if (bad.length) fail(bad.join("; "));
  console.log(`OK: all ${expected.length} chain suites succeeded`);
}
