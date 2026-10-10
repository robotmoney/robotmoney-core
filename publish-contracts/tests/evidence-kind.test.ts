// Issue 1727: evidence by deployment kind. A rehearsal evidence is never production evidence and the reverse. The 900 s floor, the start nonce, the rehearsal-only rows and the
// receipt path (registration, REAL recorded receipt, application) are accepted in a rehearsal and refused in production. Each refusal has a mutation (the fixed input passes).
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { checkEvidence, checkEvidenceOnChain, checkReceiptPathOnChain, GOVERN_STEPS, REHEARSAL_ROWS, type ChainReader } from "../src/evidence-check.ts";
import { buildRegisterCalls } from "../src/committee-register.ts";
import { finalDeployerNonce } from "../src/counts.ts";

const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const T0 = 1000;
const prod = (): any => ({
  chain_id: 8453, core_sha: "ab".repeat(20), plan_approved_at: "2026-10-05T10:00:00Z",
  owner_exceptions: [{ text: "x", recorded_at: "2026-10-04T10:00:00Z" }],
  stages: [{ stage: "safe", frozen_count: 2, receipt_count: 2, tx_hashes: [h(1), h(2)], receipts_status: [1, 1] }],
  safe: { address: a(1), owners: [a(2), a(3), a(4)], threshold: 2, creation_tx: h(3) },
  vaults: { rmUSDC: { address: a(5) }, rmPROTO: { address: a(6) }, rmAGENT: { address: a(7) }, rmRWA: { address: a(8) } },
  timelock: { address: a(9), min_delay: 172800 }, verifier: { exit_code: 0, registry_list_vaults_equals_manifests: true },
  deployer: a(20), deployer_nonce_final: 3, registry: { address: a(21) },
  govern: GOVERN_STEPS.map((step, i) => ({ step, operation_id: h(900 + i), schedule_tx: h(100 + i * 3), schedule_block_timestamp: T0 + i, execute_tx: h(101 + i * 3), execute_block_timestamp: T0 + i + 172800, schedule_status: 1, execute_status: 1 })),
  sources: { blockscout_all_verified: true, sourcify_all_exact: true },
});
const RID = h(0xabc), DIGEST = h(0xd16), SUB = a(0x5ab1);
const reh = (): any => {
  const e: any = prod();
  e.deployment_kind = "rehearsal";
  e.timelock.min_delay = 900;
  e.deployer_start_nonce = 118;
  e.deployer_nonce_final = 118 + 3;
  e.govern = GOVERN_STEPS.map((step, i) => ({ step, operation_id: h(900 + i), schedule_tx: h(100 + i * 3), schedule_block_timestamp: T0 + i, execute_tx: h(101 + i * 3), execute_block_timestamp: T0 + i + 900, schedule_status: 1, execute_status: 1 }));
  return e;
};
const rows = (e: any) => {
  e.rehearsal_rows = [
    { step: "update-delay", operation_id: h(800), schedule_tx: h(200), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(201), execute_status: 1, execute_block_timestamp: T0 + 900 },
    { step: "batch", operation_id: h(801), schedule_tx: h(202), schedule_status: 1, schedule_block_timestamp: T0 + 1000, execute_tx: h(203), execute_status: 1, execute_block_timestamp: T0 + 1900 },
    { step: "cancel", operation_id: h(802), schedule_tx: h(204), schedule_status: 1, schedule_block_timestamp: T0 + 2000, cancel_tx: h(205), cancel_status: 1 },
  ];
  return e;
};
const path = (e: any) => {
  e.committee_registrations = [{ step: "register-committee", submitter: SUB, agent_label: "s", gateway: a(30), ic_policy: a(31), timelock: a(9), valid_until: "9999999", operation_id: h(810), schedule_tx: h(210), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(211), execute_status: 1, execute_block_timestamp: T0 + 900 }];
  e.recorded_receipts = [{ receipt_id: RID, payload_digest: DIGEST, payload_uri: "https://twin.invalid/r.json", submitter: SUB, tx_hash: h(220), status: 1 }];
  e.consensus_receipt = { address: a(32) }; e.governance = { address: a(33) };
  e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, target: a(32), governance: a(33), vaults: [a(5), a(6)], bps: [9000, 1000], payload_digest: DIGEST, operation_id: h(812), schedule_tx: h(212), schedule_status: 1, schedule_block_timestamp: T0 + 10, execute_tx: h(213), execute_status: 1, execute_block_timestamp: T0 + 910 }];
  return e;
};
const R = { kind: "rehearsal" as const };
const problems = (e: any, o?: { kind?: "rehearsal" | "production" }) => checkEvidence(e, undefined, o).join("\n");

