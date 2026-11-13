// Deploy 4: the evidence of a fund system run (the one-vault prototype as a rehearsal) is checked on its own, offline and on chain. No other evidence carries a fund stage,
// and a fund evidence carries nothing of the vaults or gateway systems.
import { describe, expect, test } from "bun:test";
import { checkEvidence, checkEvidenceOnChain, type ChainReader } from "../src/evidence-check.ts";
import { FUND_EVIDENCE_STAGES, checkFundEvidence } from "../src/evidence-fund.ts";

const a = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const SHA = "b".repeat(40);
const COUNTS: Record<string, number> = { safe: 1, "fund-libs": 14, "fund-receipt": 2, fund: 18, rebalancer: 7, "fund-governance": 2, queue: 2, "fund-wiring": 3, "fund-timelock": 15 };
const SUM = Object.values(COUNTS).reduce((x, y) => x + y, 0);
const TL = a(0x71), SAFE = a(0x5a);

function fundEvidence(): any {
  let n = 0;
  return {
    system: "fund", deployment_kind: "rehearsal", chain_id: 8453, core_sha: SHA, deployer: a(0xde), deployer_start_nonce: 644, deployer_nonce_at_handover: 644 + SUM + 1,
    stages: FUND_EVIDENCE_STAGES.map((stage) => ({ stage, frozen_count: COUNTS[stage], receipt_count: COUNTS[stage], tx_hashes: Array.from({ length: COUNTS[stage]! }, () => h(++n)), receipts_status: Array(COUNTS[stage]).fill(1) })),
    safe: { address: SAFE, owners: [a(1), a(2), a(3)], threshold: 2 },
    timelock: { address: TL, proposer: SAFE, min_delay: 900 },
    control_proof: { tx_hash: h(999) },
    proxies: Object.fromEntries(["fund", "rebalancer", "governance", "queue", "consensus_receipt"].map((k, i) => [k, { address: a(0x100 + i), implementation: a(0x200 + i), upgrade_timelock: TL, upgrade_mode: "upgradeable" }])),
    keeper: a(0xee), emergency: a(0xe0), verifier: { exit_code: 0 },
  };
}
const problems = (e: any, opts: object = { kind: "rehearsal" }): string => checkFundEvidence(e, COUNTS, opts).join("\n");

describe("a fund system evidence (Deploy 4)", () => {
  test("a complete fund evidence passes, and checkEvidence routes system fund to it", () => {
    expect(checkFundEvidence(fundEvidence(), COUNTS, { kind: "rehearsal" })).toEqual([]);
    expect(checkEvidence(fundEvidence(), COUNTS, undefined, { kind: "rehearsal" })).toEqual([]);
  });
  test("a vaults or gateway evidence that carries a fund stage is refused, and so is a fund evidence with a vaults key", () => {
    const vaults = { system: "vaults", stages: [{ stage: "fund-timelock" }] };
    expect(checkEvidence(vaults, COUNTS).join("\n")).toContain("stage fund-timelock belongs to the fund system");
    expect(problems({ ...fundEvidence(), registry: a(9) })).toContain("'registry' belongs to the vaults or gateway system's evidence");
    expect(problems({ ...fundEvidence(), system: "vaults" })).toContain('system is vaults, a fund evidence says "fund"');
  });
  test("the stages run in order and each matches its frozen count, hashes and statuses", () => {
    const e = fundEvidence(); e.stages = e.stages.slice().reverse();
    expect(problems(e)).toContain("the fund system runs");
    const f = fundEvidence(); f.stages[3].receipts_status[0] = 0;
    expect(problems(f)).toContain("stage fund: receipt 0 status is 0, not 1");
    expect(checkFundEvidence(fundEvidence(), { ...COUNTS, queue: 3 }, { kind: "rehearsal" }).join("\n")).toContain("stage queue: receipt_count 2 differs from the frozen file (3)");
  });
  test("every proxy names the fund system's timelock, which the Safe alone proposes on, at the kind's delay", () => {
    const e = fundEvidence(); e.proxies.queue.upgrade_timelock = a(0xbad);
    expect(problems(e)).toContain("proxies.queue.upgrade_timelock is not the fund system's timelock");
    const p = fundEvidence(); p.timelock.proposer = a(0xde);
    expect(problems(p)).toContain("timelock.proposer is not the fund system's Safe");
    const d = fundEvidence(); d.timelock.min_delay = 60;
    expect(problems(d)).toContain("timelock.min_delay");
    expect(problems(fundEvidence(), { kind: "production" })).toContain("deployment_kind is rehearsal, the evidence is checked as production");
  });
  test("the keeper and the emergency key are their own keys, and the nonce at the handover is the start plus the counts plus the control proof", () => {
    expect(problems({ ...fundEvidence(), keeper: a(0xde) })).toContain("keeper is the deployer");
    expect(problems({ ...fundEvidence(), keeper: a(0xe0) })).toContain("keeper and emergency are the same key");
    expect(problems({ ...fundEvidence(), deployer_nonce_at_handover: 644 + SUM })).toContain("plus the control proof");
    expect(problems({ ...fundEvidence(), control_proof: undefined })).toContain("control_proof.tx_hash is missing");
  });
});

describe("a fund system evidence on chain (Deploy 4)", () => {
  const reader = (over: Partial<{ nonce: number; status: "success" | "reverted"; timelock: string; delay: bigint; proposer: boolean }> = {}): ChainReader => ({
    getChainId: async () => 8453,
    getTransactionCount: async () => over.nonce ?? 644 + SUM + 5,
    getTransactionReceipt: async () => ({ status: over.status ?? "success", blockNumber: 1n, logs: [] }),
    getBlock: async () => ({ timestamp: 1n }),
    readContract: async (r: { functionName: string }) => (r.functionName === "upgradeTimelock" ? over.timelock ?? TL : r.functionName === "getMinDelay" ? over.delay ?? 900n : over.proposer ?? true),
  } as unknown as ChainReader);
  test("receipts, each proxy's upgradeTimelock(), the delay and the Safe's proposer role read back; a nonce below the handover's is refused", async () => {
    expect(await checkEvidenceOnChain(fundEvidence(), reader(), COUNTS, { kind: "rehearsal" })).toEqual([]);
    expect((await checkEvidenceOnChain(fundEvidence(), reader({ status: "reverted" }), COUNTS, { kind: "rehearsal" })).join("\n")).toContain("receipt on chain is reverted");
    expect((await checkEvidenceOnChain(fundEvidence(), reader({ timelock: a(0xbad) }), COUNTS, { kind: "rehearsal" })).join("\n")).toContain("upgradeTimelock() on chain is");
    expect((await checkEvidenceOnChain(fundEvidence(), reader({ delay: 172800n }), COUNTS, { kind: "rehearsal" })).join("\n")).toContain("fund timelock getMinDelay()");
    expect((await checkEvidenceOnChain(fundEvidence(), reader({ proposer: false }), COUNTS, { kind: "rehearsal" })).join("\n")).toContain("does not hold the timelock's PROPOSER_ROLE");
    expect((await checkEvidenceOnChain(fundEvidence(), reader({ nonce: 600 }), COUNTS, { kind: "rehearsal" })).join("\n")).toContain("below the recorded nonce at the handover");
  });
});
