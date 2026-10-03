#!/usr/bin/env bun
/**
 * Capture the Twin chain Base snapshot (core issue 1498, epic devops 53).
 *
 * Canonical: docs/technical/full-stack-devnet.md "Fork-state fixture",
 *            docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md.
 * Replaces scripts/devnet/snapshot-fork.ts (orchestration is Bun TypeScript).
 *
 * One deployment scheme: the snapshot holds third-party Base state only. NO
 * Robot Money contract exists at genesis; the rehearsal on the Twin chain
 * (918453) deploys the production contracts with the production scripts.
 *
 * What it does (developer-run; the nightly job runs it with FORK_PIN_LAG=0):
 *   1. Pins a block (tip minus FORK_PIN_LAG) on a PUBLIC Base endpoint, with
 *      back-off on HTTP 429. No keyed RPC, no archive node.
 *   2. Boots anvil forking that block inside the foundry Docker image (the
 *      dump schema must match what devnet consumers load).
 *   3. Warms third-party code: Uniswap V3 factory, SwapRouter02, QuoterV2, every
 *      pool in config/dex-pools.json and its tokens, the Aave/Compound/Morpho
 *      stack, the canonical Safe v1.4.1 set, plus proxy implementations.
 *   4. Touches state a public RPC cannot enumerate. anvil's dump holds only the
 *      slots a mined transaction loaded or wrote, so it runs representative
 *      quotes and USDC<->token swaps through SwapRouter02 on every pool (tick,
 *      bitmap, observation and balance slots), supplies and withdraws USDC on
 *      Aave, Compound and Morpho, and copies each pool's observation ring and
 *      nearby tick bitmap/ticks explicitly.
 *   5. Dumps state, writes CURRENT.json / CURRENT.anvil-state with the sha256
 *      binding, asserts the Safe set and runs the contents check on the result.
 *   6. When writing the committed fixture dir (the default), also updates
 *      fork-block.json, genesis-alloc.json (via the genesis ingester) and
 *      expected-prices.json to the same block.
 *
 * Env: RMPC_FORK_RPC_URL (default: first public endpoint), FORK_PIN_LAG (100),
 *      FORK_CHAIN_ID (8453), ANVIL_PORT (18545), FOUNDRY_IMAGE,
 *      FIXTURE_DIR (default testing/fixtures/fork-state; any other dir skips the
 *      config updates), ANVIL_EXTRA_ARGS, SNAPSHOT_SWAP_USDC (100000000),
 *      SNAPSHOT_TICK_WORDS (6), SNAPSHOT_MAX_OBSERVATIONS (4096),
 *      SNAPSHOT_UPDATE_CONFIG (1|0 overrides the auto choice),
 *      SNAPSHOT_RESUME_CONFIG (1: skip the capture, move the config files to CURRENT.json's block).
 * Needs on PATH: docker, cast, jq (digest helper), bun; cargo for the ingester.
 * No secret is read, written or logged: transactions are sent from anvil's
 * unlocked dev account 0.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AAVE_POOL, COMET_USDC, INFRA_ADDRESSES, MORPHO_VAULT, QUOTER_V2, REPO, SAFE_SET, SAFE_SINGLETONS, SWAP_ROUTER02, USDC,
  V3_FACTORY, ZERO_WORD, addrOf, calldata, decodeSlot0, hexSlot, loadConfiguredPools, mappingSlot, origin, pad32, pmap, publicEndpoints,
  robotMoneyAddresses, rpc, signed, sh, sleep, sqrtPriceToPrice, word,
} from "./fork-snapshot-lib.ts";

const log = (m: string) => console.log(`[snapshot] ${m}`);
const env = (k: string, d: string) => process.env[k] ?? d;

const FORK_CHAIN_ID = Number(env("FORK_CHAIN_ID", "8453"));
const ANVIL_PORT = Number(env("ANVIL_PORT", "18545"));
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const FOUNDRY_IMAGE = env("FOUNDRY_IMAGE", "ghcr.io/foundry-rs/foundry:latest");
const CONTAINER = `rm-snapshot-anvil-${process.pid}`;
const DEFAULT_FIXTURE_REL = "testing/fixtures/fork-state";
const FIXTURE_DIR = resolve(REPO, env("FIXTURE_DIR", DEFAULT_FIXTURE_REL));
const UPDATE_CONFIG = process.env.SNAPSHOT_UPDATE_CONFIG
  ? process.env.SNAPSHOT_UPDATE_CONFIG === "1"
  : FIXTURE_DIR === resolve(REPO, DEFAULT_FIXTURE_REL);
const SWAP_USDC = env("SNAPSHOT_SWAP_USDC", "100000000"); // 100 USDC
const TICK_WORDS = Number(env("SNAPSHOT_TICK_WORDS", "6"));
const MAX_OBS = Number(env("SNAPSHOT_MAX_OBSERVATIONS", "4096"));
const ANVIL_EXTRA = env("ANVIL_EXTRA_ARGS", "--retries 30 --fork-retry-backoff 2000");

// anvil dev account 0 (public mnemonic, unlocked on the snapshot node only).
const EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const pinnedAccounts = new Set<string>(); // third-party contracts the snapshot must carry

// ── anvil helpers ──────────────────────────────────────────────────────────
const a = (method: string, params: unknown[] = []) => rpc(ANVIL_RPC, method, params, { log: (m) => console.error(m) });
const anvilCall = (to: string, data: string): Promise<string> => a("eth_call", [{ to, data }, "latest"]);
const getSlot = (addr: string, slot: string): Promise<string> => a("eth_getStorageAt", [addr, slot, "latest"]);

/** A state write against the snapshot node. A silent failure would leave the dump without what it exists to carry. */
async function setSlot(addr: string, slot: string, value: string): Promise<void> {
  await a("anvil_setStorageAt", [addr, slot, "0x" + value.replace(/^0x/, "").padStart(64, "0")]);
}

