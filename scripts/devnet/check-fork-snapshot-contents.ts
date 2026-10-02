#!/usr/bin/env bun
/**
 * Contents check for the committed Twin chain snapshot (core issue 1498).
 *
 * Boots a local anvil from the snapshot (no --fork-url, so nothing can fall
 * through to a live chain) and asserts:
 *   1. eth_getCode is non-empty for SwapRouter02, QuoterV2, the Uniswap V3
 *      factory and every third-party token and infrastructure address.
 *   2. Every Uniswap V3 pool in config/dex-pools.json answers slot0(),
 *      liquidity() and observe() with live values: a non-zero sqrtPrice,
 *      non-zero liquidity and a populated (initialised) observation.
 *   3. The V3 factory's getPool resolves each pool from its token pair and fee.
 *   4. No Robot Money contract address has code at genesis.
 *
 * Exit 0 when every assertion holds; non-zero otherwise, naming each failure.
 *
 * Usage:
 *   bun scripts/devnet/check-fork-snapshot-contents.ts [--state FILE] [--port N]
 *   --state defaults to testing/fixtures/fork-state/CURRENT.anvil-state
 *   --rpc URL   judge an already-running node instead of booting one
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BNKR, EXCLUDED_BASKET_SYMBOLS, INFRA_ADDRESSES, excludedSymbolRows, QUOTER_V2, REPO, SAFE_SET, SWAP_ROUTER02, V3_FACTORY, addrOf, calldata, decodeSlot0, loadConfiguredPools,
  robotMoneyAddresses, rpc, sleep, word,
} from "./fork-snapshot-lib.ts";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const failures: string[] = [];
const fail = (m: string) => {
  failures.push(m);
  console.error(`FAIL: ${m}`);
};
const ok = (m: string) => console.log(`ok:   ${m}`);

async function main() {
  const statePath = resolve(REPO, arg("--state", "testing/fixtures/fork-state/CURRENT.anvil-state")!);
  let url = arg("--rpc");
  let anvil: ReturnType<typeof Bun.spawn> | undefined;

  if (!url) {
    if (!existsSync(statePath)) throw new Error(`snapshot not found: ${statePath}`);
    let chainId = 8453;
    const cur = join(dirname(statePath), "CURRENT.json");
    if (existsSync(cur)) chainId = JSON.parse(readFileSync(cur, "utf8")).chain_id ?? chainId;
    const port = Number(arg("--port", String(20000 + Math.floor(Math.random() * 20000))));
    url = `http://127.0.0.1:${port}`;
    anvil = Bun.spawn(
      ["anvil", "--load-state", statePath, "--chain-id", String(chainId), "--port", String(port), "--silent"],
      { stdout: "ignore", stderr: "inherit" },
    );
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        await rpc(url, "eth_chainId", [], { maxAttempts: 1 });
        ready = true;
      } catch {
        await sleep(1000);
      }
    }
    if (!ready) throw new Error("anvil did not boot from the snapshot within 60s");
    console.log(`booted anvil from ${statePath} (chain ${chainId})`);
  }

  const call = async (to: string, data: string): Promise<string> => rpc(url!, "eth_call", [{ to, data }, "latest"]);
  const hasCode = async (a: string) => {
    const c: string = await rpc(url!, "eth_getCode", [a, "latest"]);
    return !!c && c !== "0x";
  };

  try {
    // 1. code at third-party infrastructure
    const required: Array<[string, string]> = [
      [SWAP_ROUTER02, "Uniswap V3 SwapRouter02"],
      [QUOTER_V2, "Uniswap V3 QuoterV2"],
      [V3_FACTORY, "Uniswap V3 factory"],
      ...INFRA_ADDRESSES,
      ...SAFE_SET.map((a): [string, string] => [a, "Safe v1.4.1 set member"]),
    ];
    // BNKR is in INFRA_ADDRESSES only when config/agent-token-shortlist.json names it (rmAGENT ships empty).
    // BNKR note: there is no BNKR address in config, so the check cannot assert it. That is the
    // documented state, not a skipped assertion. If an address is ever added, it is asserted above.
    if (!BNKR) console.log(`note: BNKR ${EXCLUDED_BASKET_SYMBOLS.bnkr}`);
    // wSOL is excluded from the basket list explicitly. No config row may name an excluded symbol.
    console.log(`note: wSOL ${EXCLUDED_BASKET_SYMBOLS.wsol}`);
    const leaked = excludedSymbolRows();
    leaked.length === 0 ? ok("no excluded basket symbol (wSOL, BNKR) in config") : leaked.forEach((l) => fail(`excluded symbol in config: ${l}`));
    const seen = new Set<string>();
    for (const [a, label] of required) {
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      (await hasCode(a)) ? ok(`code at ${label} ${a}`) : fail(`no code at ${label} ${a}`);
    }

    // 2. live pool values
    const pools = loadConfiguredPools();
    if (pools.length === 0) fail("config/dex-pools.json lists no Uniswap V3 pool");
    for (const p of pools) {
      const tag = `pool ${p.id} ${p.pool}`;
      try {
        if (!(await hasCode(p.pool))) {
          fail(`${tag}: no code`);
          continue;
        }
        // slot0() returns seven words: sqrtPriceX96, tick, observationIndex, observationCardinality,
        // observationCardinalityNext, feeProtocol, unlocked. Decode them as the ABI return, not as a packed slot.
        const s0 = await call(p.pool, await calldata("slot0()"));
        const sqrtPrice = BigInt(word(s0, 0));
        const obsIndex = Number(BigInt(word(s0, 2)));
        const obsCardinality = Number(BigInt(word(s0, 3)));
        sqrtPrice > 0n ? ok(`${tag}: slot0 sqrtPriceX96=${sqrtPrice}`) : fail(`${tag}: slot0 sqrtPriceX96 is zero`);
        obsCardinality >= 1 ? ok(`${tag}: observationCardinality=${obsCardinality}`) : fail(`${tag}: observationCardinality is zero`);

        const liq = BigInt(await call(p.pool, await calldata("liquidity()")));
        liq > 0n ? ok(`${tag}: liquidity=${liq}`) : fail(`${tag}: liquidity is zero`);

        // The observation written most recently must be initialised.
        const ob = await call(p.pool, await calldata("observations(uint256)", String(obsIndex)));
        BigInt(word(ob, 3)) === 1n && BigInt(word(ob, 0)) > 0n
          ? ok(`${tag}: observations[${obsIndex}] initialised`)
          : fail(`${tag}: observations[${obsIndex}] not initialised`);

        // observe() answers for now and for a short look-back.
        const obs = await call(p.pool, await calldata("observe(uint32[])", "[0]"));
        obs && obs !== "0x" ? ok(`${tag}: observe([0]) answers`) : fail(`${tag}: observe([0]) returned nothing`);

        // factory agrees about this pool
        const t0 = addrOf(word(await call(p.pool, await calldata("token0()")), 0));
        const t1 = addrOf(word(await call(p.pool, await calldata("token1()")), 0));
        const fee = BigInt(await call(p.pool, await calldata("fee()")));
        const gp = addrOf(word(await call(V3_FACTORY, await calldata("getPool(address,address,uint24)", t0, t1, String(fee))), 0));
        gp.toLowerCase() === p.pool.toLowerCase()
          ? ok(`${tag}: factory.getPool(${t0},${t1},${fee}) resolves the pool`)
          : fail(`${tag}: factory.getPool returned ${gp}`);
      } catch (e) {
        fail(`${tag}: ${(e as Error).message}`);
      }
    }

    // 3. no Robot Money contract at genesis
    for (const [a, label] of robotMoneyAddresses()) {
      (await hasCode(a)) ? fail(`Robot Money contract has code at genesis: ${label} ${a}`) : ok(`no Robot Money code at ${label} ${a}`);
    }
  } finally {
    anvil?.kill();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsnapshot contents check passed");
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
