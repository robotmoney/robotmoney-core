import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from "viem";
import { applyCalldata, chainReaderFromFixture, checkEvidence, checkEvidenceOnChain, checkReceiptApplications, checkReceiptApplicationsOnChain, GOVERN_STEPS, recordingChainReader, scanEvidenceFolder, unpauseCalldata, type ChainReader } from "../src/evidence-check.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOwnerExceptions } from "../src/plan.ts";
import { UNPAUSE_ROWS } from "../src/govern.ts";
import { releaseCalldata } from "../src/evidence-check.ts";
import { keccak256 } from "viem";

const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
/** The unpauses are scheduled in one sitting: step i is scheduled i seconds after step 0, and each waits one 172800 s delay. */
const T0 = 1000;
const good = () => ({
  chain_id: 8453, core_sha: "ab".repeat(20), plan_approved_at: "2026-10-05T10:00:00Z",
  owner_exceptions: [{ text: "signer C is a Ledger on a shared laptop", recorded_at: "2026-10-04T10:00:00Z" }],
  stages: [{ stage: "safe", frozen_count: 2, receipt_count: 2, tx_hashes: [h(1), h(2)], receipts_status: [1, 1] }],
  safe: { address: a(1), owners: [a(2), a(3), a(4)], threshold: 2, creation_tx: h(3) },
  vaults: { rmUSDC: { address: a(5) }, rmPROTO: { address: a(6) }, rmAGENT: { address: a(7) }, rmRWA: { address: a(8) } },
  timelock: { address: a(9), min_delay: 172800 },
  verifier: { exit_code: 0, registry_list_vaults_equals_manifests: true },
  deployer: a(20), deployer_nonce_final: 3, registry: { address: a(21) },
  govern: GOVERN_STEPS.map((step, i) => ({ step, operation_id: h(900 + i), schedule_tx: h(100 + i * 3), schedule_block_timestamp: T0 + i, execute_tx: h(101 + i * 3), execute_block_timestamp: T0 + i + 172800, schedule_status: 1, execute_status: 1 })),
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
  test("a govern gap under 172800 s is rejected", () => expect(mut((e) => { e.govern[1].execute_block_timestamp = T0 + 1 + 172799; })).toContain("gap"));
  test("a failed govern execute is rejected", () => expect(mut((e) => { e.govern[1].execute_status = 0; })).toContain("execute receipt"));
  test("chain 918453 is rejected", () => expect(mut((e) => { e.chain_id = 918453; })).toContain("chain_id"));
  test("an owner exception recorded after approval is rejected", () => expect(mut((e) => { e.owner_exceptions[0].recorded_at = "2026-10-06T00:00:00Z"; })).toContain("not before"));
});

describe("evidence check, more negatives", () => {
  test("a missing govern schedule tx is rejected", () => expect(mut((e) => { delete e.govern[0].schedule_tx; })).toContain("schedule_tx is missing"));
  test("a missing unpause is rejected", () => expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== "unpause-AGENT"); })).toContain("'unpause-AGENT'"));
  test("every unpause is required", () => { for (const step of GOVERN_STEPS) expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== step); })).toContain(`'${step}'`); });
  test("Stage 13 on 8453 is the four vault unpauses (rmUSDC first), and the unpause rows of the govern CLI are the same list", () => {
    expect(GOVERN_STEPS).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA"]);
    expect([...GOVERN_STEPS]).toEqual([...UNPAUSE_ROWS]);
  });
  test("a non-unpause operation scheduled on 8453 is rejected: update-delay, batch, cancel and anything else", () => {
    for (const step of ["update-delay", "batch", "cancel", "voting-power-quorum", "agents", "other-setters", "router-weights", "migrate-eligibility-PROTO", "round1"]) {
      expect(mut((e) => { e.govern.push({ ...e.govern[0], step, schedule_tx: h(700), execute_tx: h(701), operation_id: h(702) }); })).toContain(`'${step}' is not a vault unpause`);
    }
  });
  test("a complete record with one schedule and one execute per unpause, at least 172800 s apart and with distinct operation ids, passes", () => {
    const e = good();
    expect(e.govern.length).toBe(4);
    expect(new Set(e.govern.map((g: any) => g.operation_id)).size).toBe(4);
    for (const g of e.govern) expect(g.execute_block_timestamp - g.schedule_block_timestamp).toBeGreaterThanOrEqual(172800);
    expect(checkEvidence(e)).toEqual([]);
  });
  test("two steps sharing a schedule transaction are rejected", () => expect(mut((e) => { e.govern[1].schedule_tx = e.govern[0].schedule_tx; })).toContain("none shared"));
  test("two steps sharing an execute transaction are rejected", () => expect(mut((e) => { e.govern[1].execute_tx = e.govern[0].execute_tx; })).toContain("execute_tx is also"));
  test("two steps sharing a timelock operation id are rejected", () => expect(mut((e) => { e.govern[1].operation_id = e.govern[0].operation_id; })).toContain("operation_id is also"));
  test("a step listed twice is rejected", () => expect(mut((e) => { e.govern.push({ ...e.govern[2] }); })).toContain("more than one evidence entry"));
  test("the unpauses may all be scheduled before the first executes (one sitting): no ordering rule between them", () => expect(checkEvidence(good())).toEqual([]));
  test("a nonce that differs from the frozen sum plus the prove-control transaction is rejected (the bare sum is too low)", () => expect(checkEvidence(good(), { safe: 2, vault: 1 }).join()).toContain("deployer_nonce_final"));
});

