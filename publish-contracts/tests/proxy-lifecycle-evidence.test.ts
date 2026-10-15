// `evidence-check --proxy-lifecycle` (QA plan v1 P4, issue 1811, ADR-0014 stage 4): the governed upgrade, the freeze and the refused post-freeze upgrade a Twin
// upgrade rehearsal (src/ci/twin-upgrade-rehearsal.ts) records in its run manifest, checked offline (checkProxyLifecycle) and against a stub chain
// (checkProxyLifecycleOnChain) whose receipts carry the timelock and proxy events the real contracts emit.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { UPGRADES_ARE_FROZEN_SELECTOR, checkProxyLifecycle, checkProxyLifecycleOnChain, rejectedUpgradeKey, revertDataOf, type ChainReader } from "../src/evidence-check.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../src/proxies.ts";
import { PROXY_GOVERN_ABI } from "../src/upgrade-rows.ts";
import { tmp } from "./fixtures.ts";
import { addr } from "./govern-world.ts";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ZERO = h(0);
const TL = addr(0x7100);
const REG = addr(0x101), ROUTER = addr(0x102), OTHER = addr(0x103);
const ORIG = addr(0x201), NEW = addr(0x9e01), RIMPL = addr(0x202);
const NEW_CODE: Hex = "0x6080604052600a";
const R_CODE: Hex = "0x6080604052600b";
const SALT = h(0x5a17);
const LABEL = "post-freeze-upgrade-registry";
const T0 = 10_000;
const FLOOR = 60;
const upgradeData = (impl: Address): Hex => encodeFunctionData({ abi: PROXY_GOVERN_ABI, functionName: "upgradeToAndCall", args: [impl, "0x"] });
const freezeData = (impl: Address, codeHash: Hex): Hex => encodeFunctionData({ abi: PROXY_GOVERN_ABI, functionName: "freezeUpgrades", args: [impl, codeHash] });

const upgradeEntry = () => ({
  step: "upgrade-proxy", key: "upgrade-proxy-registry-0badc0de", round: 1, proxy: "registry", proxy_address: REG, from_implementation: ORIG, implementation: NEW,
  implementation_code_hash: keccak256(NEW_CODE), call_data: "0x", build_dir: "/core/out", core_sha: "a".repeat(40), timelock: TL,
  operation_id: h(1), schedule_tx: h(11), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(12), execute_status: 1, execute_block_timestamp: T0 + 60,
});
const freezeEntry = () => ({
  step: "freeze-proxy", key: "freeze-proxy-all-0badf00d", round: 1, proxies: [
    { name: "registry", proxy: REG, implementation: NEW, code_hash: keccak256(NEW_CODE) },
    { name: "router", proxy: ROUTER, implementation: RIMPL, code_hash: keccak256(R_CODE) },
  ], build_dirs: { registry: "/core/out", router: "/core/out" }, core_sha: "a".repeat(40), timelock: TL,
  operation_id: h(2), schedule_tx: h(21), schedule_status: 1, schedule_block_timestamp: T0 + 100, execute_tx: h(22), execute_status: 1, execute_block_timestamp: T0 + 160,
});
/** The run manifest of a green rehearsal: one upgrade, one freeze of two proxies, the generic call scheduled after the freeze and never executed. */
const manifest = (over: Record<string, unknown> = {}) => ({
  proxy_upgrades: [upgradeEntry()], proxy_freezes: [freezeEntry()],
  govern: { [rejectedUpgradeKey(LABEL)]: { scheduled: { at: "2026-10-15T05:40:00Z", operation_id: h(3), tx_hash: h(31), status: 1, ready_at: String(T0 + 260) } } },
  ...over,
});
const OPTS = { timelock: TL, floor: FLOOR, rejectedUpgrade: LABEL };
const offline = (m: unknown, o = OPTS) => checkProxyLifecycle(m, o).join("\n");

