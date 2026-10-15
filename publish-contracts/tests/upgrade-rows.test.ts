// Issue 1809 (ADR-0014 §4-§5): the govern rows upgrade-proxy and freeze-proxy, against the fake of the Safe tool (tests/govern-world.ts). The fake runs GovernedUpgrade as
// the contract behaves: only the timelock upgrades or freezes, nothing after a freeze, a freeze bound to the live implementation and its code hash. It proves what the tool
// schedules, refuses and records. The real proxies, the real Safe and the real delay are the Twin rehearsal's (P4) and the contracts' own lifecycle tests
// (contracts/test/GovernedUpgradeLifecycle.t.sol).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { decodeFunctionData, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { EXIT_CODES, type PublishError } from "../src/errors.ts";
import { GOVERN_ROWS, govRowRefusal, resolveGovernRow, resumeCommand, runGovern, stageRows, type RowRecord } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { getStageTable, stageByName } from "../src/stages.ts";
import { tableProxies } from "../src/stage-table.ts";
import { INITIALIZERS_LOCKED, ZERO_WORD, type ProxyState } from "../src/proxies.ts";
import {
  FREEZE_ROW, PROXY_GOVERN_ABI, UPGRADE_ROW, buildFreezeCall, buildUpgradeCall, freezeRecordKey, freezeRefusals, parseFreezeArgs, parseUpgradeArgs, upgradeLayoutRefusals, upgradeRecordKey, upgradeRefusals,
  type FreezeArgs, type UpgradeArgs,
} from "../src/upgrade-rows.ts";
import { currentProxyAddresses, freezesOf, upgradeLayoutsOf, upgradesOf, withRetiredProxies } from "../src/verify-stage.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { commitAll, gitIn, writeSourceArtifact } from "./source-checkout.ts";
import { absoluteBuild, parseCli } from "../src/cli.ts";
import { checkEvidence } from "../src/evidence-check.ts";
import { proveBuild, type BuildProvenance } from "../src/build-provenance.ts";
import { stageManifestName } from "../src/verify/constants.ts";
import { tmp } from "./fixtures.ts";
import { A, IMPL_AT, PROXY_AT, addr, fakeTimelock, implCode, sender, setup, signers, withProxies, writeBuild } from "./govern-world.ts";

const DELAY = 172800n;
const NAMES = tableProxies(getStageTable()).map((p) => p.name);
const tableProxiesNames = (): string[] => tableProxies(getStageTable()).map((p) => p.name);
const ARTIFACT = Object.fromEntries(tableProxies(getStageTable()).map((p) => [p.name, p.artifact])) as Record<string, string>;
const lc = (s: string): string => s.toLowerCase();
const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
/** The new gateway implementation the tests upgrade to, and the code it runs. */
const NEW = addr(0x9101);
const NEW_CODE = "0x6080604052007a5b00" as Hex;
const UPGRADE: UpgradeArgs = { proxy: "gateway", implementation: NEW };

/** The commit the fake build checkouts are at, and the release tag the fake 8453 gate finds there. */
const BUILD_SHA = "c".repeat(40);
const BUILD_TAG = "release/2.0.0";
/** A storage-layout snapshot of the gateway as the layout gate writes it (only the fields the storage rules read), and its identifier (0x + sha256 of the file). */
const LAYOUT_V1 = {
  contract: "RobotMoneyGateway", libraries: {}, openzeppelin: {},
  linearization: ["contracts/gateway/RobotMoneyGateway.sol:RobotMoneyGateway", "contracts/lib/GovernedUpgrade.sol:GovernedUpgrade"],
  storage: [
    { contract: "RobotMoneyGateway", label: "router", slot: 0, offset: 0, bytes: 20, type: "address" },
    { contract: "RobotMoneyGateway", label: "fees", slot: 1, offset: 0, bytes: 32, type: "uint256" },
  ],
  structs: {},
};
/** Writes a checkout's gateway layout snapshot; returns its identifier. */
function writeLayout(checkout: string, snapshot: object): string {
  const dir = join(checkout, "contracts", "test", "fixtures", "storage-layout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ARTIFACT.gateway}.json`), JSON.stringify(snapshot, null, 2) + "\n");
  return `0x${createHash("sha256").update(readFileSync(join(dir, `${ARTIFACT.gateway}.json`))).digest("hex")}`;
}
/** A fake build proof (security round 1): every build directory is in `checkout` at BUILD_SHA, and on 8453 the release gate passed with BUILD_TAG. */
const fakeProof = (chainId: number, checkout: string) => async (dir: string): Promise<BuildProvenance> =>
  ({ dir, checkout, sha: BUILD_SHA, ...(chainId === 8453 ? { tag: BUILD_TAG, proof: "release-gate" as const } : { proof: "checkout-sha" as const }) });

/**
 * A deployment as the deploy leaves it: every proxy names its implementation, the timelock is the authority, nothing is frozen. The checkout's out/ holds the build of
 * each implementation (the code each runs). `frozen` names proxies born frozen. `deployNew` puts the new gateway implementation on chain (UUPS, initializers locked).
 * Security round 1: the gateway's deploy manifest names its implementation and its storage-layout identifier, the deployment checkout holds that snapshot, and every
 * build is proven by a fake (the checkout is the deployment checkout, at BUILD_SHA); a test that proves builds for real passes `buildProvenance: undefined`.
 */
function world(chainId = 918453, o: { frozen?: string[]; deployNew?: boolean } = {}) {
  const { ctx, sheet } = setup({}, chainId);
  const liveLayoutId = writeLayout(ctx.coreDir, LAYOUT_V1);
  const gatewayManifest = join(ctx.coreDir, "deployments", String(chainId), `${stageManifestName(getStageTable(), "gateway")}.json`);
  writeFileSync(gatewayManifest, JSON.stringify({ ...JSON.parse(readFileSync(gatewayManifest, "utf8")), gateway_implementation: IMPL_AT.gateway, gateway_layout_id: liveLayoutId }));
  const tl = fakeTimelock(sheet, DELAY);
  withProxies(tl, { frozen: o.frozen });
  writeBuild(join(ctx.coreDir, "out"), Object.fromEntries(NAMES.map((n) => [ARTIFACT[n]!, implCode(n)])));
  if (o.deployNew !== false) { tl.s.codes.set(lc(NEW), NEW_CODE); tl.s.uups.add(lc(NEW)); tl.s.locked.add(lc(NEW)); }
  /** The reviewed build of the new gateway implementation: an out/ of its own, as the release checkout would be. */
  const newBuild = writeBuild(join(ctx.coreDir, "out-v2"), { [ARTIFACT.gateway!]: NEW_CODE });
  const manifest = newManifest(ctx, addr(0xa001));
  const out: string[] = [];
  const opts = (extra: object = {}) => ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: async (sec: bigint) => { tl.s.clock += sec; }, maxWaitSeconds: 10_000_000, emit: (l: string) => out.push(l), buildProvenance: fakeProof(chainId, ctx.coreDir), ...extra });
  const upgrade = (args: UpgradeArgs, extra: object = {}) => runGovern(ctx, stageByName("govern"), manifest, { ...opts(extra), row: UPGRADE_ROW, proxyUpgrade: args });
  const freeze = (args: FreezeArgs, extra: object = {}) => runGovern(ctx, stageByName("govern"), manifest, { ...opts(extra), row: FREEZE_ROW, proxyFreeze: args });
  const proxy = (name: string) => tl.s.proxies.get(lc(PROXY_AT[name]!))!;
  return { ctx, sheet, tl, manifest, out, upgrade, freeze, proxy, newBuild, liveLayoutId };
}