/** Send from the unlocked dev account and require success. */
async function send(to: string, data: string, what: string): Promise<void> {
  const hash: string = await a("eth_sendTransaction", [{ from: EOA, to, data, gas: "0x1c9c380" }]);
  // anvil can answer eth_sendTransaction before the receipt is indexed: poll briefly, never treat "not yet" as a revert.
  let rcpt = null;
  for (let i = 0; i < 50 && !rcpt; i++) {
    rcpt = await a("eth_getTransactionReceipt", [hash]);
    if (!rcpt) await sleep(200);
  }
  if (!rcpt) throw new Error(`${what}: no receipt for tx ${hash} after 10s`);
  if (rcpt.status !== "0x1") throw new Error(`${what} reverted (tx ${hash})`);
}

// ── contract pinning ───────────────────────────────────────────────────────
const PROXY_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967 implementation
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", // EIP-1967 admin
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", // EIP-1967 beacon
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3", // zeppelinos implementation (USDC)
  "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b", // zeppelinos admin (USDC)
];
const IMPL_SLOTS = new Set([PROXY_SLOTS[0], PROXY_SLOTS[3]]);

/**
 * Re-set a contract's code so anvil marks the account dirty (lazy fork
 * accounts are not dumped), copy proxy slots and follow proxies to their
 * implementation. A contract with no code upstream aborts the snapshot: every
 * address listed is one a downstream suite needs.
 */
async function pinContract(addr: string, label: string, depth = 0): Promise<void> {
  if (pinnedAccounts.has(addr.toLowerCase())) return;
  const code: string = await a("eth_getCode", [addr, "latest"]);
  if (!code || code === "0x") throw new Error(`${label} ${addr} has no code upstream at the pin block`);
  pinnedAccounts.add(addr.toLowerCase());
  await a("anvil_setCode", [addr, code]);
  for (const s of PROXY_SLOTS) {
    const v = await getSlot(addr, s);
    if (BigInt(v) === 0n) continue;
    await setSlot(addr, s, v);
    if (IMPL_SLOTS.has(s) && depth < 2) {
      const impl = addrOf(v);
      if (BigInt(impl) !== 0n) await pinContract(impl, `${label} implementation`, depth + 1);
    }
  }
  log(`  ${label} ${addr}: ${(code.length - 2) / 2} bytes`);
}

