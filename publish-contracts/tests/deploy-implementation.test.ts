// Issue 1861: the deploy-implementation verb (src/deploy-implementation.ts) against a stub chain. The live gateway implementation links library L at address LIB; the build's
// creation code carries L's placeholder. The real CREATE, the real libraries and the real Safe run in the suite-28 Twin upgrade lifecycle (src/ci/twin-upgrade-lifecycle.ts).
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { DEPLOY_IMPL_VERB, implementationDeploysOf, linkCreationCode, runDeployImplementation, type DeployImplApi } from "../src/deploy-implementation.ts";
import { loadRunManifest, newManifest, saveRunManifest, type RunContext } from "../src/runner.ts";
import { getStageTable } from "../src/stages.ts";
import { layoutId, proxySpecs } from "../src/verify/upgradeability.ts";
import { REPO } from "./fixtures.ts";
import { A, addr, setup } from "./govern-world.ts";

const SPECS = proxySpecs(getStageTable());
const PINS = getStageTable().upgradeAuthority!.layoutPins;
const GW = SPECS.find((x) => x.name === "gateway")!;
const LIB = addr(0x7001);
const LIVE = addr(0x9100);
const NEW = addr(0x9200);
const PLACEHOLDER = "__$0123456789abcdef0123456789abcdef01$__";
const LIB_CODE = "0x60806040526004361061001d57";
// runtime: PUSH20 <L>, the address at byte 4. creation: a 4-byte prefix, PUSH20 <L> (the address at byte 5), then the runtime from byte 25 (its address at byte 29)
const runtimeWith = (lib: string) => `0x608060${"73"}${lib}5af43d82803e`;
const RUNTIME_ART = runtimeWith(PLACEHOLDER);
const CREATION_ART = `0x60806040${"73"}${PLACEHOLDER}${RUNTIME_ART.slice(2)}`;
const linkRefs = (...starts: number[]) => ({ "src/libs/L.sol": { L: starts.map((start) => ({ start, length: 20 })) } });

/** A core checkout: the committed layout snapshots and pins, and a build whose gateway implementation links L (or `libs`). */
function writeBuild(dir: string, o: { editLayout?: (j: any) => void; libs?: string[] } = {}): void {
  for (const f of [...SPECS.map((x) => x.layout), PINS]) { mkdirSync(dirname(join(dir, f)), { recursive: true }); copyFileSync(join(REPO, f), join(dir, f)); }
  if (o.editLayout) { const p = join(dir, GW.layout); const j = JSON.parse(readFileSync(p, "utf8")); o.editLayout(j); writeFileSync(p, JSON.stringify(j)); }
  const libs = o.libs ?? ["L"];
  const refs = (...starts: number[]) => Object.fromEntries(libs.map((l) => [`src/libs/${l}.sol`, { [l]: starts.map((start) => ({ start, length: 20 })) }]));
  mkdirSync(join(dir, "out", `${GW.contract}.sol`), { recursive: true });
  writeFileSync(join(dir, "out", `${GW.contract}.sol`, `${GW.contract}.json`), JSON.stringify({
    bytecode: { object: CREATION_ART, linkReferences: refs(5, 29) },
    deployedBytecode: { object: RUNTIME_ART, linkReferences: refs(4), immutableReferences: {} },
  }));
  for (const l of libs) {
    mkdirSync(join(dir, "out", `${l}.sol`), { recursive: true });
    writeFileSync(join(dir, "out", `${l}.sol`, `${l}.json`), JSON.stringify({ bytecode: { object: LIB_CODE, linkReferences: {} }, deployedBytecode: { object: LIB_CODE, linkReferences: {}, immutableReferences: {} } }));
  }
}

