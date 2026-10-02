#!/usr/bin/env bun
/**
 * Offline selftest for the Twin chain snapshot tooling (core issue 1498).
 *
 *   - rpc() retries on HTTP 429 and on a rate-limit JSON-RPC error, gives up
 *     after the attempt budget, and does NOT retry a plain JSON-RPC error.
 *   - snapshot-fork.ts (and any leftover snapshot-fork.sh) contains no
 *     Deploy.s.sol or forge-script invocation: no Robot Money contract may be
 *     deployed into the snapshot. The check fails if one is added.
 *   - the warm list and contents check name the V3 factory, SwapRouter02 and
 *     the deSPXA pool, and the contents check refuses Robot Money code.
 *
 * No network beyond a localhost stub, no Docker, no anvil.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESPXA_POOL, REPO, SWAP_ROUTER02, V3_FACTORY, INFRA_ADDRESSES, loadConfiguredPools, rpc } from "./fork-snapshot-lib.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};
const quiet = { log: () => {}, baseDelayMs: 1 };

// ── 429 retry ────────────────────────────────────────────────────────────────
let hits = 0;
let mode: "429-then-ok" | "always-429" | "rate-json" | "plain-error" = "429-then-ok";
const server = Bun.serve({
  port: 0,
  fetch() {
    hits++;
    const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (mode === "always-429") return new Response("slow down", { status: 429 });
    if (mode === "429-then-ok") return hits <= 2 ? new Response("slow down", { status: 429 }) : json({ jsonrpc: "2.0", id: 1, result: "0x10" });
    if (mode === "rate-json") return hits <= 1 ? json({ jsonrpc: "2.0", id: 1, error: { message: "Too Many Requests" } }) : json({ jsonrpc: "2.0", id: 1, result: "0x11" });
    return json({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } });
  },
});
const url = `http://127.0.0.1:${server.port}`;

hits = 0; mode = "429-then-ok";
check((await rpc(url, "eth_blockNumber", [], { ...quiet, maxAttempts: 5 })) === "0x10" && hits === 3, `retries HTTP 429 until it succeeds (hits=${hits})`);
hits = 0; mode = "rate-json";
check((await rpc(url, "eth_blockNumber", [], { ...quiet, maxAttempts: 5 })) === "0x11" && hits === 2, "retries a rate-limit JSON-RPC error");
hits = 0; mode = "always-429";
let threw = false;
try { await rpc(url, "eth_blockNumber", [], { ...quiet, maxAttempts: 3 }); } catch { threw = true; }
check(threw && hits === 3, `gives up after the attempt budget (hits=${hits})`);
hits = 0; mode = "plain-error";
threw = false;
try { await rpc(url, "eth_call", [], { ...quiet, maxAttempts: 5 }); } catch { threw = true; }
check(threw && hits === 1, "does not retry a plain JSON-RPC error");
server.stop(true);

// ── no Deploy.s.sol in the snapshot ─────────────────────────────────────────
const stripComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join("\n");
for (const f of ["scripts/devnet/snapshot-fork.ts", "scripts/devnet/snapshot-fork.sh", "scripts/devnet/fork-snapshot-lib.ts"]) {
  const p = join(REPO, f);
  if (!existsSync(p)) continue;
  const code = stripComments(readFileSync(p, "utf8"));
  check(!/Deploy[A-Za-z]*\.s\.sol|forge\s+script|"forge"/.test(code), `${f} runs no Deploy*.s.sol or forge script`);
}
check(!existsSync(join(REPO, "scripts/devnet/snapshot-fork.sh")), "snapshot-fork.sh is gone (job moved to snapshot-fork.ts)");
check(/\.tsx?"|snapshot-fork\.ts/.test(readFileSync(join(REPO, "scripts/devnet/snapshot-fork.ts"), "utf8")) , "snapshot-fork.ts present");

// ── warm list ──────────────────────────────────────────────────────────────
const warm = new Set(INFRA_ADDRESSES.map(([x]) => x.toLowerCase()));
check(warm.has(V3_FACTORY.toLowerCase()), "warm list has the Uniswap V3 factory");
check(warm.has(SWAP_ROUTER02.toLowerCase()), "warm list has SwapRouter02");
const pools = loadConfiguredPools().map((p) => p.pool.toLowerCase());
check(pools.includes(DESPXA_POOL.toLowerCase()), "configured pools include the deSPXA pool");
check(pools.length >= 3, `configured pools: ${pools.length}`);

const contents = readFileSync(join(REPO, "scripts/devnet/check-fork-snapshot-contents.ts"), "utf8");
check(/robotMoneyAddresses/.test(contents) && /fail\(`Robot Money contract has code/.test(contents), "contents check fails on Robot Money code at genesis");

// ── block lockstep (number and hash) ───────────────────────────────────────
{
  const { lockstepErrors } = await import("./check-fork-lockstep.ts");
  const H = "0x" + "ab".repeat(32);
  const alloc = Buffer.from("{}");
  const sha = createHash("sha256").update(alloc).digest("hex");
  const cur = { fork_block: 10, fork_block_hash: H };
  const fb = { block_number: 10, block_hash: H };
  const side = { block_number: 10, block_hash: H, alloc_sha256: sha };
  check(lockstepErrors(cur, fb, side, alloc).length === 0, "lockstep: matching number and hash pass");
  check(lockstepErrors(cur, { ...fb, block_hash: "0x" + "cd".repeat(32) }, side, alloc).length > 0, "lockstep: a differing hash fails");
  check(lockstepErrors({ ...cur, fork_block: 11 }, fb, side, alloc).length > 0, "lockstep: a differing number fails");
  check(lockstepErrors(cur, fb, side, Buffer.from("{\"x\":1}")).length > 0, "lockstep: edited alloc bytes fail");
  check(lockstepErrors({ fork_block: 10 }, fb, side, alloc).length > 0, "lockstep: missing CURRENT.json hash fails");
}

if (failures > 0) {
  console.error(`${failures} selftest assertion(s) failed`);
  process.exit(1);
}
console.log("snapshot-fork selftest passed");