// ---- online mode with a stub RPC ----
const EV = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
const tl = a(9);
const id32 = (n: number) => h(n);
const log = (eventName: "CallScheduled" | "CallExecuted" | "Cancelled", n: number, delay = 172800n, target: string = a(1), calldata: string = "0x", index = 0n) => {
  const topics = encodeEventTopics({ abi: EV, eventName, args: eventName === "Cancelled" ? { id: id32(n) as Hex } : { id: id32(n) as Hex, index } } as any);
  const data = eventName === "CallScheduled" ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [target as Hex, 0n, calldata as Hex, h(0) as Hex, delay])
    : eventName === "CallExecuted" ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [target as Hex, 0n, calldata as Hex]) : "0x";
  return { address: tl, topics: topics as Hex[], data: data as Hex };
};
interface Opts { appDelay?: bigint; appGap?: number; appCalls?: number; appData?: [string?, string?]; appTarget?: [string?, string?]; appId?: number; stepData?: Record<string, string>; stepTarget?: Record<string, string>; pausedBy?: Record<string, boolean>; relTarget?: string; relData?: string; relDelay?: bigint; relGap?: number; relExtraCall?: boolean; sharedId?: boolean; paused?: boolean; nonce?: number; failed?: string; delay?: bigint; gap?: number; listed?: string[]; chainId?: number }
function stub(ev: any, o: Opts = {}): ChainReader {
  const receipts = new Map<string, any>(); const blocks = new Map<bigint, number>(); let bn = 1n;
  const add = (hash: string, logs: any[], ts: number) => { receipts.set(hash, { status: o.failed === hash ? "reverted" : "success", blockNumber: bn, logs }); blocks.set(bn++, ts); };
  for (const s of ev.stages) for (const x of s.tx_hashes) add(x, [], 1);
  add(ev.safe.creation_tx, [], 1);
  ev.govern.forEach((g: any, i: number) => {
    const id = o.sharedId && i === 1 ? 1 : i + 1;
    const t0 = g.schedule_block_timestamp ?? T0 + i;
    const label = g.round > 1 ? `${g.step}#${g.round}` : g.step;
    const target = o.stepTarget?.[label] ?? ev.vaults[VAULT[g.step] ?? "rmPROTO"].address;
    const data = o.stepData?.[label] ?? unpauseCalldata();
    add(g.schedule_tx, [log("CallScheduled", id, o.delay, target, data)], t0);
    add(g.execute_tx, [log("CallExecuted", id, 0n, target, data)], t0 + (o.gap ?? 172800));
  });
  (ev.receipt_releases ?? []).forEach((r: any, i: number) => {
    const id = 50 + i;
    const t0 = T0 + 10 + i;
    const sched = [log("CallScheduled", id, o.relDelay, o.relTarget ?? RCPT, o.relData ?? releaseCalldata(r.receipt_id))];
    if (o.relExtraCall) sched.push(log("CallScheduled", id, o.relDelay, o.relTarget ?? RCPT, o.relData ?? releaseCalldata(r.receipt_id)));
    add(r.schedule_tx, sched, t0);
    add(r.execute_tx, [log("CallExecuted", id, 0n, o.relTarget ?? RCPT, o.relData ?? releaseCalldata(r.receipt_id))], t0 + (o.relGap ?? 172800));
  });
  (ev.receipt_applications ?? []).forEach((r: any, i: number) => {
    const id = o.appId ?? 70 + i;
    const t0 = T0 + 20 + i;
    const [relData, wData] = applyCalldata(r.receipt_id, r.vaults, r.bps);
    const calls = [{ target: o.appTarget?.[0] ?? RCPT, data: o.appData?.[0] ?? relData }, { target: o.appTarget?.[1] ?? GOV, data: o.appData?.[1] ?? wData }].slice(0, o.appCalls ?? 2);
    add(r.schedule_tx, calls.map((c, k) => log("CallScheduled", id, o.appDelay, c.target, c.data, BigInt(k))), t0);
    add(r.execute_tx, calls.map((c, k) => log("CallExecuted", id, 0n, c.target, c.data, BigInt(k))), t0 + (o.appGap ?? 172800));
  });
  return {
    getChainId: async () => o.chainId ?? 8453,
    getTransactionCount: async () => o.nonce ?? 3,
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error("not found"); return r; },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks.get(blockNumber)!) }),
    readContract: async ({ address, functionName }) => (functionName === "depositsPaused" ? (o.pausedBy?.[address] ?? o.paused ?? false) : (o.listed ?? Object.values(ev.vaults).map((v: any) => v.address))),
  };
}
const VAULT: Record<string, string> = { "unpause-USDC": "rmUSDC", "unpause-PROTO": "rmPROTO", "unpause-AGENT": "rmAGENT", "unpause-RWA": "rmRWA" };
const RCPT = a(30);
const GOV = a(32);
const RID = h(0xabc);
const withRelease = (e: any) => {
  e.consensus_receipt = { address: RCPT };
  e.receipt_releases = [{ receipt_id: RID, target: RCPT, operation_id: h(950), schedule_tx: h(600), schedule_status: 1, schedule_block_timestamp: T0 + 10, execute_tx: h(601), execute_status: 1, execute_block_timestamp: T0 + 10 + 172800 }];
};
const online = (o: Opts = {}, mutate: (e: any) => void = () => {}) => { const e = good(); const chain = stub(e, o); mutate(e); return checkEvidenceOnChain(e, chain, { safe: 2 }); };