describe("evidence kind", () => {
  test("production evidence passes as production; a rehearsal evidence presented as production is refused (and the reverse)", () => {
    expect(checkEvidence(prod())).toEqual([]);
    expect(problems(reh())).toContain("deployment_kind is rehearsal, the evidence is checked as production");
    expect(problems(reh())).toContain("never production evidence");
    expect(problems(prod(), R)).toContain("deployment_kind is production, the evidence is checked as rehearsal");
    expect(checkEvidence(reh(), undefined, R)).toEqual([]); // mutation: asked for as a rehearsal it passes
  });
  test("an explicit deployment_kind production passes; an unknown kind is refused", () => {
    expect(checkEvidence({ ...prod(), deployment_kind: "production" })).toEqual([]);
    expect(problems({ ...prod(), deployment_kind: "staging" })).toContain("deployment_kind 'staging'");
  });
  test("the 900 s floor is a rehearsal floor only: min_delay 900 passes as a rehearsal, fails as production", () => {
    const e = prod(); e.timelock.min_delay = 900;
    expect(problems(e)).toContain("min_delay 900 is under 172800");
    const r = reh();
    expect(checkEvidence(r, undefined, R)).toEqual([]);
    r.timelock.min_delay = 899;
    expect(problems(r, R)).toContain("is under 900");
    r.timelock.min_delay = 172800;
    expect(problems(r, R)).toContain("cannot be told from production");
    r.timelock.min_delay = 172799;
    expect(checkEvidence(r, undefined, R)).toEqual([]);
  });
  test("govern gaps follow the kind: 900 s passes as a rehearsal, fails as production", () => {
    const r = reh();
    expect(checkEvidence(r, undefined, R)).toEqual([]);
    expect(problems(r, { kind: "production" })).toContain("gap 900 s is under 172800");
    r.govern[0].execute_block_timestamp = T0 + 899;
    expect(problems(r, R)).toContain("gap 899 s is under 900");
  });
  test("the deployer start nonce: rehearsal counts from it, production refuses one and counts from 0", () => {
    const counts = { safe: 2 };
    const r = reh(); r.deployer_nonce_final = finalDeployerNonce(counts, 118);
    expect(checkEvidence(r, counts, R)).toEqual([]);
    r.deployer_nonce_final = finalDeployerNonce(counts);
    expect(checkEvidence(r, counts, R).join()).toContain("start nonce 118");
    delete r.deployer_start_nonce;
    expect(checkEvidence(r, counts, R).join()).toContain("deployer_start_nonce is missing");
    const p = prod(); p.deployer_nonce_final = finalDeployerNonce(counts); p.deployer_start_nonce = 118;
    expect(checkEvidence(p, counts).join()).toContain("deployer_start_nonce is present in a production evidence");
  });
  test("update-delay, batch and cancel: refused on 8453 in production (govern and rehearsal_rows), accepted under rehearsal_rows in a rehearsal", () => {
    expect([...REHEARSAL_ROWS]).toEqual(["update-delay", "batch", "cancel"]);
    expect(checkEvidence(rows(reh()), undefined, R)).toEqual([]);
    expect(problems(rows(prod()))).toContain("rehearsal_rows is present in a production evidence");
    const e = reh(); e.govern.push({ ...e.govern[0], step: "update-delay", schedule_tx: h(700), execute_tx: h(701), operation_id: h(702) });
    expect(problems(e, R)).toContain("'update-delay' is not a vault unpause"); // they never go in govern
  });
  test("rehearsal rows: a missing or failed transaction, a short gap, a duplicate row and a shared transaction are refused", () => {
    const m = (f: (e: any) => void) => { const e = rows(reh()); f(e); return problems(e, R); };
    expect(m((e) => { e.rehearsal_rows[0].execute_status = 0; })).toContain("execute receipt status is 0");
    expect(m((e) => { e.rehearsal_rows[1].schedule_tx = ""; })).toContain("schedule_tx is missing");
    expect(m((e) => { e.rehearsal_rows[0].execute_block_timestamp = T0 + 899; })).toContain("gap 899 s is under 900");
    expect(m((e) => { e.rehearsal_rows[2].cancel_tx = ""; })).toContain("cancel_tx is missing");
    expect(m((e) => { e.rehearsal_rows[2].cancel_status = 0; })).toContain("cancel receipt status is 0");
    expect(m((e) => { e.rehearsal_rows.push({ ...e.rehearsal_rows[0] }); })).toContain("more than one evidence entry");
    expect(m((e) => { e.rehearsal_rows[1].schedule_tx = e.rehearsal_rows[0].schedule_tx; })).toContain("is also the schedule_tx");
    expect(m((e) => { e.rehearsal_rows.push({ step: "other" }); })).toContain("is not one of");
  });
});

