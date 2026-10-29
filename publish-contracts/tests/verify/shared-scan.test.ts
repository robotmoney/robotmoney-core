// Issue 1977: a verify scans each block range once. Every address-scoped log check is served from one shared eth_getLogs pass (an address list and topic-0
// alternatives) filtered in memory. These tests run the real verifier on the in-memory chain both ways (sharedLogScan false: each check scans on its own, as before)
// and require the same report, and they count the eth_getLogs calls of the shared way: one pass per range, plus the deployer's address-less discovery scan.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { verifyDeployment } from "../../src/verify/index.ts";
import { hashConsumedManifests } from "../../src/verify/gateway.ts";
import { ADMIN_ROLE, AGENT_ROLE, EMERGENCY_ROLE, PROPOSER_ROLE, SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP, SIG_ROLE_GRANTED, Z32, stageManifestFile } from "../../src/verify/constants.ts";
import { RPC_REFUSED_DETAIL, logMatches, padTopic, rangeLimit, scanLogs, withSharedLogScan } from "../../src/verify/logs.ts";
import type { LogEntry, VerifyOptions } from "../../src/verify/types.ts";
import { adoptTimelock, addr, buildWorld, deployedWorld, DEPLOYER, FakeChain, GATEWAY, OWNERS, REGISTRY, ROUTER, TIMELOCK, VAULTS, WORLD_CREATE2_FACTORY, type World } from "./world.ts";

const OTHER = addr(0x0bad);
const KEEPER_ROLE = keccak256(toHex("KEEPER_ROLE"));
const T_FROZEN = keccak256(toHex("UpgradesFrozen(address,address,bytes32)"));
const T_EXECUTED = keccak256(toHex("CallExecuted(bytes32,uint256,address,uint256,bytes)"));
const T_SCHEDULED = keccak256(toHex("CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)"));
const GOVERNED = parseAbi(["function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)"]);
const FREEZE_CALL = encodeFunctionData({ abi: GOVERNED, functionName: "freezeUpgrades", args: [addr(0x1111), pad("0x01", { size: 32 })] });
const txOf = (n: number) => pad(toHex(n), { size: 32 }) as Hex;

/** A world with a longer history (so every scan walks several chunks) and logs the shared pass must keep apart: other contracts, other events, out-of-range blocks. */
function busy(w: World): World {
  w.chain.head = 9_999n;
  w.opts.logChunk = 1_000;
  // noise: the same event on a contract no check scans by address, and an event no check reads on a scanned contract
  w.chain.logs.push({ address: addr(0x7777), topics: [keccak256(toHex(SIG_ROLE_GRANTED)), KEEPER_ROLE, padTopic(OTHER), padTopic(DEPLOYER)], data: "0x", blockNumber: 1_500n });
  w.chain.logs.push({ address: VAULTS.rmUSDC!.address, topics: [keccak256(toHex("Transfer(address,address,uint256)")), padTopic(OTHER), padTopic(DEPLOYER)], data: "0x", blockNumber: 2_500n });
  return w;
}

function upgradeableWorld(): World {
  const w = buildWorld(918453);
  w.sheet.upgradeMode = "upgradeable";
  for (const s of w.opts.table.stages.filter((x) => x.proxies)) {
    const p = join(w.manifestDir, stageManifestFile(w.opts.table, s.name));
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), upgrade_mode: "upgradeable" }));
  }
  for (const a of [GATEWAY, REGISTRY, ROUTER, addr(0x60b), addr(0x4ec), ...Object.values(VAULTS).map((v) => v.address)]) w.chain.set(a, "upgradesFrozen", false);
  return w;
}
function freezeLogs(w: World, proxy: `0x${string}`, block: bigint, tx: Hex, byTimelock: boolean): void {
  w.chain.set(proxy, "upgradesFrozen", true);
  w.chain.logs.push({ address: proxy, topics: [T_FROZEN, padTopic(proxy), padTopic(addr(0x1111))], data: pad("0x01", { size: 32 }), blockNumber: block, transactionHash: tx });
  if (byTimelock) w.chain.logs.push({ address: TIMELOCK, topics: [T_EXECUTED, txOf(0xf0), pad("0x00", { size: 32 })], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [proxy, 0n, FREEZE_CALL]), blockNumber: block, transactionHash: tx });
}