describe("evidence check reading the chain (stub RPC)", () => {
  test("a consistent chain passes", async () => expect(await online()).toEqual([]));
  test("a deployer nonce off the frozen sum is rejected", async () => expect((await online({ nonce: 4 })).join()).toContain("deployer nonce on chain"));
  test("a registry vault set that differs from the manifests is rejected", async () => expect((await online({ listed: [a(5), a(6), a(7)] })).join()).toContain("listVaults"));
  test("a reverted stage receipt is rejected even if the JSON says 1", async () => expect((await online({ failed: h(1) })).join()).toContain("reverted"));
  test("a reverted govern execute is rejected", async () => expect((await online({ failed: h(104) })).join()).toContain("reverted"));
  test("an on-chain gap under 172800 s is rejected even if the JSON says otherwise", async () => expect((await online({ gap: 172799 })).join()).toContain("on-chain schedule-to-execute gap"));
  test("a CallScheduled delay under 172800 s is rejected", async () => expect((await online({ delay: 60n })).join()).toContain("CallScheduled delay"));
  test("a tx hash the chain does not know is rejected", async () => expect((await online({}, (e) => { e.stages[0].tx_hashes[0] = h(999); })).join()).toContain("not readable"));
  test("two steps on one timelock operation id are rejected on chain", async () => expect((await online({ sharedId: true })).join()).toContain("also the operation of step"));
  test("a non-unpause operation on chain is rejected, even with a clean receipt", async () => {
    const e = good();
    e.govern.push({ ...e.govern[0], step: "update-delay", schedule_tx: h(500), execute_tx: h(501) });
    expect((await checkEvidenceOnChain(e, stub(e), { safe: 2 })).join()).toContain("not a vault unpause");
  });
  test("another chain id is rejected", async () => expect((await online({ chainId: 918453 })).join()).toContain("RPC reports chain"));
});

describe("a post-launch consensus receipt release on 8453 (issue 1611)", () => {
  const rel = (f: (e: any) => void = () => {}) => { const e = good(); withRelease(e); f(e); return e; };
  const offline = (f: (e: any) => void = () => {}) => checkEvidence(rel(f)).join("\n");
  const chain = (o: Opts = {}, f: (e: any) => void = () => {}) => { const e = rel(); const c = stub(e, o); f(e); return checkEvidenceOnChain(e, c, { safe: 2 }).then((p) => p.join("\n")); };

  test("a correct release passes offline and on chain", async () => {
    expect(offline()).toBe("");
    expect(await chain()).toBe("");
  });
  test("a release in the govern list is still refused: only receipt_releases may carry it", () => {
    expect(mut((e) => { e.govern.push({ ...e.govern[0], step: "release-receipt", schedule_tx: h(700), execute_tx: h(701), operation_id: h(702) }); })).toContain("is not a vault unpause");
  });
  test("the receipt contract address is required when a release is recorded", () => expect(offline((e) => { delete e.consensus_receipt; })).toContain("consensus_receipt.address is missing"));
  test("a recorded target that is not the receipt contract is rejected", () => expect(offline((e) => { e.receipt_releases[0].target = a(31); })).toContain("is not the receipt contract"));
  test("a malformed receipt id and a repeated receipt id are rejected", () => {
    expect(offline((e) => { e.receipt_releases[0].receipt_id = "0x12"; })).toContain("receipt_id is not a bytes32");
    expect(offline((e) => { e.receipt_releases.push({ ...e.receipt_releases[0], schedule_tx: h(610), execute_tx: h(611), operation_id: h(951) }); })).toContain("more than one evidence entry");
  });
  test("a recorded gap under 172800 s is rejected", () => expect(offline((e) => { e.receipt_releases[0].execute_block_timestamp = T0 + 10 + 172799; })).toContain("gap"));
  test("a release sharing a transaction or an operation id with an unpause is rejected", () => {
    expect(offline((e) => { e.receipt_releases[0].schedule_tx = e.govern[0].schedule_tx; })).toContain("none shared");
    expect(offline((e) => { e.receipt_releases[0].operation_id = e.govern[0].operation_id; })).toContain("operation_id is also");
  });
  test("a wrong target on chain is rejected", async () => expect(await chain({ relTarget: a(31) })).toContain("is not the receipt contract"));
  test("a wrong receipt id on chain is rejected", async () => expect(await chain({}, (e) => { e.receipt_releases[0].receipt_id = h(0xdef); })).toContain("calldata is not releaseReceipt"));
  test("a delay under 172800 s on chain is rejected: the event delay and the block gap", async () => {
    expect(await chain({ relDelay: 60n })).toContain("CallScheduled delay");
    expect(await chain({ relGap: 172799 })).toContain("on-chain schedule-to-execute gap");
  });
  test("a schedule with more than one call is rejected", async () => expect(await chain({ relExtraCall: true })).toContain("exactly one call"));
  test("any other operation on 8453 still fails", async () => {
    expect(await chain({ relData: "0x12345678" })).toContain("calldata is not releaseReceipt");
    const e = rel(); e.govern.push({ ...e.govern[0], step: "update-delay", schedule_tx: h(500), execute_tx: h(501) });
    expect((await checkEvidenceOnChain(e, stub(e), { safe: 2 })).join()).toContain("not a vault unpause");
  });
  test("the template lists the release block and an empty list passes", () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
    expect(tpl.receipt_releases).toEqual([]);
    expect(checkEvidence({ ...good(), receipt_releases: [] })).toEqual([]);
  });
});