describe("checkProxyLifecycle (offline: the run manifest)", () => {
  test("a green rehearsal passes, with and without the rejected upgrade named", () => {
    expect(checkProxyLifecycle(manifest(), OPTS)).toEqual([]);
    expect(checkProxyLifecycle(manifest(), { timelock: TL, floor: FLOOR })).toEqual([]);
  });
  test("both halves of the lifecycle are required: an upgrade and a freeze", () => {
    expect(offline(manifest({ proxy_upgrades: [] }))).toContain("no proxy_upgrades entry");
    expect(offline(manifest({ proxy_freezes: undefined }))).toContain("no proxy_freezes entry");
  });
  test("the freeze must fix the reviewed upgrade: it names the implementation the last upgrade installed, and no upgrade executes after the freeze was scheduled", () => {
    const f = freezeEntry();
    f.proxies[0]!.implementation = ORIG;
    expect(offline(manifest({ proxy_freezes: [f] }))).toContain(`its last upgrade (upgrade-proxy registry round 1) installed ${NEW}`);
    const late = upgradeEntry();
    late.schedule_block_timestamp = T0 + 120; late.execute_block_timestamp = T0 + 180;
    expect(offline(manifest({ proxy_upgrades: [late] }))).toContain("after freeze-proxy registry,router round 1 was scheduled");
  });
  test("an upgrade of a proxy the freeze does not name is not the lifecycle", () => {
    const u = upgradeEntry();
    u.proxy = "icpolicy"; u.proxy_address = OTHER;
    expect(offline(manifest({ proxy_upgrades: [u] }))).toContain("no proxy was upgraded and then frozen");
  });
  test("each round keeps the delay floor and names the timelock", () => {
    const u = upgradeEntry();
    u.execute_block_timestamp = T0 + 30;
    expect(offline(manifest({ proxy_upgrades: [u] }))).toContain("schedule-to-execute gap 30 s is under 60 s");
    expect(offline(manifest(), { ...OPTS, timelock: addr(0x7101) })).toContain(`is not the timelock ${addr(0x7101)}`);
  });
  test("the rejected upgrade must be scheduled and neither executed nor cancelled", () => {
    const k = rejectedUpgradeKey(LABEL);
    expect(k).toBe("call-post-freeze-upgrade-registry");
    expect(offline(manifest({ govern: {} }))).toContain(`records no ${k}`);
    const at = { at: "x", operation_id: h(3), tx_hash: h(31), status: 1 };
    expect(offline(manifest({ govern: { [k]: { scheduled: at, executed: { at: "y", tx_hash: h(32), status: 1 } } } }))).toContain(`${k}: executed`);
    expect(offline(manifest({ govern: { [k]: { scheduled: at, cancelled: { at: "y", tx_hash: h(33), status: 1 } } } }))).toContain(`${k}: cancelled`);
    expect(offline(manifest({ govern: { [k]: { scheduled: { at: "x", note: "adopted" } } } }))).toContain(`${k}: no schedule transaction`);
  });
});

// ---- the chain --------------------------------------------------------------------------------------------------------------------

const TLE = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event CallSalt(bytes32 indexed id, bytes32 salt)",
]);
const PXE = parseAbi(["event Upgraded(address indexed implementation)", "event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash)"]);
const EXEC_ABI = parseAbi(["function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable"]);
type Log = { address: string; topics: readonly Hex[]; data: Hex };
const sched = (id: Hex, i: number, target: Address, data: Hex, delay = BigInt(FLOOR)): Log => ({ address: TL, topics: encodeEventTopics({ abi: TLE, eventName: "CallScheduled", args: { id, index: BigInt(i) } }) as Hex[],
  data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [target, 0n, data, ZERO, delay]) });
const exec = (id: Hex, i: number, target: Address, data: Hex): Log => ({ address: TL, topics: encodeEventTopics({ abi: TLE, eventName: "CallExecuted", args: { id, index: BigInt(i) } }) as Hex[],
  data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [target, 0n, data]) });
const saltLog = (id: Hex, salt: Hex): Log => ({ address: TL, topics: encodeEventTopics({ abi: TLE, eventName: "CallSalt", args: { id } }) as Hex[], data: encodeAbiParameters([{ type: "bytes32" }], [salt]) });
const upgraded = (proxy: Address, impl: Address): Log => ({ address: proxy, topics: encodeEventTopics({ abi: PXE, eventName: "Upgraded", args: { implementation: impl } }) as Hex[], data: "0x" });
const frozenLog = (proxy: Address, impl: Address, codeHash: Hex): Log => ({ address: proxy, topics: encodeEventTopics({ abi: PXE, eventName: "UpgradesFrozen", args: { proxy, implementation: impl } }) as Hex[], data: encodeAbiParameters([{ type: "bytes32" }], [codeHash]) });
const word = (a: Address): Hex => `0x${"0".repeat(24)}${a.slice(2)}` as Hex;

