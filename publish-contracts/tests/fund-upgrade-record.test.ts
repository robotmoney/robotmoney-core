// The in-place upgrade of Deploy 4 (releases/v0.8.0-onevault-upgrade.yaml): the record of a fund-system governed change made through the Safe tool
// (fund-upgrade-record.ts), the queue's claim guard (ci/fund-claims.ts) and the fund verifier's build per upgraded proxy (verify/fund.ts fundProxyBuildDir).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { executorSwitchCalls, operationProblems, recordExecutorSwitch, recordUpgrade, type ChainFacts } from "../src/fund-upgrade-record.ts";
import { changes, takenFirst, type ClaimRow } from "../src/ci/fund-claims.ts";
import { fundProxyBuildDir } from "../src/verify/fund.ts";
import { BUNDLE_FORMAT, type SafeTxBundle } from "../src/safe/tx.ts";

const SAFE = "0x00000000000000000000000000000000000050fe" as Address;
const TL = "0x0000000000000000000000000000000000007100" as Address;
const FUND = "0x000000000000000000000000000000000000f00d" as Address;
const OLD = "0x0000000000000000000000000000000000000a01" as Address;
const NEW = "0x0000000000000000000000000000000000000b02" as Address;
const ID = `0x${"11".repeat(32)}` as Hex;
const Z = `0x${"00".repeat(32)}` as Hex;
const ABI = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
]);
const upgradeData = (impl: Address, data: Hex = "0x") => encodeFunctionData({ abi: ABI, functionName: "upgradeToAndCall", args: [impl, data] });
const bundle = (action: string, data: Hex, over: Partial<SafeTxBundle> = {}): SafeTxBundle => ({
  format: BUNDLE_FORMAT, chain_id: 918453, safe: SAFE, safe_version: "1.4.1", timelock: TL, action, description: action, to: TL, value: "0", data, operation: 0,
  safe_tx_gas: "0", base_gas: "0", gas_price: "0", gas_token: "0x0000000000000000000000000000000000000000", refund_receiver: "0x0000000000000000000000000000000000000000",
  nonce: 1, safe_tx_hash: `0x${"22".repeat(32)}`, timelock_operation_id: ID, threshold: 2, owners: [], signatures: [], proposed_at: "2026-11-14T00:00:00Z",
  executed: { tx_hash: `0x${action === "schedule" || action === "scheduleBatch" ? "33" : "44"}${"00".repeat(31)}` as Hex, block: 1, sent_by: SAFE, status: 1 }, ...over,
});
const single = (target: Address, data: Hex) => ({
  s: bundle("schedule", encodeFunctionData({ abi: ABI, functionName: "schedule", args: [target, 0n, data, Z, Z, 900n] })),
  e: bundle("execute", encodeFunctionData({ abi: ABI, functionName: "execute", args: [target, 0n, data, Z, Z] })),
});

describe("operationProblems: one executed timelock operation of the fund Safe", () => {
  test("a schedule and its execute: no problem, the call decoded", () => {
    const { s, e } = single(FUND, upgradeData(NEW));
    const r = operationProblems(s, e, TL, SAFE, false);
    expect(r.problems).toEqual([]);
    expect(r.calls.map((c) => ({ ...c, target: c.target.toLowerCase() }))).toEqual([{ target: FUND, value: 0n, data: upgradeData(NEW) }]);
    expect(r.id).toBe(ID);
  });
  test("an execute of other calldata, another Safe, an unexecuted bundle, another operation: each refused", () => {
    const { s, e } = single(FUND, upgradeData(NEW));
    const other = single(FUND, upgradeData(OLD)).e;
    expect(operationProblems(s, other, TL, SAFE, false).problems.join()).toContain("does not execute the calls the schedule bundle scheduled");
    expect(operationProblems({ ...s, safe: FUND }, e, TL, SAFE, false).problems.join()).toContain("not the fund Safe");
    expect(operationProblems(s, { ...e, executed: undefined }, TL, SAFE, false).problems.join()).toContain("was not executed by the Safe");
    expect(operationProblems(s, { ...e, timelock_operation_id: `0x${"99".repeat(32)}` }, TL, SAFE, false).problems.join()).toContain("different timelock operations");
    expect(operationProblems(s, e, TL, SAFE, true).problems.join()).toContain("not scheduleBatch");
  });
});

