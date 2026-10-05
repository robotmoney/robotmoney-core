import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { chainReaderFromFixture, checkEvidence, checkEvidenceOnChain, GOVERN_STEPS, recordingChainReader, scanEvidenceFolder, type ChainReader } from "../src/evidence-check.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOwnerExceptions } from "../src/plan.ts";

const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const good = () => ({
  chain_id: 8453, core_sha: "ab".repeat(20), plan_approved_at: "2026-10-05T10:00:00Z",
  owner_exceptions: [{ text: "signer C is a Ledger on a shared laptop", recorded_at: "2026-10-04T10:00:00Z" }],
  stages: [{ stage: "safe", frozen_count: 2, receipt_count: 2, tx_hashes: [h(1), h(2)], receipts_status: [1, 1] }],
  safe: { address: a(1), owners: [a(2), a(3), a(4)], threshold: 2, creation_tx: h(3) },
  vaults: { rmUSDC: { address: a(5) }, rmPROTO: { address: a(6) }, rmAGENT: { address: a(7) }, rmRWA: { address: a(8) } },
  timelock: { address: a(9), min_delay: 172800 },
  verifier: { exit_code: 0, registry_list_vaults_equals_manifests: true },
  deployer: a(20), deployer_nonce_final: 2, registry: { address: a(21) },
  govern: GOVERN_STEPS.map((step, i) => step === "cancel"
    ? { step, schedule_tx: h(100 + i * 3), cancel_tx: h(101 + i * 3), schedule_status: 1, cancel_status: 1 }
    : { step, schedule_tx: h(100 + i * 3), schedule_block_timestamp: 1000, execute_tx: h(101 + i * 3), execute_block_timestamp: 1000 + 172800, schedule_status: 1, execute_status: 1 }),
  sources: { blockscout_all_verified: true, sourcify_all_exact: true },
});
const mut = (f: (e: any) => void) => { const e = good(); f(e); return checkEvidence(e).join("\n"); };

describe("evidence check", () => {
  test("a complete record passes", () => expect(checkEvidence(good())).toEqual([]));
  test("a wrong tx count is rejected", () => expect(mut((e) => { e.stages[0].receipt_count = 3; })).toContain("receipt_count"));
  test("a count that differs from the frozen file is rejected", () => expect(checkEvidence(good(), { safe: 3 }).join()).toContain("frozen file"));
  test("a missing tx hash is rejected", () => expect(mut((e) => { e.stages[0].tx_hashes[1] = ""; })).toContain("tx hash 1"));
  test("a failed receipt is rejected", () => expect(mut((e) => { e.stages[0].receipts_status[0] = 0; })).toContain("status is 0"));
  test("a delay under 172800 s is rejected", () => expect(mut((e) => { e.timelock.min_delay = 60; })).toContain("min_delay"));
  test("a govern gap under 172800 s is rejected", () => expect(mut((e) => { e.govern[1].execute_block_timestamp = 1000 + 172799; })).toContain("gap"));
  test("a failed govern execute is rejected", () => expect(mut((e) => { e.govern[1].execute_status = 0; })).toContain("execute receipt"));
  test("chain 918453 is rejected", () => expect(mut((e) => { e.chain_id = 918453; })).toContain("chain_id"));
  test("an owner exception recorded after approval is rejected", () => expect(mut((e) => { e.owner_exceptions[0].recorded_at = "2026-10-06T00:00:00Z"; })).toContain("not before"));
});

describe("evidence check, more negatives", () => {
  test("a missing govern schedule tx is rejected", () => expect(mut((e) => { delete e.govern[0].schedule_tx; })).toContain("schedule_tx is missing"));
  test("a missing matrix step is rejected", () => expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== "router-weights"); })).toContain("'router-weights'"));
  test("every matrix step is required", () => { for (const step of GOVERN_STEPS) expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== step); })).toContain(`'${step}'`); });
  test("a nonce that differs from the frozen sum is rejected", () => expect(checkEvidence(good(), { safe: 2, vault: 1 }).join()).toContain("deployer_nonce_final"));
});