/** The gateway system's world (tests/verify/systems.test.ts): a gateway handed to its own admin behind its own timelock. */
function gatewayWorld(): { w: World; opts: VerifyOptions } {
  const w = buildWorld();
  const GW_ADMIN = addr(0x9a01), GW_TIMELOCK = addr(0x9a02);
  w.chain.codes.set(GW_TIMELOCK.toLowerCase(), "0x6001");
  w.chain.set(GATEWAY, "upgradeTimelock", GW_TIMELOCK);
  w.chain.revoke(GATEWAY, ADMIN_ROLE, TIMELOCK);
  w.chain.revoke(GATEWAY, Z32, TIMELOCK);
  w.chain.grant(GATEWAY, ADMIN_ROLE, GW_ADMIN);
  w.chain.grant(GATEWAY, Z32, GW_ADMIN);
  const gwFile = join(w.manifestDir, stageManifestFile(w.opts.table, "gateway"));
  writeFileSync(gwFile, JSON.stringify({ ...JSON.parse(readFileSync(gwFile, "utf8")), upgrade_timelock: GW_TIMELOCK, upgrade_mode: "frozen" }));
  writeFileSync(join(w.manifestDir, "gateway-handover.json"), JSON.stringify({ chain_id: 8453, gateway: GATEWAY, gateway_admin: GW_ADMIN, deployer: DEPLOYER }));
  w.chain.noncesMap.set(DEPLOYER.toLowerCase(), 47);
  const counts = { gateway: 3, "gateway-handover": 4 };
  return { w, opts: { ...w.opts, system: "gateway", frozenCounts: counts, deployerStartNonce: 40, handoverBlock: 3000n, consumedVaultsManifests: hashConsumedManifests(w.manifestDir), sheet: { ...w.sheet, upgradeMode: "frozen", gateway: { admin: GW_ADMIN, upgradeTimelock: GW_TIMELOCK } } } };
}

const agentLog = (sig: string, block: bigint): LogEntry => ({ address: GATEWAY, topics: [keccak256(toHex(sig)), padTopic(OTHER), padTopic(OWNERS[0]!)], data: "0x", blockNumber: block });

