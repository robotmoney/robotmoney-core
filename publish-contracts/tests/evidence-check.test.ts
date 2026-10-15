import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from "viem";
import { applyCalldata, chainReaderFromFixture, checkEvidence, delayFloorRefusal, checkEvidenceOnChain, checkReceiptApplications, checkReceiptApplicationsOnChain, checkVaultRedeploys, checkVaultRedeploysOnChain, GOVERN_STEPS, recordingChainReader, scanEvidenceFolder, unpauseCalldata, type ChainReader } from "../src/evidence-check.ts";
import { buildRedeployCalls } from "../src/redeploy-vault.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOwnerExceptions } from "../src/plan.ts";
import { UNPAUSE_ROWS } from "../src/govern.ts";
import { releaseCalldata, checkVotedWeightsClears, checkVotedWeightsClearsOnChain } from "../src/evidence-check.ts";
import { clearCalldata } from "../src/clear-voted-weights.ts";
import { keccak256 } from "viem";
import { ERC1967_ADMIN_SLOT, ERC1967_BEACON_SLOT, ERC1967_IMPLEMENTATION_SLOT, INITIALIZABLE_SLOT, INITIALIZERS_LOCKED } from "../src/proxies.ts";
import { loadStageTable, tableProxies } from "../src/stage-table.ts";

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
/** QA plan v1 C2: the event RouterGovernance.applyReceipt emits, the chain's own record of an application. */
const GOV_EV = parseAbi(["event ReceiptApplied(bytes32 indexed receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps)"]);
const appliedLog = (from: string, receiptId: string, digest: string, vaults: string[], bps: number[]) => ({
  address: from, topics: encodeEventTopics({ abi: GOV_EV, eventName: "ReceiptApplied", args: { receiptId: receiptId as Hex } }) as Hex[],
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "address[]" }, { type: "uint256[]" }], [digest as Hex, vaults as Hex[], bps.map(BigInt)]),
});
interface Opts { appEvent?: false | { from?: string; digest?: string; vaults?: string[]; bps?: number[] }; clearData?: string; clearTarget?: string; clearDelay?: bigint; clearGap?: number; clearCalls?: number; appDelay?: bigint; appGap?: number; appCalls?: number; appData?: string; appTarget?: string; appId?: number; stepData?: Record<string, string>; stepTarget?: Record<string, string>; pausedBy?: Record<string, boolean>; relTarget?: string; relData?: string; relDelay?: bigint; relGap?: number; relExtraCall?: boolean; sharedId?: boolean; paused?: boolean; nonce?: number; failed?: string; delay?: bigint; gap?: number; listed?: string[]; chainId?: number }
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
    // issue 1698: ONE applyReceipt call on the governance contract (appCalls above 1 plants extra copies, as a batch would)
    const id = o.appId ?? 70 + i;
    const t0 = T0 + 20 + i;
    const data = o.appData ?? applyCalldata(r.receipt_id, r.payload_digest, r.vaults, r.bps);
    const target = o.appTarget ?? GOV;
    const sched = Array.from({ length: o.appCalls ?? 1 }, (_, k) => log("CallScheduled", id, o.appDelay, target, data, BigInt(k)));
    add(r.schedule_tx, sched, t0);
    // QA plan v1 C2: the execute tx carries the governance contract's ReceiptApplied event (appEvent false drops it, an object plants another one)
    const evt = o.appEvent === false ? [] : [appliedLog(o.appEvent?.from ?? GOV, r.receipt_id, o.appEvent?.digest ?? r.payload_digest, o.appEvent?.vaults ?? r.vaults, o.appEvent?.bps ?? r.bps)];
    add(r.execute_tx, [log("CallExecuted", id, 0n, target, data), ...evt], t0 + (o.appGap ?? 172800));
  });
  (ev.voted_weights_clears ?? []).forEach((r: any, i: number) => {
    const id = 90 + i;
    const t0 = T0 + 30 + i;
    const data = o.clearData ?? clearCalldata();
    const sched = Array.from({ length: o.clearCalls ?? 1 }, (_, k) => log("CallScheduled", id, o.clearDelay, o.clearTarget ?? GOV, data, BigInt(k)));
    add(r.schedule_tx, sched, t0);
    add(r.execute_tx, [log("CallExecuted", id, 0n, o.clearTarget ?? GOV, data)], t0 + (o.clearGap ?? 172800));
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
/** The payload digest an application names (issue 1698: part of the applyReceipt calldata, so the entry carries it). */
const DIGEST = h(0xd16);
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

describe("receipt_applications: one timelock call, applyReceipt on the governance contract (issue 1696, issue 1698)", () => {
  const VAULTS = [a(5), a(6), a(8)];
  const BPS = [5000, 3000, 2000];
  const withApply = (e: any) => {
    e.consensus_receipt = { address: RCPT }; e.governance = { address: GOV };
    e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, governance: GOV, receipt: RCPT, vaults: VAULTS, bps: BPS, payload_digest: DIGEST, effective_vaults: VAULTS, effective_bps: BPS, operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: T0 + 20, execute_tx: h(621), execute_status: 1, execute_block_timestamp: T0 + 20 + 172800 }];
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
  test("receipt_applications: receipt id, the register, the governance target, the digest and the vector are checked, and one receipt is released once", () => {
    expect(offline((e) => { e.receipt_applications[0].receipt_id = "0x12"; })).toContain("receipt_id is not a bytes32");
    expect(offline((e) => { e.receipt_applications.push({ ...e.receipt_applications[0], schedule_tx: h(640), execute_tx: h(641), operation_id: h(971) }); })).toContain("more than one evidence entry");
    expect(offline((e) => { e.receipt_applications[0].receipt = a(31); })).toContain("is not the receipt contract");
    // a pre-1698 entry named the register as `target`: still read, still checked
    expect(offline((e) => { delete e.receipt_applications[0].receipt; e.receipt_applications[0].target = RCPT; })).toBe("");
    expect(offline((e) => { delete e.receipt_applications[0].receipt; e.receipt_applications[0].target = a(31); })).toContain("is not the receipt contract");
    expect(offline((e) => { e.receipt_applications[0].governance = a(33); })).toContain("is not the governance contract");
    expect(offline((e) => { delete e.consensus_receipt; })).toContain("consensus_receipt.address is missing");
    expect(offline((e) => { delete e.governance; })).toContain("governance.address is missing");
    // issue 1698: the digest the applyReceipt call named is part of the entry
    expect(offline((e) => { delete e.receipt_applications[0].payload_digest; })).toContain("payload_digest is not a bytes32");
    expect(offline((e) => { e.receipt_applications[0].payload_digest = "0x12"; })).toContain("payload_digest is not a bytes32");
    expect(offline((e) => { e.receipt_applications[0].bps = [5000, 3000, 1999]; })).toContain("bps do not sum to 10000");
    expect(offline((e) => { e.receipt_applications[0].bps = [5000, 5000]; })).toContain("distinct addresses with one weight each");
    expect(offline((e) => { e.receipt_applications[0].vaults = [a(5), a(5), a(8)]; })).toContain("distinct addresses");
    expect(offline((e) => { e.receipt_applications[0].step = "release-receipt"; })).toContain("is not apply-receipt");
    expect(offline((e) => { e.receipt_applications = {}; })).toContain("receipt_applications is not a list");
    expect(offline((e) => { e.receipt_releases = [{ receipt_id: RID, target: RCPT, operation_id: h(950), schedule_tx: h(600), schedule_status: 1, schedule_block_timestamp: T0 + 10, execute_tx: h(601), execute_status: 1, execute_block_timestamp: T0 + 10 + 172800 }]; })).toContain("a receipt is released once");
  });
  test("receipt_applications on chain: exactly one call, applyReceipt(receipt_id, payload_digest, vaults, bps) on the governance contract, one delay apart (issue 1698)", async () => {
    expect(await chain({ appCalls: 2 })).toContain("exactly one call");
    expect(await chain({ appCalls: 0 })).toContain("exactly one call");
    expect(await chain({ appTarget: a(31) })).toContain("is not the governance contract");
    expect(await chain({ appTarget: RCPT })).toContain("is not the governance contract"); // the pre-1698 release target is not the one call
    expect(await chain({ appData: "0x12345678" })).toContain("calldata is not applyReceipt");
    expect(await chain({ appData: releaseCalldata(RID) })).toContain("calldata is not applyReceipt"); // a bare release is not an application
    expect(await chain({}, (e) => { e.receipt_applications[0].bps = [6000, 2000, 2000]; })).toContain("calldata is not applyReceipt");
    expect(await chain({}, (e) => { e.receipt_applications[0].receipt_id = h(0xdef); })).toContain("calldata is not applyReceipt");
    expect(await chain({}, (e) => { e.receipt_applications[0].payload_digest = h(0xd17); })).toContain("calldata is not applyReceipt");
    expect(await chain({ appDelay: 60n })).toContain("CallScheduled delay");
    expect(await chain({ appGap: 172799 })).toContain("on-chain schedule-to-execute gap");
    expect(await chain({ failed: h(620) })).toContain("reverted");
    expect(await chain({ failed: h(621) })).toContain("reverted");
    expect(await chain({}, (e) => { e.receipt_applications[0].operation_id = h(5); })).toContain("is not the scheduled operation");
    expect(await chain({}, (e) => { e.receipt_applications[0].schedule_tx = h(998); })).toContain("not readable");
    // the standalone chain check (the Twin run) is the same function and does not read the chain id
    const e = app();
    expect(await checkReceiptApplicationsOnChain(e, stub(e, { chainId: 918453 }))).toEqual([]);
    expect((await checkReceiptApplicationsOnChain(e, stub(e, { appCalls: 2 }))).join()).toContain("exactly one call");
    // a shorter floor (a Twin timelock) accepts a shorter delay and gap, and still rejects one under it
    expect(await checkReceiptApplicationsOnChain(e, stub(e, { appDelay: 3600n, appGap: 3601 }), 3600)).toEqual([]);
    expect((await checkReceiptApplicationsOnChain(e, stub(e, { appDelay: 3599n, appGap: 3599 }), 3600)).join("\n")).toContain("under 3600 s");
  });
  test("forged receipt_applications entry refused: the entry must be the receipt, digest and vector of the chain's ReceiptApplied event (QA plan v1 C2, issue 1701)", async () => {
    // the entry is edited after the run to the vector the router drifted to: the chain applied another one
    expect(await chain({}, (e) => { e.receipt_applications[0].bps = [6000, 2000, 2000]; e.receipt_applications[0].effective_bps = [6000, 2000, 2000]; })).toContain("is not the vector the chain applied");
    // every recorded field and the timelock call agree, and still the chain's event names another vector or digest
    expect(await chain({ appEvent: { bps: [6000, 2000, 2000] } })).toContain("is not the vector the chain applied");
    expect(await chain({ appEvent: { digest: h(0xd17) } })).toContain("ReceiptApplied names payload digest");
    // no ReceiptApplied event, or one from another contract than the governance contract: nothing was applied
    expect(await chain({ appEvent: false })).toContain("0 ReceiptApplied events");
    expect(await chain({ appEvent: { from: a(31) } })).toContain("0 ReceiptApplied events");
    // the standalone check of a Twin run manifest is the same function
    const e = app();
    expect((await checkReceiptApplicationsOnChain(e, stub(e, { appEvent: { bps: [6000, 2000, 2000] } }))).join("\n")).toContain("is not the vector the chain applied");
    expect(await checkReceiptApplicationsOnChain(e, stub(e))).toEqual([]);
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
  const entry = { step: "apply-receipt", receipt_id: h(0xabc), governance: a(32), receipt: a(30), vaults: [a(5), a(6)], bps: [6000, 4000], payload_digest: DIGEST, effective_vaults: [a(5), a(6)], effective_bps: [6000, 4000], operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: 1000, execute_tx: h(621), execute_status: 1, execute_block_timestamp: 1000 + 172800 };
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

describe("issue 1701: --delay-floor against chain 8453", () => {
  test("a floor below the 8453 floor of the deployment kind is refused when the --rpc reads chain 8453; a Twin run keeps its own shorter floor", () => {
    expect(delayFloorRefusal(3600, 8453, "production")).toContain("below 172800 s");
    expect(delayFloorRefusal(172799, 8453, "production")).toContain("below 172800 s");
    expect(delayFloorRefusal(172800, 8453, "production")).toBeUndefined();
    expect(delayFloorRefusal(899, 8453, "rehearsal")).toContain("below 900 s");
    expect(delayFloorRefusal(900, 8453, "rehearsal")).toBeUndefined();
    expect(delayFloorRefusal(3600, 918453, "production")).toBeUndefined();
    expect(delayFloorRefusal(1, 918453, "rehearsal")).toBeUndefined();
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

// ---- issue 1809 (ADR-0014): the governed proxies of the stage table, as a deployment's evidence records them and the chain answers ----
const PROXY_IMPL_CODE = "0x6080604052" as Hex;
const word32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;
/** Every proxy name of the stage table (ADR-0014 §1) with its proxy and implementation: the four vaults are good()'s vault addresses, the registry good()'s registry. */
const TABLE_PROXIES: Record<string, { proxy: string; implementation: string }> = {
  rmUSDC: { proxy: a(5), implementation: a(0x2005) }, rmPROTO: { proxy: a(6), implementation: a(0x2006) }, rmAGENT: { proxy: a(7), implementation: a(0x2007) },
  rmRWA: { proxy: a(8), implementation: a(0x2008) }, registry: { proxy: a(21), implementation: a(0x2021) }, router: { proxy: a(0x1003), implementation: a(0x2103) },
  gateway: { proxy: a(0x1004), implementation: a(0x2104) }, icpolicy: { proxy: a(0x1006), implementation: a(0x2106) }, receipt: { proxy: a(0x1007), implementation: a(0x2107) },
};
/** `e` with `upgrade_mode` and a `proxies` entry per name, each what tableProxyChain answers. */
function withTableProxies(e: any, names: readonly string[] = Object.keys(TABLE_PROXIES)): any {
  e.upgrade_mode = "upgradeable";
  e.proxies = Object.fromEntries(names.map((n) => [n, {
    proxy: TABLE_PROXIES[n]!.proxy, implementation: TABLE_PROXIES[n]!.implementation, implementation_code_hash: keccak256(PROXY_IMPL_CODE), authority: e.timelock.address,
    mode: "upgradeable", frozen: false, admin_slot_empty: true, beacon_slot_empty: true,
  }]));
  return e;
}
interface Live { implementation?: string; adminSlot?: Hex; beaconSlot?: Hex; code?: Hex; authority?: string; frozen?: boolean; uninitialized?: boolean; unlocked?: boolean }
/** The stub chain of `e` plus every table proxy: `o` breaks one property of every proxy. */
function tableProxyChain(e: any, o: Live = {}): ChainReader {
  const base = stub(e);
  const impls = new Set([...Object.values(TABLE_PROXIES).map((x) => x.implementation.toLowerCase()), ...(o.implementation ? [o.implementation.toLowerCase()] : [])]);
  const isImpl = (x: string) => impls.has(x.toLowerCase());
  const implOf = (x: string) => o.implementation ?? Object.values(TABLE_PROXIES).find((y) => y.proxy.toLowerCase() === x.toLowerCase())?.implementation ?? a(0);
  return {
    ...base,
    getCode: async ({ address }) => (isImpl(address) ? (o.code ?? PROXY_IMPL_CODE) : ("0x6001" as Hex)),
    getStorageAt: async ({ address, slot }) => {
      if (slot === ERC1967_IMPLEMENTATION_SLOT) return isImpl(address) ? word32(0n) : word32(BigInt(implOf(address)));
      if (slot === ERC1967_ADMIN_SLOT) return isImpl(address) ? word32(0n) : (o.adminSlot ?? word32(0n));
      if (slot === ERC1967_BEACON_SLOT) return isImpl(address) ? word32(0n) : (o.beaconSlot ?? word32(0n));
      if (slot === INITIALIZABLE_SLOT) return isImpl(address) ? word32(o.unlocked ? 0n : INITIALIZERS_LOCKED) : word32(o.uninitialized ? 0n : 1n);
      return word32(0n);
    },
    readContract: async (x) => {
      if (x.functionName === "upgradeAuthority") return o.authority ?? e.timelock.address;
      if (x.functionName === "upgradesFrozen") return o.frozen ?? false;
      return base.readContract(x);
    },
  };
}

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
    // the CLI checks the stage table's proxies (issue 1809): offline from the record, and on the fixture from the chain reads (QA plan v1 L1)
    expect(Object.keys(TABLE_PROXIES).sort()).toEqual(tableProxies(loadStageTable(join(import.meta.dir, "..", ".."))).map((x) => x.name).sort());
    const e = withTableProxies(good());
    const rec = recordingChainReader(tableProxyChain(e));
    expect(await checkEvidenceOnChain(e, rec.reader, frozen, { proxies: Object.keys(TABLE_PROXIES) })).toEqual([]);
    const fixture = JSON.parse(JSON.stringify(rec.fixture));
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
  test("offline: the adopted library list is capped by the stage table, so a longer list cannot lower the allowed deposit count", () => {
    const cap = { safe: 2, libs: 1, proto: 3 };
    expect(checkEvidence(adoptedEv(), FROZEN_WITH_LIBS, cap)).toEqual([]);
    const forged = adoptedEv();
    forged.stages.push({ stage: "proto", frozen_count: 10, receipt_count: 0, tx_hashes: [], receipts_status: [], adopted: { deployer_txs: 0, libraries: Array.from({ length: 10 }, (_, i) => ({ name: `L${i}`, address: a(90 + i), code_hash: keccak256(LIBCODE) })) } });
    forged.deployer_nonce_final = 2 + 0 + 0 + 1;
    const f = { ...FROZEN_WITH_LIBS, proto: 10 };
    expect(checkEvidence(forged, f).join()).not.toContain("lets this stage adopt"); // without the table the lower bound is the only guard (10 - 10 = 0)
    expect(checkEvidence(forged, f, cap).join()).toContain("the stage table lets this stage adopt 3");
    const twice = adoptedEv(); twice.stages[1].adopted.libraries.push({ ...twice.stages[1].adopted.libraries[0] });
    expect(checkEvidence(twice, FROZEN_WITH_LIBS, { ...cap, libs: 2 }).join()).toContain("lists a library twice");
    const unlisted = adoptedEv(); unlisted.stages[1].stage = "recorder";
    expect(checkEvidence(unlisted, { ...FROZEN_WITH_LIBS, recorder: 4 }, cap).join()).toContain("lets this stage adopt 0");
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

describe("effective weights and voted_weights_clears in the evidence (issue 1743)", () => {
  const VAULTS = [a(5), a(6), a(8)];
  const BPS = [5000, 3000, 2000];
  const withApply = (e: any) => {
    e.consensus_receipt = { address: RCPT }; e.governance = { address: GOV };
    e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, governance: GOV, receipt: RCPT, vaults: VAULTS, bps: BPS, payload_digest: DIGEST, effective_vaults: VAULTS, effective_bps: BPS, operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: T0 + 20, execute_tx: h(621), execute_status: 1, execute_block_timestamp: T0 + 20 + 172800 }];
  };
  const withClear = (e: any) => {
    e.governance = { address: GOV };
    e.voted_weights_clears = [{ step: "clear-voted-weights", round: 1, governance: GOV, router: a(40), voted_weights_active: false, effective_vaults: VAULTS, effective_bps: BPS, operation_id: h(90), schedule_tx: h(660), schedule_status: 1, schedule_block_timestamp: T0 + 30, execute_tx: h(661), execute_status: 1, execute_block_timestamp: T0 + 30 + 172800 }];
  };
  const app = (f: (e: any) => void = () => {}) => { const e = good(); withApply(e); f(e); return checkEvidence(e).join("\n"); };
  const clr = (f: (e: any) => void = () => {}) => { const e = good(); withClear(e); f(e); return e; };
  const clearOffline = (f: (e: any) => void = () => {}) => checkEvidence(clr(f)).join("\n");
  const clearChain = (o: Opts = {}, f: (e: any) => void = () => {}) => { const e = clr(); const c = stub(e, o); f(e); return checkEvidenceOnChain(e, c, { safe: 2 }).then((p) => p.join("\n")); };

  test("an application records effective weights equal to the applied vector (its vector is the active one: no voted flag is asked of it, issue 1698), and refuses without them", () => {
    expect(app()).toBe("");
    // a flag either way is not the application's proof: the effective vector is
    expect(app((e) => { e.receipt_applications[0].voted_weights_active = true; })).toBe("");
    expect(app((e) => { e.receipt_applications[0].voted_weights_active = false; })).toBe("");
    expect(app((e) => { delete e.receipt_applications[0].effective_vaults; delete e.receipt_applications[0].effective_bps; })).toContain("effective_vaults and effective_bps");
    expect(app((e) => { e.receipt_applications[0].effective_vaults = [a(5)]; e.receipt_applications[0].effective_bps = [10000]; })).toContain("routing did not change");
    expect(app((e) => { e.receipt_applications[0].effective_bps = [5000, 3000, 1000]; })).toContain("effective_vaults and effective_bps");
  });
  test("a clear entry passes offline and on chain: one call, clearVotedWeights() on the governance contract, one delay apart", async () => {
    expect(clearOffline()).toBe("");
    expect(await clearChain()).toBe("");
    expect(checkVotedWeightsClears(clr())).toEqual([]);
    expect(await checkVotedWeightsClearsOnChain(clr(), stub(clr()))).toEqual([]);
  });
  test("a clear entry is refused for a voted vector still active, a missing read-back, a wrong target and a short gap", async () => {
    expect(clearOffline((e) => { e.voted_weights_clears[0].voted_weights_active = true; })).toContain("voted_weights_active is true");
    expect(clearOffline((e) => { delete e.voted_weights_clears[0].effective_bps; })).toContain("effective_vaults and effective_bps");
    expect(clearOffline((e) => { e.voted_weights_clears[0].governance = a(33); })).toContain("is not the governance contract");
    expect(clearOffline((e) => { e.voted_weights_clears[0].step = "unpause-USDC"; })).toContain("is not clear-voted-weights");
    expect(clearOffline((e) => { e.voted_weights_clears[0].execute_block_timestamp = T0 + 30 + 172799; })).toContain("gap");
    expect(clearOffline((e) => { e.voted_weights_clears.push({ ...e.voted_weights_clears[0] }); })).toContain("more than one evidence entry");
    expect(clearOffline((e) => { e.voted_weights_clears[0].cancelled = true; })).toContain("cancelled is not a field");
    expect(await clearChain({ clearData: "0x12345678" })).toContain("calldata is not clearVotedWeights()");
    expect(await clearChain({ clearTarget: a(31) })).toContain("is not the governance contract");
    expect(await clearChain({ clearCalls: 2 })).toContain("exactly one call");
    expect(await clearChain({ clearDelay: 60n })).toContain("delay");
    expect(await clearChain({ clearGap: 172799 })).toContain("on-chain schedule-to-execute gap");
  });
  test("the template lists the clear block and an empty list passes", () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
    expect(tpl.voted_weights_clears).toEqual([]);
    expect(checkEvidence({ ...good(), voted_weights_clears: [] })).toEqual([]);
  });
});

describe("vault_redeploys: new_vault is the contract the deploy created (QA plan v1 C2, issue 1701)", () => {
  const DEPLOYER = a(20), OLD = a(6) as Hex, NEW = a(0x3012), REG = a(21) as Hex, ROUTER = a(40), ASSET = a(0xc0de) as Hex;
  const FINAL = [a(5), NEW, a(7), a(8)], BPS4 = [8550, 525, 575, 350];
  const entry = (): any => ({
    step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: tl, deployer: DEPLOYER, core_sha: "ab".repeat(20),
    deploy_start_nonce: 40, deploy_end_nonce: 42, deploy_count: 2, deploy_tx_hashes: [h(0x501), h(0x502)], deploy_receipt_statuses: [1, 1], registry_name: "Robot Money Protocol", asset: ASSET,
    vaults: FINAL, bps: BPS4, router_vault_cap: "250000000", voted_weights_active: false, effective_vaults: FINAL, effective_bps: BPS4, old_vault_status: "Retired", new_vault_status: "Active",
    operation_id: h(0x577), schedule_tx: h(0x510), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(0x511), execute_status: 1, execute_block_timestamp: T0 + 900,
  });
  const ev = (r: any, over: object = {}) => ({ deployment_kind: "rehearsal", registry: { address: REG }, timelock: { address: tl }, vaults: { rmPROTO: { address: NEW } }, vault_redeploys: [r], ...over });
  /** The chain the entry describes: deploy tx 0 is a CREATE of `created` by `creator`, deploy tx 1 a call, then the seven-call batch for the ENTRY's vaults and cap, one delay apart. */
  const chainOf = (r: any, o: { created?: string; creator?: string } = {}): ChainReader => {
    const want = buildRedeployCalls({ registry: REG, router: ROUTER as Hex, oldVault: OLD, newVault: r.new_vault, registryName: r.registry_name, asset: ASSET, finalVaults: r.vaults, finalBps: r.bps, vaultCap: r.router_vault_cap });
    const receipts = new Map<string, any>(); const blocks = new Map<bigint, number>(); let bn = 1n;
    const add = (hash: string, logs: any[], ts: number, extra: object = {}) => { receipts.set(hash, { status: "success", blockNumber: bn, logs, ...extra }); blocks.set(bn++, ts); };
    add(r.deploy_tx_hashes[0], [], 1, { from: o.creator ?? DEPLOYER, contractAddress: o.created ?? NEW });
    add(r.deploy_tx_hashes[1], [], 1, { from: DEPLOYER, contractAddress: null });
    add(r.schedule_tx, want.map((c, i) => log("CallScheduled", 0x577, 900n, c.target, c.data, BigInt(i))), T0);
    add(r.execute_tx, want.map((c, i) => log("CallExecuted", 0x577, 0n, c.target, c.data, BigInt(i))), T0 + 900);
    return {
      getChainId: async () => 918453, getTransactionCount: async () => 0,
      getTransactionReceipt: async ({ hash }) => { const x = receipts.get(hash); if (!x) throw new Error("not found"); return x; },
      getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks.get(blockNumber)!) }),
      readContract: async () => { throw new Error("unused"); },
    };
  };
  test("an entry whose new_vault is the deployer's CREATE passes the offline and the chain check", async () => {
    expect(checkVaultRedeploys(ev(entry()), 900)).toEqual([]);
    expect(await checkVaultRedeploysOnChain(ev(entry()), chainOf(entry()), 900)).toEqual([]);
  });
  test("vault_redeploys entry whose new_vault is not the created contract is refused", async () => {
    const e = entry();
    // the Safe ran a batch for NEW (the entry and the batch agree), but no recorded deploy transaction created NEW: the deploy created another contract
    const p = (await checkVaultRedeploysOnChain(ev(e), chainOf(e, { created: a(0x3013) }), 900)).join("\n");
    expect(p).toContain(`new_vault ${NEW} is not the contract a recorded deploy transaction created`);
    expect(p).toContain(a(0x3013));
    // NEW was created, but by another sender than the run's deployer
    expect((await checkVaultRedeploysOnChain(ev(e), chainOf(e, { creator: a(0xbad) }), 900)).join("\n")).toContain("not by the deployer");
    // offline: the entry's deployer must be the run's deployer when the evidence names one
    expect(checkVaultRedeploys(ev(e, { deployer: a(0xbad) }), 900).join("\n")).toContain("is not the run's deployer");
    expect(checkVaultRedeploys(ev(e, { deployer: DEPLOYER }), 900)).toEqual([]);
  });
});

describe("evidence secret scan: a hash field exempts its own value, never its line (QA plan v1 E8, issue 1689)", () => {
  // Synthetic shapes only: none is a real key, hash or receipt.
  const KEY = "0x" + "c3".repeat(32);
  const SHA = "5d".repeat(32);
  /** Writes the files into a fresh folder and scans it: each hit as `name:line: rule`. */
  const scan = (files: Record<string, string>): string[] => {
    const d = mkdtempSync(join(tmpdir(), "evidence-e8-"));
    for (const [n, body] of Object.entries(files)) writeFileSync(join(d, n), body);
    return scanEvidenceFolder(d).map((x) => x.slice(d.length + 1));
  };
  const flagged = (hits: string[], rule = "64-hex") => hits.filter((x) => x.includes(rule)).map((x) => x.split(":")[0]).sort();

  test("a privateKey line is not exempt", () => {
    // the end-of-line shape `"name": "0x<64 hex>",` once passed under any name: a secret name never passes, as a value, a list or a snake_case key
    const run = JSON.stringify({ stages: { libs: { txHash: h(1), privateKey: KEY, status: "done" } } }, null, 2) + "\n";
    expect(run).toContain(`"privateKey": "${KEY}",`);
    const line = run.split("\n").findIndex((l) => l.includes("privateKey")) + 1;
    const hits = scan({ "publish-run.json": run });
    expect(hits).toContain(`publish-run.json:${line}: 64-hex value (private key shape)`);
    expect(hits).toContain(`publish-run.json:${line}: secret assignment`);
    expect(hits.every((x) => x.startsWith(`publish-run.json:${line}:`))).toBe(true); // the txHash line above it stays clean
    expect(flagged(scan({
      "snake.json": JSON.stringify({ deployer: { private_key: KEY, note: "x" } }, null, 2) + "\n",
      "list.json": JSON.stringify({ signerKeys: [KEY] }, null, 2) + "\n",
      "hash-named.json": JSON.stringify({ keyHash: KEY, note: "x" }, null, 2) + "\n",
    }))).toEqual(["hash-named.json", "list.json", "snake.json"]);
  });

  test("a token, auth, credential or bearer key is not exempt, and a key off the public-name allowlist exempts nothing", () => {
    // the end-of-line shape `"name": "0x<64 hex>",` passes only under a name that says it is public: a hash, a qualified id, a role, a topic
    const one = (k: string) => JSON.stringify({ x: { [k]: KEY, n: 1 } }, null, 2) + "\n";
    const names = ["token", "authToken", "auth_token", "accessToken", "credential", "credentials", "bearer", "apikey", "sessionId", "signer", "id", "note", "value"];
    const hits = scan(Object.fromEntries(names.map((k) => [`${k}.json`, one(k)])));
    expect(flagged(hits)).toEqual(names.map((k) => `${k}.json`).sort());
    // the quoted JSON key forms of the credential names are a secret assignment too, like "privateKey"
    for (const k of ["token", "authToken", "auth_token", "accessToken", "credential", "credentials", "bearer"]) expect(hits).toContain(`${k}.json:3: secret assignment`);
    // a list under such a name exempts nothing either
    expect(flagged(scan({ "tokens.json": JSON.stringify({ tokens: [KEY] }, null, 2) + "\n", "values.json": JSON.stringify({ values: [KEY] }, null, 2) + "\n" }))).toEqual(["tokens.json", "values.json"]);
  });

  test("an ERC-20 token address, a pool id on a one-line manifest and a code_hashes object scan clean", () => {
    const TOKEN = "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3";
    expect(scan({
      "agent-token-vault.json": JSON.stringify({ chain_id: 8453, assets: [{ symbol: "RM", token: TOKEN, pool_id: h(30) }] }) + "\n",
      "assets.json": JSON.stringify({ assets: [{ symbol: "RM", token: TOKEN }] }, null, 2) + "\n",
      "timelock.json": JSON.stringify({ code_hashes: { safe: h(31), consensus_receipt: h(32) }, pool_id: h(33) }, null, 2) + "\n",
      "govern-pending.txt": `next: govern --row set-unwind-guard --admin-arg token=${TOKEN} --admin-arg token=all\n`,
    })).toEqual([]);
    // the same object under a secret name is not a hash object: its keys exempt nothing
    expect(flagged(scan({ "keys.json": JSON.stringify({ signer_keys: { safe: KEY } }, null, 2) + "\n" }))).toEqual(["keys.json"]);
  });

  test("a hash word elsewhere on the line exempts nothing: a key beside a tx hash, and a bare 64-hex on a hash or tx line, are flagged", () => {
    expect(flagged(scan({
      "log.jsonl": JSON.stringify({ event: "tx.sent", hash: h(2), signer: KEY }) + "\n",
      "notes.txt": `deploy tx ${h(3)} signed with ${KEY}\n`,
      "env.txt": `PRIVATE_KEY=${KEY} # salt for the libs tx\n`,
      "bare.json": JSON.stringify({ txHash: "ab".repeat(32) }, null, 2) + "\n",
      "bare.txt": `block hash ${"ab".repeat(32)}\n`,
    }))).toEqual(["bare.json", "bare.txt", "env.txt", "log.jsonl", "notes.txt"]);
  });

  test("a sha256 value passes only directly under configHashes or config_hashes", () => {
    const iso = { chainId: 8453, configHashes: { "config/dex-pools.json": `sha256:${SHA}` }, codehashes: { "vault[USDC]": h(4) } };
    expect(scan({
      "isomorphism-8453.json": JSON.stringify(iso, null, 2) + "\n",
      "one-line.json": JSON.stringify({ configHashes: iso.configHashes }) + "\n",
      "snake.json": JSON.stringify({ config_hashes: { "config/rwa-assets.json": `sha256:${SHA}` } }, null, 2) + "\n",
    })).toEqual([]);
    expect(flagged(scan({
      "elsewhere.json": JSON.stringify({ artifacts: { "out/Vault.json": `sha256:${SHA}` } }, null, 2) + "\n",
      "nested.json": JSON.stringify({ configHashes: { extra: { "config/x.json": `sha256:${SHA}` } } }, null, 2) + "\n",
      "text.txt": `image sha256:${SHA}\n`,
    }))).toEqual(["elsewhere.json", "nested.json", "text.txt"]);
  });

  test("the public hash fields a run writes still scan clean", () => {
    const manifest = {
      stages: { libs: { status: "done", txHashes: [h(5), h(6)], firstBlock: 10 } },
      govern: { "unpause-USDC": { scheduled: { txHash: h(7), operation_id: h(8), salt: h(9), predecessor: h(0) } } },
      receipt_applications: [{ receipt_id: h(10), payload_digest: h(11), schedule_tx: h(12) }],
    };
    const fixture = { receipts: [{ hash: h(13), logs: [{ address: a(1), topics: [h(14), h(15)], data: h(16) }] }], reads: { [`${a(2)}:DEFAULT_ADMIN_ROLE`]: h(0) } };
    expect(scan({
      "publish-run.json": JSON.stringify(manifest, null, 2) + "\n",
      "chain-fixture.json": JSON.stringify(fixture, null, 2) + "\n",
      "frozen-counts.json": JSON.stringify({ measured: { crossChecked: { sha: "ab".repeat(20), fileHash: SHA } } }, null, 2) + "\n",
      "govern-stdout.jsonl": [JSON.stringify({ row: "unpause-USDC", phase: "scheduled", txHash: h(17), status: 1 }), JSON.stringify({ event: "stage.done", tx_hashes: [h(18), h(19)] })].join("\n") + "\n",
      "forge.txt": `[Success] Hash: ${h(20)}\nTransaction hash: ${h(21)}\nblockHash            ${h(22)}\n`,
    })).toEqual([]);
  });
});

// ---- issue 1809 (ADR-0014), QA plan v1 L1: the `proxies` evidence is read from the chain, never taken from the record ----
describe("evidence check re-reads the governed proxies from the chain", () => {
  const NAMES = ["rmUSDC", "registry"];
  const word = word32;
  const withProxies = () => withTableProxies(good(), NAMES);
  const proxyChain = (e: any, o: Live = {}) => tableProxyChain(e, o);
  const check = (e: any, chain: ChainReader) => checkEvidenceOnChain(e, chain, { safe: 2 }, { proxies: NAMES });

  test("proxies that read on chain what the evidence records pass", async () => {
    const e = withProxies();
    expect(await check(e, proxyChain(e))).toEqual([]);
  });
  test("each property the chain contradicts is refused by name", async () => {
    const cases: [Live, string][] = [
      [{ implementation: a(0x2999) }, "implementation slot"],
      [{ adminSlot: word(BigInt(a(0xad))) }, "admin slot"],
      [{ beaconSlot: word(BigInt(a(0xbe))) }, "beacon slot"],
      [{ code: "0x6080604053" as Hex }, "implementation code hash on chain"],
      [{ code: "0x" as Hex }, "has no code"],
      [{ authority: a(0x77) }, "upgradeAuthority()"],
      [{ frozen: true }, "upgradesFrozen()"],
      [{ uninitialized: true }, "not initialized"],
      [{ unlocked: true }, "initializers are not locked"],
    ];
    for (const [o, needle] of cases) {
      const e = withProxies();
      const p = (await check(e, proxyChain(e, o))).join("\n");
      expect(p, needle).toContain(needle);
      expect(p, needle).toContain("proxies.rmUSDC");
      expect(p, needle).toContain("proxies.registry");
    }
  });
  test("a recorded frozen flag the chain does not hold is refused, and a frozen proxy the evidence records frozen passes", async () => {
    const e = withProxies();
    e.proxies.registry.frozen = true;
    expect((await check(e, proxyChain(e))).join()).toContain("proxies.registry: upgradesFrozen()");
    const f = withProxies();
    for (const n of NAMES) f.proxies[n].frozen = true;
    expect(await check(f, proxyChain(f, { frozen: true }))).toEqual([]);
  });
  test("a reader that cannot read code or storage proves nothing: a problem, never a pass", async () => {
    const e = withProxies();
    expect((await check(e, stub(e))).join()).toContain("cannot read code or storage");
  });
  test("without the table's proxy names the chain check reads no proxy (a deployment before the proxies)", async () => {
    const e = withProxies();
    expect(await checkEvidenceOnChain(e, stub(e), { safe: 2 })).toEqual([]);
  });
  test("the recorded chain fixture carries the proxy reads, as decimal storage words that pass the secret scan", async () => {
    const e = withProxies();
    const { reader, fixture } = recordingChainReader(proxyChain(e));
    expect(await check(e, reader)).toEqual([]);
    const fx = JSON.parse(JSON.stringify(fixture));
    expect(fx.storage.length).toBeGreaterThan(0);
    for (const s of fx.storage) expect(s.value).toMatch(/^[0-9]+$/);
    expect(await check(e, chainReaderFromFixture(fx))).toEqual([]);
    // the fixture alone, offline: a storage word that differs is caught there too (an admin slot that names someone)
    const moved = JSON.parse(JSON.stringify(fx));
    const slot = moved.storage.find((s: any) => s.address === a(5) && s.slot_hash === ERC1967_ADMIN_SLOT.toLowerCase());
    slot.value = BigInt(a(0xad)).toString();
    expect((await check(e, chainReaderFromFixture(moved))).join()).toContain("proxies.rmUSDC: the ERC-1967 admin slot");
    const dir = mkdtempSync(join(tmpdir(), "evidence-proxy-fixture-"));
    writeFileSync(join(dir, "chain-fixture.json"), JSON.stringify({ storage: fx.storage, codes: fx.codes }, null, 2) + "\n");
    expect(scanEvidenceFolder(dir)).toEqual([]);
  });
});

// ---- ADR-0014 §5 and §8 (issue 1809): the immutability claim and the storage-layout identifier ----
describe("immutability claim and layout identifier (ADR-0014 §5, §8)", () => {
  const names = Object.keys(TABLE_PROXIES);
  const opts = { proxies: names };
  const still = { governed_parameters: ["vault fees and caps"], upstream_dependencies: ["USDC"] };
  const frozenAll = (e: any) => { e.upgrade_mode = "frozen-at-deploy"; for (const n of names) Object.assign(e.proxies[n], { mode: "frozen-at-deploy", frozen: true }); };

  test("no claim: an upgradeable deployment passes", () => {
    expect(checkEvidence(withTableProxies(good()), undefined, undefined, opts)).toEqual([]);
  });

  test("a claim while any proxy reads upgradeable is refused, naming the proxies", () => {
    const e = withTableProxies(good());
    e.immutability_claim = "core-logic-immutable";
    e.immutability = { still_mutable: still };
    const p = checkEvidence(e, undefined, undefined, opts).join("\n");
    expect(p).toContain("immutability_claim");
    expect(p).toContain("rmUSDC");
  });

  test("a claim with every proxy frozen passes only with the still-mutable list", () => {
    const e = withTableProxies(good());
    frozenAll(e);
    e.immutability_claim = "core-logic-immutable";
    expect(checkEvidence(e, undefined, undefined, opts).join("\n")).toContain("still_mutable");
    e.immutability = { still_mutable: still };
    expect(checkEvidence(e, undefined, undefined, opts)).toEqual([]);
  });

  // Security round 1: after a redeploy the old vault is still a proxy of the deployment with holders inside, and its authority is still the timelock.
  test("a claim is refused while a vault a redeploy replaced is not frozen by an executed proxy_freezes entry", () => {
    const OLD = `0x${"3f".repeat(20)}`;
    const e = withTableProxies(good());
    frozenAll(e);
    e.immutability_claim = "core-logic-immutable";
    e.immutability = { still_mutable: still };
    e.vault_redeploys = [{ vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD }];
    const claim = () => checkEvidence(e, undefined, undefined, opts).filter((m) => m.includes("immutability_claim"));
    expect(claim().join()).toContain(`a redeploy replaced (rmPROTO ${OLD})`);
    e.proxy_freezes = [{ step: "freeze-proxy", proxies: [{ name: "rmPROTO.retired-1", proxy: OLD, implementation: `0x${"9f".repeat(20)}`, code_hash: `0x${"cd".repeat(32)}` }] }];
    expect(claim().join()).toContain("a redeploy replaced"); // scheduled, never executed
    e.proxy_freezes[0].execute_tx = `0x${"13".repeat(32)}`;
    expect(claim()).toEqual([]);
  });

  test("a deploy-recorded layout identifier that differs from the checkout's snapshot is refused", () => {
    const e = withTableProxies(good());
    Object.assign(e.proxies.gateway, { layout_hash: `0x${"11".repeat(32)}`, layout_source: "deploy-manifest", checkout_layout_hash: `0x${"22".repeat(32)}` });
    expect(checkEvidence(e, undefined, undefined, opts).join("\n")).toContain("proxies.gateway.layout_hash");
    Object.assign(e.proxies.gateway, { checkout_layout_hash: `0x${"11".repeat(32)}` });
    expect(checkEvidence(e, undefined, undefined, opts)).toEqual([]);
  });

  // Security round 1: an upgraded proxy's layout is the one its upgrade round recorded, held to the snapshot of that round's build checkout.
  test("an upgrade-round layout identifier that differs from its build checkout's snapshot is refused", () => {
    const e = withTableProxies(good());
    Object.assign(e.proxies.gateway, { layout_hash: `0x${"11".repeat(32)}`, layout_source: "upgrade-round", checkout_layout_hash: `0x${"22".repeat(32)}` });
    expect(checkEvidence(e, undefined, undefined, opts).join("\n")).toContain("recorded by the upgrade round that installed it");
    Object.assign(e.proxies.gateway, { checkout_layout_hash: `0x${"11".repeat(32)}` });
    expect(checkEvidence(e, undefined, undefined, opts)).toEqual([]);
  });
});
