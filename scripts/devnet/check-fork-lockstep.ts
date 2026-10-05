#!/usr/bin/env bun
/**
 * Block lockstep check (core 1498): CURRENT.json and fork-block.json must describe the same Base
 * block, by number AND hash.
 *
 *   CURRENT.json    fork_block, fork_block_hash
 *   fork-block.json block_number, block_hash
 *
 * (The genesis-alloc.json leg is gone with the genesis ingester: the Twin chain is a lazy fork of
 * real Base, not a genesis built from a committed snapshot.)
 *
 * Usage: bun scripts/devnet/check-fork-lockstep.ts [--fork-state DIR] [--config DIR]
 * Exit 0 when both agree; non-zero naming every disagreement.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(import.meta.path), "..", "..");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const stateDir = resolve(REPO, arg("--fork-state", "testing/fixtures/fork-state"));
const cfgDir = resolve(REPO, arg("--config", "testing/ethereum-testnet/config"));

export function lockstepErrors(cur: any, fb: any): string[] {
  const errs: string[] = [];
  const HASH = /^0x[0-9a-f]{64}$/i;
  const want = (cond: boolean, msg: string) => { if (!cond) errs.push(msg); };
  want(Number.isInteger(cur?.fork_block), "CURRENT.json has no fork_block");
  want(HASH.test(String(cur?.fork_block_hash)), "CURRENT.json has no 32-byte fork_block_hash");
  want(Number.isInteger(fb?.block_number), "fork-block.json has no block_number");
  want(HASH.test(String(fb?.block_hash)), "fork-block.json has no 32-byte block_hash");
  if (errs.length) return errs;
  want(cur.fork_block === fb.block_number, `block number differs: CURRENT.json ${cur.fork_block} vs fork-block.json ${fb.block_number}`);
  want(cur.fork_block_hash.toLowerCase() === fb.block_hash.toLowerCase(), `block hash differs: CURRENT.json ${cur.fork_block_hash} vs fork-block.json ${fb.block_hash}`);
  return errs;
}

if (import.meta.main) {
  const rd = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const errs = lockstepErrors(rd(join(stateDir, "CURRENT.json")), rd(join(cfgDir, "fork-block.json")));
  if (errs.length) {
    for (const e of errs) console.error(`FAIL: ${e}`);
    process.exit(1);
  }
  console.log("ok: CURRENT.json and fork-block.json agree on block number and hash");
}
