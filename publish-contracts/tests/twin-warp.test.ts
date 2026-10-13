// Twin fork helpers (src/rehearsal/twin.ts) and the govern warp, against a stub anvil RPC served by Bun.serve. No chain, no network, no secret.
// A real anvil fork is only used for the optional read-only smoke check (skipped unless TWIN_SMOKE_RPC is set).
import { afterAll, describe, expect, test } from "bun:test";
import { fundGas, fundUsdc, httpRpc, isTwinFork, TwinError, usdcBalanceSlot, warpBy, warpTo, USDC_BALANCE_SLOT, type Rpc } from "../src/rehearsal/twin.ts";
import { USDC_ADDRESS } from "../src/usdc.ts";
import { runGovern } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { stageByName } from "../src/stages.ts";
import { join } from "node:path";
import { addr, fakeTimelock, sender, setup, signers, writeGovernManifests } from "./govern-world.ts";

const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);

/** A stub anvil: chain id, a clock, balances, USDC storage and a call log. `anvil: false` makes anvil_nodeInfo an error like a real node. */
function stubChain(o: { chainId?: number; anvil?: boolean; usdcCode?: string } = {}) {
  const s = { chainId: o.chainId ?? 918453, anvil: o.anvil ?? true, clock: 1_000_000n, eth: new Map<string, bigint>(), storage: new Map<string, string>(), calls: [] as string[], http429: 0, usdcCode: o.usdcCode };
  const handle = (method: string, params: any[]): unknown => {
    s.calls.push(method);
    switch (method) {
      case "eth_chainId": return hex(s.chainId);
      case "anvil_nodeInfo": if (!s.anvil) throw new Error("method not found"); return { currentBlockNumber: "0x1" };
      case "eth_getBlockByNumber": return { timestamp: hex(s.clock) };
      case "evm_increaseTime": s.clock += BigInt(params[0]); return "0x0";
      case "anvil_setNextBlockTimestamp": s.clock = BigInt(params[0]) - 1n; return null;
      case "evm_mine": s.clock += 1n; return "0x0";
      case "eth_getBalance": return hex(s.eth.get(params[0].toLowerCase()) ?? 0n);
      case "anvil_setBalance": s.eth.set(params[0].toLowerCase(), BigInt(params[1])); return null;
      case "anvil_setStorageAt": s.storage.set(`${params[0].toLowerCase()}:${params[1]}`, params[2]); return null;
      case "eth_getCode": return s.usdcCode ?? "0x";
      case "eth_call": {
        const holder = "0x" + params[0].data.slice(34);
        return s.storage.get(`${USDC_ADDRESS.toLowerCase()}:${usdcBalanceSlot(holder)}`) ?? hex(0);
      }
    }
    throw new Error(`stub: ${method}`);
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (s.http429 > 0) { s.http429--; return new Response("slow down", { status: 429 }); }
      const b = (await req.json()) as { id: number; method: string; params: any[] };
      try { return Response.json({ jsonrpc: "2.0", id: b.id, result: handle(b.method, b.params ?? []) }); }
      catch (e) { return Response.json({ jsonrpc: "2.0", id: b.id, error: { message: (e as Error).message } }); }
    },
  });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  return { s, url, rpc: httpRpc(url, { backoffMs: 1 }) };
}
const servers: { stop: (f?: boolean) => void }[] = [];
afterAll(() => { for (const x of servers) x.stop(true); });

const A1 = "0x00000000000000000000000000000000000000a1", A2 = "0x00000000000000000000000000000000000000a2";
import { keccak256 } from "viem";

describe("isTwinFork: only a non-Base chain that answers anvil_nodeInfo", () => {
  test("a Twin fork is detected", async () => expect(await isTwinFork(stubChain().rpc)).toBe(true));
  test("Base mainnet is never a Twin fork, even if it answered anvil_nodeInfo", async () => expect(await isTwinFork(stubChain({ chainId: 8453 }).rpc)).toBe(false));
  test("a real node (no anvil_nodeInfo) is not a Twin fork", async () => expect(await isTwinFork(stubChain({ anvil: false }).rpc)).toBe(false));
  test("an unreachable RPC is not a Twin fork", async () => expect(await isTwinFork(httpRpc("http://127.0.0.1:1", { retries: 0 }))).toBe(false));
});