interface ChainOpts {
  upgradeData?: Hex; delay?: bigint; noUpgradedEvent?: boolean; noFrozenEvent?: string; unfrozen?: Address; slotMoved?: boolean; codeChanged?: boolean;
  done?: boolean; notReady?: boolean; call?: "frozen" | "ok" | "other" | "nested"; rejectedTarget?: Address; rejectedData?: Hex; rejectedBeforeFreeze?: boolean;
}
function chainFor(o: ChainOpts = {}): ChainReader & { calls: Hex[] } {
  const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; logs: Log[] }>();
  const blocks = new Map<bigint, number>();
  const add = (hash: Hex, logs: Log[], block: bigint, ts: number) => { receipts.set(hash, { status: "success", blockNumber: block, logs }); blocks.set(block, ts); };
  const u = upgradeEntry(), f = freezeEntry();
  const uData = o.upgradeData ?? upgradeData(NEW);
  add(u.schedule_tx, [sched(h(1), 0, REG, uData, o.delay)], 1n, T0);
  add(u.execute_tx, [exec(h(1), 0, REG, uData), ...(o.noUpgradedEvent ? [] : [upgraded(REG, NEW)])], 2n, T0 + 60);
  add(f.schedule_tx, f.proxies.map((x, i) => sched(h(2), i, x.proxy as Address, freezeData(x.implementation as Address, x.code_hash as Hex))), 3n, T0 + 100);
  add(f.execute_tx, [...f.proxies.map((x, i) => exec(h(2), i, x.proxy as Address, freezeData(x.implementation as Address, x.code_hash as Hex))),
    ...f.proxies.filter((x) => x.name !== o.noFrozenEvent).map((x) => frozenLog(x.proxy as Address, x.implementation as Address, x.code_hash as Hex))], 4n, T0 + 160);
  const rTarget = o.rejectedTarget ?? REG;
  const rData = o.rejectedData ?? upgradeData(ORIG);
  add(h(31), [sched(h(3), 0, rTarget, rData), saltLog(h(3), SALT)], o.rejectedBeforeFreeze ? 3n : 5n, T0 + 200);
  const calls: Hex[] = [];
  return {
    calls,
    getChainId: async () => 918453, getTransactionCount: async () => 0,
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error("not found"); return r; },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks.get(blockNumber)!) }),
    readContract: async ({ address, functionName, args }) => {
      if (functionName === "upgradesFrozen") return ![REG, ROUTER].includes(address as Address) ? false : address !== o.unfrozen;
      if (functionName === "isOperationDone") return args?.[0] === h(3) ? !!o.done : true;
      if (functionName === "isOperationReady") return args?.[0] === h(3) ? !o.notReady : false;
      throw new Error(`unexpected read ${functionName}`);
    },
    getStorageAt: async ({ address, slot }) => (slot !== ERC1967_IMPLEMENTATION_SLOT ? ZERO : address === REG ? word(o.slotMoved ? ORIG : NEW) : address === ROUTER ? word(RIMPL) : ZERO),
    getCode: async ({ address }) => (address === NEW ? (o.codeChanged ? "0x00" : NEW_CODE) : address === RIMPL ? R_CODE : "0x"),
    call: async ({ to, data }) => {
      calls.push(data);
      // the simulated execute must be the scheduled operation exactly: target, value, data, predecessor and the salt of its CallSalt event
      const want = encodeFunctionData({ abi: EXEC_ABI, functionName: "execute", args: [rTarget, 0n, rData, ZERO, SALT] });
      if (to !== TL || data !== want) throw Object.assign(new Error("execution reverted"), { cause: { data: "0xdeadbeef" } });
      const mode = o.call ?? "frozen";
      if (mode === "ok") return { data: "0x" };
      if (mode === "other") throw Object.assign(new Error("execution reverted"), { cause: { data: toFunctionSelector("UpgradeNotAuthorized(address)") + "0".repeat(64) } });
      if (mode === "nested") throw Object.assign(new Error("call failed"), { cause: Object.assign(new Error("rpc"), { data: { data: UPGRADES_ARE_FROZEN_SELECTOR } }) });
      throw Object.assign(new Error("execution reverted"), { cause: Object.assign(new Error("rpc"), { data: UPGRADES_ARE_FROZEN_SELECTOR }) });
    },
  };
}
const onChain = async (o: ChainOpts = {}) => (await checkProxyLifecycleOnChain(manifest(), chainFor(o), OPTS)).join("\n");