/** Copy the slot of balances[holder] in token (standard mapping layout, slots 0-40) so a payout from holder works. */
async function copyBalanceSlot(token: string, holder: string): Promise<void> {
  const bal = BigInt(await anvilCall(token, await calldata("balanceOf(address)", holder)));
  if (bal === 0n) return;
  for (let s = 0n; s < 41n; s++) {
    const slot = await mappingSlot(pad32(BigInt(holder)), s);
    const v = await getSlot(token, slot);
    if (BigInt(v) === bal) {
      await setSlot(token, slot, v);
      return;
    }
  }
  log(`  WARN: no standard balance slot found for ${holder} in ${token}`);
}

// ── Uniswap V3 pool state ──────────────────────────────────────────────────
interface PoolInfo { id: string; pool: string; token0: string; token1: string; fee: number; spacing: number }

async function readPool(id: string, pool: string): Promise<PoolInfo> {
  const rd = async (sig: string) => word(await anvilCall(pool, await calldata(sig)), 0);
  return {
    id,
    pool,
    token0: addrOf(await rd("token0()")),
    token1: addrOf(await rd("token1()")),
    fee: Number(BigInt(await rd("fee()"))),
    spacing: Number(signed(await rd("tickSpacing()"), 24)),
  };
}

/** Representative quote and round-trip swap through the real router on one pool. */
async function exercisePool(p: PoolInfo): Promise<void> {
  const usdc = USDC.toLowerCase();
  const other = p.token0.toLowerCase() === usdc ? p.token1 : p.token0;
  if (p.token0.toLowerCase() !== usdc && p.token1.toLowerCase() !== usdc) {
    log(`  WARN ${p.id}: pool has no USDC side; quote and swap skipped`);
    return;
  }
  try {
    const q = await anvilCall(
      QUOTER_V2,
      await calldata("quoteExactInputSingle((address,address,uint256,uint24,uint160))", `(${USDC},${other},${SWAP_USDC},${p.fee},0)`),
    );
    log(`  ${p.id}: quote ${SWAP_USDC} USDC -> ${BigInt(word(q, 0))} units of ${other}`);
    await send(USDC, await calldata("approve(address,uint256)", SWAP_ROUTER02, SWAP_USDC), `${p.id} USDC approve`);
    await send(
      SWAP_ROUTER02,
      await calldata("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))", `(${USDC},${other},${p.fee},${EOA},${SWAP_USDC},0,0)`),
      `${p.id} swap in`,
    );
    const got = BigInt(await anvilCall(other, await calldata("balanceOf(address)", EOA)));
    if (got > 0n) {
      await send(other, await calldata("approve(address,uint256)", SWAP_ROUTER02, got.toString()), `${p.id} token approve`);
      await send(
        SWAP_ROUTER02,
        await calldata("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))", `(${other},${USDC},${p.fee},${EOA},${got},0,0)`),
        `${p.id} swap back`,
      );
    }
    log(`  ${p.id}: round-trip swap executed`);
  } catch (e) {
    // A transfer-restricted token (deSPXA is a Centrifuge ShareToken) can refuse the EOA.
    // The explicit slot copy below still carries the pool; the contents check judges the result.
    log(`  WARN ${p.id}: quote/swap not completed: ${(e as Error).message}`);
  }
}