/** The stub chain: the gateway proxy runs LIVE (linked to L at LIB), L's code at LIB. A CREATE puts `deployed(creation)` at NEW. */
function world(o: { deployed?: (creation: Hex) => string } = {}) {
  const d = setup({}, 918453);
  writeBuild(d.ctx.coreDir);
  const ctx = { ...d.ctx, caller: { yes: true }, signer: { address: async () => d.sheet.admin } } as unknown as RunContext;
  const dir = join(ctx.coreDir, "deployments", "918453");
  const proxies: Record<string, unknown> = {};
  for (const x of SPECS) proxies[x.name] = { proxy: x.name === "gateway" ? A.gateway : addr(0x9000), layout_id: layoutId(ctx.coreDir, x.layout, PINS) };
  writeFileSync(join(dir, "upgradeability.json"), JSON.stringify({ chain_id: 918453, mode: "upgradeable", proxies }));
  saveRunManifest(ctx.evidenceDir, newManifest(ctx, d.sheet.admin));
  const s = { codes: new Map<string, string>([[LIVE.toLowerCase(), runtimeWith(LIB.slice(2))], [LIB.toLowerCase(), LIB_CODE]]), frozen: false, creates: [] as Hex[] };
  const api: DeployImplApi = {
    getCode: async (a) => (s.codes.get(a.toLowerCase()) ?? "0x") as Hex,
    implementationOf: async () => LIVE,
    upgradesFrozen: async () => s.frozen,
    create: async (creation) => {
      s.creates.push(creation);
      // the runtime the creation code returns: the tail after the constructor prefix, with its links as filled in
      s.codes.set(NEW.toLowerCase(), o.deployed ? o.deployed(creation) : `0x${creation.slice(2 + 25 * 2)}`);
      return { txHash: keccak256(creation), status: true, address: NEW };
    },
  };
  const run = (extra: { upgradeBuild?: string } = {}) => runDeployImplementation(ctx, { proxy: "gateway", ...extra }, api);
  return { ctx, s, api, run, lines: d.lines };
}

describe("issue 1861: deploy-implementation links to the live libraries, deploys once, checks the code and records it", () => {
  test("one CREATE with every placeholder filled with the live library address, an implementation_deploys entry and the govern --row upgrade-proxy line", async () => {
    const w = world();
    const res = await w.run();
    expect(w.s.creates.length).toBe(1);
    const c = w.s.creates[0]!;
    expect(c).not.toContain("__$");
    expect(c.slice(2 + 5 * 2, 2 + 25 * 2)).toBe(LIB.slice(2));
    expect(c.slice(2 + 29 * 2, 2 + 49 * 2)).toBe(LIB.slice(2)); // the runtime's own link site too
    expect(res.reused).toBe(false);
    const list = implementationDeploysOf(loadRunManifest(w.ctx.evidenceDir)!);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ step: DEPLOY_IMPL_VERB, proxy_name: "gateway", proxy: A.gateway, contract: GW.contract, implementation: NEW, live_implementation: LIVE, libraries: { L: LIB }, deploy_tx: keccak256(c), code_hash: keccak256(w.s.codes.get(NEW.toLowerCase()) as Hex) });
    expect(res.next).toContain(`govern --row upgrade-proxy --proxy gateway --implementation ${NEW}`);
    expect(res.next).not.toContain("--upgrade-build");
  });

  test("a rerun after success sends nothing and reprints the recorded address", async () => {
    const w = world();
    const first = await w.run();
    const again = await w.run();
    expect(w.s.creates.length).toBe(1);
    expect(again).toMatchObject({ reused: true, entry: { implementation: NEW } });
    expect(again.next).toBe(first.next);
    expect(implementationDeploysOf(loadRunManifest(w.ctx.evidenceDir)!).length).toBe(1);
  });

  test("a build linking a library the live implementation does not link (or missing one it links), a non-append-only layout and a frozen proxy each refuse with no transaction sent", async () => {
    const extraLib = world();
    const b1 = join(extraLib.ctx.coreDir, "upgrade-build");
    writeBuild(b1, { libs: ["L", "M"] });
    await expect(extraLib.run({ upgradeBuild: b1 })).rejects.toMatchObject({ kind: "REFUSED", message: expect.stringContaining("links M, which the live implementation does not link") });
    const fewerLibs = world();
    const b0 = join(fewerLibs.ctx.coreDir, "upgrade-build");
    writeBuild(b0, { libs: [] });
    await expect(fewerLibs.run({ upgradeBuild: b0 })).rejects.toMatchObject({ kind: "REFUSED", message: expect.stringContaining(`the live implementation links L, which the build's ${GW.contract} does not name`) });
    const layout = world();
    const b2 = join(layout.ctx.coreDir, "upgrade-build");
    writeBuild(b2, { editLayout: (j) => { j.storage = [j.storage[1], j.storage[0], ...j.storage.slice(2)]; } });
    await expect(layout.run({ upgradeBuild: b2 })).rejects.toMatchObject({ kind: "REFUSED", message: expect.stringContaining("storage layout gate refuses") });
    const frozen = world();
    frozen.s.frozen = true;
    await expect(frozen.run()).rejects.toMatchObject({ kind: "REFUSED", message: expect.stringContaining("reads upgradesFrozen() true") });
    for (const w of [extraLib, fewerLibs, layout, frozen]) {
      expect(w.s.creates).toEqual([]);
      expect(implementationDeploysOf(loadRunManifest(w.ctx.evidenceDir)!)).toEqual([]);
    }
    // an append-only layout change from another build passes, and the printed command names that build
    const ok = world();
    const b3 = join(ok.ctx.coreDir, "upgrade-build");
    writeBuild(b3, { editLayout: (j) => { j.storage.push({ label: "appended", offset: 0, slot: "99", type: "t_uint256" }); } });
    const res = await ok.run({ upgradeBuild: b3 });
    expect(ok.s.creates.length).toBe(1);
    expect(res.next).toContain(`--implementation ${NEW} --upgrade-build ${b3}`);
  });

  test("the live implementation linking a library the build does not name is refused (linkCreationCode)", () => {
    const art = { bytecode: { object: CREATION_ART, linkReferences: linkRefs(5, 29) } };
    expect(linkCreationCode(art, { L: LIB, N: addr(0x7002) }, GW.contract).problems).toEqual([`the live implementation links N, which the build's ${GW.contract} does not name`]);
    expect(linkCreationCode(art, { L: LIB }, GW.contract).problems).toEqual([]);
    expect(linkCreationCode({ bytecode: { object: `${CREATION_ART}${PLACEHOLDER}`, linkReferences: linkRefs(5, 29) } }, { L: LIB }, GW.contract).problems[0]).toContain("unlinked library placeholder");
  });

  test("a deployed runtime code that differs from the build (masked) exits non-zero and records no entry", async () => {
    const w = world({ deployed: () => "0x6080600073" + LIB.slice(2) + "5af43d82803e" });
    await expect(w.run()).rejects.toMatchObject({ kind: "VERIFY", message: expect.stringContaining(`is not the build's ${GW.contract}`) });
    expect(w.s.creates.length).toBe(1);
    expect(implementationDeploysOf(loadRunManifest(w.ctx.evidenceDir)!)).toEqual([]);
  });
});

