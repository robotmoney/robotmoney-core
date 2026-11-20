// scripts/runbook/adapter-swap.test.ts: the ADR-0019 adapter steps of v0.9.0-onevault-upgrade (P1.83, P2.85, P3.72) against a fake cast and forge.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_SOURCE, PROXY_SOURCE, adapterBatch, basket, deploy, forgeCreateAddress, forgeCreateArgs, parseAssetConfig, plan, pending, checkExecuted } from "./adapter-swap.ts";
import type { Cast } from "./cast-io.ts";

const FUND = "0x00000000000000000000000000000000000000f0";
const LEGACY = "0xD077628B001C71d97443750aEC9e2aE62e6C98db";
const PROXY = "0x00000000000000000000000000000000000000Bb";
const IMPL = "0x00000000000000000000000000000000000000aA";
const TL = "0x0000000000000000000000000000000000000071";
const ROUTER = "0x0000000000000000000000000000000000000077";
const POOL = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** An assetConfig(i) return: kind, active, (token), adapter, (cap), pool, and padding. */
function config(kind: number, active: number, adapter: string, pool: string): string {
  return `0x${[word(kind.toString(16)), word(active.toString(16)), word("0"), word(adapter), word("0"), word(pool), word("0")].join("")}`;
}

function fakeCast(assets: string[], extra: Record<string, string> = {}): { cast: Cast; calls: string[][] } {
  const calls: string[][] = [];
  const cast: Cast = (args) => {
    calls.push(args);
    const k = args.join(" ");
    if (k in extra) return extra[k]!;
    if (k === `call ${FUND} assetCount()(uint256)`) return String(assets.length);
    const m = /^call \S+ assetConfig\(uint256\) (\d+)$/.exec(k);
    if (m) return assets[Number(m[1])]!;
    if (args[0] === "calldata") return `0x${args[1]!.split("(")[0]}-${args.slice(2).join("-")}`;
    if (args[0] === "keccak") return `0xkeccak(${args[1]})`;
    throw new Error(`unexpected cast ${k}`);
  };
  return { cast, calls };
}

const ASSETS = [config(0, 1, POOL(0xa1), POOL(0)), config(1, 1, LEGACY, POOL(0x501)), config(1, 0, LEGACY, POOL(0x502)), config(1, 1, LEGACY.toLowerCase(), POOL(0x503))];

test("assetConfig: only active basket assets, with the adapter of word 3 and the pool of word 5", () => {
  expect(parseAssetConfig(0, ASSETS[0]!)).toBeNull();
  expect(parseAssetConfig(2, ASSETS[2]!)).toBeNull();
  expect(parseAssetConfig(1, ASSETS[1]!)).toEqual({ index: 1, adapter: LEGACY.toLowerCase(), pool: POOL(0x501) });
  expect(() => parseAssetConfig(0, "0x00")).toThrow("too short");
  expect(basket(fakeCast(ASSETS).cast, FUND).map((a) => a.index)).toEqual([1, 3]);
});

test("forge create: the JSON after Compiling lines, over several lines; the last deployedTo wins", () => {
  const out = `Compiling 3 files with Solc 0.8.28\nCompiler run successful!\n{\n  "deployer": "0x01",\n  "deployedTo": "${IMPL}",\n  "transactionHash": "0x02"\n}\n`;
  expect(forgeCreateAddress(out)).toBe(IMPL);
  expect(() => forgeCreateAddress("Compiling...\nError: boom")).toThrow("no JSON");
  expect(() => forgeCreateAddress("{\"x\":1}")).toThrow("no deployedTo");
});

test("forge create argv: every library linked, --json before the variadic --constructor-args", () => {
  const a = forgeCreateArgs({ rpc: "http://r", signer: ["--keystore", "K"], libraries: ["L1:0x1", "L2:0x2"], contract: ADAPTER_SOURCE, ctorArgs: [ROUTER] });
  expect(a).toEqual(["create", "--broadcast", "--rpc-url", "http://r", "--keystore", "K", "--libraries", "L1:0x1", "--libraries", "L2:0x2", ADAPTER_SOURCE, "--json", "--constructor-args", ROUTER]);
  expect(a.indexOf("--json")).toBeLessThan(a.indexOf("--constructor-args"));
  expect(a.at(-1)).toBe(ROUTER);
});