/** Copy the observation ring, tick bitmap window and initialised ticks of a pool into the dump. */
async function copyPoolStorage(p: PoolInfo): Promise<void> {
  const writes: Array<[string, string]> = []; // [slot, value]
  const grab = async (slot: string) => {
    const v = await getSlot(p.pool, slot);
    if (BigInt(v) !== 0n) writes.push([slot, v]);
    return v;
  };
  for (let i = 0n; i < 8n; i++) await grab(hexSlot(i)); // slot0 .. positions
  const d = decodeSlot0(word(await getSlot(p.pool, "0x0"), 0));

  // observations[65535] starts at slot 8
  const obsCount = Math.max(d.observationCardinality, d.observationCardinalityNext);
  if (obsCount > MAX_OBS) log(`  WARN ${p.id}: observation ring ${obsCount} > SNAPSHOT_MAX_OBSERVATIONS=${MAX_OBS}; truncated`);
  await pmap(Array.from({ length: Math.min(obsCount, MAX_OBS) }, (_, i) => i), 16, (i) => grab(hexSlot(8n + BigInt(i))));

  // tickBitmap (slot 6) words around the current tick, then every initialised tick (slot 5, 4 slots each)
  const compressed = Math.floor(d.tick / p.spacing);
  const centre = compressed >> 8;
  const words = Array.from({ length: 2 * TICK_WORDS + 1 }, (_, i) => centre - TICK_WORDS + i);
  const bitmaps = await pmap(words, 8, async (wp) => {
    const slot = await mappingSlot(pad32(BigInt(wp)), 6n);
    return { wp, v: BigInt(await grab(slot)) };
  });
  const ticks: number[] = [];
  for (const { wp, v } of bitmaps) {
    for (let bit = 0; bit < 256; bit++) if ((v >> BigInt(bit)) & 1n) ticks.push((wp * 256 + bit) * p.spacing);
  }
  await pmap(ticks, 8, async (t) => {
    const base = BigInt(await mappingSlot(pad32(BigInt(t)), 5n));
    for (let k = 0n; k < 4n; k++) await grab(hexSlot(base + k));
  });
  for (const [slot, v] of writes) await setSlot(p.pool, slot, v);
  log(`  ${p.id}: copied ${writes.length} slots (${obsCount} observations, ${ticks.length} initialised ticks, ${words.length} bitmap words)`);
}

// ── main ───────────────────────────────────────────────────────────────────
let cleaning = false;
async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  const running = (await sh(["docker", "ps", "--format", "{{.Names}}"]).catch(() => "")).split("\n").includes(CONTAINER);
  if (running) {
    log(`tearing down anvil container ${CONTAINER}`);
    await sh(["docker", "kill", "--signal=INT", CONTAINER]).catch(() => {});
    for (let i = 0; i < 30; i++) {
      const up = (await sh(["docker", "ps", "--format", "{{.Names}}"]).catch(() => "")).split("\n").includes(CONTAINER);
      if (!up) break;
      await sleep(1000);
    }
    await sh(["docker", "rm", "--force", CONTAINER]).catch(() => {});
  }
}

/**
 * SNAPSHOT_RESUME_CONFIG=1: the capture already produced CURRENT.anvil-state (a later step failed, or the
 * config step needs a rerun). Skip the capture and move fork-block.json, genesis-alloc.json and
 * expected-prices.json to the block CURRENT.json names. The contents check runs first.
 */
async function resumeConfig(): Promise<void> {
  const cur = JSON.parse(readFileSync(join(FIXTURE_DIR, "CURRENT.json"), "utf8"));
  const block = Number(cur.fork_block);
  const currentState = join(FIXTURE_DIR, "CURRENT.anvil-state");
  await sh(["bun", join(REPO, "scripts/devnet/check-fork-snapshot-contents.ts"), "--state", currentState], {}, true);
  const upstream = process.env.RMPC_FORK_RPC_URL || (await publicEndpoints())[0];
  const blk = await rpc(upstream, "eth_getBlockByNumber", ["0x" + block.toString(16), false]);
  if (!blk?.hash) throw new Error(`upstream did not return block ${block}`);
  const state = JSON.parse(readFileSync(currentState, "utf8"));
  const accounts: Record<string, any> = state.accounts ?? state;
  const slot0ByPool = new Map<string, bigint>();
  for (const p of loadConfiguredPools()) {
    const raw = accounts[p.pool.toLowerCase()]?.storage?.["0x" + "0".repeat(64)];
    if (!raw) throw new Error(`pool ${p.id} ${p.pool} has no slot0 in the snapshot`);
    slot0ByPool.set(p.pool.toLowerCase(), decodeSlot0(word(raw, 0)).sqrtPriceX96);
  }
  await updateConfig(state, block, blk.hash, currentState, slot0ByPool);
  log("resume done.");
}

