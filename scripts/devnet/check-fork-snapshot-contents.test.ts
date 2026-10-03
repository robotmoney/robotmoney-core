// Canonical: robotmoney/devops issue 53 / core issue 1499, core 1498.
// Behavioural test of scripts/devnet/check-fork-snapshot-contents.ts against a fake JSON-RPC node
// (--rpc URL, so no anvil and no committed snapshot are needed). It asserts the three exit-code
// criteria of the issue: infrastructure code is required, every configured pool must answer with
// liquidity and an initialised observation, and no Robot Money address may have code at genesis.
// Run: bun test scripts/devnet/check-fork-snapshot-contents.test.ts --timeout 120000
// Needs `cast` on PATH (calldata and quote decoding). Skipped, with this reason, when it is absent.
// The run against the committed snapshot itself needs anvil and the fixture:
//   bun scripts/devnet/check-fork-snapshot-contents.ts   (suite 5 required CI job)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  QUOTER_V2, SWAP_ROUTER02, V3_FACTORY, calldata, loadConfiguredPools, robotMoneyAddresses,
} from "./fork-snapshot-lib.ts";

const haveCast = Bun.which("cast") !== null;
const script = join(resolve(import.meta.dir), "check-fork-snapshot-contents.ts");
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

let sel: Record<string, string> = {};
const pools = loadConfiguredPools();
const poolSet = new Set(pools.map((p) => p.pool.toLowerCase()));
/** Mutable fake-chain faults, reset before each run. */
let noCode = new Set<string>();
let codeAt = new Set<string>();
let zeroLiquidity = new Set<string>();

function handle(method: string, params: any[]): string {
  if (method === "eth_chainId") return "0x2105";
  if (method === "eth_getCode") {
    const a = String(params[0]).toLowerCase();
    if (codeAt.has(a)) return "0x6001";
    if (noCode.has(a)) return "0x";
    return robotMoneyAddresses().some(([x]) => x.toLowerCase() === a) ? "0x" : "0x6001";
  }
  if (method !== "eth_call") return "0x0";
  // cast sends the calldata as `input`, the check's own calls send `data`.
  const call = params[0] as { to: string; data?: string; input?: string };
  const to = call.to;
  const data = call.data ?? call.input ?? "0x";
  const t = to.toLowerCase();
  const s = data.slice(0, 10);
  if (t === QUOTER_V2.toLowerCase()) return "0x" + w(123456) + w(1) + w(1) + w(1);
  if (s === sel.slot0) return "0x" + w(1n << 96n) + w(0) + w(3) + w(50) + w(50) + w(0) + w(1);
  if (s === sel.liquidity) return "0x" + w(zeroLiquidity.has(t) ? 0 : 10n ** 18n);
  if (s === sel.observations) return "0x" + w(1700000000) + w(1) + w(1) + w(1);
  if (s === sel.observe) return "0x" + w(64) + w(128) + w(1) + w(1) + w(1) + w(1);
  // token0 is the pool address itself, so getPool(token0, token1, fee) can answer with it.
  if (s === sel.token0) return "0x" + t.slice(2).padStart(64, "0");
  if (s === sel.token1) return "0x" + w(0xdead);
  if (s === sel.fee) return "0x" + w(500);
  if (s === sel.getPool && t === V3_FACTORY.toLowerCase()) return "0x" + data.slice(10, 74);
  return "0x" + w(0);
}

let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  if (!haveCast) return;
  for (const [k, sig] of Object.entries({
    slot0: "slot0()", liquidity: "liquidity()", observations: "observations(uint256)", observe: "observe(uint32[])",
    token0: "token0()", token1: "token1()", fee: "fee()", getPool: "getPool(address,address,uint24)",
  })) sel[k] = (await calldata(sig, ...(k === "observations" ? ["0"] : k === "observe" ? ["[0]"] : k === "getPool" ? ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "500"] : []))).slice(0, 10);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const j = (await req.json()) as { id: number; method: string; params: any[] };
      return Response.json({ jsonrpc: "2.0", id: j.id, result: handle(j.method, j.params) });
    },
  });
});
afterAll(() => server?.stop(true));

async function run(): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", script, "--rpc", `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
}
const reset = () => {
  noCode = new Set();
  codeAt = new Set();
  zeroLiquidity = new Set();
};

describe.skipIf(!haveCast)("snapshot contents check against a fake node", () => {
  test("the config names at least one pool and one Robot Money address", () => {
    expect(pools.length).toBeGreaterThan(0);
    expect(robotMoneyAddresses().length).toBeGreaterThan(0);
  });

  test("a snapshot with the infrastructure, live pools and no Robot Money code exits 0", async () => {
    reset();
    const r = await run();
    expect(r.out).toContain("snapshot contents check passed");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`code at Uniswap V3 SwapRouter02 ${SWAP_ROUTER02}`);
  });

  test("code at a Robot Money address at genesis exits non-zero and names the address", async () => {
    reset();
    const [addr] = robotMoneyAddresses()[0]!;
    codeAt.add(addr.toLowerCase());
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Robot Money contract has code at genesis");
    expect(r.out).toContain(addr);
  });

  test("no code at SwapRouter02 exits non-zero", async () => {
    reset();
    noCode.add(SWAP_ROUTER02.toLowerCase());
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`no code at Uniswap V3 SwapRouter02 ${SWAP_ROUTER02}`);
  });

  test("no code at the V3 factory exits non-zero", async () => {
    reset();
    noCode.add(V3_FACTORY.toLowerCase());
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("no code at Uniswap V3 factory");
  });

  test("a configured pool with zero liquidity exits non-zero and names the pool", async () => {
    reset();
    const p = pools[0]!.pool;
    expect(poolSet.has(p.toLowerCase())).toBe(true);
    zeroLiquidity.add(p.toLowerCase());
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`pool [^\\n]*${p}: liquidity is zero`));
  });

  test("a configured pool with no code exits non-zero", async () => {
    reset();
    const p = pools[pools.length - 1]!.pool;
    noCode.add(p.toLowerCase());
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${p}: no code`);
  });
});