/** Each case builds a fresh world: the role, agent, timelock, creation-proof and freeze cases of the verifier, healthy and failing. */
const CASES: [string, () => { w: World; opts: VerifyOptions }][] = [
  ["healthy (legacy)", () => { const w = busy(buildWorld()); return { w, opts: w.opts }; }],
  ["healthy (vaults system)", () => { const w = busy(buildWorld()); w.chain.noncesMap.set(DEPLOYER.toLowerCase(), 57); return { w, opts: { ...w.opts, system: "vaults", frozenCounts: { safe: 1, libs: 4, vault: 12, registry: 2, router: 2, governance: 2, receipt: 3, proto: 6, rwa: 6, timelock: 18 } } }; }],
  ["a second KEEPER_ROLE holder", () => { const w = busy(buildWorld()); w.chain.grant(VAULTS.rmPROTO!.address, KEEPER_ROLE, OTHER); w.chain.roleGrantedLog(VAULTS.rmPROTO!.address, KEEPER_ROLE, OTHER, 4_400n); return { w, opts: w.opts }; }],
  ["a second EMERGENCY_ROLE holder", () => { const w = busy(buildWorld()); w.chain.grant(VAULTS.rmRWA!.address, EMERGENCY_ROLE, OTHER); w.chain.roleGrantedLog(VAULTS.rmRWA!.address, EMERGENCY_ROLE, OTHER, 6_100n); return { w, opts: w.opts }; }],
  ["a revoked grant (logged, no longer held)", () => { const w = busy(buildWorld()); w.chain.roleGrantedLog(VAULTS.rmUSDC!.address, KEEPER_ROLE, OTHER, 7_000n); return { w, opts: w.opts }; }],
  ["an extra allowed adapter", () => { const w = busy(buildWorld()); w.chain.logs.push({ address: VAULTS.rmUSDC!.address, topics: [keccak256(toHex("AdapterAllowedSet(address,bool)")), padTopic(addr(0xbeef))], data: "0x", blockNumber: 3_000n }); w.chain.set(VAULTS.rmUSDC!.address, "adapterAllowed", () => true); return { w, opts: w.opts }; }],
  ["an unexpected governed ADMIN_ROLE holder", () => { const w = busy(buildWorld()); w.chain.grant(VAULTS.rmPROTO!.address, ADMIN_ROLE, OTHER); w.chain.roleGrantedLog(VAULTS.rmPROTO!.address, ADMIN_ROLE, OTHER, 8_400n); return { w, opts: w.opts }; }],
  ["a stray timelock PROPOSER_ROLE holder", () => { const w = busy(buildWorld()); w.chain.grant(TIMELOCK, PROPOSER_ROLE, OTHER); w.chain.roleGrantedLog(TIMELOCK, PROPOSER_ROLE, OTHER, 1_300n); return { w, opts: w.opts }; }],
  ["the deployer holds a role on a contract no manifest names", () => { const w = busy(buildWorld()); const stray = addr(0x57a7); w.chain.grant(stray, ADMIN_ROLE, DEPLOYER); w.chain.roleGrantedLog(stray, ADMIN_ROLE, DEPLOYER, 900n); return { w, opts: w.opts }; }],
  ["agent logs before and after the handover block", () => {
    const w = busy(buildWorld());
    w.chain.logs.push(agentLog(SIG_AGENT_AUTHORIZED, 2_000n), agentLog(SIG_AGENT_OWNERSHIP, 2_100n), agentLog(SIG_AGENT_AUTHORIZED, 5_000n));
    w.chain.roleGrantedLog(GATEWAY, AGENT_ROLE, OTHER, 2_200n); w.chain.grant(GATEWAY, AGENT_ROLE, OTHER);
    return { w, opts: { ...w.opts, handoverBlock: 3_000n } };
  }],
  ["agent logs only after the handover block", () => { const w = busy(buildWorld()); w.chain.logs.push(agentLog(SIG_AGENT_AUTHORIZED, 4_000n)); return { w, opts: { ...w.opts, handoverBlock: 3_000n } }; }],
  ["a creation proof from block 100", () => { const w = deployedWorld(); w.chain.head = 9_999n; w.opts.logChunk = 1_000; w.chain.roleGrantedLog(VAULTS.rmUSDC!.address, KEEPER_ROLE, OTHER, 50n); return { w, opts: w.opts }; }],
  ["a vault created before the scan start", () => { const w = deployedWorld({ rmPROTO: 50n }); w.opts.logChunk = 700; return { w, opts: w.opts }; }],
  ["an adopted timelock (its constructor grant)", () => { const w = adoptTimelock(deployedWorld(), 105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] })); w.opts.logChunk = 30; return { w, opts: w.opts }; }],
  ["an adopted timelock whose first grant is not the constructor's", () => { const w = adoptTimelock(deployedWorld(), 105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] }), { sender: OTHER }); w.opts.logChunk = 30; return { w, opts: w.opts }; }],
  ["a proxy frozen by the timelock", () => { const w = busy(upgradeableWorld()); freezeLogs(w, REGISTRY, 4_321n, txOf(9), true); return { w, opts: w.opts }; }],
  ["a proxy frozen outside the timelock", () => { const w = busy(upgradeableWorld()); freezeLogs(w, ROUTER, 120n, txOf(7), false); return { w, opts: w.opts }; }],
  ["a scheduled freeze outside the freeze alert window", () => {
    const w = busy(upgradeableWorld());
    w.chain.logs.push({ address: TIMELOCK, topics: [T_SCHEDULED, txOf(0x100), pad("0x00", { size: 32 })], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [REGISTRY, 0n, FREEZE_CALL, pad("0x00", { size: 32 }), 172800n]), blockNumber: 4_000n, transactionHash: txOf(0x5c) });
    w.chain.set(TIMELOCK, "isOperationPending", () => true);
    return { w, opts: w.opts };
  }],
  ["the gateway system", () => { const g = gatewayWorld(); g.w.chain.head = 9_999n; return { w: g.w, opts: { ...g.opts, logChunk: 1_000 } }; }],
  ["the gateway system with an agent before the handover", () => { const g = gatewayWorld(); g.w.chain.logs.push(agentLog(SIG_AGENT_AUTHORIZED, 300n)); g.w.chain.roleGrantedLog(GATEWAY, ADMIN_ROLE, DEPLOYER, 200n); g.w.chain.grant(GATEWAY, ADMIN_ROLE, DEPLOYER); return g; }],
];

const ranges = (from: bigint, head: bigint, chunk: number) => Number((head - from + 1n + BigInt(chunk) - 1n) / BigInt(chunk));