describe("the records against a run manifest and manifests on disk", () => {
  const EXEC = keccak256(toHex("EXECUTOR_ROLE"));
  const setup = () => {
    const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fund-upgrade-record-"));
    const ev = join(d, "evidence"), man = join(d, "manifests");
    mkdirSync(ev); mkdirSync(man);
    writeFileSync(join(ev, "publish-run.json"), JSON.stringify({ version: 1, system: "fund", coreSha: "7c23569f85e96232fc75bbba32ebbd469da31966", stages: {}, implementation_deploys: [{ system: "fund", proxy_name: "fund", implementation: NEW, build: "/b/v080" }] }));
    writeFileSync(join(man, "fund.json"), JSON.stringify({ chain_id: 918453, fund: FUND, fund_implementation: OLD }));
    writeFileSync(join(man, "fund-timelock.json"), JSON.stringify({ timelock: TL, safe: SAFE, executorPolicy: "open", code_hashes: { fund_implementation: "0x00" } }));
    writeFileSync(join(man, "safe.json"), JSON.stringify({ safe: SAFE }));
    return { ev, man };
  };
  const coreDir = join(import.meta.dir, "..", "..");
  const facts = (over: Partial<ChainFacts> = {}): ChainFacts => ({
    implementationOf: async () => NEW, code: async (a) => (`0x60${a.slice(2, 6)}` as Hex), isOperationDone: async () => true,
    hasRole: async (_at, role, who) => role === EXEC && who.toLowerCase() === SAFE, tx: async () => ({ status: "success", timestamp: 1000 }), ...over,
  });

  test("upgrade: re-records the manifest copy and appends proxy_upgrades with the build; a slot that is not the upgrade's writes nothing", async () => {
    const { ev, man } = setup();
    const { s, e } = single(FUND, upgradeData(NEW));
    const bad = await recordUpgrade({ evidenceDir: ev, manifestDir: man, scheduleBundle: s, executeBundle: e, coreDir, proxy: "fund", upgradeBuild: "/b/v080" }, facts({ implementationOf: async () => OLD }));
    expect(bad.problems.join()).toContain("ERC-1967 slot reads");
    expect(JSON.parse(readFileSync(join(man, "fund.json"), "utf8")).fund_implementation).toBe(OLD);
    const wrongBuild = await recordUpgrade({ evidenceDir: ev, manifestDir: man, scheduleBundle: s, executeBundle: e, coreDir, proxy: "fund", upgradeBuild: "/elsewhere" }, facts());
    expect(wrongBuild.problems.join()).toContain("records no deploy-implementation --system fund");
    const migration = single(FUND, upgradeData(NEW, "0x1234"));
    expect((await recordUpgrade({ evidenceDir: ev, manifestDir: man, scheduleBundle: migration.s, executeBundle: migration.e, coreDir, proxy: "fund", upgradeBuild: "/b/v080" }, facts())).problems.join()).toContain("migration data");
    const ok = await recordUpgrade({ evidenceDir: ev, manifestDir: man, scheduleBundle: s, executeBundle: e, coreDir, proxy: "fund", upgradeBuild: "/b/v080" }, facts());
    expect(ok.problems).toEqual([]);
    expect(JSON.parse(readFileSync(join(man, "fund.json"), "utf8")).fund_implementation.toLowerCase()).toBe(NEW);
    const m = JSON.parse(readFileSync(join(ev, "publish-run.json"), "utf8"));
    expect(m.proxy_upgrades).toHaveLength(1);
    expect({ ...m.proxy_upgrades[0], from_implementation: m.proxy_upgrades[0].from_implementation.toLowerCase(), to_implementation: m.proxy_upgrades[0].to_implementation.toLowerCase() }).toMatchObject({ step: "upgrade-proxy", proxy_name: "fund", from_implementation: OLD, to_implementation: NEW, build: "/b/v080", operation_id: ID, schedule_status: 1, execute_status: 1 });
  });

  test("executor: exactly grant to the Safe and revoke from address(0); the chain must read the Safe as the only executor", async () => {
    const { ev, man } = setup();
    const calls = executorSwitchCalls(TL, SAFE);
    const batch = (cs: typeof calls) => ({
      s: bundle("scheduleBatch", encodeFunctionData({ abi: ABI, functionName: "scheduleBatch", args: [cs.map((c) => c.target), cs.map(() => 0n), cs.map((c) => c.data), ID, Z, 900n] })),
      e: bundle("executeBatch", encodeFunctionData({ abi: ABI, functionName: "executeBatch", args: [cs.map((c) => c.target), cs.map(() => 0n), cs.map((c) => c.data), ID, Z] })),
    });
    const grantOnly = batch(calls.slice(0, 1));
    expect((await recordExecutorSwitch({ evidenceDir: ev, manifestDir: man, scheduleBundle: grantOnly.s, executeBundle: grantOnly.e, coreDir: "" }, facts())).problems.join()).toContain("not exactly [grantRole");
    const b = batch(calls);
    expect((await recordExecutorSwitch({ evidenceDir: ev, manifestDir: man, scheduleBundle: b.s, executeBundle: b.e, coreDir: "" }, facts({ hasRole: async () => true }))).problems.join()).toContain("still holds EXECUTOR_ROLE");
    expect(JSON.parse(readFileSync(join(man, "fund-timelock.json"), "utf8")).executorPolicy).toBe("open");
    const ok = await recordExecutorSwitch({ evidenceDir: ev, manifestDir: man, scheduleBundle: b.s, executeBundle: b.e, coreDir: "" }, facts());
    expect(ok.problems).toEqual([]);
    const tm = JSON.parse(readFileSync(join(man, "fund-timelock.json"), "utf8"));
    expect(tm.executorPolicy).toBe("safe-only");
    expect(tm.executor_policy_change).toMatchObject({ from_policy: "open", to_policy: "safe-only", operation_id: ID, predecessor: ID });
    expect(JSON.parse(readFileSync(join(ev, "publish-run.json"), "utf8")).timelock_executor_switches).toHaveLength(1);
  });
});

