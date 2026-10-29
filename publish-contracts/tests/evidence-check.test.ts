import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from "viem";
import { getStageTable } from "../src/stages.ts";
import { adoptableFromTable, applyCalldata, chainReaderFromFixture, checkEvidence, checkEvidenceOnChain, checkReceiptApplications, checkReceiptApplicationsOnChain, GOVERN_STEPS, recordingChainReader, scanEvidenceFolder, unpauseCalldata, type ChainReader } from "../src/evidence-check.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOwnerExceptions } from "../src/plan.ts";
import { UNPAUSE_ROWS } from "../src/govern.ts";
import { checkVaultRetirements, checkVaultRetirementsOnChain } from "../src/evidence-check.ts";
import { buildRetireCalls } from "../src/retire-vault.ts";
import { releaseCalldata, checkVaultRedeploys, checkVaultRedeploysOnChain, checkVotedWeightsClears, checkVotedWeightsClearsOnChain, governedUpgradeProblems, checkGovernedUpgradesOnChain } from "../src/evidence-check.ts";
import { buildRedeployCalls } from "../src/redeploy-vault.ts";
import { pinnedMigrationData } from "../src/upgrade-rows.ts";
import { upgradeCalldata } from "../src/upgrade-lifecycle.ts";
import { VAULT_RULES } from "../src/vault-rules.ts";
import { keccak256 } from "viem";
// HISTORICAL (issue 1743, removed by issue 1988): the calldata of the removed clear row, which pinned run manifests still record.
const clearCalldata = () => encodeFunctionData({ abi: parseAbi(["function clearVotedWeights()"]), functionName: "clearVotedWeights" });
import { withUpgradeability, withUpgradeabilityReads } from "./upgradeability-fixture.ts";

const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
/** The unpauses are scheduled in one sitting: step i is scheduled i seconds after step 0, and each waits one 172800 s delay. */
const T0 = 1000;
const good = () => withUpgradeability({
  chain_id: 8453, core_sha: "ab".repeat(20), plan_approved_at: "2026-10-05T10:00:00Z",
  owner_exceptions: [{ text: "signer C is a Ledger on a shared laptop", recorded_at: "2026-10-04T10:00:00Z" }],
  stages: [{ stage: "safe", frozen_count: 2, receipt_count: 2, tx_hashes: [h(1), h(2)], receipts_status: [1, 1] }],
  safe: { address: a(1), owners: [a(2), a(3), a(4)], threshold: 2, creation_tx: h(3) },
  vaults: { rmUSDC: { address: a(5) }, rmPROTO: { address: a(6) }, rmRWA: { address: a(8) } },
  timelock: { address: a(9), min_delay: 172800 },
  verifier: { exit_code: 0, registry_list_vaults_equals_manifests: true },
  deployer: a(20), deployer_nonce_final: 3, registry: { address: a(21) },
  govern: GOVERN_STEPS.map((step, i) => ({ step, operation_id: h(900 + i), schedule_tx: h(100 + i * 3), schedule_block_timestamp: T0 + i, execute_tx: h(101 + i * 3), execute_block_timestamp: T0 + i + 172800, schedule_status: 1, execute_status: 1 })),
  sources: { blockscout_all_verified: true, sourcify_all_exact: true },
} as any);
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
  test("a missing unpause is rejected", () => expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== "unpause-RWA"); })).toContain("'unpause-RWA'"));
  test("every unpause is required", () => { for (const step of GOVERN_STEPS) expect(mut((e) => { e.govern = e.govern.filter((g: any) => g.step !== step); })).toContain(`'${step}'`); });
  test("Stage 13 on 8453 is the three vault unpauses (rmUSDC first), and the unpause rows of the govern CLI are the same list", () => {
    expect(GOVERN_STEPS).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-RWA"]);
    expect([...GOVERN_STEPS]).toEqual([...UNPAUSE_ROWS]);
  });
  test("a non-unpause operation scheduled on 8453 is rejected: update-delay, batch, cancel and anything else", () => {
    for (const step of ["update-delay", "batch", "cancel", "voting-power-quorum", "agents", "other-setters", "router-weights", "migrate-eligibility-PROTO", "round1"]) {
      expect(mut((e) => { e.govern.push({ ...e.govern[0], step, schedule_tx: h(700), execute_tx: h(701), operation_id: h(702) }); })).toContain(`'${step}' is not a vault unpause`);
    }
  });
  test("a complete record with one schedule and one execute per unpause, at least 172800 s apart and with distinct operation ids, passes", () => {
    const e = good();
    expect(e.govern.length).toBe(3);
    expect(new Set(e.govern.map((g: any) => g.operation_id)).size).toBe(3);
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
interface Opts { retireCalls?: { target: string; data: string }[]; retireDelay?: bigint; retireGap?: number; clearData?: string; clearTarget?: string; clearDelay?: bigint; clearGap?: number; clearCalls?: number; appDelay?: bigint; appGap?: number; appCalls?: number; appData?: string; appTarget?: string; appId?: number; stepData?: Record<string, string>; stepTarget?: Record<string, string>; pausedBy?: Record<string, boolean>; relTarget?: string; relData?: string; relDelay?: bigint; relGap?: number; relExtraCall?: boolean; sharedId?: boolean; paused?: boolean; nonce?: number; failed?: string; delay?: bigint; gap?: number; listed?: string[]; chainId?: number }
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
    const call = { target: o.appTarget ?? GOV, data: o.appData ?? applyCalldata(r.receipt_id, r.payload_digest, r.vaults, r.bps) };
    const calls = Array.from({ length: o.appCalls ?? 1 }, () => call);
    add(r.schedule_tx, calls.map((c, k) => log("CallScheduled", id, o.appDelay, c.target, c.data, BigInt(k))), t0);
    add(r.execute_tx, calls.map((c, k) => log("CallExecuted", id, 0n, c.target, c.data, BigInt(k))), t0 + (o.appGap ?? 172800));
  });
  (ev.voted_weights_clears ?? []).forEach((r: any, i: number) => {
    const id = 90 + i;
    const t0 = T0 + 30 + i;
    const data = o.clearData ?? clearCalldata();
    const sched = Array.from({ length: o.clearCalls ?? 1 }, (_, k) => log("CallScheduled", id, o.clearDelay, o.clearTarget ?? GOV, data, BigInt(k)));
    add(r.schedule_tx, sched, t0);
    add(r.execute_tx, [log("CallExecuted", id, 0n, o.clearTarget ?? GOV, data)], t0 + (o.clearGap ?? 172800));
  });
  (ev.vault_retirements ?? []).forEach((r: any, i: number) => {
    const id = 95 + i;
    const t0 = T0 + 35 + i;
    const calls = o.retireCalls ?? buildRetireCalls({ registry: r.registry, vault: r.vault, finalVaults: r.vaults, finalBps: r.bps });
    add(r.schedule_tx, calls.map((c, k) => log("CallScheduled", id, o.retireDelay, c.target, c.data, BigInt(k))), t0);
    add(r.execute_tx, calls.map((c, k) => log("CallExecuted", id, 0n, c.target, c.data, BigInt(k))), t0 + (o.retireGap ?? 172800));
  });
  return withUpgradeabilityReads(ev, {
    getChainId: async () => o.chainId ?? 8453,
    getTransactionCount: async () => o.nonce ?? 3,
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error("not found"); return r; },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks.get(blockNumber)!) }),
    readContract: async ({ address, functionName }) => (functionName === "depositsPaused" ? (o.pausedBy?.[address] ?? o.paused ?? false) : (o.listed ?? Object.values(ev.vaults).map((v: any) => v.address))),
  });
}
const VAULT: Record<string, string> = { "unpause-USDC": "rmUSDC", "unpause-PROTO": "rmPROTO", "unpause-RWA": "rmRWA" };
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