describe("forged evidence cannot skip the gap check (review B1)", () => {
  test("a production unpause flagged cancelled with a 5 s gap still fails the offline gap check", () => {
    const e = prod(); e.govern[0].execute_block_timestamp = e.govern[0].schedule_block_timestamp + 5;
    expect(problems(e)).toContain("gap 5 s is under 172800"); // baseline
    e.govern[0].cancelled = true;
    const out = problems(e);
    expect(out).toContain("gap 5 s is under 172800"); // mutation: the flag does not skip it
    expect(out).toContain("cancelled is not a field of an executed operation");
  });
  test("cancelled, cancel_tx and cancel_status are refused on govern, receipt_releases and receipt_applications entries, in every kind", () => {
    for (const k of ["cancelled", "cancel_tx", "cancel_status"]) {
      const g = prod(); g.govern[1][k] = k === "cancelled" ? true : h(1);
      expect(problems(g)).toContain(`${k} is not a field of an executed operation`);
      const r = path(reh()); r.receipt_applications[0][k] = k === "cancelled" ? true : h(1);
      expect(problems(r, R)).toContain(`${k} is not a field of an executed operation`);
      const c = path(reh()); c.committee_registrations[0][k] = true;
      expect(problems(c, R)).toContain(`${k} is not a field of an executed operation`);
    }
    const rel: any = prod(); rel.consensus_receipt = { address: a(32) };
    rel.receipt_releases = [{ step: "release-receipt", receipt_id: RID, target: a(32), operation_id: h(820), schedule_tx: h(230), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(231), execute_status: 1, execute_block_timestamp: T0 + 5, cancelled: true }];
    expect(problems(rel)).toContain("gap 5 s is under 172800");
    expect(problems(rel)).toContain("cancelled is not a field");
  });
  test("in a rehearsal the cancel flag on an update-delay or batch row does not skip its gap, while the real cancel row is still exempt", () => {
    const e = rows(reh()); e.rehearsal_rows[0].execute_block_timestamp = T0 + 5; e.rehearsal_rows[0].cancelled = true;
    expect(problems(e, R)).toContain("gap 5 s is under 900");
    expect(checkEvidence(rows(reh()), undefined, R)).toEqual([]); // mutation: the genuine cancel row has no execute and passes
  });
});

describe("the receipt path of a rehearsal", () => {
  test("a registered submitter, a recorded receipt and the application of that same receipt pass", () => expect(checkEvidence(path(reh()), undefined, R)).toEqual([]));
  test("production refuses both lists", () => {
    const e: any = path(prod());
    expect(problems(e)).toContain("committee_registrations is present in a production evidence");
    expect(problems(e)).toContain("recorded_receipts is present in a production evidence");
  });
  test("an application whose receipt was never recorded in this run (a fixture) is refused", () => {
    const e = path(reh()); e.recorded_receipts = [];
    expect(problems(e, R)).toContain("no recorded_receipts entry");
  });
  test("an application whose digest differs from the recorded receipt's is refused", () => {
    const e = path(reh()); e.receipt_applications[0].payload_digest = h(0xbad);
    expect(problems(e, R)).toContain("differs from the recorded receipt's");
  });
  test("a receipt recorded by an unregistered submitter is refused", () => {
    const e = path(reh()); e.recorded_receipts[0].submitter = a(0xbad);
    expect(problems(e, R)).toContain("has no committee_registrations entry");
    e.recorded_receipts[0].submitter = SUB;
    expect(checkEvidence(e, undefined, R)).toEqual([]);
  });
  test("the shape of each entry is checked: addresses, label, validity, digest, uri, status, transaction", () => {
    const m = (f: (e: any) => void) => { const e = path(reh()); f(e); return problems(e, R); };
    expect(m((e) => { e.committee_registrations[0].submitter = "x"; })).toContain("submitter is not an address");
    expect(m((e) => { e.committee_registrations[0].gateway = "x"; })).toContain("gateway is not an address");
    expect(m((e) => { e.committee_registrations[0].timelock = a(1); })).toContain("is not the run's timelock");
    expect(m((e) => { e.committee_registrations[0].agent_label = ""; })).toContain("agent_label is missing");
    expect(m((e) => { e.committee_registrations[0].valid_until = "soon"; })).toContain("valid_until");
    expect(m((e) => { e.committee_registrations[0].execute_block_timestamp = T0 + 899; })).toContain("gap 899 s");
    expect(m((e) => { e.recorded_receipts[0].payload_digest = "0x1"; })).toContain("payload_digest is not a bytes32");
    expect(m((e) => { e.recorded_receipts[0].payload_uri = "ftp://x"; })).toContain("payload_uri");
    expect(m((e) => { e.recorded_receipts[0].tx_hash = ""; })).toContain("tx_hash is missing");
    expect(m((e) => { e.recorded_receipts[0].status = 0; })).toContain("status is 0");
    expect(m((e) => { e.recorded_receipts.push({ ...e.recorded_receipts[0] }); })).toContain("more than one evidence entry");
    expect(m((e) => { e.committee_registrations[0].schedule_tx = e.govern[0].schedule_tx; })).toContain("is also the");
  });
  test("a recorded receipt that was already on chain needs no transaction of its own", () => {
    const e = path(reh()); delete e.recorded_receipts[0].tx_hash; e.recorded_receipts[0].already_recorded = true;
    expect(checkEvidence(e, undefined, R)).toEqual([]);
  });
  test("no key, passphrase or keystore path is a field of the evidence", () => {
    expect(JSON.stringify(path(reh()))).not.toMatch(/private|passphrase|keystore|mnemonic/i);
  });
});

