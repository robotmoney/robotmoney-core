// Issue 1861: the deploy-implementation verb (src/deploy-implementation.ts) against a stub chain. The live gateway implementation links library L at address LIB; the build's
// creation code carries L's placeholder. The real CREATE, the real libraries and the real Safe run in the suite-28 Twin upgrade lifecycle (src/ci/twin-upgrade-lifecycle.ts).
import { describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { DEPLOY_IMPL_VERB, implementationDeploysOf, linkCreationCode, realDeployImplApi, runDeployImplementation, type DeployImplApi } from "../src/deploy-implementation.ts";
import { loadRunManifest, newManifest, saveRunManifest, type RunContext } from "../src/runner.ts";
import { getStageTable, peekStageState, restoreStageState, useStageTable } from "../src/stages.ts";
import { loadStageTable } from "../src/stage-table.ts";
import { layoutId, proxySpecs } from "../src/verify/upgradeability.ts";
import { REPO, tmp } from "./fixtures.ts";
import { LIBRARY_ADDRESS_CAUSE } from "../src/libs-adopt.ts";

/** What `forge --version` prints for the pinned release-build forge (issue 1926). */
const PINNED_FORGE = async () => ({ code: 0, stdout: "forge Version: 1.8.5-v1.8.5\nCommit SHA: stub", stderr: "" });
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
function world(o: { deployed?: (creation: Hex) => string; forgeVersion?: string } = {}) {
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
    forgeVersion: o.forgeVersion === undefined ? PINNED_FORGE : async () => ({ code: 0, stdout: o.forgeVersion!, stderr: "" }),
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
    expect(linkCreationCode(art, { L: LIB, N: addr(0x7002) }, GW.contract).problems).toEqual([`the live implementation links N, which the build's ${GW.contract} does not name (expected: ${addr(0x7002)}, the address the live implementation links; derived: no link site in the build). ${LIBRARY_ADDRESS_CAUSE}`]);
    expect(linkCreationCode(art, { L: LIB }, GW.contract).problems).toEqual([]);
    expect(linkCreationCode({ bytecode: { object: `${CREATION_ART}${PLACEHOLDER}`, linkReferences: linkRefs(5, 29) } }, { L: LIB }, GW.contract).problems[0]).toContain("unlinked library placeholder");
  });

  test("issue 1926: a library address read from the live implementation with NO code is refused before the CREATE, nothing sent; with code it proceeds to exactly one CREATE", async () => {
    const empty = world();
    empty.s.codes.delete(LIB.toLowerCase()); // the live implementation links L at LIB, and LIB holds no code on this chain
    await expect(empty.run()).rejects.toMatchObject({ kind: "REFUSED", message: expect.stringContaining(`links L at ${LIB}, which has NO code on chain 918453`), details: { library: "L", address: LIB } });
    expect(empty.s.creates).toEqual([]);
    expect(implementationDeploysOf(loadRunManifest(empty.ctx.evidenceDir)!)).toEqual([]);
    const full = world();
    await full.run();
    expect(full.s.creates.length).toBe(1);
  });

  test("issue 1926: a library-link refusal prints the expected (live) address, the derived one and the likely cause (checkout path or forge version, the one-time address move)", () => {
    const art = { bytecode: { object: CREATION_ART, linkReferences: linkRefs(5, 29) } };
    const p = linkCreationCode(art, {}, GW.contract).problems[0]!;
    expect(p).toContain("links L, which the live implementation does not link");
    expect(p).toContain("expected: an address the live implementation links; derived: none");
    expect(p).toContain("another checkout path or with another forge version");
    expect(p).toContain("library addresses moved once");
  });

  test("issue 1926: deploy-implementation reads forge --version first and refuses any forge but the pinned 1.8.5 (TOOL), naming both versions, with nothing read or sent", async () => {
    for (const v of ["forge Version: 1.7.1-v1.7.1", "forge Version: 1.8.3-v1.8.3"]) {
      const w = world({ forgeVersion: v });
      const got = v.split(" ")[2]!.split("-")[0]!;
      await expect(w.run()).rejects.toMatchObject({ kind: "TOOL", message: expect.stringContaining(`is forge ${got}, but release builds use exactly forge 1.8.5`), details: { found: got, pinned: "1.8.5" } });
      expect(w.s.creates).toEqual([]);
    }
    const ok = world({ forgeVersion: "forge Version: 1.8.5-v1.8.5" });
    await ok.run();
    expect(ok.s.creates.length).toBe(1);
  });

  test("a deployed runtime code that differs from the build (masked) exits non-zero and records no entry", async () => {
    const w = world({ deployed: () => "0x6080600073" + LIB.slice(2) + "5af43d82803e" });
    await expect(w.run()).rejects.toMatchObject({ kind: "VERIFY", message: expect.stringContaining(`is not the build's ${GW.contract}`) });
    expect(w.s.creates.length).toBe(1);
    expect(implementationDeploysOf(loadRunManifest(w.ctx.evidenceDir)!)).toEqual([]);
  });
});