describe("checkProxyLifecycleOnChain (the chain, not the run manifest)", () => {
  test("a green rehearsal passes; the simulated execute is the scheduled operation with the salt of its CallSalt event", async () => {
    const chain = chainFor();
    expect(await checkProxyLifecycleOnChain(manifest(), chain, OPTS)).toEqual([]);
    expect(chain.calls).toEqual([encodeFunctionData({ abi: EXEC_ABI, functionName: "execute", args: [REG, 0n, upgradeData(ORIG), ZERO, SALT] })]);
    expect(await onChain({ call: "nested" })).toBe(""); // viem may nest the revert data one level deeper
  });
  test("the upgrade: the scheduled call is rebuilt from the entry, the delay is the floor, and the proxy itself emitted Upgraded", async () => {
    expect(await onChain({ upgradeData: upgradeData(addr(0xbad)) })).toContain("calldata is not registry.upgradeToAndCall");
    expect(await onChain({ delay: 30n })).toContain("delay 30 is under 60 s");
    expect(await onChain({ noUpgradedEvent: true })).toContain(`no Upgraded(${NEW}) event from the proxy ${REG}`);
  });
  test("the freeze: each proxy emitted UpgradesFrozen, and NOW reads frozen, on the frozen implementation, whose code still hashes to the bound code hash", async () => {
    expect(await onChain({ noFrozenEvent: "router" })).toContain(`no UpgradesFrozen(${ROUTER}, ${RIMPL}`);
    expect(await onChain({ unfrozen: ROUTER })).toContain(`router ${ROUTER}: upgradesFrozen() reads false`);
    expect(await onChain({ slotMoved: true })).toContain("a frozen proxy changed implementation");
    expect(await onChain({ codeChanged: true })).toContain(`does not hash to ${keccak256(NEW_CODE)}`);
  });
  test("the rejected upgrade: still pending and ready on the timelock, and its execute reverts with the proxy's own UpgradesAreFrozen", async () => {
    expect(await onChain({ done: true })).toContain("isOperationDone true: the upgrade of a frozen proxy executed");
    expect(await onChain({ notReady: true })).toContain("isOperationReady false: the delay has not passed");
    expect(await onChain({ call: "ok" })).toContain("executing the scheduled upgrade now succeeds");
    expect(await onChain({ call: "other" })).toContain("not UpgradesAreFrozen()");
  });
  test("the rejected upgrade must be an upgradeToAndCall of a proxy the freeze froze, scheduled after the freeze executed", async () => {
    expect(await onChain({ rejectedTarget: OTHER })).toContain(`targets ${OTHER}, which no executed proxy_freezes entry froze`);
    expect(await onChain({ rejectedData: freezeData(NEW, keccak256(NEW_CODE)) })).toContain("is not upgradeToAndCall(address,bytes)");
    expect(await onChain({ rejectedBeforeFreeze: true })).toContain("not after freeze-proxy registry,router round 1 executed in block 4");
  });
  test("revertDataOf finds the revert data wherever viem nests it, and the selector is GovernedUpgrade.UpgradesAreFrozen()", () => {
    expect(UPGRADES_ARE_FROZEN_SELECTOR).toBe(toFunctionSelector("UpgradesAreFrozen()"));
    expect(revertDataOf({ data: "0x12345678" })).toBe("0x12345678");
    expect(revertDataOf({ cause: { cause: { data: { data: "0xabcdef01" } } } })).toBe("0xabcdef01");
    expect(revertDataOf(new Error("no data"))).toBeUndefined();
  });
});

describe("evidence-check --proxy-lifecycle (the CLI)", () => {
  const cli = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "evidence-check.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const file = (m: unknown) => { const p = join(tmp("plc-"), "publish-run.json"); writeFileSync(p, JSON.stringify(m, null, 2)); return p; };
  test("a green run manifest passes offline and says what it checked", () => {
    const r = cli(["--proxy-lifecycle", file(manifest()), "--timelock", TL, "--rejected-upgrade", LABEL, "--delay-floor", String(FLOOR)]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("evidence ok (1 proxy upgrade(s), 1 freeze(s), 1 post-freeze upgrade refused by the proxy, offline shape only)");
  });
  test("an executed post-freeze upgrade fails, and a missing --timelock is a usage error", () => {
    const k = rejectedUpgradeKey(LABEL);
    const bad = cli(["--proxy-lifecycle", file(manifest({ govern: { [k]: { scheduled: { at: "x", operation_id: h(3), tx_hash: h(31), status: 1 }, executed: { at: "y", tx_hash: h(32), status: 1 } } } })), "--timelock", TL, "--rejected-upgrade", LABEL, "--delay-floor", String(FLOOR)]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(`evidence: ${k}: executed`);
    expect(cli(["--proxy-lifecycle", file(manifest()), "--delay-floor", String(FLOOR)]).code).toBe(2);
  });
});