describe("issue 1809: the upgrade and freeze rows are on demand, never stage 13, and run on every chain and kind", () => {
  test("neither row is a numbered row, a stage row or a default run; resolveGovernRow names their arguments; no chain or kind refuses them", () => {
    for (const r of [UPGRADE_ROW, FREEZE_ROW]) {
      expect([...GOVERN_ROWS]).not.toContain(r);
      for (const chain of [8453, 918453]) expect([...stageRows(chain)]).not.toContain(r);
      expect(() => resolveGovernRow(r)).toThrow("on-demand");
      for (const kind of ["production", "rehearsal"] as const) for (const chain of [8453, 918453]) expect(govRowRefusal(r, chain, kind)).toBeUndefined();
    }
  });

  test("bad arguments are USAGE before the Safe is read and nothing is sent", async () => {
    const bad: [UpgradeArgs | undefined, string][] = [
      [undefined, "needs --admin-arg proxy="],
      [{ proxy: "vault" }, "--admin-arg proxy must be one of"],
      [{ proxy: "gateway" }, "implementation=0x<address>"],
      [{ proxy: "gateway", implementation: "0x1234" }, "implementation=0x<address>"],
      [{ proxy: "gateway", implementation: `0x${"0".repeat(40)}` }, "zero address"],
      [{ ...UPGRADE, call: "1234" }, "0x-prefixed calldata"],
      [{ ...UPGRADE, call: "0x123" }, "0x-prefixed calldata"],
      [{ proxy: "all", implementation: NEW }, "--admin-arg proxy must be one of"],
    ];
    for (const [args, msg] of bad) {
      expect(() => parseUpgradeArgs(args, NAMES)).toThrow(msg);
      const w = world();
      let connected = 0;
      const connect = w.tl.api.connectSafe;
      w.tl.api.connectSafe = (async (...x: unknown[]) => { connected++; return (connect as (...y: unknown[]) => unknown)(...x); }) as never;
      await expect(w.upgrade(args as UpgradeArgs)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(msg) });
      expect(connected).toBe(0);
      expect(w.tl.s.events).toEqual([]);
    }
    expect(() => parseFreezeArgs(undefined, NAMES)).toThrow("proxy=");
    expect(() => parseFreezeArgs({ proxy: "timelock" }, NAMES)).toThrow("--admin-arg proxy must be one of");
    expect(parseFreezeArgs({ proxy: "all" }, NAMES)).toEqual({ proxy: "all" });
    // a deployment before the proxies has nothing to upgrade or freeze
    expect(() => parseUpgradeArgs(UPGRADE, [])).toThrow("lists no proxies");
    // each row's --admin-arg values go with that row only
    const w = world();
    await expect(runGovern(w.ctx, stageByName("govern"), w.manifest, { ownerSigners: signers(w.sheet), sender, api: w.tl.api, row: "unpause-PROTO", proxyUpgrade: UPGRADE } as never)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(`--row ${UPGRADE_ROW} only`) });
    await expect(runGovern(w.ctx, stageByName("govern"), w.manifest, { ownerSigners: signers(w.sheet), sender, api: w.tl.api, row: UPGRADE_ROW, proxyUpgrade: UPGRADE, proxyFreeze: { proxy: "gateway" } } as never)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(`--row ${FREEZE_ROW} only`) });
  });
});

