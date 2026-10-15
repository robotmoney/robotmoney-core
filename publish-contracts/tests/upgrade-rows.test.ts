// Issue 1809 (ADR-0014 §4-§5): the govern rows upgrade-proxy and freeze-proxy, against the fake of the Safe tool (tests/govern-world.ts). The fake runs GovernedUpgrade as
// the contract behaves: only the timelock upgrades or freezes, nothing after a freeze, a freeze bound to the live implementation and its code hash. It proves what the tool
// schedules, refuses and records. The real proxies, the real Safe and the real delay are the Twin rehearsal's (P4) and the contracts' own lifecycle tests
// (contracts/test/GovernedUpgradeLifecycle.t.sol).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { EXIT_CODES, type PublishError } from "../src/errors.ts";
import { GOVERN_ROWS, govRowRefusal, resolveGovernRow, resumeCommand, runGovern, stageRows } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { getStageTable, stageByName } from "../src/stages.ts";
import { tableProxies } from "../src/stage-table.ts";
import { INITIALIZERS_LOCKED, ZERO_WORD, type ProxyState } from "../src/proxies.ts";
import {
  FREEZE_ROW, PROXY_GOVERN_ABI, UPGRADE_ROW, buildFreezeCall, buildUpgradeCall, freezeRecordKey, freezeRefusals, parseFreezeArgs, parseUpgradeArgs, upgradeRecordKey, upgradeRefusals,
  type FreezeArgs, type UpgradeArgs,
} from "../src/upgrade-rows.ts";
import { freezesOf, upgradesOf } from "../src/verify-stage.ts";
import { parseCli } from "../src/cli.ts";
import { A, IMPL_AT, PROXY_AT, addr, fakeTimelock, implCode, sender, setup, signers, withProxies, writeBuild } from "./govern-world.ts";

const DELAY = 172800n;
const NAMES = tableProxies(getStageTable()).map((p) => p.name);
const ARTIFACT = Object.fromEntries(tableProxies(getStageTable()).map((p) => [p.name, p.artifact])) as Record<string, string>;
const lc = (s: string): string => s.toLowerCase();
const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
/** The new gateway implementation the tests upgrade to, and the code it runs. */
const NEW = addr(0x9101);
const NEW_CODE = "0x6080604052007a5b00" as Hex;
const UPGRADE: UpgradeArgs = { proxy: "gateway", implementation: NEW };

/**
 * A deployment as the deploy leaves it: every proxy names its implementation, the timelock is the authority, nothing is frozen. The checkout's out/ holds the build of
 * each implementation (the code each runs). `frozen` names proxies born frozen. `deployNew` puts the new gateway implementation on chain (UUPS, initializers locked).
 */
function world(chainId = 918453, o: { frozen?: string[]; deployNew?: boolean } = {}) {
  const { ctx, sheet } = setup({}, chainId);
  const tl = fakeTimelock(sheet, DELAY);
  withProxies(tl, { frozen: o.frozen });
  writeBuild(join(ctx.coreDir, "out"), Object.fromEntries(NAMES.map((n) => [ARTIFACT[n]!, implCode(n)])));
  if (o.deployNew !== false) { tl.s.codes.set(lc(NEW), NEW_CODE); tl.s.uups.add(lc(NEW)); tl.s.locked.add(lc(NEW)); }
  /** The reviewed build of the new gateway implementation: an out/ of its own, as the release checkout would be. */
  const newBuild = writeBuild(join(ctx.coreDir, "out-v2"), { [ARTIFACT.gateway!]: NEW_CODE });
  const manifest = newManifest(ctx, addr(0xa001));
  const out: string[] = [];
  const opts = (extra: object = {}) => ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: async (sec: bigint) => { tl.s.clock += sec; }, maxWaitSeconds: 10_000_000, emit: (l: string) => out.push(l), ...extra });
  const upgrade = (args: UpgradeArgs, extra: object = {}) => runGovern(ctx, stageByName("govern"), manifest, { ...opts(extra), row: UPGRADE_ROW, proxyUpgrade: args });
  const freeze = (args: FreezeArgs, extra: object = {}) => runGovern(ctx, stageByName("govern"), manifest, { ...opts(extra), row: FREEZE_ROW, proxyFreeze: args });
  const proxy = (name: string) => tl.s.proxies.get(lc(PROXY_AT[name]!))!;
  return { ctx, sheet, tl, manifest, out, upgrade, freeze, proxy, newBuild };
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
    });
    expect(lc(e[0].from_implementation)).toBe(lc(IMPL_AT.gateway!));
    // the verifier expects the gateway on the round's target, compared with the round's build
    expect(upgradesOf(w.manifest)).toEqual([{ proxy: "gateway", implementation: want.implementation, buildDir: w.newBuild }]);
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