describe("one shared log pass serves every address-scoped check (issue 1977)", () => {
  for (const [name, make] of CASES) {
    test(`${name}: the same report both ways, and one eth_getLogs pass per range`, async () => {
      const before = make();
      const old = await verifyDeployment({ ...before.opts, sharedLogScan: false });
      const after = make();
      const now = await verifyDeployment(after.opts);
      expect(now.checks).toEqual(old.checks);
      expect(now.ok).toBe(old.ok);
      expect(now.upgradeability).toEqual(old.upgradeability);
      if (/^(healthy|the gateway system$|a creation proof|an adopted timelock \(|a proxy frozen by the timelock|a revoked grant|agent logs only after|a scheduled freeze)/.test(name)) expect(now.checks.filter((x) => !x.ok)).toEqual([]);
      else expect(now.ok).toBe(false);

      // the calls of the shared way: one walk of [fromBlock, head] with the address list, plus (vaults and legacy only) the deployer's address-less discovery scan
      const n = ranges(after.opts.fromBlock, after.w.chain.head, after.opts.logChunk ?? 2000);
      const f = after.w.chain.logFilters;
      const shared = f.filter((x) => Array.isArray(x.address)), unscoped = f.filter((x) => x.address === undefined), single = f.filter((x) => typeof x.address === "string");
      expect(single).toEqual([]); // no check scanned its own address: the shared pass covered them all
      // a case whose creation proof fails scans nothing: its scan labels fail before any read
      expect([0, n]).toContain(shared.length);
      expect([0, after.opts.system === "gateway" ? 0 : n]).toContain(unscoped.length);
      expect(f.length).toBeLessThanOrEqual((after.opts.system === "gateway" ? 1 : 2) * n);
      // the shared walk covers the range once, in order, with no gap and no overlap
      let next = after.opts.fromBlock;
      for (const x of shared) { expect(x.fromBlock).toBe(next); next = x.toBlock + 1n; }
      expect(next).toBe(after.w.chain.head + 1n);
      // and the per-check way made more calls than the shared one, unless neither scanned
      if (shared.length) expect(before.w.chain.logFilters.length).toBeGreaterThan(f.length);
    });
  }
});

describe("the shared scan and the per-check scan read the same logs (issue 1977)", () => {
  test("every filter the checks use returns the logs a per-check scan returns, including sub-ranges", async () => {
    const c = new FakeChain();
    c.head = 4_000n;
    const A = addr(0xa), B = addr(0xb), t0 = keccak256(toHex(SIG_ROLE_GRANTED)), t1 = keccak256(toHex(SIG_AGENT_AUTHORIZED));
    for (let b = 0n; b < 4_000n; b += 37n) c.logs.push({ address: b % 2n ? A : B, topics: [b % 3n ? t0 : t1, b % 5n ? KEEPER_ROLE : EMERGENCY_ROLE, padTopic(b % 7n ? OTHER : DEPLOYER)], data: "0x", blockNumber: b, transactionHash: txOf(Number(b)) });
    const s = withSharedLogScan(c, { addresses: [A, B], topic0s: [t0, t1], fromBlock: 0n, toBlock: 4_000n, chunk: 500, retryBaseMs: 0 });
    const filters = [
      { address: A, topics: [t0] }, { address: B, topics: [t1] }, { address: A, topics: [t0, KEEPER_ROLE] }, { address: B, topics: [t0, [KEEPER_ROLE, EMERGENCY_ROLE]] },
      { address: A, topics: [t0, null, padTopic(DEPLOYER)] }, { address: B, topics: [[t0, t1]] },
    ];
    for (const f of filters) for (const [from, to] of [[0n, 4_000n], [100n, 3_000n], [1_234n, 1_234n]] as const) {
      const p = { ...f, fromBlock: from, toBlock: to, chunk: 500, retryBaseMs: 0 };
      expect(await scanLogs(s, p)).toEqual(await scanLogs(c, p));
    }
    expect(c.logFilters.filter((x) => Array.isArray(x.address))).toHaveLength(9); // [0, 4000] in 500-block windows, once
  });
  test("a filter the plan does not cover scans on its own: no address, another address, another topic 0, a range outside the plan", async () => {
    const c = new FakeChain();
    const A = addr(0xa), t0 = keccak256(toHex(SIG_ROLE_GRANTED));
    const s = withSharedLogScan(c, { addresses: [A], topic0s: [t0], fromBlock: 100n, toBlock: 1_000n, chunk: 2_000, retryBaseMs: 0 });
    for (const p of [{ topics: [t0] }, { address: addr(0xb), topics: [t0] }, { address: A, topics: [keccak256(toHex("X()"))] }, { address: A, topics: [null] }, { address: A, topics: [t0], fromBlock: 0n }]) {
      c.logFilters = [];
      await scanLogs(s, { fromBlock: 100n, toBlock: 1_000n, chunk: 2_000, retryBaseMs: 0, ...p });
      expect(c.logFilters.map((x) => Array.isArray(x.address))).toEqual([false]);
    }
  });
  test("the in-memory match follows eth_getLogs: a filter with more topics than the log never matches, null and an empty list match anything", () => {
    const l: LogEntry = { address: addr(0xa), topics: [txOf(1), txOf(2)], data: "0x", blockNumber: 5n };
    const at = (topics: (Hex | Hex[] | null)[]) => logMatches(l, { address: addr(0xa), topics, fromBlock: 0n, toBlock: 10n });
    expect(at([txOf(1)])).toBe(true);
    expect(at([txOf(1), null])).toBe(true);
    expect(at([txOf(1), null, null])).toBe(false);
    expect(at([[], [txOf(3), txOf(2)]])).toBe(true);
    expect(at([txOf(2)])).toBe(false);
    expect(logMatches(l, { address: addr(0xb), topics: [], fromBlock: 0n, toBlock: 10n })).toBe(false);
    expect(logMatches(l, { topics: [], fromBlock: 6n, toBlock: 10n })).toBe(false);
  });
});

/** A chain that answers a range-limit error for any eth_getLogs over `limit` blocks. */
function capped(limit: bigint, message: string): FakeChain {
  const c = new FakeChain();
  c.maxLogSpan = 1n << 60n;
  const inner = c.getLogs.bind(c);
  c.getLogs = async (p) => { if (p.toBlock - p.fromBlock + 1n > limit) { c.logFilters.push(p); throw new Error(message); } return inner(p); };
  return c;
}

describe("a range-limit answer shrinks the window and the scan completes (issue 1977)", () => {
  for (const [message, limit] of [
    ["exceed maximum block range: 500", 500n],
    ["ranges over 500 blocks are not supported", 500n],
    ["Block range too large", 300n],
  ] as const) {
    test(`"${message}"`, async () => {
      expect(rangeLimit(new Error(message))).toBe(message.startsWith("Block") ? 0n : 500n);
      const c = capped(limit, message);
      for (let b = 0n; b < 5_000n; b += 101n) c.logs.push({ address: addr(0xa), topics: [txOf(1)], data: "0x", blockNumber: b });
      const s = withSharedLogScan(c, { addresses: [addr(0xa)], topic0s: [txOf(1)], fromBlock: 0n, toBlock: 4_999n, chunk: 2_000, retryBaseMs: 0 });
      const logs = await scanLogs(s, { address: addr(0xa), topics: [txOf(1)], fromBlock: 0n, toBlock: 4_999n, chunk: 2_000, retryBaseMs: 0 });
      expect(logs.map((l) => l.blockNumber)).toEqual(c.logs.map((l) => l.blockNumber));
      // every served window is within the limit, and they cover the range once
      let next = 0n;
      for (const x of c.logCalls) { expect(x.to - x.from + 1n).toBeLessThanOrEqual(limit); expect(x.from).toBe(next); next = x.to + 1n; }
      expect(next).toBe(5_000n);
    });
  }
  test("the full verify completes against a 500-block RPC asked for 2000-block windows", async () => {
    const w = busy(buildWorld());
    w.opts.logChunk = 2_000;
    const c = w.chain, inner = c.getLogs.bind(c);
    c.getLogs = async (p) => { if (p.toBlock - p.fromBlock + 1n > 500n) throw new Error("exceed maximum block range: 500"); return inner(p); };
    const r = await verifyDeployment(w.opts);
    expect(r.checks.filter((x) => !x.ok)).toEqual([]);
    for (const x of c.logCalls) expect(x.to - x.from + 1n).toBeLessThanOrEqual(500n);
  });
});

describe("a failed chunk is one scan error, never 'no logs' (issue 1977)", () => {
  test("every scan label fails with the RPC_REFUSED detail, and the shared pass is tried once, not once per check", async () => {
    const w = busy(buildWorld());
    w.chain.rateLimits = 1_000_000; // every eth_getLogs answers 429
    const r = await verifyDeployment(w.opts);
    const bad = r.checks.filter((x) => !x.ok);
    expect(bad.length).toBeGreaterThan(5);
    for (const x of bad) expect(x.detail.startsWith(RPC_REFUSED_DETAIL), `${x.label}: ${x.detail}`).toBe(true);
    expect(bad.map((x) => x.label)).toContain("deployer: holds no role on any contract (log scan)");
    expect(bad.map((x) => x.label)).toContain("agents: no agent authorized at handover");
    // 7 tries (the first and 6 retries) of the shared pass's first chunk, and 7 of the deployer scan's
    expect(w.chain.logFilters.filter((x) => Array.isArray(x.address))).toHaveLength(7);
    expect(w.chain.logFilters).toHaveLength(14);
  });
});