test("the batch: two hash allows, the proxy hash, then one setAssetAdapter per active basket asset on the legacy adapter", () => {
  const { cast } = fakeCast(ASSETS);
  const b = adapterBatch(cast, { fund: FUND, proxy: PROXY, legacy: LEGACY, implHash: "0xI", proxyHash: "0xP", assets: basket(cast, FUND) });
  expect(b.targets).toEqual([FUND, FUND, FUND, FUND, FUND]);
  expect(b.values).toEqual(["0", "0", "0", "0", "0"]);
  expect(b.datas).toEqual([
    "0xsetAdapterCodeHashAllowed-0xI-true", "0xsetAdapterCodeHashAllowed-0xP-true", "0xsetAdapterProxyCodeHash-0xP-true",
    `0xsetAssetAdapter-1-${PROXY}`, `0xsetAssetAdapter-3-${PROXY}`,
  ]);
});

function runDir(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "adapter-swap-"));
}

test("plan writes the five state files the runner reads, and refuses a basket with no legacy asset", () => {
  const dir = runDir();
  const { cast } = fakeCast(ASSETS, { [`call ${TL} hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32) ${FUND} 0 0xdata 0x${"0".repeat(64)} 0xsalt`]: "0xfundop" });
  const o = { "state-dir": dir, "run-dir": "/run", timelock: TL, fund: FUND, legacy: LEGACY, proxy: PROXY, "impl-hash": "0xI", "proxy-hash": "0xP", "fund-target": FUND, "fund-data": "0xdata", "fund-salt": "0xsalt" };
  plan(cast, o);
  const r = (f: string) => readFileSync(join(dir, f), "utf8");
  expect(r("target-upg-adapter")).toBe(`${Array(5).fill(FUND).join(",")}\n`);
  expect(r("values-upg-adapter")).toBe("0,0,0,0,0\n");
  expect(r("data-upg-adapter").split(",")).toHaveLength(5);
  expect(r("salt-upg-adapter")).toBe("0xkeccak(robotmoney.deploy4-upgrade.adapter./run)\n");
  expect(r("upg-fund-op")).toBe("0xfundop\n");
  const none = fakeCast([config(1, 1, PROXY, POOL(1))]).cast;
  expect(() => plan(none, { ...o, "state-dir": runDir() })).toThrow("no basket asset uses the legacy adapter");
});

const OP = { timelock: TL, targets: `${FUND},${FUND}`, values: "0,0", datas: "0x1,0x2", predecessor: "0xpred", salt: "0xs" };
const HASH_KEY = `call ${TL} hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32) [${FUND},${FUND}] [0,0] [0x1,0x2] 0xpred 0xs`;

test("pending writes the batch id and requires it pending", () => {
  const out = join(runDir(), "upg-adapter-op");
  pending(fakeCast([], { [HASH_KEY]: "0xop", [`call ${TL} isOperationPending(bytes32)(bool) 0xop`]: "true" }).cast, { ...OP, out });
  expect(readFileSync(out, "utf8")).toBe("0xop\n");
  expect(() => pending(fakeCast([], { [HASH_KEY]: "0xop", [`call ${TL} isOperationPending(bytes32)(bool) 0xop`]: "false" }).cast, { ...OP, out })).toThrow("not pending");
});

test("check: done, both hashes allowed, no asset left on the legacy adapter, one on the proxy", () => {
  const ok = { [HASH_KEY]: "0xop", [`call ${TL} isOperationDone(bytes32)(bool) 0xop`]: "true", [`call ${FUND} adapterCodeHashAllowed(bytes32)(bool) 0xI`]: "true", [`call ${FUND} adapterCodeHashAllowed(bytes32)(bool) 0xP`]: "true", [`call ${FUND} totalAssets()(uint256)`]: "5" };
  const o = { ...OP, fund: FUND, proxy: PROXY, legacy: LEGACY, "impl-hash": "0xI", "proxy-hash": "0xP" };
  const moved = [config(0, 1, POOL(0xa1), POOL(0)), config(1, 1, PROXY, POOL(0x501))];
  expect(() => checkExecuted(fakeCast(moved, ok).cast, o)).not.toThrow();
  expect(() => checkExecuted(fakeCast(ASSETS, ok).cast, o)).toThrow("still uses the legacy adapter");
  expect(() => checkExecuted(fakeCast(moved, { ...ok, [`call ${TL} isOperationDone(bytes32)(bool) 0xop`]: "false" }).cast, o)).toThrow("not done");
  expect(() => checkExecuted(fakeCast(moved, { ...ok, [`call ${FUND} adapterCodeHashAllowed(bytes32)(bool) 0xP`]: "false" }).cast, o)).toThrow("proxy hash is not allowed");
});