describe("warp", () => {
  test("warpBy raises evm_increaseTime and mines, and the head moved by at least the seconds", async () => {
    const c = stubChain();
    const t = await warpBy(c.rpc, 172_801n);
    expect(c.s.calls).toContain("evm_increaseTime");
    expect(c.s.calls.at(-1)).toBe("eth_getBlockByNumber");
    expect(t).toBe(1_000_000n + 172_801n + 1n);
  });
  test("warpTo sets the next block timestamp and refuses a target in the past", async () => {
    const c = stubChain();
    expect(await warpTo(c.rpc, 1_500_000n)).toBeGreaterThanOrEqual(1_500_000n);
    await expect(warpTo(c.rpc, 1_000n)).rejects.toThrow(/not after the head/);
  });
  test("a warp is refused on Base mainnet and on a node that is not anvil, and sends nothing", async () => {
    const base = stubChain({ chainId: 8453 });
    await expect(warpBy(base.rpc, 10n)).rejects.toThrow(/Base mainnet/);
    expect(base.s.calls).not.toContain("evm_increaseTime");
    const real = stubChain({ anvil: false });
    await expect(warpBy(real.rpc, 10n)).rejects.toThrow(/not an anvil fork/);
    expect(real.s.calls).not.toContain("evm_increaseTime");
    await expect(warpBy(stubChain().rpc, 0n)).rejects.toThrow(TwinError);
  });
});

describe("fund-gas", () => {
  test("sets the balance of each address, leaves a higher balance alone, refuses a bad address or a huge amount", async () => {
    const c = stubChain();
    c.s.eth.set(A2, 5n * 10n ** 18n);
    const out = await fundGas(c.rpc, [A1, A2], 10n ** 18n);
    expect(out[A1]).toBe(10n ** 18n);
    expect(out[A2]).toBe(5n * 10n ** 18n);
    await expect(fundGas(c.rpc, ["0x12"], 1n)).rejects.toThrow(/not an address/);
    await expect(fundGas(c.rpc, [A1], 10n ** 30n)).rejects.toThrow(/misread/);
    await expect(fundGas(stubChain({ chainId: 8453 }).rpc, [A1], 1n)).rejects.toThrow(/Base mainnet/);
  });
});

