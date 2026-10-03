// Canonical: robotmoney/devops issue 53 / core issue 1499, core S2 (issue 1484).
// Process-level test of scripts/ci/config-check.ts against a local fake JSON-RPC server.
// It proves the CLI contract the issue states: exit 0 when live facts match for wETH, cbBTC and
// deSPXA, non-zero when a pool address or fee is altered, and an output file named with the block.
// Run: bun test scripts/ci/config-check-cli.test.ts --timeout 60000
// Live run (needs the network, no secret; run later in the config-check CI job):
//   bun scripts/ci/config-check.ts --rpc https://mainnet.base.org --out-dir config-check-output
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfigs, keccakHex } from "./config-check";

const repo = resolve(import.meta.dir, "..", "..");
const script = join(repo, "scripts/ci/config-check.ts");
const realDir = join(repo, "config");
const BLOCK = 52082423;
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const a = (x: string) => x.replace(/^0x/, "").toLowerCase().padStart(64, "0");

// The fake chain serves the code 0x6001 everywhere, so its hash is the USDC pin.
const FAKE_HASH = keccakHex("0x6001");
const base = loadConfigs(realDir);
const all = [...base.protocol.assets, ...base.rwa.assets];
const FACTORY = base.rwa.uniswapV3Factory.toLowerCase();

/** The live pool fee the fake chain reports for a symbol (default: the committed fee). */
let liveFeeOverride: Record<string, number> = {};

function handle(method: string, params: any[]): string {
  if (method === "eth_chainId") return "0x2105";
  if (method === "eth_blockNumber") return "0x" + BLOCK.toString(16);
  if (method === "eth_getStorageAt") return "0x" + a("0x4444444444444444444444444444444444444444");
  if (method === "eth_getCode") return "0x6001";
  const { to, data } = params[0] as { to: string; data: string };
  const sel = data.slice(0, 10);
  const t = to.toLowerCase();
  const asset = all.find((x) => x.pool.toLowerCase() === t);
  if (sel === "0xddca3f43") return "0x" + w(asset ? (liveFeeOverride[asset.symbol] ?? Number(asset.poolFee)) : 0);
  if (sel === "0x0dfe1681") return "0x" + a(base.rwa.usdc);
  if (sel === "0xd21220a7") return "0x" + a(asset!.token);
  if (sel === "0x3850c7bd") return "0x" + w(1n << 96n) + w(0) + w(0) + w(0) + w(50) + w(0) + w(1);
  if (sel === "0x1a686502") return "0x" + w(10n ** 18n);
  if (sel === "0x70a08231") return "0x" + w(2_000_000n * 10n ** 6n);
  if (sel === "0x1698ee82" && t === FACTORY) {
    const tok = "0x" + data.slice(10, 74).slice(24);
    const x = all.find((y) => y.token.toLowerCase() === tok.toLowerCase());
    return "0x" + a(x!.pool);
  }
  return "0x" + w(0);
}

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const j = (await req.json()) as { id: number; method: string; params: any[] };
      try {
        return Response.json({ jsonrpc: "2.0", id: j.id, result: handle(j.method, j.params) });
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id: j.id, error: { message: String(e) } });
      }
    },
  });
});
afterAll(() => server.stop(true));

/** A temp config dir with the USDC pin set to the fake chain's code hash, then mutated. */
function configDir(mutate: (files: Record<string, any>) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-cli-"));
  cpSync(realDir, dir, { recursive: true });
  const files: Record<string, any> = {};
  for (const n of readdirSync(dir)) if (n.endsWith(".json")) files[n] = JSON.parse(readFileSync(join(dir, n), "utf8"));
  files["usdc-hashes.json"] = { ...files["usdc-hashes.json"], proxyCodeHash: FAKE_HASH, implementationCodeHash: FAKE_HASH };
  mutate(files);
  for (const [n, j] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(j, null, 2));
  return dir;
}

// Async spawn: the fake RPC server lives in this process, so a blocking spawn would deadlock it.
async function exec(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

async function run(dir: string, extra: string[] = []): Promise<{ code: number; out: string; outDir: string }> {
  const outDir = mkdtempSync(join(tmpdir(), "cc-out-"));
  const r = await exec(["--rpc", `http://127.0.0.1:${server.port}`, "--config-dir", dir, "--out-dir", outDir, ...extra]);
  return { ...r, outDir };
}

describe("config-check CLI against a fake live chain", () => {
  test("exits 0 when live facts match, and writes an output file named with the block number", async () => {
    liveFeeOverride = {};
    const r = await run(configDir());
    expect(r.out).toContain("config-check: ok");
    expect(r.code).toBe(0);
    const file = join(r.outDir, `config-check-block-${BLOCK}.json`);
    expect(existsSync(file)).toBe(true);
    const report = JSON.parse(readFileSync(file, "utf8"));
    expect(report.blockNumber).toBe(BLOCK);
    expect(report.ok).toBe(true);
    for (const sym of ["wETH", "cbBTC", "deSPXA"]) {
      expect(report.findings.some((f: any) => f.scope.endsWith(`:${sym}`) && f.ok)).toBe(true);
    }
  });

  test("exits non-zero when a pool fee in config differs from the live pool fee", async () => {
    liveFeeOverride = {};
    const dir = configDir((f) => {
      const x = f["protocol-assets.json"].assets.find((s: any) => s.symbol === "cbBTC");
      x.poolFee = x.poolFee === 500 || x.poolFee === "500" ? 3000 : 500;
    });
    const r = await run(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FAIL");
    const report = JSON.parse(readFileSync(join(r.outDir, `config-check-block-${BLOCK}.json`), "utf8"));
    expect(report.ok).toBe(false);
  });

  test("exits non-zero when the live deSPXA pool reports a fee other than 500", async () => {
    liveFeeOverride = { deSPXA: 3000 };
    const r = await run(configDir());
    liveFeeOverride = {};
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL[^\n]*deSPXA/);
  });

  test("exits non-zero when a pool address in config is altered", async () => {
    liveFeeOverride = {};
    const dir = configDir((f) => {
      const x = f["protocol-assets.json"].assets.find((s: any) => s.symbol === "wETH");
      x.pool = "0x1111111111111111111111111111111111111111";
    });
    const r = await run(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL[^\n]*wETH/);
  });

  test("exits non-zero when the chain id is not Base", async () => {
    liveFeeOverride = {};
    const r = await run(configDir(), ["--chain", "1"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("chain-id");
  });
});

const liveRpc = process.env.CONFIG_CHECK_LIVE_RPC;
describe("config-check against live Base head", () => {
  test.skipIf(!liveRpc)(
    "exits 0 for wETH, cbBTC and deSPXA (skipped: set CONFIG_CHECK_LIVE_RPC to a public Base RPC, no secret; " +
      "run: CONFIG_CHECK_LIVE_RPC=https://mainnet.base.org bun test scripts/ci/config-check-cli.test.ts)",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "cc-live-"));
      const p = await exec(["--rpc", liveRpc!, "--out-dir", outDir]);
      expect(p.code).toBe(0);
      expect(readdirSync(outDir).some((n) => /^config-check-block-\d+\.json$/.test(n))).toBe(true);
    },
  );
});