describe("the queue's claims", () => {
  const D = "0x00000000000000000000000000000000000000d0";
  const row = (id: number, over: Partial<ClaimRow> = {}): ClaimRow => ({ id, requestId: String(id), owner: D, kind: 0, settlementId: "1", unlockAt: 2000, shares: "10", usdc: "1", claimed: "0", sharesClaimed: "0", ...over });
  test("guard: an older open deposit claim out of its hold (or within the margin) would be taken first; a held, a delivered or another owner's is not", () => {
    const claims = [row(1, { unlockAt: 5000 }), row(2, { unlockAt: 1200 }), row(3, { claimed: "10", unlockAt: 100 }), row(4, { owner: "0x00000000000000000000000000000000000000e0", unlockAt: 100 }), row(5, { unlockAt: 100 })];
    expect(takenFirst(claims, D, 5, "deposit", 1000, 300).map((x) => x.split(" ")[1])).toEqual(["2"]);
    expect(takenFirst(claims, D, 5, "deposit", 1000, 100)).toEqual([]);
    expect(takenFirst(claims, D, 5, "deposit", 4800, 300).map((x) => x.split(" ")[1])).toEqual(["1", "2"]);
  });
  test("guard: any other unpaid redemption claim of the owner comes first", () => {
    const claims = [row(1, { kind: 1, sharesClaimed: "10" }), row(2, { kind: 1, sharesClaimed: "3" }), row(3, { kind: 1 })];
    expect(takenFirst(claims, D, 3, "redeem", 0, 0).map((x) => x.split(" ")[1])).toEqual(["2"]);
  });
  test("same: every field of every snapshot claim, unlockAt included", () => {
    expect(changes([row(1)], [row(1)])).toEqual([]);
    expect(changes([row(1)], [row(1, { unlockAt: 2001 })])).toEqual(["claim 1: unlockAt was 2000, is 2001"]);
    expect(changes([row(1)], [])).toEqual(["claim 1 no longer reads"]);
  });
});

test("the fund verifier compares an upgraded proxy with its upgrade's build and every other proxy with the deploy's", () => {
  const opts = { artifactsDir: "/live/out", proxyBuildDirs: { fund: "/b/v080/out", queue: "/b/v080/out" } };
  expect(fundProxyBuildDir("fund", opts)).toBe("/b/v080/out");
  expect(fundProxyBuildDir("queue", opts)).toBe("/b/v080/out");
  expect(fundProxyBuildDir("rebalancer", opts)).toBe("/live/out");
  expect(fundProxyBuildDir("fund-governance", { artifactsDir: "/live/out" })).toBe("/live/out");
});