describe("receipt_applications: one timelock batch, release then weights (issue 1696)", () => {
  const VAULTS = [a(5), a(6), a(8)];
  const BPS = [5000, 3000, 2000];
  const withApply = (e: any) => {
    e.consensus_receipt = { address: RCPT }; e.governance = { address: GOV };
    e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, target: RCPT, governance: GOV, vaults: VAULTS, bps: BPS, operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: T0 + 20, execute_tx: h(621), execute_status: 1, execute_block_timestamp: T0 + 20 + 172800 }];
  };
  const app = (f: (e: any) => void = () => {}) => { const e = good(); withApply(e); f(e); return e; };
  const offline = (f: (e: any) => void = () => {}) => checkEvidence(app(f)).join("\n");
  const chain = (o: Opts = {}, f: (e: any) => void = () => {}) => { const e = app(); const c = stub(e, o); f(e); return checkEvidenceOnChain(e, c, { safe: 2 }).then((p) => p.join("\n")); };

  test("receipt_applications accepts a complete entry and rejects a missing tx hash, a failed receipt, a gap under the chain delay floor and two entries sharing an operation id", async () => {
    expect(offline()).toBe("");
    expect(await chain()).toBe("");
    expect(checkReceiptApplications(app())).toEqual([]);
    expect(offline((e) => { delete e.receipt_applications[0].schedule_tx; })).toContain("schedule_tx is missing");
    expect(offline((e) => { e.receipt_applications[0].execute_tx = ""; })).toContain("execute_tx is missing");
    expect(offline((e) => { e.receipt_applications[0].schedule_status = 0; })).toContain("schedule receipt status is 0");
    expect(offline((e) => { e.receipt_applications[0].execute_status = 0; })).toContain("execute receipt status is 0");
    expect(offline((e) => { e.receipt_applications[0].execute_block_timestamp = T0 + 20 + 172799; })).toContain("gap");
    expect(offline((e) => { e.receipt_applications.push({ ...e.receipt_applications[0], receipt_id: h(0xabd), schedule_tx: h(630), execute_tx: h(631) }); })).toContain("operation_id is also");
    // the standalone check (the Twin run manifest) says the same
    const tw = app((e) => { e.receipt_applications[0].schedule_tx = "0x12"; });
    expect(checkReceiptApplications(tw).join("\n")).toContain("schedule_tx is missing");
  });
  test("receipt_applications: receipt id, targets and the vector are checked, and one receipt is released once", () => {
    expect(offline((e) => { e.receipt_applications[0].receipt_id = "0x12"; })).toContain("receipt_id is not a bytes32");
    expect(offline((e) => { e.receipt_applications.push({ ...e.receipt_applications[0], schedule_tx: h(640), execute_tx: h(641), operation_id: h(971) }); })).toContain("more than one evidence entry");
    expect(offline((e) => { e.receipt_applications[0].target = a(31); })).toContain("is not the receipt contract");
    expect(offline((e) => { e.receipt_applications[0].governance = a(33); })).toContain("is not the governance contract");
    expect(offline((e) => { delete e.consensus_receipt; })).toContain("consensus_receipt.address is missing");
    expect(offline((e) => { delete e.governance; })).toContain("governance.address is missing");
    expect(offline((e) => { e.receipt_applications[0].bps = [5000, 3000, 1999]; })).toContain("bps do not sum to 10000");
    expect(offline((e) => { e.receipt_applications[0].bps = [5000, 5000]; })).toContain("distinct addresses with one weight each");
    expect(offline((e) => { e.receipt_applications[0].vaults = [a(5), a(5), a(8)]; })).toContain("distinct addresses");
    expect(offline((e) => { e.receipt_applications[0].step = "release-receipt"; })).toContain("is not apply-receipt");
    expect(offline((e) => { e.receipt_applications = {}; })).toContain("receipt_applications is not a list");
    expect(offline((e) => { e.receipt_releases = [{ receipt_id: RID, target: RCPT, operation_id: h(950), schedule_tx: h(600), schedule_status: 1, schedule_block_timestamp: T0 + 10, execute_tx: h(601), execute_status: 1, execute_block_timestamp: T0 + 10 + 172800 }]; })).toContain("a receipt is released once");
  });
  test("receipt_applications on chain: one batch of exactly the release then the weight change, one delay apart", async () => {
    expect(await chain({ appCalls: 1 })).toContain("exactly 2 calls");
    expect(await chain({ appTarget: [a(31), undefined] })).toContain("call 0 target");
    expect(await chain({ appTarget: [undefined, a(33)] })).toContain("call 1 target");
    expect(await chain({ appData: ["0x12345678", undefined] })).toContain("calldata is not releaseReceipt");
    expect(await chain({ appData: [undefined, "0x12345678"] })).toContain("calldata is not setDefaultWeights");
    expect(await chain({}, (e) => { e.receipt_applications[0].bps = [6000, 2000, 2000]; })).toContain("calldata is not setDefaultWeights");
    expect(await chain({}, (e) => { e.receipt_applications[0].receipt_id = h(0xdef); })).toContain("calldata is not releaseReceipt");
    expect(await chain({ appDelay: 60n })).toContain("CallScheduled delay");
    expect(await chain({ appGap: 172799 })).toContain("on-chain schedule-to-execute gap");
    expect(await chain({ failed: h(620) })).toContain("reverted");
    expect(await chain({ failed: h(621) })).toContain("reverted");
    expect(await chain({}, (e) => { e.receipt_applications[0].operation_id = h(5); })).toContain("is not the scheduled operation");
    expect(await chain({}, (e) => { e.receipt_applications[0].schedule_tx = h(998); })).toContain("not readable");
    // the standalone chain check (the Twin run) is the same function and does not read the chain id
    const e = app();
    expect(await checkReceiptApplicationsOnChain(e, stub(e, { chainId: 918453 }))).toEqual([]);
    expect((await checkReceiptApplicationsOnChain(e, stub(e, { appCalls: 1 }))).join()).toContain("exactly 2 calls");
    // a shorter floor (a Twin timelock) accepts a shorter delay and gap, and still rejects one under it
    expect(await checkReceiptApplicationsOnChain(e, stub(e, { appDelay: 3600n, appGap: 3601 }), 3600)).toEqual([]);
    expect((await checkReceiptApplicationsOnChain(e, stub(e, { appDelay: 3599n, appGap: 3599 }), 3600)).join("\n")).toContain("under 3600 s");
  });
  test("receipt_applications: the template lists the block and an empty list passes", () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
    expect(tpl.receipt_applications).toEqual([]);
    expect(tpl.governance.address).toBeDefined();
    expect(checkEvidence({ ...good(), receipt_applications: [] })).toEqual([]);
  });
});