describe("receipt_applications: one timelock call, the weight setter's applyReceipt (issue 1696, issue 1698)", () => {
  const VAULTS = [a(5), a(6), a(8)];
  const BPS = [5000, 3000, 2000];
  const withApply = (e: any) => {
    e.consensus_receipt = { address: RCPT }; e.governance = { address: GOV };
    e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, target: GOV, governance: GOV, payload_digest: h(0xd16), vaults: VAULTS, bps: BPS, voted_weights_active: true, effective_vaults: VAULTS, effective_bps: BPS, operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: T0 + 20, execute_tx: h(621), execute_status: 1, execute_block_timestamp: T0 + 20 + 172800 }];
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
    expect(offline((e) => { e.receipt_applications[0].target = RCPT; })).toContain("is not the weight setter");
    expect(offline((e) => { e.receipt_applications[0].payload_digest = "0x12"; })).toContain("payload_digest is not a bytes32");
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
  test("receipt_applications on chain: exactly one applyReceipt call of the recorded entry on the weight setter, one delay apart", async () => {
    expect(await chain({ appCalls: 2 })).toContain("exactly one applyReceipt call");
    expect(await chain({ appTarget: RCPT })).toContain("is not the weight setter");
    expect(await chain({ appData: "0x12345678" })).toContain("calldata is not applyReceipt");
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
    expect((await checkReceiptApplicationsOnChain(e, stub(e, { appCalls: 2 }))).join()).toContain("exactly one applyReceipt call");
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
  const entry = { step: "apply-receipt", receipt_id: h(0xabc), target: a(32), governance: a(32), payload_digest: h(0xd16), vaults: [a(5), a(6)], bps: [6000, 4000], voted_weights_active: true, effective_vaults: [a(5), a(6)], effective_bps: [6000, 4000], operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: 1000, execute_tx: h(621), execute_status: 1, execute_block_timestamp: 1000 + 172800 };
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

describe("evidence-check --receipt-applications: a submitter registered before and after the receipt migration", () => {
  const run = (manifest: object) => {
    const dir = mkdtempSync(join(tmpdir(), "pc-apply-rereg-"));
    const file = join(dir, "publish-run.json");
    writeFileSync(file, JSON.stringify(manifest));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "evidence-check.ts"), "--receipt-applications", file, "--consensus-receipt", a(30), "--governance", a(32), "--timelock", a(9)]);
    return r.stderr.toString();
  };
  const hist = { submitter: a(40), execute_block_timestamp: 1000 };
  const again = { submitter: a(40), schedule_block_timestamp: 5000 };
  const migration = { proxy_name: "receipt", migration: { name: "receipt-submitter-roles" }, execute_block_timestamp: 3000 };
  test("the manifest's proxy_upgrades reach the rule", () => {
    expect(run({ committee_registrations: [hist], submitter_registrations: [again], proxy_upgrades: [migration] })).not.toContain("executed between them");
    expect(run({ committee_registrations: [hist], submitter_registrations: [again] })).toContain("executed between them");
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
    expect(p.filter((m) => m.includes("depositsPaused()")).length).toBe(3); // rmUSDC and the two baskets, all tied to their unpause row
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
  // Issue 1833: the alarm does not read the table's deployPaused, so a uniform table edit to deployPaused=false cannot silence it.
  for (const deployPaused of [true, false]) {
    test(`a vault reading paused=false without an executed unpause receipt is reported when the table says deployPaused=${deployPaused}`, async () => {
      const rules = VAULT_RULES.map((v) => ({ ...v, deployPaused, unpauseInStage13: v.unpauseInStage13 && deployPaused }));
      const e = good();
      const chain = stub(e, { paused: false });
      e.govern.find((x: any) => x.step === "unpause-RWA").execute_status = 0;
      const p = await checkEvidenceOnChain(e, chain, { safe: 2 }, { vaultRules: rules });
      expect(p).toContain("rmRWA.depositsPaused() reads false on chain, but govern unpause-RWA has no executed receipt");
    });
  }
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

// ---- issue 1667: the unpause rounds ----
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
  test("the template step list has all three vault steps: rmUSDC is required", () => expect(GOVERN_STEPS).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-RWA"]));
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
// issue 1809: the proxies and implementations of the upgradeability record keep their own code; every other address holds `code`
const codeChain = (e: any, code: Hex | undefined = LIBCODE, nonce = 3): ChainReader => withUpgradeabilityReads(e, { ...stub(e, { nonce }), getCode: async () => code });
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
    const wrong = adoptedEv(); wrong.stages[1].stage = "registry"; wrong.stages[1].frozen_count = 6;
    expect(checkEvidence(wrong, { ...FROZEN_WITH_LIBS, registry: 6 }).join()).toContain("is below the frozen count 6 less its 1 adopted library");
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
    const unlisted = adoptedEv(); unlisted.stages[1].stage = "registry";
    expect(checkEvidence(unlisted, { ...FROZEN_WITH_LIBS, registry: 4 }, cap).join()).toContain("lets this stage adopt 0");
  });
  test("offline: the timelock stage may adopt the core timelock only (issue 1835): the table cap is one, frozen count less one passes, two entries are refused", () => {
    const cap = adoptableFromTable(getStageTable());
    expect(cap.timelock).toBe(1);
    expect(cap.registry).toBe(1); // GovernedUpgrade only: the cap of other stages is unchanged
    const mk = (n: number, txs: number) => {
      const e: any = good();
      e.stages.push({ stage: "timelock", frozen_count: 25, receipt_count: txs, tx_hashes: Array.from({ length: txs }, (_, i) => h(60 + i)), receipts_status: Array.from({ length: txs }, () => 1),
        adopted: { deployer_txs: txs, libraries: Array.from({ length: n }, (_, i) => ({ name: i ? `X${i}` : "TimelockController", address: a(70 + i), code_hash: keccak256(LIBCODE) })) } });
      e.deployer_nonce_final = 2 + txs + 1;
      return e;
    };
    const f = { safe: 2, timelock: 25 };
    expect(checkEvidence(mk(1, 24), f, cap)).toEqual([]);
    expect(checkEvidence(mk(2, 23), f, cap).join()).toContain("the stage table lets this stage adopt 1");
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
    const noReader: ChainReader = { ...stub(e, { nonce: 3 }), getCode: undefined };
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

describe("effective weights, and the HISTORICAL voted_weights_clears, in the evidence (issue 1743, issue 1988)", () => {
  const VAULTS = [a(5), a(6), a(8)];
  const BPS = [5000, 3000, 2000];
  const withApply = (e: any) => {
    e.consensus_receipt = { address: RCPT }; e.governance = { address: GOV };
    e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, target: GOV, governance: GOV, payload_digest: h(0xd16), vaults: VAULTS, bps: BPS, voted_weights_active: true, effective_vaults: VAULTS, effective_bps: BPS, operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: T0 + 20, execute_tx: h(621), execute_status: 1, execute_block_timestamp: T0 + 20 + 172800 }];
  };
  const withClear = (e: any) => {
    e.governance = { address: GOV };
    e.voted_weights_clears = [{ step: "clear-voted-weights", round: 1, governance: GOV, router: a(40), voted_weights_active: false, effective_vaults: VAULTS, effective_bps: BPS, operation_id: h(90), schedule_tx: h(660), schedule_status: 1, schedule_block_timestamp: T0 + 30, execute_tx: h(661), execute_status: 1, execute_block_timestamp: T0 + 30 + 172800 }];
  };
  const app = (f: (e: any) => void = () => {}) => { const e = good(); withApply(e); f(e); return checkEvidence(e).join("\n"); };
  const clr = (f: (e: any) => void = () => {}) => { const e = good(); withClear(e); f(e); return e; };
  const clearOffline = (f: (e: any) => void = () => {}) => checkEvidence(clr(f)).join("\n");
  const clearChain = (o: Opts = {}, f: (e: any) => void = () => {}) => { const e = clr(); const c = stub(e, o); f(e); return checkEvidenceOnChain(e, c, { safe: 2 }).then((p) => p.join("\n")); };

  test("an application records votedWeightsActive true (applyReceipt sets the active vector) and effective weights equal to the applied vector, and refuses without them", () => {
    expect(app()).toBe("");
    expect(app((e) => { e.receipt_applications[0].voted_weights_active = false; })).toContain("voted_weights_active is false, want true");
    expect(app((e) => { delete e.receipt_applications[0].voted_weights_active; })).toContain("voted_weights_active is undefined");
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
  test("the template no longer lists the clear block (issue 1988: no tool writes one) and an empty list still passes", () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
    expect(tpl.voted_weights_clears).toBeUndefined();
    expect(checkEvidence({ ...good(), voted_weights_clears: [] })).toEqual([]);
  });
});

describe("vault_retirements in the evidence (issue 1912, ADR-0017)", () => {
  const VAULTS3 = [a(5), a(6), a(8)];
  const BPS3 = [9500, 500, 0];
  const withRetire = (e: any) => {
    e.vault_retirements = [{ step: "retire-vault", round: 1, vault: a(60), registry: a(21), router: a(40), timelock: a(9), vaults: [...VAULTS3], bps: [...BPS3], voted_weights_active: false, effective_vaults: [...VAULTS3], effective_bps: [...BPS3], operation_id: h(95), schedule_tx: h(680), schedule_status: 1, schedule_block_timestamp: T0 + 35, execute_tx: h(681), execute_status: 1, execute_block_timestamp: T0 + 35 + 172800 }];
  };
  const mk = (f: (e: any) => void = () => {}) => { const e = good(); withRetire(e); f(e); return e; };
  const offline = (f: (e: any) => void = () => {}) => checkEvidence(mk(f)).join("\n");
  const chain = (o: Opts = {}, f: (e: any) => void = () => {}) => { const e = mk(); const c = stub(e, o); f(e); return checkEvidenceOnChain(e, c, { safe: 2 }).then((p) => p.join("\n")); };
  test("an entry passes offline and on chain: one batch of two calls, migrateEligibility(vault, false, three legs) then retire(vault), one delay apart", async () => {
    expect(offline()).toBe("");
    expect(await chain()).toBe("");
    expect(checkVaultRetirements(mk())).toEqual([]);
    expect(await checkVaultRetirementsOnChain(mk(), stub(mk()))).toEqual([]);
  });
  test("an entry is refused for a four-leg vector, a vector still naming the vault, a missing read-back, a wrong step and a short gap", async () => {
    expect(offline((e) => { e.vault_retirements[0].vaults = [...VAULTS3, a(60)]; e.vault_retirements[0].bps = [9500, 500, 0, 0]; })).toContain("3 distinct addresses");
    expect(offline((e) => { e.vault_retirements[0].vaults[2] = a(60); })).toContain("is still in the default vector");
    expect(offline((e) => { e.vault_retirements[0].bps = [9500, 500, 1]; })).toContain("sum to 10000");
    expect(offline((e) => { delete e.vault_retirements[0].effective_bps; })).toContain("effective_vaults and effective_bps");
    expect(offline((e) => { e.vault_retirements[0].voted_weights_active = "yes"; })).toContain("voted_weights_active is yes");
    expect(offline((e) => { e.vault_retirements[0].step = "unpause-USDC"; })).toContain("is not retire-vault");
    expect(offline((e) => { e.vault_retirements[0].execute_block_timestamp = T0 + 35 + 172799; })).toContain("gap");
    expect(offline((e) => { e.vault_retirements.push({ ...e.vault_retirements[0] }); })).toContain("more than one evidence entry");
    expect(offline((e) => { e.vault_retirements[0].cancelled = true; })).toContain("cancelled is not a field");
  });
  test("issue 1988: an entry with an active applied vector passes when the vector fits the three that stay and the retired leg was seen skipped", () => {
    const four = [a(5), a(6), a(60), a(8)];
    const active = (f: (r: any) => void = () => {}) => offline((e) => { Object.assign(e.vault_retirements[0], { voted_weights_active: true, effective_vaults: [...four], effective_bps: [8000, 1000, 500, 500], retired_leg_skipped: true }); f(e.vault_retirements[0]); });
    expect(active()).toBe("");
    expect(active((r) => { r.effective_vaults = [...VAULTS3]; r.effective_bps = [8000, 1000, 1000]; delete r.retired_leg_skipped; })).toBe("");
    expect(active((r) => { delete r.retired_leg_skipped; })).toContain("retired_leg_skipped is undefined, want true");
    expect(active((r) => { r.effective_bps = [8000, 1000, 500, 400]; })).toContain("sums to 9900");
    expect(active((r) => { r.effective_vaults = [a(5), a(8), a(60), a(6)]; })).toContain("are not the default's vaults");
    expect(active((r) => { r.effective_bps = [0, 0, 10000, 0]; })).toContain("no weight on the vaults that stay");
    expect(active((r) => { delete r.effective_vaults; })).toContain("effective_vaults and effective_bps");
  });
  test("the chain read refuses a batch whose calls, number of calls or delay differ from the recorded retirement", async () => {
    const wrong = buildRetireCalls({ registry: a(21) as `0x${string}`, vault: a(60) as `0x${string}`, finalVaults: VAULTS3, finalBps: [9000, 1000, 0] });
    expect(await chain({ retireCalls: wrong })).toContain("calldata is not registry.migrateEligibility(vault, false, three legs)");
    const only = buildRetireCalls({ registry: a(21) as `0x${string}`, vault: a(60) as `0x${string}`, finalVaults: VAULTS3, finalBps: BPS3 }).slice(1);
    expect(await chain({ retireCalls: only })).toContain("a retire round is exactly 2 calls in one batch");
    expect(await chain({ retireDelay: 60n })).toContain("delay");
    expect(await chain({ retireGap: 172799 })).toContain("on-chain schedule-to-execute gap");
  });
  test("the template lists the block and an empty list passes", () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
    expect(tpl.vault_retirements).toEqual([]);
    expect(checkEvidence({ ...good(), vault_retirements: [] })).toEqual([]);
  });
});

describe("issue 1701: --delay-floor cannot go under the 8453 floor when --rpc reads chain 8453", () => {
  test("a production floor below 172800 s on chain 8453 is refused with a clear error, the 8453 floor itself and a Twin chain floor pass", async () => {
    const { delayFloorArgProblem } = await import("../src/evidence-check.ts");
    for (const f of [1, 3600, 172799]) expect(delayFloorArgProblem(f, 8453, "production")).toContain(`--delay-floor ${f} is below the chain 8453 floor 172800 s`);
    expect(delayFloorArgProblem(172800, 8453, "production")).toBe("");
    expect(delayFloorArgProblem(200000, 8453, "production")).toBe("");
    // a Twin run (chain 918453) and an offline check (no --rpc) keep their own floor
    expect(delayFloorArgProblem(3600, 918453, "production")).toBe("");
    expect(delayFloorArgProblem(3600, undefined, "production")).toBe("");
    // a rehearsal on 8453 runs a short timelock: its floor is the rehearsal floor, still refused below it
    expect(delayFloorArgProblem(900, 8453, "rehearsal")).toBe("");
    expect(delayFloorArgProblem(899, 8453, "rehearsal")).toContain("below the chain 8453 floor 900 s");
    // not a positive integer: refused everywhere
    for (const f of [0, -1, 1.5, Number.NaN]) expect(delayFloorArgProblem(f, 918453, "production")).toContain("positive number of seconds");
  });
});

describe("vault_redeploys: new_vault is the contract the deploy created (QA plan v1 C2, issue 1701)", () => {
  const DEPLOYER = a(20), OLD = a(6) as Hex, NEW = a(0x3012), REG = a(21) as Hex, ROUTER = a(40) as Hex, ASSET = a(0xc0de) as Hex;
  const FINAL = [a(5), NEW, a(7), a(8)], BPS4 = [8550, 525, 575, 350];
  const entry = (): any => ({
    step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: tl, deployer: DEPLOYER, core_sha: "ab".repeat(20),
    deploy_start_nonce: 40, deploy_end_nonce: 42, deploy_count: 2, deploy_tx_hashes: [h(0x501), h(0x502)], deploy_receipt_statuses: [1, 1], registry_name: "Robot Money Protocol", asset: ASSET,
    vaults: FINAL, bps: BPS4, router_vault_cap: "250000000", voted_weights_active: false, effective_vaults: FINAL, effective_bps: BPS4, old_vault_status: "Retired", new_vault_status: "Active",
    operation_id: h(0x577), schedule_tx: h(0x510), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(0x511), execute_status: 1, execute_block_timestamp: T0 + 900,
  });
  const ev = (r: any, over: object = {}) => ({ deployment_kind: "rehearsal", registry: { address: REG }, timelock: { address: tl }, vaults: { rmPROTO: { address: NEW } }, vault_redeploys: [r], ...over });
  /** The chain the entry describes: deploy tx 0 is a CREATE of `created` by `creator`, deploy tx 1 a call, then the batch for the ENTRY's vaults and cap, one delay apart. */
  const chainOf = (r: any, o: { created?: string; creator?: string } = {}): ChainReader => {
    const want = buildRedeployCalls({ router: ROUTER, routerVaultCap: BigInt(r.router_vault_cap), registry: REG, oldVault: OLD, newVault: r.new_vault, registryName: r.registry_name, asset: ASSET, finalVaults: r.vaults, finalBps: r.bps });
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

describe("vault_redeploys: the verify of a round at another sha is recorded (QA plan v1 E1)", () => {
  const SHA_A = "ab".repeat(20), SHA_B = "cd".repeat(20);
  const OLD = a(6), NEW = a(0x3012);
  const FINAL = [a(5), NEW, a(7), a(8)], BPS4 = [8550, 525, 575, 350];
  const entry = (over: object = {}): any => ({
    step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: NEW, registry: a(21), router: a(40), timelock: tl, deployer: a(20), core_sha: SHA_A,
    deploy_count: 1, deploy_tx_hashes: [h(0x501)], deploy_receipt_statuses: [1], registry_name: "Robot Money Protocol", asset: a(0xc0de),
    vaults: FINAL, bps: BPS4, router_vault_cap: "250000000", voted_weights_active: false, effective_vaults: FINAL, effective_bps: BPS4, old_vault_status: "Retired", new_vault_status: "Active",
    operation_id: h(0x577), schedule_tx: h(0x510), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(0x511), execute_status: 1, execute_block_timestamp: T0 + 900, ...over,
  });
  const ev = (r: any) => ({ deployment_kind: "rehearsal", core_sha: SHA_A, registry: { address: a(21) }, timelock: { address: tl }, vaults: { rmPROTO: { address: NEW } }, vault_redeploys: [r] });
  test("a round at the deployment's sha needs neither field; one written alone is refused", () => {
    expect(checkVaultRedeploys(ev(entry()), 900)).toEqual([]);
    expect(checkVaultRedeploys(ev(entry({ prior_out_sha: SHA_A })), 900).join("\n")).toContain("written together");
  });
  test("a round at another sha needs the verify at that sha with --prior-out of the deployment's sha", () => {
    expect(checkVaultRedeploys(ev(entry({ core_sha: SHA_B })), 900).join("\n")).toContain("prior_out_sha is missing");
    expect(checkVaultRedeploys(ev(entry({ core_sha: SHA_B, prior_out_sha: SHA_A, verified_at_sha: SHA_B })), 900)).toEqual([]);
    expect(checkVaultRedeploys(ev(entry({ core_sha: SHA_B, prior_out_sha: SHA_B, verified_at_sha: SHA_B })), 900).join("\n")).toContain("is not the evidence core_sha");
    expect(checkVaultRedeploys(ev(entry({ core_sha: SHA_B, prior_out_sha: SHA_A, verified_at_sha: SHA_A })), 900).join("\n")).toContain(`verified_at_sha ${SHA_A} is not ${SHA_B}`);
  });
});

// Issue 1859: the governed-upgrade lists the freeze and upgrade rows write (govern.ts), checked offline: well formed, executed once, never a cancel field. A transaction the tool
// could not recover (an execution adopted from the chain with no CallExecuted log found) is null with a note.
describe("upgrade_freezes and proxy_upgrades (issue 1859)", () => {
  const D = 172800;
  const freeze = () => ({
    step: "freeze-upgrades", timelock: a(9), targets: { gateway: { proxy: a(40), implementation: a(41), implementation_code_hash: h(42) }, registry: { proxy: a(43), implementation: a(44), implementation_code_hash: h(45) } },
    operation_id: h(4000), schedule_tx: h(4001), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(4002), execute_status: 1, execute_block_timestamp: T0 + D,
  });
  const upgrade = () => ({
    step: "upgrade-proxy", proxy_name: "gateway", proxy: a(40), from_implementation: a(46), from_code_hash: h(47), to_implementation: a(41), to_code_hash: h(42), build: "/core",
    timelock: a(9), manifest_fields: { gateway_implementation: a(41), gateway_implementation_runtime_hash: h(42), gateway_runtime_hash: h(48) },
    operation_id: h(5000), schedule_tx: h(5001), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(5002), execute_status: 1, execute_block_timestamp: T0 + D,
  });
  const withLists = (f: (fr: any, up: any) => void = () => {}) => { const e = good(); const fr = freeze(), up = upgrade(); f(fr, up); e.upgrade_freezes = [fr]; e.proxy_upgrades = [up]; return checkEvidence(e); };
  test("well formed entries pass, alone and inside the evidence", () => {
    expect(withLists()).toEqual([]);
    expect(governedUpgradeProblems({ upgrade_freezes: [freeze()], proxy_upgrades: [upgrade()] })).toEqual([]);
  });
  test("a malformed upgrade_freezes entry fails", () => {
    expect(withLists((fr) => { fr.targets = {}; }).join("\n")).toContain("targets name no proxy");
    expect(withLists((fr) => { fr.targets.gateway.implementation_code_hash = "0x12"; }).join("\n")).toContain("target gateway implementation_code_hash is not a bytes32");
    expect(withLists((fr) => { fr.targets["vault[rmNOPE]"] = fr.targets.gateway; }).join("\n")).toContain("is not a proxied core contract");
    expect(withLists((fr) => { fr.execute_status = 0; }).join("\n")).toContain("execute receipt status is 0");
    expect(withLists((fr) => { fr.execute_block_timestamp = T0 + 60; }).join("\n")).toContain("schedule-to-execute gap 60 s is under 172800 s");
    expect(withLists((fr) => { fr.timelock = a(99); }).join("\n")).toContain("is not the deployed timelock");
  });
  test("a malformed proxy_upgrades entry fails", () => {
    expect(withLists((_, up) => { up.to_implementation = up.from_implementation; }).join("\n")).toContain("nothing was upgraded");
    expect(withLists((_, up) => { up.proxy_name = "nope"; }).join("\n")).toContain("proxy_name nope is not a proxied core contract");
    expect(withLists((_, up) => { up.to_code_hash = undefined; }).join("\n")).toContain("to_code_hash is not a bytes32");
    expect(withLists((_, up) => { up.manifest_fields = {}; }).join("\n")).toContain("manifest_fields does not re-record the implementation field");
    expect(withLists((_, up) => { up.execute_tx = up.schedule_tx; }).join("\n")).toContain("execute_tx is also the schedule_tx");
    expect(withLists((fr, up) => { up.operation_id = fr.operation_id; }).join("\n")).toContain("operation_id is also the operation_id");
    expect(checkEvidence({ ...good(), proxy_upgrades: {} }).join("\n")).toContain("proxy_upgrades is not a list");
  });
  test("an unknown transaction is null with a null status and timestamp and a note; without the note, or with a status, it fails", () => {
    const unknown = (x: any) => { x.execute_tx = null; x.execute_status = null; x.execute_block_timestamp = null; x.note = "execute_tx unknown: no CallExecuted log"; };
    expect(withLists((fr, up) => { unknown(fr); unknown(up); })).toEqual([]);
    expect(withLists((_, up) => { unknown(up); delete up.note; }).join("\n")).toContain("execute_tx is null with no note");
    expect(withLists((_, up) => { unknown(up); up.execute_status = 1; }).join("\n")).toContain("execute_status and execute_block_timestamp must be null");
  });
  test("an entry carrying cancelled, cancel_tx or cancel_status fails with the forged-cancel message", () => {
    for (const k of ["cancelled", "cancel_tx", "cancel_status"]) {
      expect(withLists((fr) => { fr[k] = k === "cancel_tx" ? h(1) : 1; }).join("\n")).toContain(`freeze-upgrades ${h(4000)}: ${k} is not a field of an executed operation`);
      expect(withLists((_, up) => { up[k] = true; }).join("\n")).toContain(`upgrade-proxy gateway ${h(5000)}: ${k} is not a field of an executed operation`);
    }
  });
});

// ---- issue 1910: the typed migration of a proxy_upgrades entry ----
describe("proxy_upgrades typed migration (issue 1910)", () => {
  const D = 172800;
  const RELEASER = a(60);
  const MIG = () => {
    const data = pinnedMigrationData("receipt-submitter-roles", RELEASER);
    return { name: "receipt-submitter-roles", function: "migrateToSubmitterRoles", selector: data.slice(0, 10), argument: "releaser", releaser: RELEASER, data, data_hash: keccak256(data) };
  };
  const upgrade = (migration: any = MIG()) => ({
    step: "upgrade-proxy", proxy_name: "receipt", proxy: a(70), from_implementation: a(71), from_code_hash: h(72), to_implementation: a(73), to_code_hash: h(74), build: "/core",
    timelock: a(9), manifest_fields: { consensus_receipt_implementation: a(73) }, ...(migration ? { migration } : {}),
    operation_id: h(6000), schedule_tx: h(6001), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(6002), execute_status: 1, execute_block_timestamp: T0 + D,
  });
  const evOf = (up: any) => ({ timelock: { address: a(9) }, governance: { address: RELEASER }, proxy_upgrades: [up] });
  const problems = (f: (u: any) => void = () => {}) => { const u = upgrade(); f(u); return governedUpgradeProblems(evOf(u), D, ["receipt", "gateway"]).join("\n"); };

  test("a well formed migration entry passes, and so does an upgrade without one", () => {
    expect(governedUpgradeProblems(evOf(upgrade()), D, ["receipt"])).toEqual([]);
    expect(governedUpgradeProblems(evOf(upgrade(null)), D, ["receipt"])).toEqual([]);
  });
  test("an unknown name, another proxy, a wrong function, free hex, a wrong hash or selector, a zero or foreign releaser fail", () => {
    expect(problems((u) => { u.migration.name = "other"; })).toContain("is not a known typed migration");
    expect(problems((u) => { u.proxy_name = "gateway"; })).toContain("belongs to the receipt proxy, not gateway");
    expect(problems((u) => { u.migration.function = "initialize"; })).toContain("migration function initialize is not migrateToSubmitterRoles");
    expect(problems((u) => { u.migration.data = "0xdeadbeef"; })).toContain("migration data is not migrateToSubmitterRoles");
    expect(problems((u) => { u.migration.data_hash = h(1); })).toContain("migration data_hash");
    expect(problems((u) => { u.migration.selector = "0xdeadbeef"; })).toContain("migration selector");
    expect(problems((u) => { u.migration.releaser = "0x" + "0".repeat(40); })).toContain("zero address");
    expect(problems((u) => { u.migration.releaser = a(61); })).toContain("is not RouterGovernance");
    expect(problems((u) => { u.migration = "yes"; })).toContain("migration is not an object");
  });

  // the chain: the timelock's CallScheduled of the recorded operation
  const chainOf = (up: any, scheduledData: string, calls = 1): ChainReader => {
    const logs = Array.from({ length: calls }, (_, k) => log("CallScheduled", 6000, 172800n, up.proxy, scheduledData, BigInt(k)));
    return { getChainId: async () => 8453, getTransactionCount: async () => 0, getBlock: async () => ({ timestamp: 1n }), readContract: async () => undefined,
      getTransactionReceipt: async ({ hash }: { hash: string }) => { if (hash !== up.schedule_tx) throw new Error("not found"); return { status: "success", blockNumber: 1n, logs }; } } as unknown as ChainReader;
  };
  test("the scheduled data is read back from the chain and must equal upgradeToAndCall(impl, typed migration data)", async () => {
    const up = upgrade();
    const want = upgradeCalldata(up.to_implementation, pinnedMigrationData("receipt-submitter-roles", RELEASER));
    expect(await checkGovernedUpgradesOnChain(evOf(up), chainOf(up, want))).toEqual([]);
    // an entry that claims the migration while the chain scheduled EMPTY data
    const empty = (await checkGovernedUpgradesOnChain(evOf(up), chainOf(up, upgradeCalldata(up.to_implementation)))).join("\n");
    expect(empty).toContain("CallScheduled calldata is not upgradeToAndCall");
    expect(empty).toContain("it schedules upgradeToAndCall(");
    // other data on the chain (another releaser)
    expect((await checkGovernedUpgradesOnChain(evOf(up), chainOf(up, upgradeCalldata(up.to_implementation, pinnedMigrationData("receipt-submitter-roles", a(99)))))).join("\n")).toContain("CallScheduled calldata is not upgradeToAndCall");
    // an entry that claims NO migration cannot hide one
    const plain = upgrade(null);
    expect(await checkGovernedUpgradesOnChain(evOf(plain), chainOf(plain, upgradeCalldata(plain.to_implementation)))).toEqual([]);
    expect((await checkGovernedUpgradesOnChain(evOf(plain), chainOf(plain, want))).join("\n")).toContain("CallScheduled calldata is not upgradeToAndCall");
    // another implementation, a batch of two
    expect((await checkGovernedUpgradesOnChain(evOf(up), chainOf(up, upgradeCalldata(a(99), pinnedMigrationData("receipt-submitter-roles", RELEASER))))).join("\n")).toContain("CallScheduled calldata is not upgradeToAndCall");
    expect((await checkGovernedUpgradesOnChain(evOf(up), chainOf(up, want, 2))).join("\n")).toContain("2 CallScheduled events");
  });
});