// ---- online mode with a stub RPC ----
const EV = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
const tl = a(9);
const id32 = (n: number) => h(n);
const log = (eventName: "CallScheduled" | "CallExecuted" | "Cancelled", n: number, delay = 172800n) => {
  const topics = encodeEventTopics({ abi: EV, eventName, args: eventName === "Cancelled" ? { id: id32(n) as Hex } : { id: id32(n) as Hex, index: 0n } } as any);
  const data = eventName === "CallScheduled" ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [a(1) as Hex, 0n, "0x", h(0) as Hex, delay])
    : eventName === "CallExecuted" ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [a(1) as Hex, 0n, "0x"]) : "0x";
  return { address: tl, topics: topics as Hex[], data: data as Hex };
};
interface Opts { paused?: boolean; nonce?: number; failed?: string; delay?: bigint; gap?: number; listed?: string[]; chainId?: number }
function stub(ev: any, o: Opts = {}): ChainReader {
  const receipts = new Map<string, any>(); const blocks = new Map<bigint, number>(); let bn = 1n;
  const add = (hash: string, logs: any[], ts: number) => { receipts.set(hash, { status: o.failed === hash ? "reverted" : "success", blockNumber: bn, logs }); blocks.set(bn++, ts); };
  for (const s of ev.stages) for (const x of s.tx_hashes) add(x, [], 1);
  add(ev.safe.creation_tx, [], 1);
  ev.govern.forEach((g: any, i: number) => {
    add(g.schedule_tx, [log("CallScheduled", i + 1, o.delay)], 1000);
    if (g.step === "cancel") add(g.cancel_tx, [log("Cancelled", i + 1)], 1500);
    else add(g.execute_tx, [log("CallExecuted", i + 1)], 1000 + (o.gap ?? 172800));
  });
  return {
    getChainId: async () => o.chainId ?? 8453,
    getTransactionCount: async () => o.nonce ?? 2,
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error("not found"); return r; },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks.get(blockNumber)!) }),
    readContract: async ({ functionName }) => (functionName === "paused" ? (o.paused ?? false) : (o.listed ?? Object.values(ev.vaults).map((v: any) => v.address))),
  };
}
const online = (o: Opts = {}, mutate: (e: any) => void = () => {}) => { const e = good(); const chain = stub(e, o); mutate(e); return checkEvidenceOnChain(e, chain, { safe: 2 }); };

describe("evidence check reading the chain (stub RPC)", () => {
  test("a consistent chain passes", async () => expect(await online()).toEqual([]));
  test("a deployer nonce off the frozen sum is rejected", async () => expect((await online({ nonce: 3 })).join()).toContain("deployer nonce on chain"));
  test("a registry vault set that differs from the manifests is rejected", async () => expect((await online({ listed: [a(5), a(6), a(7)] })).join()).toContain("listVaults"));
  test("a reverted stage receipt is rejected even if the JSON says 1", async () => expect((await online({ failed: h(1) })).join()).toContain("reverted"));
  test("a reverted govern execute is rejected", async () => expect((await online({ failed: h(104) })).join()).toContain("reverted"));
  test("an on-chain gap under 172800 s is rejected even if the JSON says otherwise", async () => expect((await online({ gap: 172799 })).join()).toContain("on-chain schedule-to-execute gap"));
  test("a CallScheduled delay under 172800 s is rejected", async () => expect((await online({ delay: 60n })).join()).toContain("CallScheduled delay"));
  test("a tx hash the chain does not know is rejected", async () => expect((await online({}, (e) => { e.stages[0].tx_hashes[0] = h(999); })).join()).toContain("not readable"));
  test("another chain id is rejected", async () => expect((await online({ chainId: 918453 })).join()).toContain("RPC reports chain"));
});

describe("owner exceptions before plan approval", () => {
  test("an empty list passes", () => expect(() => assertOwnerExceptions([], "2026-10-05T10:00:00Z")).not.toThrow());
  test("a placeholder is refused", () => expect(() => assertOwnerExceptions([{ text: "<x>", recorded_at: "2026-10-01T00:00:00Z" }], "2026-10-05T10:00:00Z")).toThrow());
  test("no approval time is refused", () => expect(() => assertOwnerExceptions([], undefined)).toThrow());
});

describe("unpause govern rows and paused=false reads tell one story", () => {
  test("every unpause row executed and every basket vault reads paused=false: passes", async () => expect(await online({ paused: false })).toEqual([]));
  test("an unpause row that executed while the vault still reads paused=true is rejected, naming the row", async () => {
    const p = await online({ paused: true });
    expect(p.join("\n")).toContain("govern unpause-PROTO executed with receipt status 1, but rmPROTO.paused() reads true");
    expect(p.filter((m) => m.includes("paused()")).length).toBe(3);
  });
  test("a vault that reads paused=false with no executed unpause row is rejected", async () => {
    const p = await online({ paused: false }, (e) => { const g = e.govern.find((x: any) => x.step === "unpause-RWA"); g.execute_status = 0; });
    expect(p.join("\n")).toContain("rmRWA.paused() reads false on chain, but govern unpause-RWA has no executed receipt");
  });
  test("rmUSDC ships unpaused and is not part of the link", async () => expect((await online({ paused: false })).join()).not.toContain("rmUSDC"));
});