describe("evidence-check --receipt-applications: the Twin run manifest (issue 1696)", () => {
  const run = (manifest: object, extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "pc-apply-ev-"));
    const file = join(dir, "publish-run.json");
    writeFileSync(file, JSON.stringify(manifest));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "evidence-check.ts"), "--receipt-applications", file, "--consensus-receipt", a(30), "--governance", a(32), "--timelock", a(9), ...extra]);
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const entry = { step: "apply-receipt", receipt_id: h(0xabc), target: a(30), governance: a(32), vaults: [a(5), a(6)], bps: [6000, 4000], operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: 1000, execute_tx: h(621), execute_status: 1, execute_block_timestamp: 1000 + 172800 };
  test("a complete entry passes, a missing entry or a broken one exits 1 naming the problem", () => {
    const ok = run({ receipt_applications: [entry] });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("1 receipt application(s)");
    const none = run({});
    expect(none.code).toBe(1);
    expect(none.err).toContain("no receipt_applications entry");
    const gap = run({ receipt_applications: [{ ...entry, execute_block_timestamp: 1000 + 172799 }] });
    expect(gap.code).toBe(1);
    expect(gap.err).toContain("gap");
    // a Twin run passes its own (shorter) timelock delay as the floor; the gap must still reach it
    expect(run({ receipt_applications: [{ ...entry, execute_block_timestamp: 1000 + 3601 }] }, ["--delay-floor", "3600"]).code).toBe(0);
    expect(run({ receipt_applications: [{ ...entry, execute_block_timestamp: 1000 + 3599 }] }, ["--delay-floor", "3600"]).code).toBe(1);
    expect(run({ receipt_applications: [entry] }, ["--delay-floor", "0"]).code).toBe(2);
    const nohash = run({ receipt_applications: [{ ...entry, execute_tx: "" }] });
    expect(nohash.code).toBe(1);
    expect(nohash.err).toContain("execute_tx is missing");
  });
});

