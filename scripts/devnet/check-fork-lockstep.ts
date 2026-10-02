#!/usr/bin/env bun
/**
 * Block lockstep check (core 1498): CURRENT.json, fork-block.json and genesis-alloc.json
 * must describe the same Base block, by number AND hash.
 *
 *   CURRENT.json                      fork_block, fork_block_hash
 *   fork-block.json                   block_number, block_hash
 *   genesis-alloc.block.json (sidecar) block_number, block_hash, alloc_sha256 of genesis-alloc.json
 *
 * genesis-alloc.json is an address map the ingester writes, so it cannot carry a block field.
 * The snapshot writes the sidecar next to it and this check binds the sidecar to the alloc bytes.
 *
 * Usage: bun scripts/devnet/check-fork-lockstep.ts [--fork-state DIR] [--config DIR]
 * Exit 0 when all three agree; non-zero naming every disagreement.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(import.meta.path), "..", "..");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const stateDir = resolve(REPO, arg("--fork-state", "testing/fixtures/fork-state"));
const cfgDir = resolve(REPO, arg("--config", "testing/ethereum-testnet/config"));

export function lockstepErrors(cur: any, fb: any, side: any, allocBytes: Buffer): string[] {
  const errs: string[] = [];
  const HASH = /^0x[0-9a-f]{64}$/i;
  const want = (cond: boolean, msg: string) => { if (!cond) errs.push(msg); };
  want(Number.isInteger(cur?.fork_block), "CURRENT.json has no fork_block");
  want(HASH.test(String(cur?.fork_block_hash)), "CURRENT.json has no 32-byte fork_block_hash");
  want(Number.isInteger(fb?.block_number), "fork-block.json has no block_number");
  want(HASH.test(String(fb?.block_hash)), "fork-block.json has no 32-byte block_hash");
  want(Number.isInteger(side?.block_number), "genesis-alloc.block.json has no block_number");
  want(HASH.test(String(side?.block_hash)), "genesis-alloc.block.json has no 32-byte block_hash");
  if (errs.length) return errs;
  want(cur.fork_block === fb.block_number, `block number differs: CURRENT.json ${cur.fork_block} vs fork-block.json ${fb.block_number}`);
  want(side.block_number === fb.block_number, `block number differs: genesis-alloc ${side.block_number} vs fork-block.json ${fb.block_number}`);
  want(cur.fork_block_hash.toLowerCase() === fb.block_hash.toLowerCase(), `block hash differs: CURRENT.json ${cur.fork_block_hash} vs fork-block.json ${fb.block_hash}`);
  want(side.block_hash.toLowerCase() === fb.block_hash.toLowerCase(), `block hash differs: genesis-alloc ${side.block_hash} vs fork-block.json ${fb.block_hash}`);
  want(side.alloc_sha256 === createHash("sha256").update(allocBytes).digest("hex"), "genesis-alloc.json bytes do not match alloc_sha256 in genesis-alloc.block.json");
  return errs;
}

if (import.meta.main) {
  const rd = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const errs = lockstepErrors(
    rd(join(stateDir, "CURRENT.json")),
    rd(join(cfgDir, "fork-block.json")),
    rd(join(stateDir, "genesis-alloc.block.json")),
    readFileSync(join(stateDir, "genesis-alloc.json")),
  );
  if (errs.length) {
    for (const e of errs) console.error(`FAIL: ${e}`);
    process.exit(1);
  }
  console.log("ok: CURRENT.json, fork-block.json and genesis-alloc.json agree on block number and hash");
}