describe("issue 1809: govern --row upgrade-proxy", () => {
  test("ONE upgradeToAndCall on the proxy, scheduled through the Safe, executed after the delay, read back; the Safe transaction names both implementations; the evidence records the round", async () => {
    const w = world();
    const want = parseUpgradeArgs({ ...UPGRADE, build: w.newBuild }, NAMES);
    const res = await w.upgrade({ ...UPGRADE, build: w.newBuild });
    const name = upgradeRecordKey(want);
    expect(name).toMatch(new RegExp(`^${UPGRADE_ROW}-gateway-[0-9a-f]{8}$`));
    expect(res.rows).toEqual([name]);
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
    const sc = w.tl.s.scheduled.get(UPGRADE_ROW)!;
    expect(sc.form).toBe("single");
    expect(sc.calls).toEqual([{ target: A.gateway, data: encodeFunctionData({ abi: PROXY_GOVERN_ABI, functionName: "upgradeToAndCall", args: [want.implementation, "0x"] }) }]);
    expect(lc(sc.description!)).toContain(lc(`gateway ${A.gateway} from ${IMPL_AT.gateway} to ${NEW}`));
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(NEW));
    expect(w.out.map((l) => JSON.parse(l)).map((l) => `${l.row}:${l.phase}:${l.status}`)).toEqual([`${UPGRADE_ROW}:scheduled:1`, `${UPGRADE_ROW}:executed:1`]);
    const e = (w.manifest as { proxy_upgrades?: any[] }).proxy_upgrades!;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      step: UPGRADE_ROW, key: name, round: 1, proxy: "gateway", proxy_address: A.gateway, implementation: want.implementation, implementation_code_hash: keccak256(NEW_CODE),
      call_data: "0x", build_dir: w.newBuild, timelock: A.timelock, schedule_status: 1, execute_status: 1,
      // security round 1: the commit the build was proven at, and the two storage layouts compared (equal here)
      build_sha: BUILD_SHA, build_proof: "checkout-sha", live_layout_hash: w.liveLayoutId, build_layout_hash: w.liveLayoutId,
    });
    expect(lc(e[0].from_implementation)).toBe(lc(IMPL_AT.gateway!));
    // the verifier expects the gateway on the round's target, compared with the round's build
    expect(upgradesOf(w.manifest)).toEqual([{ proxy: "gateway", implementation: want.implementation, buildDir: w.newBuild, buildSha: BUILD_SHA }]);
    // never part of stage 13; a rerun reprints the lines and sends nothing
    expect(w.manifest.stages.govern).toBeUndefined();
    w.out.length = 0;
    expect((await w.upgrade({ ...UPGRADE, build: w.newBuild })).skipped).toEqual([]);
    expect(w.tl.s.events).toHaveLength(2);
    expect(w.out.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed"]);
    expect((w.manifest as { proxy_upgrades?: any[] }).proxy_upgrades).toHaveLength(1);
  });

  test("refused with GOVERN and nothing scheduled: a frozen proxy, a target that is not the reviewed build, no code, no UUPS, unlocked initializers, an authority that is not the timelock, an admin slot", async () => {
    const cases: [string, (w: ReturnType<typeof world>) => UpgradeArgs, string][] = [
      ["frozen", (w) => { w.proxy("gateway").frozen = true; return { ...UPGRADE, build: w.newBuild }; }, "is frozen"],
      ["the checkout's build is the old implementation's", () => UPGRADE, "is not the reviewed build"],
      ["another build", (w) => ({ ...UPGRADE, build: writeBuild(join(w.ctx.coreDir, "out-other"), { [ARTIFACT.gateway!]: "0x6080604052007b5b00" }) }), "is not the reviewed build"],
      ["a build with no artifact", (w) => ({ ...UPGRADE, build: join(w.ctx.coreDir, "nowhere") }), "no build to compare with"],
      ["no code", (w) => { w.tl.s.codes.set(lc(NEW), "0x"); return { ...UPGRADE, build: w.newBuild }; }, "has no code"],
      ["not UUPS", (w) => { w.tl.s.uups.delete(lc(NEW)); return { ...UPGRADE, build: w.newBuild }; }, "no UUPS implementation"],
      ["unlocked initializers", (w) => { w.tl.s.locked.delete(lc(NEW)); return { ...UPGRADE, build: w.newBuild }; }, "initializers are not locked"],
      ["another authority", (w) => { w.proxy("gateway").authority = addr(0xbad); return { ...UPGRADE, build: w.newBuild }; }, "not the timelock"],
      ["an admin slot", (w) => { w.proxy("gateway").admin = `0x${"0".repeat(24)}${"ba".repeat(20)}` as Hex; return { ...UPGRADE, build: w.newBuild }; }, "admin slot is not empty"],
    ];
    for (const [why, arrange, msg] of cases) {
      const w = world();
      const args = arrange(w);
      let err: unknown;
      try { await w.upgrade(args); } catch (e) { err = e; }
      expect([why, (err as PublishError)?.kind]).toEqual([why, "GOVERN"]);
      expect((err as PublishError).exitCode).toBe(EXIT_CODES.GOVERN);
      expect([why, (err as PublishError).message]).toEqual([why, expect.stringContaining(msg)]);
      expect([why, w.tl.s.events]).toEqual([why, []]);
      expect(lc(w.proxy("gateway").implementation)).toBe(lc(IMPL_AT.gateway!));
    }
  });

  test("an implementation the proxy already runs is recorded as skipped and nothing is sent", async () => {
    const w = world();
    const res = await w.upgrade({ proxy: "router", implementation: IMPL_AT.router! });
    expect(res.skipped).toEqual(res.rows);
    expect(w.tl.s.events).toEqual([]);
    expect(w.manifest.govern![res.rows[0]!]).toMatchObject({ skipped: { reason: expect.stringContaining("already runs") } });
  });

  test("on 8453 the row schedules and exits GOVERN_PENDING with a resume command that spells out its --admin-arg values; the resume after the delay executes it", async () => {
    const w = world(8453);
    let err: unknown;
    try { await w.upgrade({ ...UPGRADE, build: w.newBuild }, { warp: noWarp }); } catch (e) { err = e; }
    const e = err as PublishError;
    expect(e.kind).toBe("GOVERN_PENDING");
    const want = parseUpgradeArgs({ ...UPGRADE, build: w.newBuild }, NAMES);
    expect(String(e.details.next_command)).toContain(`--row ${UPGRADE_ROW} --admin-arg proxy=gateway --admin-arg implementation=${want.implementation} --admin-arg build=${w.newBuild}`);
    expect(String(e.details.next_command)).toContain("--chain 8453");
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`]);
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(IMPL_AT.gateway!)); // nothing changes during the delay: withdrawals stay open the whole time
    w.tl.s.clock += DELAY;
    await w.upgrade({ ...UPGRADE, build: w.newBuild }, { warp: noWarp });
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(NEW));
    // the resume command text for the record key, without and with the parsed arguments
    expect(resumeCommand(w.ctx, upgradeRecordKey(want))).toContain(`--row ${UPGRADE_ROW} --admin-arg K=V`);
    expect(resumeCommand(w.ctx, upgradeRecordKey(want), undefined, undefined, { upgrade: want })).toContain(`--admin-arg implementation=${want.implementation}`);
  });

  test("a reinitializer call is carried in the one call and changes the record key", () => {
    const plain = parseUpgradeArgs(UPGRADE, NAMES);
    const withCall = parseUpgradeArgs({ ...UPGRADE, call: "0xABCDEF01" }, NAMES);
    expect(withCall.call).toBe("0xabcdef01");
    expect(upgradeRecordKey(withCall)).not.toBe(upgradeRecordKey(plain));
    const c = buildUpgradeCall("gateway", A.gateway, withCall);
    expect(c.target).toBe(A.gateway);
    expect(decodeFunctionData({ abi: PROXY_GOVERN_ABI, data: c.data }).args).toEqual([withCall.implementation, "0xabcdef01"]);
    expect(c.label).toContain("0xabcdef01");
  });
});

describe("issue 1809: govern --row freeze-proxy", () => {
  test("ONE freezeUpgrades(liveImplementation, liveCodeHash) on the proxy, read back; the Safe transaction says PERMANENT; the evidence records what was frozen; a rerun sends nothing", async () => {
    const w = world();
    const res = await w.freeze({ proxy: "gateway" });
    const hash = keccak256(implCode("gateway"));
    const call = buildFreezeCall("gateway", A.gateway, IMPL_AT.gateway!, hash);
    const name = freezeRecordKey("gateway", [call]);
    expect(res.rows).toEqual([name]);
    expect(w.tl.s.events).toEqual([`schedule:${FREEZE_ROW}`, `execute:${FREEZE_ROW}`]);
    const sc = w.tl.s.scheduled.get(FREEZE_ROW)!;
    expect(sc.form).toBe("single");
    expect(sc.calls).toEqual([{ target: A.gateway, data: call.data }]);
    expect(decodeFunctionData({ abi: PROXY_GOVERN_ABI, data: call.data }).args).toEqual([expect.stringMatching(/^0x0+9004$/i), hash]);
    expect(sc.description).toContain("PERMANENT");
    expect(sc.description).toContain(`codehash ${hash}`);
    expect(w.proxy("gateway").frozen).toBe(true);
    expect(w.proxy("router").frozen).toBe(false);
    const e = (w.manifest as { proxy_freezes?: any[] }).proxy_freezes!;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ step: FREEZE_ROW, key: name, round: 1, proxies: [{ name: "gateway", proxy: A.gateway, code_hash: hash }], timelock: A.timelock, schedule_status: 1, execute_status: 1 });
    expect(lc(e[0].proxies[0].implementation)).toBe(lc(IMPL_AT.gateway!));
    expect(freezesOf(w.manifest)).toEqual(["gateway"]);
    // a rerun reprints the executed round and sends nothing
    w.out.length = 0;
    expect((await w.freeze({ proxy: "gateway" })).rows).toEqual([name]);
    expect(w.tl.s.events).toHaveLength(2);
    expect(w.out.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed"]);
    // the freeze is one-way: an upgrade of a frozen proxy is refused before anything is scheduled
    await expect(w.upgrade({ ...UPGRADE, build: w.newBuild })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is frozen") });
    expect(w.tl.s.events).toHaveLength(2);
  });

  test("proxy=all freezes every proxy not yet frozen in ONE batch and skips one frozen at deploy; when all read frozen nothing is sent", async () => {
    const w = world(918453, { frozen: ["rmUSDC"] });
    await w.freeze({ proxy: "all" });
    expect(w.tl.s.events).toEqual([`scheduleBatch:${FREEZE_ROW}`, `executeBatch:${FREEZE_ROW}`]);
    const sc = w.tl.s.scheduled.get(FREEZE_ROW)!;
    expect(sc.calls.map((c) => lc(c.target))).toEqual(NAMES.filter((n) => n !== "rmUSDC").map((n) => lc(PROXY_AT[n]!)));
    for (const n of NAMES) expect([n, w.proxy(n).frozen]).toEqual([n, true]);
    expect(freezesOf(w.manifest).sort()).toEqual(NAMES.filter((n) => n !== "rmUSDC").sort());
    const all = world(918453, { frozen: [...NAMES] });
    const res = await all.freeze({ proxy: "all" });
    expect(res.skipped).toEqual(res.rows);
    expect(all.tl.s.events).toEqual([]);
    expect(all.manifest.govern![res.rows[0]!]).toMatchObject({ skipped: { reason: expect.stringContaining("upgradesFrozen() true") } });
  });

  test("refused with GOVERN and nothing scheduled: the live implementation is not the reviewed build, an upgrade round of the proxy is still pending, the authority is not the timelock", async () => {
    const other = world();
    writeBuild(join(other.ctx.coreDir, "out"), { [ARTIFACT.gateway!]: "0x6080604052007c5b00" });
    await expect(other.freeze({ proxy: "gateway" })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not the reviewed build, and a freeze would fix it forever") });
    expect(other.tl.s.events).toEqual([]);
    expect(other.proxy("gateway").frozen).toBe(false);
    // ADR-0014 §5: an upgrade still queued must be cancelled through the Safe before the freeze
    const pending = world(8453);
    await expect(pending.upgrade({ ...UPGRADE, build: pending.newBuild }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    await expect(pending.freeze({ proxy: "gateway" }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is scheduled and not executed: cancel it through the Safe") });
    expect(pending.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`]);
    const foreign = world();
    foreign.proxy("router").authority = addr(0xbad);
    await expect(foreign.freeze({ proxy: "all" })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("router.upgradeAuthority()") });
    expect(foreign.tl.s.events).toEqual([]);
  });

  test("a freeze or an upgrade the operator cancelled through the Safe is scheduled again in the same round, executes after the delay and still records its evidence", async () => {
    const w = world(8453);
    await expect(w.freeze({ proxy: "gateway" }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    w.tl.s.ops.delete(w.tl.s.ids.get(FREEZE_ROW)!);
    await expect(w.freeze({ proxy: "gateway" }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual([`schedule:${FREEZE_ROW}`, `schedule:${FREEZE_ROW}`]);
    w.tl.s.clock += DELAY;
    await w.freeze({ proxy: "gateway" }, { warp: noWarp });
    expect(w.proxy("gateway").frozen).toBe(true);
    expect((w.manifest as { proxy_freezes?: any[] }).proxy_freezes).toHaveLength(1);
    expect(Object.keys(w.manifest.govern!).some((k) => k.startsWith(`${FREEZE_ROW}-gateway-`) && k.endsWith(":cancelled-1"))).toBe(true);
    const u = world(8453);
    await expect(u.upgrade({ ...UPGRADE, build: u.newBuild }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    u.tl.s.ops.delete(u.tl.s.ids.get(UPGRADE_ROW)!);
    await expect(u.upgrade({ ...UPGRADE, build: u.newBuild }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    u.tl.s.clock += DELAY;
    await u.upgrade({ ...UPGRADE, build: u.newBuild }, { warp: noWarp });
    expect(u.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
    expect(lc(u.proxy("gateway").implementation)).toBe(lc(NEW));
    expect((u.manifest as { proxy_upgrades?: any[] }).proxy_upgrades).toHaveLength(1);
  });

  test("the freeze names its target: an upgrade that executes between the freeze's schedule and its execute makes the freeze revert, and nothing is frozen", async () => {
    const w = world(8453);
    await expect(w.freeze({ proxy: "gateway" }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING", details: { next_command: expect.stringContaining(`--row ${FREEZE_ROW} --admin-arg proxy=gateway`) } });
    expect(w.tl.s.events).toEqual([`schedule:${FREEZE_ROW}`]);
    // meanwhile another operation upgraded the gateway (an upgrade scheduled before the freeze)
    w.proxy("gateway").implementation = NEW;
    w.tl.s.clock += DELAY;
    await expect(w.freeze({ proxy: "gateway" }, { warp: noWarp })).rejects.toThrow("FreezeTargetMismatch");
    expect(w.proxy("gateway").frozen).toBe(false);
    // the resumed round executed the operation the Safe signed, never a plan re-read from the chain
    expect(w.tl.s.events).toEqual([`schedule:${FREEZE_ROW}`, `execute:${FREEZE_ROW}`]);
  });
});

const cleanEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...cleanEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
/** The reviewed source of the new gateway implementation in a build checkout (security round 2: its forge artifact carries this source's hash). */
const GATEWAY_SOL = "contracts/gateway/RobotMoneyGateway.sol";
const GATEWAY_V2_SOURCE = "// SPDX-License-Identifier: MIT\ncontract RobotMoneyGateway { uint256 reviewedV2; }\n";
/**
 * A REAL git checkout holding the new gateway's source and the layout snapshot, committed: HEAD is a sha no release tag points at. Its out/ is git-ignored, as in the
 * repository, and holds the new gateway's build compiled from the committed source (forge's metadata names it; security round 2).
 */
function buildCheckout(layout: object = LAYOUT_V1): { root: string; out: string; sha: string } {
  const root = tmp("pc-build-");
  git(root, "init", "-q"); git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "out/\n");
  mkdirSync(join(root, "contracts", "gateway"), { recursive: true });
  writeFileSync(join(root, GATEWAY_SOL), GATEWAY_V2_SOURCE);
  writeLayout(root, layout);
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "a build no release tag names");
  const out = writeSourceArtifact(join(root, "out"), ARTIFACT.gateway!, { code: NEW_CODE, target: GATEWAY_SOL, sources: { [GATEWAY_SOL]: GATEWAY_V2_SOURCE } });
  return { root, out, sha: git(root, "rev-parse", "HEAD") };
}
/** The run manifest's govern records, typed. */
const gov = (w: { manifest: { govern?: unknown } }): Record<string, RowRecord> => w.manifest.govern as Record<string, RowRecord>;
/** Counts the Safe connections of a world: a refusal "before connectSafe" leaves it at 0. */
function countConnects(w: ReturnType<typeof world>): { n: number } {
  const c = { n: 0 };
  const connect = w.tl.api.connectSafe;
  w.tl.api.connectSafe = (async (...x: unknown[]) => { c.n++; return (connect as (...y: unknown[]) => unknown)(...x); }) as never;
  return c;
}

describe("security round 1: the build an upgrade or a freeze compares with is a reviewed release, and its layout keeps the live one", () => {
  test("on 8453 an upgrade-proxy whose build= is a checkout at an untagged sha is refused with RELEASE_SHA_UNTAGGED before the Safe is read; nothing is scheduled", async () => {
    const w = world(8453);
    const b = buildCheckout();
    const c = countConnects(w);
    await expect(w.upgrade({ ...UPGRADE, build: b.out }, { warp: noWarp, buildProvenance: undefined })).rejects.toMatchObject({ kind: "RELEASE_SHA_UNTAGGED", message: expect.stringContaining(b.sha) });
    expect(c.n).toBe(0);
    expect(w.tl.s.events).toEqual([]);
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(IMPL_AT.gateway!));
  });

  test("on 8453 a build= that is in no git checkout, or in a checkout with uncommitted changes, is refused with GOVERN; nothing is scheduled", async () => {
    // no checkout (no readable HEAD): refused on 8453, recorded as unproven elsewhere
    const noHead = { dir: "/nowhere/out", coreDir: "/core", coreSha: "a".repeat(40), row: UPGRADE_ROW, gate: async () => BUILD_TAG, head: () => undefined };
    await expect(proveBuild({ ...noHead, chainId: 8453 })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not inside a git checkout") });
    expect(await proveBuild({ ...noHead, chainId: 918453 })).toMatchObject({ proof: "none" });
    expect((await proveBuild({ ...noHead, chainId: 918453 })).sha).toBeUndefined();
    const dirty = world(8453);
    const b = buildCheckout();
    writeFileSync(join(b.root, "stray.txt"), "not committed\n");
    let gated = false;
    await expect(dirty.upgrade({ ...UPGRADE, build: b.out }, { warp: noWarp, buildProvenance: undefined, buildGate: async () => { gated = true; return BUILD_TAG; } })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("uncommitted changes") });
    expect(gated).toBe(false);
    expect(dirty.tl.s.events).toEqual([]);
  });

  test("mutation: the same checkout, clean and gated, schedules the upgrade and records its commit and tag", async () => {
    const w = world(8453);
    const b = buildCheckout();
    let gatedSha: string | undefined;
    await expect(w.upgrade({ ...UPGRADE, build: b.out }, { warp: noWarp, buildProvenance: undefined, buildGate: async (i: { sha: string }) => { gatedSha = i.sha; return BUILD_TAG; } })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(gatedSha).toBe(b.sha);
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`]);
    const rec = gov(w)[upgradeRecordKey(parseUpgradeArgs({ ...UPGRADE, build: b.out }, NAMES))]!.upgrade!;
    expect(rec).toMatchObject({ build_dir: b.out, build_sha: b.sha, build_tag: BUILD_TAG, build_proof: "release-gate", live_layout_hash: w.liveLayoutId, build_layout_hash: w.liveLayoutId });
    expect(rec.core_sha).toBe(w.ctx.coreSha); // the deployment's sha stays what it is; the build's commit is build_sha
  });

  test("security round 3 (review: SECURITY_AVAILABILITY_SELF_PAUSE): a relative build= is recorded as an absolute build_dir, so a verify from another directory names the same build", async () => {
    const w = world(8453);
    const b = buildCheckout();
    const rel = relative(process.cwd(), b.out);
    expect(isAbsolute(rel)).toBe(false);
    await expect(w.upgrade({ ...UPGRADE, build: rel }, { warp: noWarp, buildProvenance: undefined, buildGate: async () => BUILD_TAG })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    const rec = gov(w)[upgradeRecordKey(parseUpgradeArgs({ ...UPGRADE, build: rel }, NAMES))]!.upgrade!;
    expect(rec.build_dir).toBe(b.out);
    expect(isAbsolute(rec.build_dir)).toBe(true);
    // the CLI resolves build= against its own working directory (deps.cwd) before govern sees it; a row without build= is unchanged
    expect(absoluteBuild({ proxy: "gateway", build: "../rel-1.1/out" }, "/work/deploy")).toEqual({ proxy: "gateway", build: "/work/rel-1.1/out" });
    expect(absoluteBuild({ proxy: "all" }, "/work")).toEqual({ proxy: "all" });
  });

  test("on 8453 a freeze-proxy whose build= is a checkout at an untagged sha is refused with RELEASE_SHA_UNTAGGED before the Safe is read", async () => {
    const w = world(8453);
    const b = buildCheckout();
    const c = countConnects(w);
    await expect(w.freeze({ proxy: "gateway", build: b.out }, { warp: noWarp, buildProvenance: undefined })).rejects.toMatchObject({ kind: "RELEASE_SHA_UNTAGGED" });
    expect(c.n).toBe(0);
    expect(w.tl.s.events).toEqual([]);
    expect(w.proxy("gateway").frozen).toBe(false);
  });

  test("a build whose layout snapshot moves an existing variable relative to the live layout id is refused with GOVERN on every chain; nothing is scheduled", async () => {
    // the two live variables swap slots: router moves from slot 0 to slot 1, fees from 1 to 0
    const [router, fees] = LAYOUT_V1.storage as [(typeof LAYOUT_V1.storage)[0], (typeof LAYOUT_V1.storage)[0]];
    const moved = { ...LAYOUT_V1, storage: [{ ...fees, slot: 0 }, { ...router, slot: 1 }] };
    for (const chainId of [8453, 918453]) {
      const w = world(chainId);
      const other = tmp("pc-layout-");
      expect(writeLayout(other, moved)).not.toBe(w.liveLayoutId);
      await expect(w.upgrade({ ...UPGRADE, build: w.newBuild }, { warp: noWarp, buildProvenance: fakeProof(chainId, other) }))
        .rejects.toMatchObject({ kind: "GOVERN", message: expect.stringMatching(/breaks the live one.*variable router changed slot: 0 -> 1/) });
      expect([chainId, w.tl.s.events]).toEqual([chainId, []]);
      expect(lc(w.proxy("gateway").implementation)).toBe(lc(IMPL_AT.gateway!));
    }
  });

  test("mutation: a build that appends a variable after the last live slot passes and records both layout ids", async () => {
    const appended = { ...LAYOUT_V1, storage: [...LAYOUT_V1.storage, { contract: "RobotMoneyGateway", label: "limit", slot: 2, offset: 0, bytes: 32, type: "uint256" }] };
    const w = world();
    const other = tmp("pc-layout-");
    const id = writeLayout(other, appended);
    await w.upgrade({ ...UPGRADE, build: w.newBuild }, { buildProvenance: fakeProof(918453, other) });
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
    expect((w.manifest as { proxy_upgrades?: any[] }).proxy_upgrades![0]).toMatchObject({ live_layout_hash: w.liveLayoutId, build_layout_hash: id });
  });

  test("on 8453 a live layout id that is not recorded, or a build checkout with no snapshot, is refused; elsewhere it is not", async () => {
    const empty = tmp("pc-nolayout-");
    const w = world(8453);
    await expect(w.upgrade({ ...UPGRADE, build: w.newBuild }, { warp: noWarp, buildProvenance: fakeProof(8453, empty) })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("holds no storage-layout snapshot") });
    const unrecorded = world(8453);
    const gm = join(unrecorded.ctx.coreDir, "deployments", "8453", `${stageManifestName(getStageTable(), "gateway")}.json`);
    const { gateway_layout_id: _dropped, ...rest } = JSON.parse(readFileSync(gm, "utf8"));
    writeFileSync(gm, JSON.stringify(rest));
    await expect(unrecorded.upgrade({ ...UPGRADE, build: unrecorded.newBuild }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("no storage-layout identifier is recorded") });
    expect(unrecorded.tl.s.events).toEqual([]);
    const t = world(918453);
    await t.upgrade({ ...UPGRADE, build: t.newBuild }, { buildProvenance: fakeProof(918453, empty) });
    expect(t.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
  });

  test("evidence-check refuses an 8453 proxy_upgrades entry without build_sha or layout ids, and a proxy_freezes entry without the build_sha of each frozen proxy", () => {
    const T = A.timelock;
    const op = { operation_id: `0x${"11".repeat(32)}`, schedule_tx: `0x${"12".repeat(32)}`, schedule_status: 1, schedule_block_timestamp: 2000, execute_tx: `0x${"13".repeat(32)}`, execute_status: 1, execute_block_timestamp: 2000 + 172800 };
    const up = { step: UPGRADE_ROW, proxy: "gateway", proxy_address: A.gateway, from_implementation: IMPL_AT.gateway, implementation: NEW, implementation_code_hash: `0x${"ef".repeat(32)}`, timelock: T, round: 1, build_sha: BUILD_SHA, live_layout_hash: `0x${"aa".repeat(32)}`, build_layout_hash: `0x${"bb".repeat(32)}`, ...op };
    const fr = { step: FREEZE_ROW, proxies: [{ name: "gateway", proxy: A.gateway, implementation: NEW, code_hash: `0x${"cd".repeat(32)}` }], build_shas: { gateway: BUILD_SHA }, timelock: T, round: 1, ...op, operation_id: `0x${"21".repeat(32)}`, schedule_tx: `0x${"22".repeat(32)}`, execute_tx: `0x${"23".repeat(32)}` };
    const problems = (e: object) => checkEvidence({ chain_id: 8453, timelock: { address: T, min_delay: 172800 }, ...e }).filter((m) => /upgrade-proxy|freeze-proxy/.test(m));
    expect(problems({ proxy_upgrades: [up], proxy_freezes: [fr] })).toEqual([]);
    for (const k of ["build_sha", "live_layout_hash", "build_layout_hash"]) {
      const { [k]: _gone, ...rest } = up as Record<string, unknown>;
      expect([k, problems({ proxy_upgrades: [rest] }).join()]).toEqual([k, expect.stringContaining(k)]);
    }
    expect(problems({ proxy_upgrades: [{ ...up, build_sha: "main" }] }).join()).toContain("build_sha");
    expect(problems({ proxy_freezes: [{ ...fr, build_shas: {} }] }).join()).toContain("build_shas.gateway");
  });
});

describe("security round 1: upgrade rounds are numbered, so an earlier record never stands for the chain", () => {
  const OUT = (w: ReturnType<typeof world>) => join(w.ctx.coreDir, "out");
  test("A to B to A, then B again schedules a NEW round (a new operation) instead of reprinting the round that executed first", async () => {
    const w = world();
    const toB = { ...UPGRADE, build: w.newBuild };
    const toA = { proxy: "gateway", implementation: IMPL_AT.gateway!, build: OUT(w) };
    await w.upgrade(toB);
    const firstB = w.tl.s.ids.get(UPGRADE_ROW);
    await w.upgrade(toA);
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(IMPL_AT.gateway!));
    await w.upgrade(toB);
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`, `schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`, `schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(NEW));
    const key = upgradeRecordKey(parseUpgradeArgs(toB, NAMES));
    expect(gov(w)[key]!.round).toBe(2);
    expect(gov(w)[`${key}:round-1`]!.executed).toBeDefined();
    expect(w.tl.s.ids.get(UPGRADE_ROW)).not.toBe(firstB);
    // three executed rounds, three evidence entries; the verifier expects the last one
    expect((w.manifest as { proxy_upgrades?: any[] }).proxy_upgrades).toHaveLength(3);
    expect(upgradesOf(w.manifest)).toMatchObject([{ proxy: "gateway", implementation: NEW }]);
    // a rerun now reprints round 2 and sends nothing
    await w.upgrade(toB);
    expect(w.tl.s.events).toHaveLength(6);
  });

  test("a skipped record for A does not block a later rollback from B to A", async () => {
    const w = world();
    const toA = { proxy: "gateway", implementation: IMPL_AT.gateway!, build: OUT(w) };
    expect((await w.upgrade(toA)).skipped).toHaveLength(1);
    await w.upgrade({ ...UPGRADE, build: w.newBuild });
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(NEW));
    const res = await w.upgrade(toA);
    expect(res.skipped).toEqual([]);
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`, `schedule:${UPGRADE_ROW}`, `execute:${UPGRADE_ROW}`]);
    expect(lc(w.proxy("gateway").implementation)).toBe(lc(IMPL_AT.gateway!));
    const key = upgradeRecordKey(parseUpgradeArgs(toA, NAMES));
    expect(gov(w)[`${key}:round-1`]!.skipped).toBeDefined();
    expect(gov(w)[key]!.round).toBe(2);
  });
});

describe("security round 1: a vault a redeploy replaced is still a proxy, and freeze-proxy freezes it", () => {
  const OLD = addr(0x3f02), OLD_IMPL = addr(0x9f02);
  /** A governed redeploy of rmPROTO: the vault manifest names the new vault (PROXY_AT.rmPROTO); the old one is a live proxy on the deployment's build, holders inside. */
  const withRetired = (w: ReturnType<typeof world>) => {
    w.tl.s.proxies.set(lc(OLD), { implementation: OLD_IMPL, frozen: false, authority: A.timelock, admin: `0x${"00".repeat(32)}` as Hex });
    w.tl.s.codes.set(lc(OLD_IMPL), implCode("rmPROTO")); w.tl.s.uups.add(lc(OLD_IMPL)); w.tl.s.locked.add(lc(OLD_IMPL));
    (w.manifest as { vault_redeploys?: unknown[] }).vault_redeploys = [{ step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: A.vaults.PROTO }];
  };
  test("proxy=all freezes the retired rmPROTO proxy in the same batch; it can also be named alone", async () => {
    const w = world();
    withRetired(w);
    await w.freeze({ proxy: "all" });
    expect(w.tl.s.scheduled.get(FREEZE_ROW)!.calls.map((c) => lc(c.target))).toEqual([...NAMES.map((n) => lc(PROXY_AT[n]!)), lc(OLD)]);
    expect(w.tl.s.proxies.get(lc(OLD))!.frozen).toBe(true);
    expect(freezesOf(w.manifest)).toContain("rmPROTO.retired-1");
    const one = world();
    withRetired(one);
    await one.freeze({ proxy: "rmPROTO.retired-1" });
    expect(one.tl.s.scheduled.get(FREEZE_ROW)!.calls.map((c) => lc(c.target))).toEqual([lc(OLD)]);
    expect(one.tl.s.proxies.get(lc(OLD))!.frozen).toBe(true);
    expect(one.proxy("rmPROTO").frozen).toBe(false); // the new vault is another proxy
    // mutation: with no redeploy record the name is no proxy of the deployment
    await expect(world().freeze({ proxy: "rmPROTO.retired-1" })).rejects.toMatchObject({ kind: "USAGE" });
  });
  test("the verify record keeps core logic upgradeable while no executed freeze froze the retired proxy", () => {
    const names = tableProxiesNames();
    const allFrozen = { core_logic_immutable: true, upgradeable: [] as string[] };
    const m = { vault_redeploys: [{ status: "governed", key: "PROTO", ordinal: 1, old_vault: OLD }], proxy_freezes: [] as unknown[] } as never;
    expect(withRetiredProxies(allFrozen, m)).toEqual({ core_logic_immutable: false, upgradeable: ["rmPROTO.retired-1"] });
    const frozen = { vault_redeploys: [{ status: "governed", key: "PROTO", ordinal: 1, old_vault: OLD }], proxy_freezes: [{ proxies: [{ name: "rmPROTO.retired-1", proxy: OLD }], execute_tx: "0x1" }] } as never;
    expect(withRetiredProxies(allFrozen, frozen)).toEqual(allFrozen);
    // a freeze that was scheduled and never executed proves nothing
    const pending = { vault_redeploys: [{ status: "governed", key: "PROTO", ordinal: 1, old_vault: OLD }], proxy_freezes: [{ proxies: [{ proxy: OLD }] }] } as never;
    expect(withRetiredProxies(allFrozen, pending).core_logic_immutable).toBe(false);
    expect(names.length).toBe(9);
  });
});

describe("issue 1809: the pure refusals", () => {
  const healthy = (): ProxyState => ({
    proxy: A.gateway, proxyCode: "0x60016001" as Hex, implementation: IMPL_AT.gateway!, implementationCode: implCode("gateway"), adminSlot: ZERO_WORD, beaconSlot: ZERO_WORD,
    authority: A.timelock, frozen: false, initialized: { version: 1n, initializing: false }, implementationInitialized: { version: INITIALIZERS_LOCKED, initializing: false },
  });
  const target = { address: NEW as Address, code: NEW_CODE, initializerVersion: INITIALIZERS_LOCKED, proxiableUUID: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex };
  const ok = { ok: true, detail: "masked hash 0x" };
  test("a healthy proxy and a reviewed, UUPS, locked target pass; each fault is named", () => {
    expect(upgradeRefusals({ name: "gateway", live: healthy(), target, build: ok, timelock: A.timelock })).toEqual([]);
    expect(upgradeRefusals({ name: "gateway", live: { ...healthy(), frozen: true }, target, build: ok, timelock: A.timelock }).join()).toContain("UpgradesAreFrozen");
    expect(upgradeRefusals({ name: "gateway", live: { ...healthy(), frozen: null }, target, build: ok, timelock: A.timelock }).join()).toContain("no governed proxy");
    expect(upgradeRefusals({ name: "gateway", live: { ...healthy(), beaconSlot: `0x${"0".repeat(63)}1` as Hex }, target, build: ok, timelock: A.timelock }).join()).toContain("beacon slot is not empty");
    expect(upgradeRefusals({ name: "gateway", live: healthy(), target: { ...target, proxiableUUID: null }, build: ok, timelock: A.timelock }).join()).toContain("a revert");
    expect(upgradeRefusals({ name: "gateway", live: healthy(), target, build: { ok: false, detail: "masked hash differs" }, timelock: A.timelock }).join()).toContain("masked hash differs");
    expect(freezeRefusals({ name: "gateway", live: healthy(), build: ok, timelock: A.timelock })).toEqual([]);
    expect(freezeRefusals({ name: "gateway", live: healthy(), build: ok, timelock: A.timelock, pendingUpgrade: "upgrade-proxy-gateway-abcd1234" }).join()).toContain("upgrade-proxy-gateway-abcd1234");
    expect(freezeRefusals({ name: "gateway", live: { ...healthy(), implementationCode: "0x" }, build: ok, timelock: A.timelock }).join()).toContain("has no code");
    // no message carries a raw 32-byte slot word: the evidence secret scan reads every log line (QA plan v1 E8)
    const msgs = upgradeRefusals({ name: "gateway", live: { ...healthy(), adminSlot: `0x${"ab".repeat(32)}` as Hex }, target: { ...target, proxiableUUID: `0x${"cd".repeat(32)}` as Hex }, build: ok, timelock: A.timelock }).join(" ");
    expect(msgs).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  test("the verify inputs read executed rounds only, the last upgrade of a proxy winning", () => {
    const m = {
      proxy_upgrades: [
        { proxy: "gateway", implementation: addr(0x1), build_dir: "/b1", execute_tx: "0x1" },
        { proxy: "gateway", implementation: addr(0x2), build_dir: "/b2", execute_tx: "0x2" },
        { proxy: "router", implementation: addr(0x3) },
      ],
      proxy_freezes: [{ proxies: [{ name: "registry" }], execute_tx: "0x3" }, { proxies: [{ name: "router" }] }],
    };
    expect(upgradesOf(m as never)).toEqual([{ proxy: "gateway", implementation: addr(0x2), buildDir: "/b2" }]);
    expect(freezesOf(m as never)).toEqual(["registry"]);
    expect(upgradesOf({} as never)).toEqual([]);
    expect(freezesOf({} as never)).toEqual([]);
  });
});

describe("issue 1809: the CLI reads the rows' --admin-arg values before any signer", () => {
  const base = (chain: string) => ["--chain", chain, "--core-sha", "a".repeat(40), "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
  test("accepted on both chains, and the values reach the parsed arguments", () => {
    for (const chain of ["8453", "918453"]) {
      expect(parseCli(["govern", ...base(chain), "--row", UPGRADE_ROW, "--admin-arg", "proxy=gateway", "--admin-arg", `implementation=${NEW}`, "--admin-arg", "build=/out-v2"])).toMatchObject({ row: UPGRADE_ROW, adminArgs: { proxy: "gateway", implementation: NEW, build: "/out-v2" } });
      expect(parseCli(["govern", ...base(chain), "--row", FREEZE_ROW, "--admin-arg", "proxy=all"])).toMatchObject({ row: FREEZE_ROW, adminArgs: { proxy: "all" } });
    }
  });
  test("refused with USAGE: no --admin-arg, a key of another row, a repeated key, an upgrade with no implementation", () => {
    expect(() => parseCli(["govern", ...base("8453"), "--row", UPGRADE_ROW])).toThrow("needs --admin-arg proxy=<name> --admin-arg implementation=0x<address>");
    expect(() => parseCli(["govern", ...base("8453"), "--row", FREEZE_ROW])).toThrow("needs --admin-arg proxy=<name>|all");
    expect(() => parseCli(["govern", ...base("8453"), "--row", UPGRADE_ROW, "--admin-arg", "proxy=gateway", "--admin-arg", "vault=PROTO"])).toThrow("--admin-arg takes key=value with key proxy, implementation, call, build");
    expect(() => parseCli(["govern", ...base("8453"), "--row", FREEZE_ROW, "--admin-arg", "proxy=gateway", "--admin-arg", `implementation=${NEW}`])).toThrow("--admin-arg takes key=value with key proxy, build");
    expect(() => parseCli(["govern", ...base("8453"), "--row", FREEZE_ROW, "--admin-arg", "proxy=gateway", "--admin-arg", "proxy=router"])).toThrow("is given twice");
    expect(() => parseCli(["govern", ...base("8453"), "--row", UPGRADE_ROW, "--admin-arg", "proxy=gateway"])).toThrow("needs --admin-arg implementation=0x<address>");
    // the rows' keys with any other row
    expect(() => parseCli(["govern", ...base("918453"), "--row", "unpause-PROTO", "--admin-arg", "proxy=gateway"])).toThrow(`--row ${UPGRADE_ROW} or --row ${FREEZE_ROW} only`);
  });
});

describe("security round 2: on 8453 the build is the build of the release's sources, not whatever its ignored out/ holds", () => {
  test("a clean, tagged checkout whose ignored out/ holds a stale feature build of the gateway is refused with GOVERN before the Safe is read; nothing is scheduled", async () => {
    const w = world(8453);
    const b = buildCheckout();
    // the operator built a feature branch, deployed its implementation (NEW_CODE on chain), then checked out the release without rebuilding: same name, same code, other source
    writeSourceArtifact(b.out, ARTIFACT.gateway!, { code: NEW_CODE, target: GATEWAY_SOL, sources: { [GATEWAY_SOL]: "contract RobotMoneyGateway { uint256 featureBranch; }\n" } });
    expect(git(b.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const c = countConnects(w);
    let gated = false;
    await expect(w.upgrade({ ...UPGRADE, build: b.out }, { warp: noWarp, buildProvenance: undefined, buildGate: async () => { gated = true; return BUILD_TAG; } }))
      .rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining(`compiled from a ${GATEWAY_SOL} that differs from the one committed at ${b.sha}`) });
    expect(gated).toBe(true);
    expect(c.n).toBe(0);
    expect(w.tl.s.events).toEqual([]);
    // another contract's artifact placed under the gateway's name is refused the same way
    writeSourceArtifact(b.out, ARTIFACT.gateway!, { code: NEW_CODE, target: "contracts/Other.sol", targetName: "Other", sources: { "contracts/Other.sol": "contract Other {}\n" } });
    await expect(w.upgrade({ ...UPGRADE, build: b.out }, { warp: noWarp, buildProvenance: undefined, buildGate: async () => BUILD_TAG })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("not the contract RobotMoneyGateway") });
    expect(w.tl.s.events).toEqual([]);
  });

  test("the deployment checkout is held to the same rule: an out/ deeper in it, or its own out/ without the deploy sha's metadata, is refused; nothing is scheduled", async () => {
    const w = world(8453);
    const core = w.ctx.coreDir;
    writeFileSync(join(core, ".gitignore"), "out/\nout-v2/\nevidence/\n");
    gitIn(core, "init", "-q");
    gitIn(core, "config", "commit.gpgsign", "false");
    (w.ctx as { coreSha: string }).coreSha = commitAll(core, "the deployment sha");
    const deeper = writeSourceArtifact(join(core, "build", "out"), ARTIFACT.gateway!, { code: NEW_CODE, target: GATEWAY_SOL, sources: { [GATEWAY_SOL]: "contract RobotMoneyGateway {}\n" } });
    await expect(w.upgrade({ ...UPGRADE, build: deeper }, { warp: noWarp, buildProvenance: undefined })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not the forge out/ of its checkout") });
    await expect(w.upgrade({ ...UPGRADE, build: join(core, "out") }, { warp: noWarp, buildProvenance: undefined })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("carries no compiler metadata") });
    expect(w.tl.s.events).toEqual([]);
  });
});

describe("security round 2: the live-vs-build layout compare holds every stored enum's members append-only", () => {
  const fixture = (n: string) => JSON.parse(readFileSync(join(REPO_ROOT, "contracts", "test", "fixtures", "storage-layout", `${n}.json`), "utf8"));
  const STATUS = "enum VaultRegistry.VaultStatus";
  const registry = fixture("VaultRegistry");
  const withEnum = (snap: any, e: string, members: string[]) => ({ ...snap, enums: { ...snap.enums, [e]: members } });
  const refusals = (live: object, build: object, mainnet = true) => upgradeLayoutRefusals({ name: "registry", artifact: "VaultRegistry", liveField: "registry_layout_id", mainnet, liveId: `0x${"01".repeat(32)}`, live, buildId: `0x${"02".repeat(32)}`, build });

  test("the real VaultRegistry snapshot stores VaultStatus [Active, DepositsPaused, Retired]", () => {
    expect(registry.enums[STATUS]).toEqual(["Active", "DepositsPaused", "Retired"]);
    expect(registry.storage.some((r: { type: string }) => r.type.includes(STATUS))).toBe(true);
  });

  test("a member inserted before Retired, or the members reordered, is refused naming the enum, on 8453 and elsewhere; nothing else in the snapshot changed", () => {
    for (const members of [["Active", "Sunsetting", "DepositsPaused", "Retired"], ["Active", "Retired", "DepositsPaused"]]) {
      for (const mainnet of [true, false]) {
        const r = refusals(registry, withEnum(registry, STATUS, members), mainnet);
        expect([members, mainnet, r.length]).toEqual([members, mainnet, 1]);
        expect(r[0]).toContain(`storage enum "${STATUS}" changed its existing members`);
      }
    }
  });

  test("mutation: a member appended at the end passes", () => {
    expect(refusals(registry, withEnum(registry, STATUS, ["Active", "DepositsPaused", "Retired", "Sunsetting"]))).toEqual([]);
  });

  test("a reordered BasketAssetConfigGuard.Venue inside the basket vaults' AssetInfo struct is refused", () => {
    const VENUE = "enum BasketAssetConfigGuard.Venue";
    const vault = fixture("ProtocolAssetVault");
    expect(vault.enums[VENUE]).toEqual(["V3", "V4", "Aerodrome"]);
    expect(refusals(vault, withEnum(vault, VENUE, ["V4", "V3", "Aerodrome"])).join()).toContain(`storage enum "${VENUE}"`);
  });

  test("on 8453 a live snapshot recorded before enums were (no enums map) is refused while storage holds an enum; elsewhere it passes as before", () => {
    const { enums: _none, ...old } = registry;
    expect(refusals(old, withEnum(registry, STATUS, ["Active", "Retired", "DepositsPaused"])).join()).toContain("the live layout snapshot records no enum members");
    expect(refusals(old, registry, false)).toEqual([]);
  });
});

describe("security round 2: upgrade and freeze history is bound to the proxy's address, not only its name", () => {
  const OLD = addr(0x3f02);
  test("an executed upgrade recorded at another address (a vault a redeploy replaced) is not the proxy's history: the upgrade compares with the deploy manifest's layout", async () => {
    const entry = { step: UPGRADE_ROW, proxy: "gateway", proxy_address: OLD, implementation: addr(0x9f99), build_dir: "/gone/out", build_layout_hash: `0x${"ab".repeat(32)}`, execute_tx: "0x1" };
    const w = world(8453);
    (w.manifest as { proxy_upgrades?: unknown[] }).proxy_upgrades = [entry];
    await expect(w.upgrade({ ...UPGRADE, build: w.newBuild }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual([`schedule:${UPGRADE_ROW}`]);
    expect(gov(w)[upgradeRecordKey(parseUpgradeArgs({ ...UPGRADE, build: w.newBuild }, NAMES))]!.upgrade).toMatchObject({ live_layout_hash: w.liveLayoutId });
    // mutation: the same entry at the gateway's own address IS its history, and the live implementation is not the one it installed: no live layout, refused
    const m = world(8453);
    (m.manifest as { proxy_upgrades?: unknown[] }).proxy_upgrades = [{ ...entry, proxy_address: PROXY_AT.gateway }];
    await expect(m.upgrade({ ...UPGRADE, build: m.newBuild }, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("no storage-layout identifier is recorded") });
  });

  test("the verify inputs count only the rounds recorded at the address each name reaches now; a retired name keeps its own", () => {
    const w = world();
    const at = currentProxyAddresses(w.ctx);
    expect(lc(at("rmPROTO")!)).toBe(lc(PROXY_AT.rmPROTO!));
    expect(at("rmPROTO.retired-1")).toBeUndefined();
    const m = {
      proxy_upgrades: [
        { proxy: "rmPROTO", proxy_address: OLD, implementation: addr(0x1), build_dir: "/old", build_layout_hash: `0x${"ab".repeat(32)}`, execute_tx: "0x1" },
        { proxy: "gateway", proxy_address: PROXY_AT.gateway, implementation: addr(0x2), execute_tx: "0x2" },
      ],
      proxy_freezes: [{ proxies: [{ name: "rmPROTO", proxy: OLD }, { name: "rmPROTO.retired-1", proxy: OLD }, { name: "gateway", proxy: PROXY_AT.gateway }], execute_tx: "0x3" }],
    };
    expect(upgradesOf(m as never, at).map((u) => u.proxy)).toEqual(["gateway"]);
    expect([...upgradeLayoutsOf(m as never, at).keys()]).toEqual(["gateway"]);
    expect(freezesOf(m as never, at).sort()).toEqual(["gateway", "rmPROTO.retired-1"]);
    // mutation: without the current addresses the new rmPROTO inherits the old vault's freeze and upgrade
    expect(freezesOf(m as never)).toContain("rmPROTO");
    expect(upgradesOf(m as never).map((u) => u.proxy).sort()).toEqual(["gateway", "rmPROTO"]);
  });
});