describe("issue 1861: the deploy-implementation CLI", () => {
  test("parse: --proxy is required, --implementation and --dry-run are refused, --upgrade-build is accepted", async () => {
    const { parseCli } = await import("../src/cli.ts");
    const { SHA } = await import("./fixtures.ts");
    const base = [DEPLOY_IMPL_VERB, "--chain", "8453", "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "keystore:/k"];
    expect(parseCli([...base, "--proxy", "gateway", "--upgrade-build", "b"])).toMatchObject({ verb: DEPLOY_IMPL_VERB, proxy: "gateway", upgradeBuild: join(process.cwd(), "b") });
    expect(() => parseCli(base)).toThrow(`${DEPLOY_IMPL_VERB} needs --proxy NAME`);
    expect(() => parseCli([...base, "--proxy", "gateway", "--implementation", NEW])).toThrow("--implementation goes with govern --row upgrade-proxy only");
    expect(() => parseCli([...base, "--proxy", "gateway", "--dry-run"])).toThrow("has no --dry-run");
  });

  test("on 8453 the release gate runs first (a red DEPLOY_SHA sends nothing); on the Twin chain the verb prints the govern line on stdout", async () => {
    const { world: cliWorld } = await import("./harness.ts");
    const calls: string[] = [];
    const verb = (async () => { calls.push("deploy"); return { reused: false, entry: { proxy_name: "gateway", implementation: NEW, code_hash: "0x01", deploy_tx: "0x02" }, next: `govern --row upgrade-proxy --proxy gateway --implementation ${NEW}` }; }) as never;
    const main = cliWorld({ chainId: 8453 });
    const code = await main.run([DEPLOY_IMPL_VERB, "--proxy", "gateway"], { deployImplementation: verb, checkShaGreen: async () => { calls.push("green"); return { code: 1, output: "RED" }; } });
    expect(code).not.toBe(0);
    expect(calls).toEqual(["green"]);
    const twin = cliWorld();
    const out: string[] = [];
    const log = console.log;
    console.log = (x: unknown) => { out.push(String(x)); };
    let rc: number;
    try { rc = await twin.run([DEPLOY_IMPL_VERB, "--proxy", "gateway"], { deployImplementation: verb }); } finally { console.log = log; }
    expect(rc).toBe(0);
    expect(calls).toEqual(["green", "deploy"]);
    expect(JSON.parse(out.find((l) => l.includes("deploy_implementation"))!)).toMatchObject({ event: "deploy_implementation", implementation: NEW, next: expect.stringContaining(`govern --row upgrade-proxy --proxy gateway --implementation ${NEW}`) });
  });
});