describe("recorded chain fixture (offline mode of the same chain checks)", () => {
  const frozen = { safe: 2 };
  async function record(o: Opts = {}) {
    const e = good();
    const { reader, fixture } = recordingChainReader(stub(e, o));
    expect(await checkEvidenceOnChain(e, reader, frozen)).toEqual([]);
    return { e, fixture: JSON.parse(JSON.stringify(fixture)) };
  }
  test("a fixture recorded from a passing run passes with no reader behind it", async () => {
    const { e, fixture } = await record();
    expect(await checkEvidenceOnChain(e, chainReaderFromFixture(fixture), frozen)).toEqual([]);
  });
  test("criterion 2: a nonce off the frozen sum fails in the fixture", async () => {
    const { e, fixture } = await record();
    fixture.nonces[e.deployer.toLowerCase()] = 3;
    expect((await checkEvidenceOnChain(e, chainReaderFromFixture(fixture), frozen)).join()).toContain("deployer nonce on chain");
  });
  test("criterion 3: a reverted govern receipt and a short gap fail in the fixture", async () => {
    const { e, fixture } = await record();
    fixture.receipts.find((r: any) => r.hash === h(104)).status = "reverted";
    expect((await checkEvidenceOnChain(e, chainReaderFromFixture(fixture), frozen)).join()).toContain("reverted");
    const { e: e2, fixture: f2 } = await record();
    const ex = f2.receipts.find((r: any) => r.hash === h(104));
    f2.blocks[ex.blockNumber] = 1000 + 172799;
    expect((await checkEvidenceOnChain(e2, chainReaderFromFixture(f2), frozen)).join()).toContain("on-chain schedule-to-execute gap");
  });
  test("a read the fixture lacks is an error, never a guess", async () => {
    const { e, fixture } = await record();
    fixture.receipts = fixture.receipts.filter((r: any) => r.hash !== h(1));
    expect((await checkEvidenceOnChain(e, chainReaderFromFixture(fixture), frozen)).join()).toContain("the chain fixture has no receipt");
  });

  test("the CLI, as CI calls it (--frozen, --deploy-sha, --chain-fixture): exit 0 on a good run, 1 on a bad one, and the folder passes the secret scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-ci-"));
    const run = join(dir, "evidence", "run-1");
    mkdirSync(run, { recursive: true });
    const { e, fixture } = await record();
    writeFileSync(join(run, "evidence.json"), JSON.stringify(e, null, 2));
    writeFileSync(join(run, "chain-fixture.json"), JSON.stringify(fixture, null, 2));
    const frozenFile = join(dir, "frozen.json");
    writeFileSync(frozenFile, JSON.stringify({ deploySha: e.core_sha, counts: frozen }));
    expect(scanEvidenceFolder(run)).toEqual([]);
    const cli = (extra: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "evidence-check.ts"), "--evidence", join(run, "evidence.json"), ...extra], { stdout: "pipe", stderr: "pipe" });
    const ok = cli(["--frozen", frozenFile, "--deploy-sha", e.core_sha, "--chain-fixture", join(run, "chain-fixture.json")]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("recorded chain fixture, offline");
    // a fixture with a wrong nonce
    fixture.nonces[e.deployer.toLowerCase()] = 99;
    writeFileSync(join(run, "chain-fixture.json"), JSON.stringify(fixture, null, 2));
    const bad = cli(["--frozen", frozenFile, "--deploy-sha", e.core_sha, "--chain-fixture", join(run, "chain-fixture.json")]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("deployer nonce on chain");
    // the flags CI needs are required together
    expect(cli(["--chain-fixture", join(run, "chain-fixture.json")]).exitCode).toBe(2);
    expect(cli(["--frozen", frozenFile, "--chain-fixture", join(run, "chain-fixture.json")]).exitCode).toBe(2);
    expect(cli(["--frozen", frozenFile, "--deploy-sha", "f".repeat(40), "--chain-fixture", join(run, "chain-fixture.json")]).exitCode).toBe(1); // frozen file is for another sha
  });
});