async function main(): Promise<void> {
  if (process.env.SNAPSHOT_RESUME_CONFIG === "1") return resumeConfig();
  for (const t of ["cast", "jq", "docker"]) await sh(["which", t]).catch(() => { throw new Error(`required tool '${t}' not on PATH`); });
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const upstream = process.env.RMPC_FORK_RPC_URL || (await publicEndpoints())[0];
  log(`querying upstream block number from ${origin(upstream)}`);
  const tip = parseInt(await rpc(upstream, "eth_blockNumber"), 16);
  const pinBlock = tip - Number(env("FORK_PIN_LAG", "100"));
  log(`upstream tip=${tip} pinning at block=${pinBlock}`);
  const pinBlk = await rpc(upstream, "eth_getBlockByNumber", ["0x" + pinBlock.toString(16), false]);
  if (!pinBlk?.hash) throw new Error(`upstream did not return block ${pinBlock}`);

  // anvil in the foundry image so the dump schema matches the runtime consumers.
  const stateDir = (await sh(["mktemp", "-d", "-t", "anvil-state.XXXXXX"])).trim();
  await sh(["chmod", "0777", stateDir]); // the container user (uid 1000) must write the dump
  log(`pulling ${FOUNDRY_IMAGE}`);
  await sh(["docker", "pull", "--quiet", FOUNDRY_IMAGE]);
  log(`starting anvil --fork-block-number ${pinBlock}`);
  await sh([
    "docker", "run", "--rm", "--detach", "--name", CONTAINER,
    "--publish", `127.0.0.1:${ANVIL_PORT}:8545`, "--volume", `${stateDir}:/state`, FOUNDRY_IMAGE,
    `exec anvil --fork-url ${upstream} --fork-block-number ${pinBlock} --chain-id ${FORK_CHAIN_ID} --host 0.0.0.0 --port 8545 ` +
      `--mnemonic 'test test test test test test test test test test test junk' --accounts 10 --balance 10000 ` +
      `--dump-state /state/state.json --silent ${ANVIL_EXTRA}`,
  ]);
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

  try {
    for (let i = 1; ; i++) {
      try {
        await rpc(ANVIL_RPC, "eth_chainId", [], { maxAttempts: 1 });
        log(`anvil ready after ${i}s`);
        break;
      } catch {
        if (i >= 60) throw new Error("anvil did not become ready within 60s");
        await sleep(1000);
      }
    }

    // Aave's index math underflows when block.timestamp precedes a reserve's last accrual, and a
    // swap writes an observation at block.timestamp. Move the chain to wall-clock now.
    const now = Math.floor(Date.now() / 1000);
    log(`advancing fork timestamp to ${now} (wall-clock now)`);
    await a("evm_setNextBlockTimestamp", [now]);
    await a("evm_mine");

    // 3. warm code
    log("warming third-party contracts");
    for (const [addr, label] of INFRA_ADDRESSES) await pinContract(addr, label);
    for (const addr of SAFE_SET) await pinContract(addr, "Safe v1.4.1 set member");
    const lock = "0x" + pad32(1n);
    for (const addr of SAFE_SINGLETONS) {
      // Each singleton's constructor sets threshold = 1 (slot 4); a code-only copy leaves it takeover-able.
      const v = await rpc(upstream, "eth_getStorageAt", [addr, "0x4", "0x" + pinBlock.toString(16)]);
      if (BigInt(v) !== 1n) throw new Error(`Safe singleton ${addr} slot 4 = ${v} upstream, not 1: not the locked canonical singleton`);
      await setSlot(addr, "0x4", lock);
    }
    log("  Safe singletons: threshold lock (slot 4 = 1) written");

    const pools: PoolInfo[] = [];
    for (const cp of loadConfiguredPools()) {
      await pinContract(cp.pool, `pool ${cp.id}`);
      const info = await readPool(cp.id, cp.pool);
      await pinContract(info.token0, `token0 of ${cp.id}`);
      await pinContract(info.token1, `token1 of ${cp.id}`);
      pools.push(info);
    }

    // Factory registry. The Base UniswapV3Factory layout (verified against the live factory, not
    // the Ethereum mainnet layout): owner slot 3, feeAmountTickSpacing slot 4, getPool slot 5.
    // getPool is written both ways.
    log("copying Uniswap V3 factory registry slots");
    const FACTORY_OWNER_SLOT = "0x3";
    const FACTORY_FEE_TICK_SPACING_SLOT = 4n;
    const FACTORY_GET_POOL_SLOT = 5n;
    await setSlot(V3_FACTORY, FACTORY_OWNER_SLOT, await getSlot(V3_FACTORY, FACTORY_OWNER_SLOT));
    for (const p of pools) {
      const fts = await mappingSlot(pad32(BigInt(p.fee)), FACTORY_FEE_TICK_SPACING_SLOT);
      const spacing = await getSlot(V3_FACTORY, fts);
      if (BigInt(spacing) === 0n) throw new Error(`factory.feeAmountTickSpacing(${p.fee}) is empty upstream for ${p.id}`);
      await setSlot(V3_FACTORY, fts, spacing);
      for (const [x, y] of [[p.token0, p.token1], [p.token1, p.token0]]) {
        const s1 = await mappingSlot(pad32(BigInt(x)), FACTORY_GET_POOL_SLOT);
        const s2 = await mappingSlot(pad32(BigInt(y)), s1);
        const s3 = await mappingSlot(pad32(BigInt(p.fee)), s2);
        const v = await getSlot(V3_FACTORY, s3);
        if (BigInt(v) === 0n) throw new Error(`factory.getPool(${x},${y},${p.fee}) is empty upstream for ${p.id}`);
        await setSlot(V3_FACTORY, s3, v);
      }
    }

    // 4. touch state: fund the dev account with USDC by writing its balance slot (FiatToken balances at slot 9),
    //    no whale impersonation.
    const usdcBal = await mappingSlot(pad32(BigInt(EOA)), 9n);
    await setSlot(USDC, usdcBal, "0x" + pad32(2_000_000_000n)); // 2,000 USDC

    log("quotes and swaps on every configured pool");
    for (const p of pools) await exercisePool(p);

    log("copying pool observation, tick and balance slots");
    for (const p of pools) {
      await copyPoolStorage(p);
      await copyBalanceSlot(p.token0, p.pool);
      await copyBalanceSlot(p.token1, p.pool);
    }

    // Aave, Compound and Morpho: one supply and a partial withdraw each, straight from the dev account, so
    // reserve, index, position and oracle slots are loaded by mined transactions.
    log("yield protocol round-trips (Aave V3, Compound V3, Morpho)");
    const fifty = "50000000";
    await send(USDC, await calldata("approve(address,uint256)", AAVE_POOL, fifty), "Aave approve");
    await send(AAVE_POOL, await calldata("supply(address,uint256,address,uint16)", USDC, fifty, EOA, "0"), "Aave supply");
    await send(AAVE_POOL, await calldata("withdraw(address,uint256,address)", USDC, "20000000", EOA), "Aave withdraw");
    await send(USDC, await calldata("approve(address,uint256)", COMET_USDC, fifty), "Compound approve");
    await send(COMET_USDC, await calldata("supply(address,uint256)", USDC, fifty), "Compound supply");
    await send(COMET_USDC, await calldata("withdraw(address,uint256)", USDC, "20000000"), "Compound withdraw");
    await send(USDC, await calldata("approve(address,uint256)", MORPHO_VAULT, fifty), "Morpho approve");
    await send(MORPHO_VAULT, await calldata("deposit(uint256,address)", fifty, EOA), "Morpho deposit");
    const shares = BigInt(await anvilCall(MORPHO_VAULT, await calldata("balanceOf(address)", EOA)));
    if (shares === 0n) throw new Error("Morpho deposit minted zero shares");
    await send(MORPHO_VAULT, await calldata("redeem(uint256,address,address)", (shares / 2n).toString(), EOA, EOA), "Morpho redeem");

    // Harness USDC holder grant (ingester also patches it; keep the balance in the fixture too).
    const holder = "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5";
    await setSlot(USDC, await mappingSlot(pad32(BigInt(holder)), 9n), "0x" + pad32(1_000_000_000_000n));
    await a("anvil_setBalance", [holder, "0x3635c9adc5dea00000"]);

    // expected-prices inputs, read from the same state the dump will carry.
    const slot0ByPool = new Map<string, bigint>();
    for (const p of pools) slot0ByPool.set(p.pool.toLowerCase(), decodeSlot0(word(await getSlot(p.pool, "0x0"), 0)).sqrtPriceX96);

    // 5. flush the dump with SIGINT
    log("flushing --dump-state via SIGINT");
    await sh(["docker", "kill", "--signal=INT", CONTAINER]).catch(() => {});
    const dump = join(stateDir, "state.json");
    for (let i = 0; i < 90; i++) {
      const up = (await sh(["docker", "ps", "--format", "{{.Names}}"]).catch(() => "")).split("\n").includes(CONTAINER);
      if (existsSync(dump) && !up) break;
      await sleep(1000);
    }
    await sh(["docker", "rm", "--force", CONTAINER]).catch(() => {});
    if (!existsSync(dump) || readFileSync(dump).length === 0) throw new Error("anvil --dump-state did not produce a state file");
    const state = JSON.parse(readFileSync(dump, "utf8")); // also asserts it is JSON

    // 6. fixture + manifest
    const capturedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const fixtureName = `base-${pinBlock}.json`;
    const stateName = `base-${pinBlock}.anvil-state`;
    const stateFile = join(FIXTURE_DIR, stateName);
    copyFileSync(dump, stateFile);
    rmSync(stateDir, { recursive: true, force: true });
    const fixtureFile = join(FIXTURE_DIR, fixtureName);
    writeFileSync(
      fixtureFile,
      JSON.stringify(
        { chain_id: FORK_CHAIN_ID, fork_block: pinBlock, captured_at: capturedAt, upstream_rpc: origin(upstream), state_file: stateName }, null, 2,
      ) + "\n",
    );
    const digest = join(REPO, "scripts/devnet/fork-state-digest.sh");
    await sh(["bash", digest, "write", stateFile, fixtureFile]);

    const currentState = join(FIXTURE_DIR, "CURRENT.anvil-state");
    copyFileSync(stateFile, currentState);
    const currentJson = join(FIXTURE_DIR, "CURRENT.json");
    writeFileSync(
      currentJson,
      JSON.stringify({ fixture: fixtureName, state_file: stateName, fork_block: pinBlock, fork_block_hash: pinBlk.hash, chain_id: FORK_CHAIN_ID, captured_at: capturedAt }, null, 2) + "\n",
    );
    await sh(["bash", digest, "write", currentState, currentJson]);

    await sh(["bash", join(REPO, "scripts/devnet/check-fork-safe-set.sh"), currentState], {}, true);
    // The snapshot must answer with live values and carry no Robot Money contract.
    await sh(["bun", join(REPO, "scripts/devnet/check-fork-snapshot-contents.ts"), "--state", currentState], {}, true);

    if (UPDATE_CONFIG) await updateConfig(state, pinBlock, pinBlk.hash, currentState, slot0ByPool);
    else log("FIXTURE_DIR is not the committed dir: fork-block.json, genesis-alloc.json and expected-prices.json left alone");

    log("done.");
    log(`  fixture    : ${fixtureFile}`);
    log(`  state_file : ${stateFile}`);
    log(`  current    : ${currentJson}`);
  } finally {
    await cleanup();
  }
}