describe("fund-usdc", () => {
  test("the balance slot is keccak(abi.encode(holder, 9)) (the FiatToken balanceAndBlacklistStates mapping)", () => {
    expect(USDC_BALANCE_SLOT).toBe(9n);
    expect(usdcBalanceSlot(A1)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(usdcBalanceSlot(A1)).not.toBe(usdcBalanceSlot(A2));
  });
  test("refuses a token whose code is not the pinned FiatTokenProxy (a mock), and writes nothing", async () => {
    const c = stubChain({ usdcCode: "0x6000" });
    await expect(fundUsdc(c.rpc, [A1], 1_000_000n)).rejects.toThrow(/USDC check failed/);
    expect(c.s.calls).not.toContain("anvil_setStorageAt");
  });
  test("with the pinned code: writes the slot, reads the balance back, and leaves a higher balance alone", async () => {
    const code = "0x60806040";
    const c = stubChain({ usdcCode: code });
    const pin = keccak256(code as `0x${string}`);
    c.s.storage.set(`${USDC_ADDRESS.toLowerCase()}:${usdcBalanceSlot(A2)}`, hex(9_000_000n));
    const out = await fundUsdc(c.rpc, [A1, A2], 5_000_000n, pin);
    expect(out[A1]).toBe(5_000_000n);
    expect(out[A2]).toBe(9_000_000n);
    expect(c.s.calls.filter((x) => x === "anvil_setStorageAt").length).toBe(1);
    await expect(fundUsdc(c.rpc, [A1], 0n, pin)).rejects.toThrow(/outside the valid range/);
  });
});

describe("rehearsal cli: fund-gas, fund-usdc, warp", () => {
  const SHEET = new URL("./fixtures/frozen-sheet.env.example", import.meta.url).pathname;
  test("fund-gas sets every wallet of the sheet, warp moves time, and both refuse Base mainnet", async () => {
    const { main } = await import("../src/rehearsal/cli.ts");
    const c = stubChain();
    expect(await main(["fund-gas", "--rpc", c.url, "--sheet", SHEET, "--wei", "1000000000000000000"])).toBe(0);
    expect(c.s.calls.filter((x) => x === "anvil_setBalance").length).toBeGreaterThanOrEqual(6);   // deployer, pauser, emergency, three owners
    expect(await main(["warp", "--rpc", c.url, "--seconds", "172801"])).toBe(0);
    const base = stubChain({ chainId: 8453 });
    await expect(main(["fund-gas", "--rpc", base.url, "--sheet", SHEET])).rejects.toThrow(/Base mainnet/);
    await expect(main(["warp", "--rpc", base.url, "--seconds", "5"])).rejects.toThrow(/Base mainnet/);
  });
  test("fund-gas with no --wei gives every wallet TWIN_GAS_WEI, and that default stays at 0.5 ETH or more (core 1554: 0.02 ETH failed the vault stage pre-flight)", async () => {
    const { main } = await import("../src/rehearsal/cli.ts");
    const { TWIN_GAS_WEI } = await import("../src/rehearsal/twin.ts");
    const c = stubChain();
    expect(await main(["fund-gas", "--rpc", c.url, "--sheet", SHEET])).toBe(0);
    expect(c.s.eth.size).toBeGreaterThanOrEqual(6);
    for (const bal of c.s.eth.values()) expect(bal).toBe(TWIN_GAS_WEI);
    expect(TWIN_GAS_WEI).toBeGreaterThanOrEqual(5n * 10n ** 17n);
  });
  test("fund-usdc refuses a token that is not the pinned FiatTokenProxy", async () => {
    const { main } = await import("../src/rehearsal/cli.ts");
    const c = stubChain({ usdcCode: "0x6000" });
    await expect(main(["fund-usdc", "--rpc", c.url, "--sheet", SHEET, "--usdc-units", "1000000"])).rejects.toThrow(/USDC check failed/);
  });
});

describe("httpRpc", () => {
  test("retries with backoff on HTTP 429 and then answers", async () => {
    const c = stubChain();
    c.s.http429 = 2;
    expect(await c.rpc("eth_chainId")).toBe("0xe03b5");
  });
  test("gives up after the retries and says the HTTP status, never the URL", async () => {
    const c = stubChain();
    c.s.http429 = 99;
    const rpc = httpRpc(c.url, { retries: 1, backoffMs: 1 });
    const err = await rpc("eth_chainId").catch((e: Error) => e);
    expect(String((err as Error).message)).toContain("HTTP 429");
    expect(String((err as Error).message)).not.toContain(c.url);
  });
});

describe("govern warps the timelock waits on a Twin fork only", () => {
  const base = (sheet: ReturnType<typeof setup>["sheet"], tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
    ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { throw new Error("must not sleep: the warp covers the wait"); }, pollMs: 0, maxWaitSeconds: 60, ...extra });

  test("with an injected warp the 48 hour delay is crossed with ONE warp for all the unpauses, then one per Twin-only round, and the run finishes", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet, 172800n);
    const warps: bigint[] = [];
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, base(sheet, tl, { warp: async (s: bigint) => { warps.push(s); tl.s.clock += s; } }) as never);
    expect(manifest.stages.govern!.status).toBe("done");
    expect(warps.length).toBe(3);                 // one wait for all four unpauses, one for update-delay, one for batch; the cancel round has none
    // the unpauses and update-delay wait the real 172800 s delay; the batch round runs after update-delay, at the new delay (the sheet's GOVERN_NEW_DELAY)
    expect(warps.slice(0, 2)).toEqual([172_801n, 172_801n]);
    expect(warps[2]).toBe(sheet.govern.newDelay + 1n);
  });

  test("the default warp talks to the RPC only when it is a Twin fork: a stub anvil sees evm_increaseTime", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet, 172800n);
    const c = stubChain();
    // the stub below shares the fake timelock's clock; c only records the calls
    const server = Bun.serve({ port: 0, async fetch(req) {
      const b = (await req.json()) as { id: number; method: string; params: any[] };
      const res = (r: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result: r });
      if (b.method === "eth_chainId") return res("0xe03b5");
      if (b.method === "anvil_nodeInfo") return res({});
      if (b.method === "evm_increaseTime") { tl.s.clock += BigInt(b.params[0]); c.s.calls.push("evm_increaseTime"); return res("0x0"); }
      if (b.method === "evm_mine") { tl.s.clock += 1n; return res("0x0"); }
      if (b.method === "eth_getBlockByNumber") return res({ timestamp: "0x" + tl.s.clock.toString(16) });
      return Response.json({ jsonrpc: "2.0", id: b.id, error: { message: "stub" } });
    } });
    servers.push(server);
    (ctx as { rpc: string }).rpc = `http://127.0.0.1:${server.port}`;
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, base(sheet, tl) as never);
    expect(manifest.stages.govern!.status).toBe("done");
    expect(c.s.calls.filter((x) => x === "evm_increaseTime").length).toBe(3);
  });

  test("an RPC that answers chain id 8453 never warps, even if it answers anvil_nodeInfo: a long delay exits GOVERN_PENDING", async () => {
    const { ctx, sheet } = setup();
    (ctx as { rpc: string }).rpc = stubChain({ chainId: 8453 }).url;
    const tl = fakeTimelock(sheet, 172800n);
    let err: unknown;
    try { await runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), base(sheet, tl) as never); } catch (e) { err = e; }
    expect((err as { kind: string }).kind).toBe("GOVERN_PENDING");
  });

  test("on a node that is not an anvil there is no warp either", async () => {
    const { ctx, sheet } = setup();
    (ctx as { rpc: string }).rpc = stubChain({ anvil: false }).url;
    const tl = fakeTimelock(sheet, 172800n);
    let err: unknown;
    try { await runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), base(sheet, tl) as never); } catch (e) { err = e; }
    expect((err as { kind: string }).kind).toBe("GOVERN_PENDING");
  });
});