describe("owner exceptions before plan approval", () => {
  test("an empty list passes", () => expect(() => assertOwnerExceptions([], "2026-10-05T10:00:00Z")).not.toThrow());
  test("a placeholder is refused", () => expect(() => assertOwnerExceptions([{ text: "<x>", recorded_at: "2026-10-01T00:00:00Z" }], "2026-10-05T10:00:00Z")).toThrow());
  test("no approval time is refused", () => expect(() => assertOwnerExceptions([], undefined)).toThrow());
});

describe("unpause govern rows and paused=false reads tell one story", () => {
  test("every unpause row executed and every vault reads paused=false: passes", async () => expect(await online({ paused: false })).toEqual([]));
  test("an unpause row that executed while the vault still reads paused=true is rejected, naming the row", async () => {
    const p = await online({ paused: true });
    expect(p.join("\n")).toContain("govern unpause-PROTO executed with receipt status 1, but rmPROTO.depositsPaused() reads true");
    expect(p.filter((m) => m.includes("depositsPaused()")).length).toBe(4); // rmUSDC and the three baskets, all four tied to their unpause row
    expect(p.join("\n")).toContain("govern unpause-USDC executed with receipt status 1, but rmUSDC.depositsPaused() reads true");
  });
  test("a vault that reads paused=false with no executed unpause row is rejected", async () => {
    const p = await online({ paused: false }, (e) => { const g = e.govern.find((x: any) => x.step === "unpause-RWA"); g.execute_status = 0; });
    expect(p.join("\n")).toContain("rmRWA.depositsPaused() reads false on chain, but govern unpause-RWA has no executed receipt");
  });
  test("rmUSDC deploys paused (core 1710): it reads false only with an executed unpause-USDC row", async () => {
    expect((await online({ paused: false })).join()).not.toContain("rmUSDC");
    const p = await online({ paused: false }, (e) => { e.govern.find((x: any) => x.step === "unpause-USDC").execute_status = 0; });
    expect(p.join("\n")).toContain("rmUSDC.depositsPaused() reads false on chain, but govern unpause-USDC has no executed receipt");
  });
  test("a missing unpause-USDC row is rejected: rmUSDC is no longer optional", () => expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== "unpause-USDC"); })).toContain("'unpause-USDC' of Stage 13 has no evidence entry"));
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
    fixture.nonces[e.deployer.toLowerCase()] = 4;
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

describe("the evidence template", () => {
  const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
  test("it lists one govern entry per basket unpause, in the CLI's row order", () => {
    expect(tpl.govern.map((g: any) => g.step)).toEqual([...GOVERN_STEPS]);
    expect([...GOVERN_STEPS]).toEqual([...UNPAUSE_ROWS]);
  });
  test("each step has its own schedule and execute fields, and the template is not mistaken for evidence", () => {
    for (const g of tpl.govern) {
      expect(g.schedule_tx).toBeDefined();
      expect(g.execute_tx).toBeDefined();
    }
    expect(checkEvidence(tpl).length).toBeGreaterThan(0);
  });
});