test("deploy: forge creates the implementation then the proxy over it, reads both back, writes the hashes; a rerun reuses both", async () => {
  const dir = runDir();
  const forged: { args: string[]; cwd: string }[] = [];
  const forge = (args: string[], cwd: string) => {
    forged.push({ args, cwd });
    return `Compiling...\n{\n"deployedTo": "${forged.length === 1 ? IMPL : PROXY}"\n}`;
  };
  const code: Record<string, string> = {};
  const extra = (): Record<string, string> => ({
    [`code ${IMPL}`]: code[IMPL] ?? "0x", [`code ${PROXY}`]: code[PROXY] ?? "0x",
    [`calldata initialize(address) ${TL}`]: "0xinit",
    [`call ${PROXY} implementation()(address)`]: IMPL.toLowerCase(), [`call ${PROXY} upgradeTimelock()(address)`]: TL, [`call ${PROXY} upgradesFrozen()(bool)`]: "false",
    [`call ${PROXY} ROUTER()(address)`]: ROUTER, [`call --from ${TL} ${PROXY} upgradeToAndCall(address,bytes) ${IMPL} 0x`]: "0x",
    [`call ${PROXY} isFixedFeePool(address)(bool) ${POOL(0x501)}`]: "true", [`call ${PROXY} isFixedFeePool(address)(bool) ${POOL(0x503)}`]: "true",
  });
  const castOf = (): Cast => (args) => {
    const e = extra(), k = args.join(" ");
    if (k in e) return e[k]!;
    return fakeCast(ASSETS).cast(args);
  };
  const checked: string[] = [];
  const input = { rpc: "http://r", build: "/b/v090", stateDir: dir, router: ROUTER, governedUpgrade: "0xG", twapTickMath: "0xT", timelock: TL, fund: FUND, signer: ["--keystore", "K"] };
  await deploy(castOf(), forge, async (a, n) => { checked.push(`${n}@${a}`); return { ok: true, detail: "ok" }; }, input);
  expect(forged).toHaveLength(2);
  expect(forged[0]!.cwd).toBe("/b/v090");
  expect(forged[0]!.args).toContain("contracts/lib/GovernedUUPS.sol:GovernedUpgrade:0xG");
  expect(forged[0]!.args).toContain("contracts/lib/TwapTickMath.sol:TwapTickMath:0xT");
  expect(forged[1]!.args.slice(-5)).toEqual([PROXY_SOURCE, "--json", "--constructor-args", IMPL, "0xinit"]);
  expect(checked).toEqual([`UniswapV3ExactOutSwapAdapterUpgradeable@${IMPL}`, `ERC1967Proxy@${PROXY}`]);
  expect(readFileSync(join(dir, "upg-adapter-impl"), "utf8")).toBe(`${IMPL}\n`);
  expect(readFileSync(join(dir, "upg-adapter-proxy-hash"), "utf8")).toBe("0xkeccak(0x)\n");
  code[IMPL] = "0x60aa"; code[PROXY] = "0x60bb";
  await deploy(castOf(), forge, async () => ({ ok: true, detail: "ok" }), input);
  expect(forged).toHaveLength(2);
  expect(readFileSync(join(dir, "upg-adapter-impl-hash"), "utf8")).toBe("0xkeccak(0x60aa)\n");
  await expect(deploy(castOf(), forge, async () => ({ ok: false, detail: "differs" }), input)).rejects.toThrow("not the build's code");
  expect(existsSync(join(dir, "upg-adapter-proxy"))).toBe(true);
});