describe("govern warp guards", () => {
  const base = (sheet: ReturnType<typeof setup>["sheet"], tl: ReturnType<typeof fakeTimelock>) =>
    ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { throw new Error("must not sleep"); }, pollMs: 0, maxWaitSeconds: 60 });
  const spy = (tl: ReturnType<typeof fakeTimelock>, o: { chainId: number; anvil?: boolean }) => {
    const calls: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const b = (await req.json()) as { id: number; method: string; params: any[] };
      calls.push(b.method);
      const res = (r: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result: r });
      if (b.method === "eth_chainId") return res("0x" + o.chainId.toString(16));
      if (b.method === "anvil_nodeInfo" && o.anvil !== false) return res({});
      if (b.method === "evm_increaseTime") { tl.s.clock += BigInt(b.params[0]); return res("0x0"); }
      if (b.method === "evm_mine") { tl.s.clock += 1n; return res("0x0"); }
      if (b.method === "eth_getBlockByNumber") return res({ timestamp: "0x" + tl.s.clock.toString(16) });
      return Response.json({ jsonrpc: "2.0", id: b.id, error: { message: "stub" } });
    } });
    servers.push(server);
    return { calls, url: `http://127.0.0.1:${server.port}` };
  };

  test("on chain 8453 (ctx and RPC) no anvil_* or evm_* method is ever called", async () => {
    const { ctx, sheet } = setup();
    (ctx as { chainId: number }).chainId = 8453;
    writeGovernManifests(join(ctx.coreDir, "deployments", "8453"));
    const tl = fakeTimelock(sheet, 172800n);
    const r = spy(tl, { chainId: 8453 });
    (ctx as { rpc: string }).rpc = r.url;
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), base(sheet, tl) as never)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(r.calls.filter((m) => m.startsWith("anvil_") || m.startsWith("evm_"))).toEqual([]);
  });

  test("--row update-delay, batch and cancel exit USAGE on an RPC answering chain id 8453 (no anvil_ or evm_ call, nothing sent) and run on a Twin fork", async () => {
    for (const row of ["update-delay", "batch", "cancel"]) {
      const main = setup();
      (main.ctx as { chainId: number }).chainId = 8453;
      writeGovernManifests(join(main.ctx.coreDir, "deployments", "8453"));
      const tlMain = fakeTimelock(main.sheet, 172800n);
      const r8453 = spy(tlMain, { chainId: 8453 });
      (main.ctx as { rpc: string }).rpc = r8453.url;
      await expect(runGovern(main.ctx, stageByName("govern"), newManifest(main.ctx, addr(0xa001)), { ...base(main.sheet, tlMain), row } as never)).rejects.toMatchObject({ kind: "USAGE" });
      expect(tlMain.s.events).toEqual([]);
      expect(r8453.calls.filter((m) => m.startsWith("anvil_") || m.startsWith("evm_"))).toEqual([]);
    }
    // on a Twin fork the same rows run, through the real default warp, after the unpauses
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet, 172800n);
    const twin = spy(tl, { chainId: 918453 });
    (ctx as { rpc: string }).rpc = twin.url;
    const manifest = newManifest(ctx, addr(0xa001));
    for (const row of ["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA", "update-delay", "batch", "cancel"]) await runGovern(ctx, stageByName("govern"), manifest, { ...base(sheet, tl), row } as never);
    expect(Object.keys(manifest.govern!)).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA", "update-delay", "batch", "cancel"]);
    expect(twin.calls).toContain("evm_increaseTime");
  });

  test("an RPC that answers 8453 while ctx says a Twin id still never gets an anvil_* call", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet, 172800n);
    const r = spy(tl, { chainId: 8453 });
    (ctx as { rpc: string }).rpc = r.url;
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), base(sheet, tl) as never)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(r.calls.filter((m) => m.startsWith("anvil_"))).toEqual([]);
  });

  test("the delay floor is untouched: warps stop one second past the ready time, no state is patched, minDelay is the real one", async () => {
    const { ctx, sheet, lines } = setup();
    const tl = fakeTimelock(sheet, 172800n);
    const r = spy(tl, { chainId: 918453 });
    (ctx as { rpc: string }).rpc = r.url;
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, base(sheet, tl) as never);
    expect(manifest.stages.govern!.status).toBe("done");
    const allowed = new Set(["eth_chainId", "anvil_nodeInfo", "evm_increaseTime", "evm_mine", "eth_getBlockByNumber"]);
    expect(r.calls.filter((m) => !allowed.has(m))).toEqual([]);   // no anvil_setStorageAt, anvil_setCode, setBalance
    const warped = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "govern.warped" || e.msg === "govern.warped");
    expect(warped.length).toBe(3);
    const secs = warped.map((w) => w.seconds ?? w.data?.seconds);
    expect(secs.slice(0, 2)).toEqual([172_801, 172_801]);
    expect(secs[2]).toBe(Number(sheet.govern.newDelay) + 1);
  });
});

// Optional read-only smoke check against a local anvil forked from the public Base endpoint:
//   anvil --fork-url https://mainnet.base.org --fork-block-number <head-2> --chain-id 918453 &
//   TWIN_SMOKE_RPC=http://127.0.0.1:8545 bun test tests/twin-warp.test.ts
const SMOKE = process.env.TWIN_SMOKE_RPC;
describe.skipIf(!SMOKE)("smoke: a real Twin fork (set TWIN_SMOKE_RPC to a local anvil fork of Base with --chain-id 918453)", () => {
  test("fund-gas, fund-usdc and warp work on the real fork", async () => {
    const rpc: Rpc = httpRpc(SMOKE!);
    expect(await isTwinFork(rpc)).toBe(true);
    expect((await fundGas(rpc, [A1], 10n ** 18n))[A1]).toBe(10n ** 18n);
    expect((await fundUsdc(rpc, [A1, A2], 1_000_000n))[A2]).toBe(1_000_000n);
    const t0 = BigInt(((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string }).timestamp);
    expect(await warpBy(rpc, 172_800n)).toBeGreaterThanOrEqual(t0 + 172_800n);
  }, 120_000);
});