describe("issue 1861: the deploy-implementation CLI", () => {
  test("the real CREATE puts every cast option before --create CODE (cast's trailing subcommand) and reads the receipt", async () => {
    const calls: string[][] = [];
    const ctx = { rpc: "http://x", chainId: 918453, baseEnv: {}, chainReader: () => ({}) as never,
      signer: { forgeArgs: async () => ["--keystore", "/k", "--password-file", "/p", "--sender", NEW] },
      run: async (_tool: string, args: string[]) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ transactionHash: "0x" + "ab".repeat(32), status: "0x1", contractAddress: NEW }), stderr: "" }; },
    } as unknown as RunContext;
    const res = await realDeployImplApi(ctx).create("0x6080");
    expect(calls).toEqual([["send", "--json", "--keystore", "/k", "--password-file", "/p", "--from", NEW, "--create", "0x6080"]]);
    expect(res).toEqual({ txHash: `0x${"ab".repeat(32)}`, status: true, address: NEW });
  });

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

// Issue 1927: the runbook 4.15 shape. --core-dir (ctx.coreDir) is the checkout of the build that is LIVE, release/v0.5.0-rehearsal: its stage table (the committed copy in
// tests/fixtures/v050, where the receipt is ic-policy.json consensus_receipt), its storage layout snapshots and its build out/. --upgrade-build is the rc checkout: this repo's
// snapshots and storage-layout-renames.json, and a build whose code differs from the live one (the rc gateway is 12923 bytes, the live one 24283).
describe("issue 1927: deploy-implementation against the live v0.5.0 build", () => {
  const V050 = join(import.meta.dir, "fixtures", "v050");
  const LIVE_TAIL = "5af43d82803e", RC_TAIL = "5af43d82803f00";
  const runtimeOf = (lib: string, tail: string) => `0x608060${"73"}${lib}${tail}`;
  const creationOf = (lib: string, tail: string) => `0x60806040${"73"}${lib}${runtimeOf(lib, tail).slice(2)}`;
  const RC_PROXY = addr(0x1006), LIVE_RC = addr(0x9300);

  /** One build: the contract's artifact (the runtime ends in `tail`), linking every name in `libs` at the offsets the placeholder layout uses, and each library's own artifact. */
  function writeOut(dir: string, contract: string, tail: string, libs: string[]): void {
    const refs = (...starts: number[]) => Object.fromEntries(libs.map((l) => [`src/libs/${l}.sol`, { [l]: starts.map((start) => ({ start, length: 20 })) }]));
    mkdirSync(join(dir, "out", `${contract}.sol`), { recursive: true });
    writeFileSync(join(dir, "out", `${contract}.sol`, `${contract}.json`), JSON.stringify({
      bytecode: { object: creationOf(PLACEHOLDER, tail), linkReferences: refs(5, 29) },
      deployedBytecode: { object: runtimeOf(PLACEHOLDER, tail), linkReferences: refs(4), immutableReferences: {} },
      abi: [],
    }));
    for (const l of libs) {
      mkdirSync(join(dir, "out", `${l}.sol`), { recursive: true });
      writeFileSync(join(dir, "out", `${l}.sol`, `${l}.json`), JSON.stringify({ bytecode: { object: LIB_CODE, linkReferences: {} }, deployedBytecode: { object: LIB_CODE, linkReferences: {}, immutableReferences: {} } }));
    }
  }

  function world050(o: { proxy?: "gateway" | "receipt"; editRc?: (j: any) => void; renames?: boolean; recordedLayout?: (spec: any, ids: Record<string, string>) => string; rcLibs?: string[]; liveCode?: string; deployed?: (creation: Hex) => string } = {}) {
    const proxy = o.proxy ?? "gateway";
    const d = setup({}, 918453);
    const saved = peekStageState();
    const table = loadStageTable(V050);
    useStageTable(table);
    try {
      const specs = proxySpecs(table);
      const spec = specs.find((x) => x.name === proxy)!;
      const core = tmp("pc-v050-core-"), rc = tmp("pc-v050-rc-");
      // the v0.5.0 checkout: its table and snapshots, and its build out/ (the live code)
      cpSync(V050, core, { recursive: true });
      writeOut(core, spec.contract, LIVE_TAIL, ["L"]);
      // the rc checkout: this repo's snapshots (the receipt's slot 0 renamed _retiredWriterSlot), its renames file, its build out/
      for (const s of specs) { const f = join(REPO, s.layout); if (existsSync(f)) { mkdirSync(dirname(join(rc, s.layout)), { recursive: true }); copyFileSync(f, join(rc, s.layout)); } }
      if (o.renames !== false) { mkdirSync(join(rc, "scripts", "ci"), { recursive: true }); copyFileSync(join(REPO, "scripts", "ci", "storage-layout-renames.json"), join(rc, "scripts", "ci", "storage-layout-renames.json")); }
      if (o.editRc) { const p = join(rc, spec.layout); const j = JSON.parse(readFileSync(p, "utf8")); o.editRc(j); writeFileSync(p, JSON.stringify(j)); }
      writeOut(rc, spec.contract, RC_TAIL, o.rcLibs ?? ["L"]);
      // the deployment's manifests, named by the v0.5.0 table, and the upgradeability.json the v0.5.0 verify wrote (its layout ids are the v0.5.0 snapshots')
      const dir = join(core, "deployments", "918453");
      mkdirSync(dir, { recursive: true });
      const proxyAddr = proxy === "gateway" ? A.gateway : RC_PROXY;
      writeFileSync(join(dir, "gateway.json"), JSON.stringify({ gateway: A.gateway }));
      writeFileSync(join(dir, "ic-policy.json"), JSON.stringify({ consensus_receipt: RC_PROXY, policy: addr(0x1007) }));
      const pins = table.upgradeAuthority!.layoutPins;
      const ids: Record<string, string> = Object.fromEntries(["gateway", "receipt"].map((n) => [n, layoutId(core, specs.find((x) => x.name === n)!.layout, pins)]));
      const proxies = { gateway: { proxy: A.gateway, layout_id: o.recordedLayout?.(specs[0], ids) ?? ids.gateway }, receipt: { proxy: RC_PROXY, layout_id: o.recordedLayout?.(spec, ids) ?? ids.receipt } };
      writeFileSync(join(dir, "upgradeability.json"), JSON.stringify({ chain_id: 918453, mode: "upgradeable", proxies }));
      const ctx = { ...d.ctx, coreDir: core, evidenceDir: join(core, "evidence"), caller: { yes: true }, signer: { address: async () => d.sheet.admin } } as unknown as RunContext;
      saveRunManifest(ctx.evidenceDir, newManifest(ctx, d.sheet.admin));
      const live = proxy === "gateway" ? LIVE : LIVE_RC;
      const s = { codes: new Map<string, string>([[live.toLowerCase(), o.liveCode ?? runtimeOf(LIB.slice(2), LIVE_TAIL)], [LIB.toLowerCase(), LIB_CODE]]), creates: [] as Hex[] };
      const api: DeployImplApi = {
        getCode: async (a) => (s.codes.get(a.toLowerCase()) ?? "0x") as Hex,
        implementationOf: async (p) => { expect(p.toLowerCase()).toBe(proxyAddr.toLowerCase()); return live; },
        upgradesFrozen: async () => false,
        forgeVersion: PINNED_FORGE,
        create: async (creation) => { s.creates.push(creation); s.codes.set(NEW.toLowerCase(), o.deployed ? o.deployed(creation) : `0x${creation.slice(2 + 25 * 2)}`); return { txHash: keccak256(creation), status: true, address: NEW }; },
      };
      const run = async () => { const was = peekStageState(); useStageTable(table); try { return await runDeployImplementation(ctx, { proxy, upgradeBuild: rc }, api); } finally { restoreStageState(was); } };
      return { ctx, s, run, rc, core, ids, spec };
    } finally { restoreStageState(saved); }
  }
  const entries = (w: { ctx: RunContext }) => implementationDeploysOf(loadRunManifest(w.ctx.evidenceDir)!);

  test("the v0.5.0 table names the receipt in the ic-policy stage and the recorded layout ids are the ones Deploy 3 recorded (0xe2ca...21a0, the gateway 0x6b24...f1f4)", () => {
    const t = loadStageTable(V050);
    const specs = proxySpecs(t);
    expect(specs.find((x) => x.name === "receipt")).toMatchObject({ stage: "ic-policy", field: "consensus_receipt", contract: "ConsensusRecommendationReceipt" });
    expect(specs.find((x) => x.name === "icpolicy")).toMatchObject({ stage: "ic-policy", field: "policy" });
    expect(specs.find((x) => x.name === "vault[rmAGENT]")).toMatchObject({ stage: "agent" });
    const pins = t.upgradeAuthority!.layoutPins;
    expect(layoutId(V050, specs.find((x) => x.name === "receipt")!.layout, pins)).toBe("0xe2ca7434dbf653b43914d8856a31a0c4f5523292eae0a3f514d8dee68bb221a0");
    expect(layoutId(REPO, specs.find((x) => x.name === "receipt")!.layout, pins)).toBe("0x35a244a88c20f3fafb46c41caa6e049660d60ec6ccbc996c8853bf2b210026e6");
    expect(layoutId(V050, specs.find((x) => x.name === "gateway")!.layout, pins)).toBe(layoutId(REPO, specs.find((x) => x.name === "gateway")!.layout, pins));
  });

  for (const proxy of ["gateway", "receipt"] as const) {
    test(`${proxy}: the live code is the --core-dir build, its links are read there, the new implementation is the --upgrade-build artifact: one CREATE and its entry`, async () => {
      const w = world050({ proxy });
      const res = await w.run();
      expect(w.s.creates.length).toBe(1);
      expect(w.s.creates[0]!.slice(2 + 5 * 2, 2 + 25 * 2)).toBe(LIB.slice(2));
      expect(w.s.creates[0]!).toContain(RC_TAIL);
      expect(res.entry).toMatchObject({ proxy_name: proxy, build: w.rc, libraries: { L: LIB }, implementation: NEW });
      expect(res.next).toContain(`--upgrade-build ${w.rc}`);
      expect(entries(w).length).toBe(1);
    });
  }

  test("each refusal still fires with nothing sent: live code that is not the --core-dir build, a layout id that is not the recorded one, a non-append-only snapshot, an unreviewed rename, a library the live code does not link", async () => {
    const cases: [string, ReturnType<typeof world050>, string][] = [
      ["live code", world050({ liveCode: runtimeOf(LIB.slice(2), RC_TAIL) }), "is not the RobotMoneyGateway of"],
      ["layout id", world050({ proxy: "receipt", recordedLayout: () => "0x35a244a88c20f3fafb46c41caa6e049660d60ec6ccbc996c8853bf2b210026e6" }), "is not the one verify recorded"],
      ["append-only", world050({ proxy: "receipt", editRc: (j) => { j.storage = [j.storage[1], j.storage[0], ...j.storage.slice(2)]; } }), "storage layout gate refuses"],
      ["unreviewed rename", world050({ proxy: "receipt", renames: false }), "storage: a variable moved, was retyped or removed"],
      ["library", world050({ rcLibs: ["L", "M"] }), "links M, which the live implementation does not link"],
    ];
    for (const [what, w, msg] of cases) {
      await expect(w.run(), what).rejects.toMatchObject({ kind: "REFUSED", message: expect.stringContaining(msg) });
      expect(w.s.creates, what).toEqual([]);
      expect(entries(w), what).toEqual([]);
    }
  });

  test("deployed code that is not the --upgrade-build artifact exits VERIFY and records no entry", async () => {
    const w = world050({ deployed: (creation) => `0x${creation.slice(2 + 25 * 2).replace(RC_TAIL, LIVE_TAIL)}` });
    await expect(w.run()).rejects.toMatchObject({ kind: "VERIFY", message: expect.stringContaining("is not the build's RobotMoneyGateway") });
    expect(w.s.creates.length).toBe(1);
    expect(entries(w)).toEqual([]);
  });
});