// ---- issue 1667: the four-vault unpause rounds ----
describe("issue 1667: rmUSDC and re-paused vaults come back through numbered Safe unpause rounds", () => {
  const usdc = (n = 5, round = 2) => ({ step: "unpause-USDC", round, operation_id: h(800 + n), schedule_tx: h(300 + n * 2), schedule_block_timestamp: T0 + 400000 + n * 400000, execute_tx: h(301 + n * 2), execute_block_timestamp: T0 + 400000 + n * 400000 + 172800, schedule_status: 1, execute_status: 1 });
  /** a second PROTO round: scheduled after round 1 executed */
  const proto2 = () => ({ ...usdc(6, 2), step: "unpause-PROTO" });
  const withUsdc = (e: any) => { e.govern.push(usdc()); };
  const offline = (f: (e: any) => void) => { const e = good(); f(e); return checkEvidence(e).join("\n"); };
  const chain = (o: Opts, f: (e: any) => void) => { const e = good(); f(e); return checkEvidenceOnChain(e, stub(e, o), { safe: 2 }).then((p) => p.join("\n")); };

  test("a second unpause-USDC round (after a pause-all) is accepted offline and on chain", async () => {
    expect(offline(withUsdc)).toBe("");
    expect(await chain({}, withUsdc)).toBe("");
  });
  test("the template step list has all four vault steps: rmUSDC is required", () => expect(GOVERN_STEPS).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA"]));
  test("any other call on rmUSDC is rejected: another function (setPerDepositCap), garbage calldata, another target", async () => {
    const calls = ["0x12345678", encodeFunctionDataSetCap()];
    for (const data of calls) expect(await chain({ stepData: { "unpause-USDC": data } }, withUsdc)).toContain("unpauseDeposits(): the only call");
    expect(await chain({ stepTarget: { "unpause-USDC": a(6) } }, withUsdc)).toContain("is not rmUSDC");
  });
  test("a basket step is held to the same rule: one unpauseDeposits on its own vault", async () => {
    expect(await chain({ stepData: { "unpause-PROTO": "0x12345678" } }, () => {})).toContain("unpauseDeposits()");
    expect(await chain({ stepTarget: { "unpause-RWA": a(5) } }, () => {})).toContain("is not rmRWA");
  });
  test("a step that is not an unpause is still rejected, rmUSDC included", () => {
    expect(offline((e) => { e.govern.push({ ...usdc(), step: "set-cap-USDC" }); })).toContain("is not a vault unpause");
  });
  test("rmUSDC that reads paused is rejected when its latest round executed", async () => {
    const p = await chain({ pausedBy: { [a(5)]: true } }, withUsdc);
    expect(p).toContain("govern unpause-USDC executed with receipt status 1, but rmUSDC.depositsPaused() reads true");
  });
  test("a second round of a basket is accepted when it is scheduled after round 1 executed and has its own transactions and operation id", async () => {
    const add = (e: any) => { e.govern.push(proto2()); };
    expect(offline(add)).toBe("");
    expect(await chain({}, add)).toBe("");
  });
  test("rounds: a repeated round, a gap in the numbers, a round scheduled before the one it follows executed, and a bad round number are rejected", () => {
    expect(offline((e) => { e.govern.push({ ...proto2(), round: 1 }); })).toContain("more than one evidence entry");
    expect(offline((e) => { e.govern.push({ ...proto2(), round: 3 }); })).toContain("rounds must be 1 to 2 in order");
    expect(offline((e) => { e.govern.push({ ...proto2(), schedule_block_timestamp: T0 + 100 }); })).toContain("not after round 1 executed");
    expect(offline((e) => { e.govern.push({ ...proto2(), round: 0 }); })).toContain("round 0 is not a positive integer");
  });
  test("a second round that reuses the first round's operation id or transactions is rejected (a replay, not a new round)", () => {
    expect(offline((e) => { e.govern.push({ ...proto2(), operation_id: e.govern[0].operation_id }); })).toContain("operation_id is also");
    expect(offline((e) => { e.govern.push({ ...proto2(), schedule_tx: e.govern[0].schedule_tx }); })).toContain("none shared");
  });
  test("a second round whose on-chain gap is under 172800 s is rejected", async () => {
    const add = (e: any) => { e.govern.push(proto2()); };
    expect(await chain({ gap: 172799 }, add)).toContain("on-chain schedule-to-execute gap");
  });
  test("the latest round decides the paused link: round 2 executed and the vault reads unpaused passes, reads paused fails", async () => {
    const add = (e: any) => { e.govern.push(proto2()); };
    expect(await chain({ pausedBy: { [a(6)]: true } }, add)).toContain("rmPROTO.depositsPaused() reads true");
  });
});
function encodeFunctionDataSetCap(): string { return encodeFunctionData({ abi: parseAbi(["function setPerDepositCap(uint256 newCap)"]), functionName: "setPerDepositCap", args: [1n] }); }

// ---- an adopted libs stage (issue 1721): the library already sat on chain, the deployer sent nothing for it ----
const LIBCODE = "0x73" + "11".repeat(20) + "3014608060405260" as Hex;
const FROZEN_WITH_LIBS = { safe: 2, libs: 4 };
const adoptedEv = (txs = 0) => {
  const e: any = good();
  e.stages.push({ stage: "libs", frozen_count: 4, receipt_count: txs, tx_hashes: Array.from({ length: txs }, (_, i) => h(40 + i)), receipts_status: Array.from({ length: txs }, () => 1),
    adopted: { deployer_txs: txs, libraries: [{ name: "tick_math", address: a(77), code_hash: keccak256(LIBCODE) }] } });
  e.deployer_nonce_final = 2 + txs + 1;
  return e;
};
const codeChain = (e: any, code: Hex | undefined = LIBCODE, nonce = 3): ChainReader => ({ ...stub(e, { nonce }), getCode: async () => code });
describe("evidence check: an adopted libs stage (issue 1721)", () => {
  test("offline: an adopted libs stage with zero receipts passes, the frozen count of 4 is not demanded of it", () => {
    expect(checkEvidence(adoptedEv(), FROZEN_WITH_LIBS)).toEqual([]);
  });
  test("offline: the nonce is the frozen sum minus the libs count (the adopted stage contributes what the deployer sent) plus the prove-control transaction", () => {
    const e = adoptedEv(); e.deployer_nonce_final = 2 + 4 + 1; // the un-adjusted sum
    expect(checkEvidence(e, FROZEN_WITH_LIBS).join()).toContain("deployer_nonce_final");
    const e2 = adoptedEv(); e2.deployer_nonce_final = 2 + 0 + 1 + 1; // a stray extra deployer transaction
    expect(checkEvidence(e2, FROZEN_WITH_LIBS).join()).toContain("deployer_nonce_final");
  });
  test("offline: a resume that had already landed the deployer's own libs transaction is adopted with deployer_txs 4 and the normal sum", () => {
    expect(checkEvidence(adoptedEv(4), FROZEN_WITH_LIBS)).toEqual([]);
  });
  test("offline: deployer_txs above the frozen count, a receipt_count that disagrees with it, and a stage other than libs are refused", () => {
    const over = adoptedEv(5); over.stages[1].frozen_count = 4;
    expect(checkEvidence(over, FROZEN_WITH_LIBS).join()).toContain("above the frozen count");
    const split = adoptedEv(); split.stages[1].receipt_count = 1; split.stages[1].tx_hashes = [h(40)]; split.stages[1].receipts_status = [1];
    expect(checkEvidence(split, FROZEN_WITH_LIBS).join()).toContain("differs from adopted.deployer_txs");
    // a non-libs stage adopts at most one creation per adopted library: 0 sent of 6 with one adopted library is refused, 5 and 6 are fine
    const wrong = adoptedEv(); wrong.stages[1].stage = "recorder"; wrong.stages[1].frozen_count = 6;
    expect(checkEvidence(wrong, { ...FROZEN_WITH_LIBS, recorder: 6 }).join()).toContain("is below the frozen count 6 less its 1 adopted library");
  });
  test("offline: a basket stage that adopted three libraries sends the frozen count less three (or more), never fewer", () => {
    const mk = (txs: number) => {
      const e: any = good();
      e.stages.push({ stage: "proto", frozen_count: 10, receipt_count: txs, tx_hashes: Array.from({ length: txs }, (_, i) => h(60 + i)), receipts_status: Array.from({ length: txs }, () => 1),
        adopted: { deployer_txs: txs, libraries: ["BasketAssetConfigGuard", "TwapTickMath", "BasketViews"].map((name, i) => ({ name, address: a(80 + i), code_hash: keccak256(LIBCODE) })) } });
      e.deployer_nonce_final = 2 + txs + 1;
      return e;
    };
    const f = { safe: 2, proto: 10 };
    expect(checkEvidence(mk(7), f)).toEqual([]);
    expect(checkEvidence(mk(10), f)).toEqual([]);
    expect(checkEvidence(mk(6), f).join()).toContain("is below the frozen count 10 less its 3 adopted libraries");
    expect(checkEvidence(mk(11), f).join()).toContain("above the frozen count");
  });
  test("offline: an adopted entry without a library, an address or a code hash is refused", () => {
    const none = adoptedEv(); none.stages[1].adopted.libraries = [];
    expect(checkEvidence(none, FROZEN_WITH_LIBS).join()).toContain("names no library");
    const noHash = adoptedEv(); delete noHash.stages[1].adopted.libraries[0].code_hash;
    expect(checkEvidence(noHash, FROZEN_WITH_LIBS).join()).toContain("no code_hash");
    const noAddr = adoptedEv(); noAddr.stages[1].adopted.libraries[0].address = "0x1";
    expect(checkEvidence(noAddr, FROZEN_WITH_LIBS).join()).toContain("no address");
  });
  test("offline: a non-adopted stage is still held to frozen_count == receipt_count == the frozen file", () => {
    const e = good(); e.stages[0].receipt_count = 3;
    expect(checkEvidence(e, { safe: 2 }).join()).toContain("receipt_count");
  });
  test("on chain: the code at the adopted address must hash to the recorded code_hash; a matching hash passes", async () => {
    const e = adoptedEv();
    expect(await checkEvidenceOnChain(e, codeChain(e), FROZEN_WITH_LIBS)).toEqual([]);
  });
  test("on chain: a forged adopted flag whose hash does not match the chain is refused (other code, no code, an unreadable code)", async () => {
    const e = adoptedEv();
    expect((await checkEvidenceOnChain(e, codeChain(e, "0x73" + "22".repeat(20) + "3014" as Hex), FROZEN_WITH_LIBS)).join()).toContain("code hash on chain");
    expect((await checkEvidenceOnChain(e, codeChain(e, "0x"), FROZEN_WITH_LIBS)).join()).toContain("has no code");
    const noReader = stub(e, { nonce: 3 });
    expect((await checkEvidenceOnChain(e, noReader, FROZEN_WITH_LIBS)).join()).toContain("cannot read code");
  });
  test("on chain: the on-chain deployer nonce uses the adopted count too, so a stray extra transaction is refused", async () => {
    const e = adoptedEv();
    expect(await checkEvidenceOnChain(e, codeChain(e, LIBCODE, 3), FROZEN_WITH_LIBS)).toEqual([]);
    expect((await checkEvidenceOnChain(e, codeChain(e, LIBCODE, 4), FROZEN_WITH_LIBS)).join()).toContain("deployer nonce on chain is 4");
    expect((await checkEvidenceOnChain(e, codeChain(e, LIBCODE, 7), FROZEN_WITH_LIBS)).join()).toContain("deployer nonce on chain is 7");
  });
  test("a recorded fixture keeps the adopted library's code, so the offline check reads it back", async () => {
    const e = adoptedEv();
    const { reader, fixture } = recordingChainReader(codeChain(e));
    expect(await checkEvidenceOnChain(e, reader, FROZEN_WITH_LIBS)).toEqual([]);
    expect(fixture.codes?.[a(77)]).toBe(LIBCODE);
    expect(await checkEvidenceOnChain(e, chainReaderFromFixture(JSON.parse(JSON.stringify(fixture))), FROZEN_WITH_LIBS)).toEqual([]);
  });
});