/** fork-block.json, genesis-alloc.json and expected-prices.json move to the same block as CURRENT.json. */
async function updateConfig(state: any, block: number, hash: string, currentState: string, slot0ByPool: Map<string, bigint>): Promise<void> {
  const cfgDir = join(REPO, "testing/ethereum-testnet/config");
  const sha = createHash("sha256").update(readFileSync(currentState)).digest("hex");

  // Ingest allowlist: every account the dump holds with code (third-party contracts, implementations and
  // the Aave/Morpho/Comet working set the round-trips loaded), minus Robot Money's own addresses.
  const rm = new Set(robotMoneyAddresses().map(([x]) => x.toLowerCase()));
  const accounts: Record<string, any> = state.accounts ?? state;
  const addrs = new Set<string>(pinnedAccounts);
  for (const [addr, acct] of Object.entries<any>(accounts)) {
    const code = acct?.code;
    if (typeof code === "string" && code !== "0x" && code.length > 2) addrs.add(addr.toLowerCase());
  }
  for (const x of rm) addrs.delete(x);

  const fbPath = join(cfgDir, "fork-block.json");
  const fb = JSON.parse(readFileSync(fbPath, "utf8"));
  fb.block_number = block;
  fb.block_hash = hash;
  fb.snapshot_uri = "file://testing/fixtures/fork-state/genesis-alloc.json";
  fb.ingested_addresses = [...addrs].sort();
  fb.pinned = true;
  fb.snapshot_sha256 = "0x" + sha;
  writeFileSync(fbPath, JSON.stringify(fb, null, 2) + "\n");
  log(`fork-block.json -> block ${block}, ${addrs.size} ingested addresses`);

  await sh(
    [
      "cargo", "run", "--quiet", "--release", "--manifest-path", "testing/smoke-test/Cargo.toml", "--bin", "smoke-test-genesis-ingester", "--",
      "--manifest", fbPath, "--snapshot", currentState, "--output", join(FIXTURE_DIR, "genesis-alloc.json"), "--require-pinned",
    ],
    {}, true,
  );
  // Block lockstep sidecar: genesis-alloc.json is an address map, so the block it was built at is recorded
  // next to it. check-fork-lockstep.ts asserts CURRENT.json, fork-block.json and this file agree.
  writeFileSync(
    join(FIXTURE_DIR, "genesis-alloc.block.json"),
    JSON.stringify(
      { block_number: block, block_hash: hash, alloc_sha256: createHash("sha256").update(readFileSync(join(FIXTURE_DIR, "genesis-alloc.json"))).digest("hex") }, null, 2,
    ) + "\n",
  );

  const epPath = join(cfgDir, "expected-prices.json");
  const ep = JSON.parse(readFileSync(epPath, "utf8"));
  for (const pair of ep.pairs) {
    const sqrt = slot0ByPool.get(String(pair.pool).toLowerCase());
    if (!sqrt) throw new Error(`pair ${pair.id}: pool ${pair.pool} is not a configured pool, no price captured`);
    const d0 = pair.base_is_token0 ? pair.base_decimals : pair.quote_decimals;
    const d1 = pair.base_is_token0 ? pair.quote_decimals : pair.base_decimals;
    pair.expected_price = Number(sqrtPriceToPrice(sqrt, d0, d1, pair.base_is_token0).toPrecision(8));
    pair.captured = true;
  }
  ep.fork_block = block;
  ep.captured = true;
  writeFileSync(epPath, JSON.stringify(ep, null, 2) + "\n");
  log(`expected-prices.json -> fork_block ${block}`);
}

main().then(
  () => process.exit(0),
  async (e) => {
    console.error(`ERROR: ${(e as Error).message}`);
    await cleanup();
    process.exit(1);
  },
);