// ---- on chain: the registration batch and the rehearsal rows against a stub that returns timelock events ----
const TL = a(9);
const TLABI = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
const sched = (id: Hex, i: number, target: string, data: Hex, delay: number) => ({ address: TL, topics: encodeEventTopics({ abi: TLABI, eventName: "CallScheduled", args: { id, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [target as Hex, 0n, data, h(0) as Hex, BigInt(delay)]) });
const exec = (id: Hex, i: number, target: string, data: Hex) => ({ address: TL, topics: encodeEventTopics({ abi: TLABI, eventName: "CallExecuted", args: { id, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [target as Hex, 0n, data]) });
const stub = (rcs: Record<string, { status?: "success" | "reverted"; logs: any[]; block: bigint }>, blocks: Record<string, number>): ChainReader => ({
  getChainId: async () => 8453, getTransactionCount: async () => 0,
  getTransactionReceipt: async ({ hash }) => { const r = rcs[hash]; if (!r) throw new Error("no receipt"); return { status: r.status ?? "success", blockNumber: r.block, logs: r.logs }; },
  getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks[blockNumber.toString()]!) }), readContract: async () => { throw new Error("unused"); },
});

describe("the registration batch and the rehearsal rows on chain", () => {
  const validUntil = 9999999n;
  const calls = () => buildRegisterCalls(a(30) as never, TL as never, SUB as never, "s", validUntil);
  const regEvidence = () => { const e = path(reh()); e.committee_registrations[0].valid_until = validUntil.toString(); return e; };
  const chain = (delay = 900, gap = 900, tweak: (c: ReturnType<typeof calls>) => void = () => {}) => {
    const c = calls(); tweak(c);
    const id = h(810) as Hex;
    return stub({
      [h(210)]: { block: 1n, logs: c.map((x, i) => sched(id, i, x.target, x.data, delay)) },
      [h(211)]: { block: 2n, logs: calls().map((x, i) => exec(id, i, x.target, x.data)) },
      [h(220)]: { block: 3n, logs: [] },
    }, { "1": T0, "2": T0 + gap, "3": T0 + gap });
  };
  const run = (c: ChainReader, f: (e: any) => void = () => {}) => { const e = regEvidence(); f(e); return checkReceiptPathOnChain(e, c, 900).then((p) => p.join("\n")); };
  test("a registration whose calls are exactly authorizeAgent and committeeRegister for the recorded submitter, label and validity passes", async () => expect(await run(chain())).toBe(""));
  test("a different label or submitter in the evidence than in the scheduled calldata is refused", async () => {
    expect(await run(chain(), (e) => { e.committee_registrations[0].agent_label = "other"; })).toContain("calldata is not");
    expect(await run(chain(), (e) => { e.committee_registrations[0].submitter = a(0x5ab2); })).toContain("calldata is not");
  });
  test("a scheduled delay under the rehearsal floor, at the production floor, or a short block gap is refused", async () => {
    expect(await run(chain(899))).toContain("is under 900");
    expect(await run(chain(172800))).toContain("CallScheduled delay");
    expect(await run(chain(900, 899))).toContain("gap is under 900");
  });
  test("a registration that schedules a third call, or another target, is refused", async () => {
    expect(await run(chain(900, 900, (c) => { c[1] = { ...c[1]!, target: a(99) as never }; }))).toContain("is not the gateway");
  });
  test("a reverted recorded-receipt transaction is refused", async () => {
    const c = chain(); const inner = c.getTransactionReceipt;
    const bad: ChainReader = { ...c, getTransactionReceipt: async (x) => (x.hash === h(220) ? { ...(await inner(x)), status: "reverted" } : inner(x)) };
    expect(await run(bad)).toContain("recorded receipt");
  });
  test("checkEvidenceOnChain in production does not run the rehearsal checks, and refuses a rehearsal evidence as production", async () => {
    const out = await checkEvidenceOnChain(reh(), stub({}, {}), { safe: 2 });
    expect(out.join("\n")).toContain("the evidence is checked as production");
  });
});
