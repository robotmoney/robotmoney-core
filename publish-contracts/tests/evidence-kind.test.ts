// Issue 1727: evidence by deployment kind. A rehearsal evidence is never production evidence and the reverse. The 900 s floor, the start nonce, the rehearsal-only rows and the
// receipt path (registration, REAL recorded receipt, application) are accepted in a rehearsal and refused in production. Each refusal has a mutation (the fixed input passes).
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { checkEvidence, reRegistrationProblems, checkEvidenceOnChain, checkReceiptPathOnChain, GOVERN_STEPS, REHEARSAL_ROWS, type ChainReader } from "../src/evidence-check.ts";
import { buildHistoricalRegisterCalls as buildRegisterCalls } from "../src/committee-register.ts";
import { finalDeployerNonce } from "../src/counts.ts";
import { withUpgradeability } from "./upgradeability-fixture.ts";

const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const T0 = 1000;
const prod = (): any => withUpgradeability({
  chain_id: 8453, core_sha: "ab".repeat(20), plan_approved_at: "2026-10-05T10:00:00Z",
  owner_exceptions: [{ text: "x", recorded_at: "2026-10-04T10:00:00Z" }],
  stages: [{ stage: "safe", frozen_count: 2, receipt_count: 2, tx_hashes: [h(1), h(2)], receipts_status: [1, 1] }],
  safe: { address: a(1), owners: [a(2), a(3), a(4)], threshold: 2, creation_tx: h(3) },
  vaults: { rmUSDC: { address: a(5) }, rmPROTO: { address: a(6) }, rmAGENT: { address: a(7) }, rmRWA: { address: a(8) } },
  timelock: { address: a(9), min_delay: 172800 }, verifier: { exit_code: 0, registry_list_vaults_equals_manifests: true },
  deployer: a(20), deployer_nonce_final: 3, registry: { address: a(21) },
  govern: GOVERN_STEPS.map((step, i) => ({ step, operation_id: h(900 + i), schedule_tx: h(100 + i * 3), schedule_block_timestamp: T0 + i, execute_tx: h(101 + i * 3), execute_block_timestamp: T0 + i + 172800, schedule_status: 1, execute_status: 1 })),
  sources: { blockscout_all_verified: true, sourcify_all_exact: true },
} as any);
const RID = h(0xabc), DIGEST = h(0xd16), SUB = a(0x5ab1);
const reh = (): any => {
  const e: any = prod();
  e.deployment_kind = "rehearsal";
  e.timelock.min_delay = 900;
  e.upgradeability.timelock.min_delay = "900"; // issue 1809: the record read the same timelock
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
/** Issue 1750: the submitter is a 2-of-3 Safe. The evidence entries carry its facts. */
const SAFE_FACTS = { threshold: 2, owners: [a(2), a(3), a(4)], code_hash: h(0xc0de) };
const path = (e: any) => {
  e.committee_registrations = [{ step: "register-committee", submitter: SUB, agent_label: "s", gateway: a(30), ic_policy: a(31), timelock: a(9), valid_until: "9999999", operation_id: h(810), schedule_tx: h(210), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(211), execute_status: 1, submitter_safe: { ...SAFE_FACTS }, execute_block_timestamp: T0 + 900 }];
  e.recorded_receipts = [{ receipt_id: RID, payload_digest: DIGEST, payload_uri: "https://twin.invalid/r.json", submitter: SUB, tx_hash: h(220), status: 1, submitter_safe: { address: SUB, ...SAFE_FACTS, safe_tx_hash: h(0x5a), nonce: 3, signers: [a(2), a(3)], sent_by: a(20) } }];
  e.consensus_receipt = { address: a(32) }; e.governance = { address: a(33) };
  e.receipt_applications = [{ step: "apply-receipt", receipt_id: RID, target: a(33), governance: a(33), vaults: [a(5), a(6)], bps: [9000, 1000], voted_weights_active: true, effective_vaults: [a(5), a(6)], effective_bps: [9000, 1000], payload_digest: DIGEST, operation_id: h(812), schedule_tx: h(212), schedule_status: 1, schedule_block_timestamp: T0 + 10, execute_tx: h(213), execute_status: 1, execute_block_timestamp: T0 + 910 }];
  return e;
};
const R = { kind: "rehearsal" as const };
const problems = (e: any, o?: { kind?: "rehearsal" | "production" }) => checkEvidence(e, undefined, undefined, o).join("\n");

describe("evidence kind", () => {
  test("production evidence passes as production; a rehearsal evidence presented as production is refused (and the reverse)", () => {
    expect(checkEvidence(prod())).toEqual([]);
    expect(problems(reh())).toContain("deployment_kind is rehearsal, the evidence is checked as production");
    expect(problems(reh())).toContain("never production evidence");
    expect(problems(prod(), R)).toContain("deployment_kind is production, the evidence is checked as rehearsal");
    expect(checkEvidence(reh(), undefined, undefined, R)).toEqual([]); // mutation: asked for as a rehearsal it passes
  });
  test("an explicit deployment_kind production passes; an unknown kind is refused", () => {
    expect(checkEvidence({ ...prod(), deployment_kind: "production" })).toEqual([]);
    expect(problems({ ...prod(), deployment_kind: "staging" })).toContain("deployment_kind 'staging'");
  });
  test("the 900 s floor is a rehearsal floor only: min_delay 900 passes as a rehearsal, fails as production", () => {
    const e = prod(); e.timelock.min_delay = 900;
    expect(problems(e)).toContain("min_delay 900 is under 172800");
    const r = reh();
    expect(checkEvidence(r, undefined, undefined, R)).toEqual([]);
    r.timelock.min_delay = 899;
    expect(problems(r, R)).toContain("is under 900");
    r.timelock.min_delay = 172800;
    expect(problems(r, R)).toContain("cannot be told from production");
    r.timelock.min_delay = 172799;
    r.upgradeability.timelock.min_delay = "172799";
    expect(checkEvidence(r, undefined, undefined, R)).toEqual([]);
  });
  test("govern gaps follow the kind: 900 s passes as a rehearsal, fails as production", () => {
    const r = reh();
    expect(checkEvidence(r, undefined, undefined, R)).toEqual([]);
    expect(problems(r, { kind: "production" })).toContain("gap 900 s is under 172800");
    r.govern[0].execute_block_timestamp = T0 + 899;
    expect(problems(r, R)).toContain("gap 899 s is under 900");
  });
  test("the deployer start nonce: rehearsal counts from it, production refuses one and counts from 0", () => {
    const counts = { safe: 2 };
    const r = reh(); r.deployer_nonce_final = finalDeployerNonce(counts, 118);
    expect(checkEvidence(r, counts, undefined, R)).toEqual([]);
    r.deployer_nonce_final = finalDeployerNonce(counts);
    expect(checkEvidence(r, counts, undefined, R).join()).toContain("start nonce 118");
    delete r.deployer_start_nonce;
    expect(checkEvidence(r, counts, undefined, R).join()).toContain("deployer_start_nonce is missing");
    const p = prod(); p.deployer_nonce_final = finalDeployerNonce(counts); p.deployer_start_nonce = 118;
    expect(checkEvidence(p, counts).join()).toContain("deployer_start_nonce is present in a production evidence");
  });
  test("update-delay, batch and cancel: refused on 8453 in production (govern and rehearsal_rows), accepted under rehearsal_rows in a rehearsal", () => {
    expect([...REHEARSAL_ROWS]).toEqual(["update-delay", "batch", "cancel"]);
    expect(checkEvidence(rows(reh()), undefined, undefined, R)).toEqual([]);
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
    expect(checkEvidence(rows(reh()), undefined, undefined, R)).toEqual([]); // mutation: the genuine cancel row has no execute and passes
  });
});

describe("the receipt path of a rehearsal (HISTORICAL register-committee fixtures stay valid, issue 1888)", () => {
  test("a registered submitter, a recorded receipt and the application of that same receipt pass", () => expect(checkEvidence(path(reh()), undefined, undefined, R)).toEqual([]));
  test("issue 1888: production no longer refuses the lists (a Safe records on 8453 in production); the same entry checks run and a single key is still refused", () => {
    const e: any = path(prod());
    expect(problems(e)).not.toContain("is present in a production evidence");
    delete e.recorded_receipts[0].submitter_safe;
    expect(problems(e)).toContain("no submitter_safe: the consensus receipt submitter is a multisig Safe on every chain");
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
    expect(problems(e, R)).toContain("has no submitter_registrations (or historical committee_registrations) entry");
    e.recorded_receipts[0].submitter = SUB;
    expect(checkEvidence(e, undefined, undefined, R)).toEqual([]);
  });
  test("issue 1750: a single-key submitter is refused on 8453, a role key is refused anywhere, and the Safe facts are checked (mutation: the Safe passes)", () => {
    const m = (f: (e: any) => void) => { const e = path(reh()); f(e); return problems(e, R); };
    expect(m((e) => { delete e.recorded_receipts[0].submitter_safe; })).toContain("the consensus receipt submitter is a multisig Safe on every chain");
    expect(m((e) => { delete e.committee_registrations[0].submitter_safe; })).toContain("the consensus receipt submitter is a multisig Safe on every chain");
    for (const [who, text] of [[a(9), "the timelock"], [a(1), "the governing Safe"], [a(20), "the deployer"], [a(2), "governing Safe owner 1"]] as const) {
      expect(m((e) => { e.committee_registrations[0].submitter = who; e.recorded_receipts[0].submitter = who; e.recorded_receipts[0].submitter_safe.address = who; })).toContain(text);
    }
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.threshold = 1; })).toContain("threshold is 1");
    expect(m((e) => { e.committee_registrations[0].submitter_safe.owners = [a(2)]; e.committee_registrations[0].submitter_safe.threshold = 2; })).toContain("under its threshold");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.code_hash = "0x1"; })).toContain("code_hash");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.address = a(0x77); })).toContain("is not the submitter");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.safe_tx_hash = ""; })).toContain("safe_tx_hash");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.nonce = -1; })).toContain("nonce");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.signers = [a(2)]; })).toContain("under the threshold");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.signers = [a(2), a(2)]; })).toContain("repeats an owner");
    expect(m((e) => { e.recorded_receipts[0].submitter_safe.signers = [a(2), a(0x66)]; })).toContain("are not owners of the submitter Safe");
    expect(m(() => {})).toBe("");
  });
  test("issue 1750: on the Twin chain a key submitter without submitter_safe stays accepted, but a role key never is", () => {
    const e = path(reh()); e.chain_id = 918453;
    delete e.recorded_receipts[0].submitter_safe; delete e.committee_registrations[0].submitter_safe;
    expect(problems(e, R)).not.toContain("multisig Safe"); // the Twin run manifest is read by --receipt-applications; only chain 8453 evidence needs the Safe
    e.committee_registrations[0].submitter = a(2); e.recorded_receipts[0].submitter = a(2);
    expect(problems(e, R)).toContain("governing Safe owner 1");
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
    expect(checkEvidence(e, undefined, undefined, R)).toEqual([]);
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

describe("the HISTORICAL registration batch and the rehearsal rows on chain", () => {
  const validUntil = 9999999n;
  const calls = () => buildRegisterCalls(a(30) as never, TL as never, SUB as never, "s", validUntil);
  const regEvidence = () => { const e = path(reh()); e.committee_registrations[0].valid_until = validUntil.toString(); return e; };
  // Issue 1750: the submitter Safe emits ExecutionSuccess(safeTxHash, 0) in the recorded receipt transaction and reads threshold 2.
  const execOk = (safe: string, safeTxHash: string) => ({ address: safe, topics: [keccak256(toBytes("ExecutionSuccess(bytes32,uint256)")), safeTxHash as Hex], data: `0x${"0".repeat(64)}` as Hex });
  const chain = (delay = 900, gap = 900, tweak: (c: ReturnType<typeof calls>) => void = () => {}, receiptLogs: any[] = [execOk(SUB, h(0x5a))], threshold = 2n): ChainReader => {
    const c = calls(); tweak(c);
    const id = h(810) as Hex;
    return { ...stub({
      [h(210)]: { block: 1n, logs: c.map((x, i) => sched(id, i, x.target, x.data, delay)) },
      [h(211)]: { block: 2n, logs: calls().map((x, i) => exec(id, i, x.target, x.data)) },
      [h(220)]: { block: 3n, logs: receiptLogs },
    }, { "1": T0, "2": T0 + gap, "3": T0 + gap }), readContract: async () => threshold };
  };
  const run = (c: ChainReader, f: (e: any) => void = () => {}) => { const e = regEvidence(); f(e); return checkReceiptPathOnChain(e, c, 900).then((p) => p.join("\n")); };
  test("a registration whose calls are exactly setPolicy and committeeRegister for the recorded submitter, label and validity passes", async () => expect(await run(chain())).toBe(""));
  test("QA plan v1 B6: the recorded private hand-over must be in a block before the schedule (mutation: one block after the schedule is refused)", async () => {
    const withHandOver = (block: bigint): ChainReader => { const c = chain(); const base = c.getTransactionReceipt; return { ...c, getTransactionReceipt: async ({ hash }) => (hash === h(209) ? { status: "success", blockNumber: block, logs: [] } : base({ hash })) }; };
    const set = (e: any) => { e.committee_registrations[0].self_authorization = { commit_tx: h(207), reveal_tx: h(208), hand_over_tx: h(209) }; };
    expect(await run(withHandOver(0n), set)).toBe("");
    expect(await run(withHandOver(1n), set)).toContain("not before the batch was scheduled");
    expect(await run(withHandOver(2n), set)).toContain("the address was public while unowned");
  });
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
  test("issue 1750: the submitter Safe must have emitted ExecutionSuccess for the recorded Safe transaction hash, and its threshold must match (mutation: both right passes)", async () => {
    expect(await run(chain())).toBe("");
    expect(await run(chain(900, 900, () => {}, []))).toContain("emitted no ExecutionSuccess");
    expect(await run(chain(900, 900, () => {}, [execOk(SUB, h(0x5b))]))).toContain("emitted no ExecutionSuccess"); // another Safe transaction
    expect(await run(chain(900, 900, () => {}, [execOk(a(0x77), h(0x5a))]))).toContain("emitted no ExecutionSuccess"); // another Safe emitted it
    expect(await run(chain(900, 900, () => {}, undefined, 3n))).toContain("threshold on chain is 3");
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


// ---- issue 1888: the live register-submitter evidence (ONE receipt.grantRole), the Safe-only recorded receipts, and the narrow-role release refusal ----
import { buildRegisterCall } from "../src/submitter-register.ts";
describe("issue 1888: submitter_registrations and Safe-recorded receipts, in every kind", () => {
  const RECEIPT = a(32);
  /** The new shape: ONE grantRole call, a Safe submitter, no gateway and no IC policy. `gap` is the schedule-to-execute seconds. */
  const live = (base: any, gap: number): any => {
    const e = path(base);
    delete e.committee_registrations;
    e.submitter_registrations = [{ step: "register-submitter", submitter: SUB, receipt: RECEIPT, timelock: a(9), operation_id: h(810), schedule_tx: h(210), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(211), execute_status: 1, execute_block_timestamp: T0 + gap, submitter_safe: { ...SAFE_FACTS } }];
    return e;
  };
  const liveProd = (): any => { const e = live(prod(), 172800); e.receipt_applications = []; return e; };
  test("a rehearsal and a production evidence with the live shape pass (no production refusal of the lists)", () => {
    expect(checkEvidence(live(reh(), 900), undefined, undefined, R)).toEqual([]);
    expect(checkEvidence(liveProd())).toEqual([]);
  });
  test("a single key (no submitter_safe) is refused in every mode, the Twin chain included", () => {
    for (const [mk, o] of [[() => live(reh(), 900), R], [() => liveProd(), undefined]] as const) {
      for (const chain of [8453, 918453]) {
        for (const list of ["submitter_registrations", "recorded_receipts"]) {
          const e = mk(); e.chain_id = chain; delete e[list][0].submitter_safe;
          expect([chain, list, problems(e, o as never)]).toEqual([chain, list, expect.stringContaining("multisig Safe on every chain")]);
        }
      }
    }
  });
  test("the governing Safe may be the submitter, and its owners may be shared; the timelock and the deployer may not", () => {
    const g = live(reh(), 900); g.safe.address = SUB; g.recorded_receipts[0].submitter_safe.owners = [...g.safe.owners];
    expect(checkEvidence(g, undefined, undefined, R)).toEqual([]);
    for (const [who, text] of [[a(9), "the timelock"], [a(20), "the deployer (admin)"]] as const) {
      const e = live(reh(), 900); e.submitter_registrations[0].submitter = who; e.recorded_receipts[0].submitter = who; e.recorded_receipts[0].submitter_safe.address = who; e.submitter_registrations[0].submitter_safe.address = who;
      expect(problems(e, R)).toContain(text);
    }
  });
  test("the shape of a registration is checked: addresses, step, receipt contract, duplicates, gap", () => {
    const m = (f: (e: any) => void) => { const e = live(reh(), 900); f(e); return problems(e, R); };
    expect(m(() => {})).toBe("");
    expect(m((e) => { e.submitter_registrations[0].submitter = "x"; })).toContain("submitter is not an address");
    expect(m((e) => { e.submitter_registrations[0].receipt = "x"; })).toContain("receipt is not an address");
    expect(m((e) => { e.submitter_registrations[0].receipt = a(77); })).toContain("is not the run's receipt contract");
    expect(m((e) => { e.submitter_registrations[0].step = "register-committee"; })).toContain("is not register-submitter");
    expect(m((e) => { e.submitter_registrations[0].timelock = a(1); })).toContain("is not the run's timelock");
    expect(m((e) => { e.submitter_registrations.push({ ...e.submitter_registrations[0] }); })).toContain("submitter has more than one evidence entry");
    expect(m((e) => { e.submitter_registrations[0].execute_block_timestamp = T0 + 899; })).toContain("gap 899 s");
    expect(m((e) => { e.submitter_registrations[0].cancelled = true; })).toContain("cancelled is not a field of an executed operation");
    expect(m((e) => { e.submitter_registrations = "x"; })).toContain("submitter_registrations is not a list");
  });
  test("a submitter registered by the v0.5.0 tool and again after the receipt migration passes; without the migration between them it is refused (runbook 4.15)", () => {
    const hist = { submitter: SUB, execute_block_timestamp: T0 };
    const again = { submitter: SUB, schedule_block_timestamp: T0 + 5000 };
    const migration = (at: number) => ({ proxy_name: "receipt", migration: { name: "receipt-submitter-roles" }, execute_block_timestamp: at });
    expect(reRegistrationProblems([hist], [again], [migration(T0 + 3000)])).toEqual([]);
    expect(reRegistrationProblems([hist], [again], [migration(T0 + 5000)])).toEqual([]);
    expect(reRegistrationProblems([hist], [again], []).join("\n")).toContain("valid only after a receipt-submitter-roles migration executed between them");
    expect(reRegistrationProblems([hist], [again], [migration(T0 - 1)]).join("\n")).toContain("executed between them"); // before the historical registration
    expect(reRegistrationProblems([hist], [again], [migration(T0 + 5001)]).join("\n")).toContain("executed between them"); // after the new one was scheduled
    expect(reRegistrationProblems([hist], [again], [{ proxy_name: "gateway", migration: { name: "receipt-submitter-roles" }, execute_block_timestamp: T0 + 3000 }, { proxy_name: "receipt", execute_block_timestamp: T0 + 3000 }]).join("\n")).toContain("executed between them");
    expect(reRegistrationProblems([{ submitter: a(99), execute_block_timestamp: T0 }], [again], [])).toEqual([]); // another submitter: nothing to compare
  });
  test("a historical and a new registration of the same submitter in the evidence need the migration; a duplicate inside either list is still refused", () => {
    const e = path(live(reh(), 900));
    expect(problems(e, R)).toContain("submitter is also a historical committee registration");
    const dupNew = live(reh(), 900); dupNew.submitter_registrations.push({ ...dupNew.submitter_registrations[0] });
    expect(problems(dupNew, R)).toContain("submitter has more than one evidence entry");
    const dupHist = path(live(reh(), 900)); dupHist.committee_registrations.push({ ...dupHist.committee_registrations[0] });
    expect(problems(dupHist, R)).toContain("submitter has more than one evidence entry");
  });
  test("a receipt recorded by a submitter with no registration is refused in a rehearsal (mutation: the registered one passes)", () => {
    const e = live(reh(), 900); e.recorded_receipts[0].submitter = a(0xbad); e.recorded_receipts[0].submitter_safe.address = a(0xbad);
    expect(problems(e, R)).toContain("has no submitter_registrations");
  });
  test("a standalone release after the narrow-role handover is refused; the same release in historical evidence (no flag) passes", () => {
    const e: any = prod(); e.consensus_receipt = { address: a(32) };
    e.receipt_releases = [{ step: "release-receipt", receipt_id: RID, target: a(32), operation_id: h(820), schedule_tx: h(230), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(231), execute_status: 1, execute_block_timestamp: T0 + 172800 }];
    expect(checkEvidence(e)).toEqual([]); // historical shape: the release was possible then
    e.consensus_receipt.governance_has_release_role = true;
    expect(problems(e)).toContain("after the narrow-role handover a receipt is released only by apply-receipt");
    e.consensus_receipt.governance_has_release_role = false;
    expect(checkEvidence(e)).toEqual([]);
  });

  describe("on chain", () => {
    const grant = () => buildRegisterCall(RECEIPT as never, SUB as never);
    const topicOf = (x: string) => `0x${x.slice(2).padStart(64, "0")}` as Hex;
    const execOk = (safe: string, safeTxHash: string) => ({ address: safe, topics: [keccak256(toBytes("ExecutionSuccess(bytes32,uint256)")), safeTxHash as Hex], data: `0x${"0".repeat(64)}` as Hex });
    const recorded = (over: Partial<{ address: string; id: Hex }> = {}) => ({ address: over.address ?? RECEIPT, topics: [keccak256(toBytes("ReceiptRecorded(bytes32,address,uint256,bytes32,string,uint64)")), over.id ?? (RID as Hex), topicOf(SUB), topicOf(a(0))], data: "0x" as Hex });
    const chain = (o: { calls?: { target: string; data: Hex }[]; execCalls?: number; delay?: number; gap?: number; receiptLogs?: any[] } = {}): ChainReader => {
      const id = h(810) as Hex;
      const calls = o.calls ?? [grant()];
      return { ...stub({
        [h(210)]: { block: 1n, logs: calls.map((x, i) => sched(id, i, x.target, x.data, o.delay ?? 900)) },
        [h(211)]: { block: 2n, logs: calls.slice(0, o.execCalls ?? calls.length).map((x, i) => exec(id, i, x.target, x.data)) },
        [h(220)]: { block: 3n, logs: o.receiptLogs ?? [execOk(SUB, h(0x5a)), recorded()] },
      }, { "1": T0, "2": T0 + (o.gap ?? 900), "3": T0 + (o.gap ?? 900) }), readContract: async () => 2n };
    };
    const run = (c: ChainReader, f: (e: any) => void = () => {}) => { const e = live(reh(), 900); f(e); return checkReceiptPathOnChain(e, c, 900).then((p) => p.join("\n")); };
    test("exactly one grantRole(RECEIPT_SUBMITTER_ROLE, submitter) on the receipt contract, executed once, with the ReceiptRecorded log, passes", async () => expect(await run(chain())).toBe(""));
    test("the retired two-call batch (setPolicy, committeeRegister) and any extra call are refused as a new grant batch", async () => {
      const hist = buildRegisterCalls(a(30) as never, TL as never, SUB as never, "s", 9999999n);
      expect(await run(chain({ calls: hist }))).toContain("a registration is exactly one call");
      expect(await run(chain({ calls: [grant(), { target: RECEIPT, data: grant().data }] }))).toContain("a registration is exactly one call");
    });
    test("another target, other calldata (another role or account), a short delay, a short gap or a missing execute are refused", async () => {
      expect(await run(chain({ calls: [{ ...grant(), target: a(99) }] }))).toContain("is not the receipt contract");
      expect(await run(chain({ calls: [{ ...grant(), data: buildRegisterCall(RECEIPT as never, a(0x5ab2) as never).data }] }))).toContain("calldata is not");
      expect(await run(chain({ delay: 899 }))).toContain("is under 900");
      expect(await run(chain({ gap: 899 }))).toContain("gap is under 900");
      expect(await run(chain({ execCalls: 0 }))).toContain("0 CallExecuted events");
      expect(await run(chain(), (e) => { e.submitter_registrations[0].submitter = a(0x5ab2); })).toContain("calldata is not");
    });
    test("a recorded receipt whose transaction lacks the receipt contract's ReceiptRecorded, or the Safe's ExecutionSuccess, is refused (mutation: both present passes)", async () => {
      expect(await run(chain({ receiptLogs: [execOk(SUB, h(0x5a))] }))).toContain("emitted no ReceiptRecorded");
      expect(await run(chain({ receiptLogs: [execOk(SUB, h(0x5a)), recorded({ address: a(99) })] }))).toContain("emitted no ReceiptRecorded");
      expect(await run(chain({ receiptLogs: [execOk(SUB, h(0x5a)), recorded({ id: h(0xdef) as Hex })] }))).toContain("emitted no ReceiptRecorded");
      expect(await run(chain({ receiptLogs: [recorded()] }))).toContain("emitted no ExecutionSuccess");
    });
  });
});


// ---- rehearsal kind + adoption (PR 1722) together: start + sum(effectiveCounts) + proof ----
import { keccak256 as k256 } from "viem";
describe("a rehearsal evidence with adopted stages and a non-zero start nonce", () => {
  const CODE = "0x73" + "11".repeat(20) + "3014608060405260";
  const FROZEN = { safe: 2, libs: 4, proto: 10 };
  const CAP = { safe: 0, libs: 1, proto: 3 };
  const START = 118;
  const adopted = (): any => {
    const e = reh();
    e.deployer_start_nonce = START;
    e.stages.push({ stage: "libs", frozen_count: 4, receipt_count: 0, tx_hashes: [], receipts_status: [], adopted: { deployer_txs: 0, libraries: [{ name: "tick_math", address: a(77), code_hash: k256(CODE as Hex) }] } });
    e.stages.push({ stage: "proto", frozen_count: 10, receipt_count: 7, tx_hashes: Array.from({ length: 7 }, (_, i) => h(60 + i)), receipts_status: Array.from({ length: 7 }, () => 1),
      adopted: { deployer_txs: 7, libraries: ["BasketAssetConfigGuard", "TwapTickMath", "BasketViews"].map((name, i) => ({ name, address: a(80 + i), code_hash: k256(CODE as Hex) })) } });
    e.deployer_nonce_final = START + (2 + 0 + 7) + 1; // start + sum(effectiveCounts) + proof
    return e;
  };
  const off = (e: any) => checkEvidence(e, FROZEN, CAP, R).join("\n");
  test("start 118, libs adopted at 0 and proto at 7 of 10: the final nonce is start + sum(effective) + proof, and it passes", () => expect(off(adopted())).toBe(""));
  test("mutations: without the start, with the un-adjusted frozen sum, or with one stray transaction the final nonce fails", () => {
    for (const final of [(2 + 0 + 7) + 1, START + (2 + 4 + 10) + 1, START + (2 + 0 + 7) + 2, START + (2 + 0 + 7)]) {
      const e = adopted(); e.deployer_nonce_final = final;
      expect(off(e)).toContain("deployer_nonce_final");
    }
  });
  test("adoption bounds still hold in a rehearsal: proto below its frozen count less three, a longer library list than the table allows, and an adopted stage with no start are refused", () => {
    const low = adopted(); low.stages[2].receipt_count = 6; low.stages[2].tx_hashes.pop(); low.stages[2].receipts_status.pop(); low.stages[2].adopted.deployer_txs = 6; low.deployer_nonce_final = START + 2 + 6 + 1;
    expect(off(low)).toContain("is below the frozen count 10 less its 3 adopted libraries");
    const forged = adopted(); forged.stages[2].adopted.libraries.push({ name: "X", address: a(99), code_hash: k256(CODE as Hex) });
    expect(off(forged)).not.toBe("");
    const nostart = adopted(); delete nostart.deployer_start_nonce;
    expect(off(nostart)).toContain("deployer_start_nonce is missing");
  });
  test("on chain: the live deployer nonce must be start + sum(effective) + proof", async () => {
    const reader = (nonce: number): ChainReader => ({ getChainId: async () => 8453, getTransactionCount: async () => nonce, getTransactionReceipt: async () => { throw new Error("none"); }, getBlock: async () => { throw new Error("none"); }, readContract: async () => { throw new Error("none"); }, getCode: async () => CODE as Hex } as never);
    const want = START + 9 + 1;
    const ok = (await checkEvidenceOnChain(adopted(), reader(want), FROZEN, R)).join("\n");
    expect(ok).not.toContain("deployer nonce on chain");
    for (const bad of [want + 1, want - 1, 10]) expect((await checkEvidenceOnChain(adopted(), reader(bad), FROZEN, R)).join("\n")).toContain("deployer nonce on chain");
  });
});
