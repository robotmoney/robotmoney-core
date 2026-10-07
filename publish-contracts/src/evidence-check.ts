#!/usr/bin/env bun
// Evidence check for a mainnet run. Reads evidence/<run-id>/evidence.json (template: publish-contracts/evidence.example.json).
// Usage: bun src/evidence-check.ts --evidence FILE [--frozen FILE --deploy-sha SHA] [--rpc URL [--record-chain-fixture OUT] | --chain-fixture FILE]
// Rejects: a wrong tx count against the frozen count, a missing tx hash, a failed receipt, a delay under 172800 s, a govern
// schedule-to-execute gap under 172800 s, a govern step that shares a round (a transaction or an operation id) with another step, a step scheduled
// before the previous step executed, a chain id other than 8453, owner exceptions recorded at or after plan approval.
// Offline mode (no --rpc) checks the recorded JSON shape only. Online mode (--rpc URL, chain 8453) reads the chain with viem and
// does not trust the recorded numbers: deployer nonce, every receipt status, the timelock events and block timestamps of each
// govern step, registry.listVaults() against the recorded manifests, and depositsPaused() of the basket vaults against the unpause govern rows.
// Recorded-fixture mode (--chain-fixture FILE, with --frozen) runs the same chain checks over a fixture of what the chain returned, recorded at the end
// of the run with --rpc ... --record-chain-fixture OUT. CI uses it: acceptance criteria 2 (nonce and per-stage counts) and 3 (receipts, 48 hour gap)
// are checked with no RPC and no network. No secret is read or needed.
import { decodeEventLog, parseAbi, type Hex } from "viem";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MAINNET_CHAIN_ID, MAINNET_DELAY_FLOOR } from "./floors.ts";
import { assertOwnerExceptions } from "./plan.ts";
import { sumCounts } from "./counts.ts";

const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * The Stage 13 matrix from the plan: one govern entry per step, and one 48-hour round per step (owner decision, 2026-10-05): each step has its own
 * schedule transaction, its own execute transaction and its own timelock operation. cancel has a cancel_tx in place of an execute_tx.
 * The names are the rows of the govern CLI (src/govern.ts GOVERN_ROWS).
 */
export const BASKETS = ["PROTO", "AGENT", "RWA"] as const;
export const GOVERN_STEPS: readonly string[] = [
  "voting-power-quorum", "agents", "other-setters",
  ...BASKETS.map((b) => `migrate-eligibility-${b}`),
  "router-weights",
  ...BASKETS.map((b) => `unpause-${b}`),
  "update-delay", "batch", "cancel",
];

export function checkEvidence(ev: any, frozenCounts?: Record<string, number>): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  if (ev?.chain_id !== MAINNET_CHAIN_ID) bad(`chain_id is ${ev?.chain_id}, evidence is read for ${MAINNET_CHAIN_ID}`);
  if (!/^[0-9a-f]{40}$/.test(ev?.core_sha ?? "") || /^0+$/.test(ev.core_sha)) bad("core_sha is missing or a placeholder");
  try { assertOwnerExceptions(ev?.owner_exceptions, ev?.plan_approved_at); } catch (e) { bad((e as Error).message); }

  const stages: any[] = Array.isArray(ev?.stages) ? ev.stages : [];
  if (stages.length === 0) bad("no stages recorded");
  for (const s of stages) {
    const hashes: unknown[] = Array.isArray(s.tx_hashes) ? s.tx_hashes : [];
    const st: unknown[] = Array.isArray(s.receipts_status) ? s.receipts_status : [];
    if (s.frozen_count !== s.receipt_count) bad(`stage ${s.stage}: frozen_count ${s.frozen_count} differs from receipt_count ${s.receipt_count}`);
    if (frozenCounts && s.stage in frozenCounts && frozenCounts[s.stage] !== s.receipt_count) bad(`stage ${s.stage}: receipt_count ${s.receipt_count} differs from the frozen file (${frozenCounts[s.stage]})`);
    if (hashes.length !== s.receipt_count) bad(`stage ${s.stage}: ${hashes.length} tx hashes for ${s.receipt_count} receipts`);
    hashes.forEach((h, i) => { if (typeof h !== "string" || !TX.test(h)) bad(`stage ${s.stage}: tx hash ${i} is missing or malformed`); });
    if (st.length !== hashes.length) bad(`stage ${s.stage}: ${st.length} receipt statuses for ${hashes.length} tx hashes`);
    st.forEach((x, i) => { if (x !== 1) bad(`stage ${s.stage}: receipt ${i} status is ${x}, not 1`); });
  }

  if (!ADDR.test(ev?.safe?.address ?? "") || !TX.test(ev?.safe?.creation_tx ?? "")) bad("safe address or creation_tx is missing");
  if (!ADDR.test(ev?.timelock?.address ?? "")) bad("timelock address is missing");
  if (!(ev?.timelock?.min_delay >= MAINNET_DELAY_FLOOR)) bad(`timelock min_delay ${ev?.timelock?.min_delay} is under ${MAINNET_DELAY_FLOOR} s`);
  if (!(ev?.safe?.owners?.length >= 3) || !(ev?.safe?.threshold >= 2)) bad("safe owners or threshold are under the floor (3 owners, threshold 2)");
  for (const k of ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]) if (!ADDR.test(ev?.vaults?.[k]?.address ?? "")) bad(`vault ${k} address is missing`);

  const govern: any[] = Array.isArray(ev?.govern) ? ev.govern : [];
  for (const step of GOVERN_STEPS) if (!govern.some((g) => g?.step === step)) bad(`govern step '${step}' of the Stage 13 matrix has no evidence entry`);
  for (const g of govern) if (!GOVERN_STEPS.includes(g?.step)) bad(`govern step '${g?.step}' is not a step of the Stage 13 matrix (one round per step: ${GOVERN_STEPS.join(", ")})`);
  for (const step of GOVERN_STEPS) if (govern.filter((g) => g?.step === step).length > 1) bad(`govern step '${step}' has more than one evidence entry`);
  // one round per step: no schedule or execute transaction is shared by two steps
  for (const field of ["schedule_tx", "execute_tx", "cancel_tx"]) {
    const seen = new Map<string, string>();
    for (const g of govern) {
      const h = typeof g?.[field] === "string" ? g[field].toLowerCase() : "";
      if (!TX.test(h)) continue;
      const other = seen.get(h);
      if (other !== undefined) bad(`govern ${g.step}: ${field} is also the ${field} of step '${other}' (one round per step, no shared rounds)`);
      else seen.set(h, g.step);
    }
  }
  // rounds run one after the other: a step is scheduled only after the previous step executed
  let prevExec: { step: string; ts: number } | undefined;
  for (const step of GOVERN_STEPS) {
    const g = govern.find((x) => x?.step === step);
    if (!g) continue;
    const sched = Number(g.schedule_block_timestamp);
    if (prevExec && Number.isFinite(sched) && sched < prevExec.ts) bad(`govern ${step}: scheduled at ${sched}, before step '${prevExec.step}' executed at ${prevExec.ts} (rounds run one at a time)`);
    const ex = Number(g.execute_block_timestamp);
    if (step !== "cancel" && Number.isFinite(ex)) prevExec = { step, ts: ex };
  }
  for (const g of govern) {
    if (!TX.test(g.schedule_tx ?? "")) bad(`govern ${g.step}: schedule_tx is missing`);
    if (g.schedule_status !== 1) bad(`govern ${g.step}: schedule receipt status is ${g.schedule_status}`);
    if (g.step === "cancel") {
      if (!TX.test(g.cancel_tx ?? "")) bad(`govern ${g.step}: cancel_tx is missing`);
      if (g.cancel_status !== 1) bad(`govern ${g.step}: cancel receipt status is ${g.cancel_status}`);
      continue;
    }
    if (!TX.test(g.execute_tx ?? "")) bad(`govern ${g.step}: execute_tx is missing`);
    if (g.execute_status !== 1) bad(`govern ${g.step}: execute receipt status is ${g.execute_status}`);
    const gap = Number(g.execute_block_timestamp) - Number(g.schedule_block_timestamp);
    if (!(gap >= MAINNET_DELAY_FLOOR)) bad(`govern ${g.step}: schedule-to-execute gap ${gap} s is under ${MAINNET_DELAY_FLOOR} s`);
  }
  if (!ADDR.test(ev?.deployer ?? "")) bad("deployer address is missing");
  if (!ADDR.test(ev?.registry?.address ?? "")) bad("registry address is missing");
  if (!Number.isInteger(ev?.deployer_nonce_final)) bad("deployer_nonce_final is missing");
  if (frozenCounts && ev?.deployer_nonce_final !== sumCounts(frozenCounts)) bad(`deployer_nonce_final ${ev?.deployer_nonce_final} differs from the summed frozen counts ${sumCounts(frozenCounts)}`);
  if (ev?.verifier?.exit_code !== 0) bad("the verifier did not exit 0");
  if (ev?.verifier?.registry_list_vaults_equals_manifests !== true) bad("registry listVaults was not shown equal to the manifests");
  if (ev?.sources?.blockscout_all_verified !== true || ev?.sources?.sourcify_all_exact !== true) bad("source verification is not complete");
  return p;
}

/** The slice of a viem PublicClient this check uses. A stub implements it in unit tests. */
export interface ChainReader {
  getChainId(): Promise<number>;
  getTransactionCount(a: { address: `0x${string}` }): Promise<number>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] }>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  readContract(a: { address: `0x${string}`; abi: any; functionName: string }): Promise<unknown>;
}

const TIMELOCK_ABI = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
const REGISTRY_ABI = parseAbi(["function listVaults() view returns (address[])"]);
const PAUSED_ABI = parseAbi(["function depositsPaused() view returns (bool)"]);
const lc = (x: string) => x.toLowerCase();

function timelockEvents(rc: Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>, timelock: string, name: "CallScheduled" | "CallExecuted" | "Cancelled") {
  const out: { id: string; delay?: bigint }[] = [];
  for (const l of rc.logs) {
    if (lc(l.address) !== lc(timelock)) continue;
    try {
      const d: any = decodeEventLog({ abi: TIMELOCK_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === name) out.push({ id: d.args.id as string, delay: d.args.delay as bigint | undefined });
    } catch { /* another event of the timelock */ }
  }
  return out;
}

/** Reads chain 8453 and checks the recorded evidence against it. Returns problems; an empty list is a pass. */
export async function checkEvidenceOnChain(ev: any, chain: ChainReader, frozenCounts: Record<string, number>): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const id = await chain.getChainId();
  if (id !== MAINNET_CHAIN_ID) { bad(`the RPC reports chain ${id}, evidence is read on ${MAINNET_CHAIN_ID}`); return p; }
  const want = sumCounts(frozenCounts);
  const nonce = await chain.getTransactionCount({ address: ev.deployer });
  if (nonce !== want) bad(`deployer nonce on chain is ${nonce}, the summed frozen counts say ${want}`);

  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const s of ev.stages ?? []) for (const [i, h] of (s.tx_hashes ?? []).entries()) await status(`stage ${s.stage} tx ${i}`, h);
  if (ev.safe?.creation_tx) await status("safe creation", ev.safe.creation_tx);

  try {
    const listed = ((await chain.readContract({ address: ev.registry.address, abi: REGISTRY_ABI, functionName: "listVaults" })) as string[]).map(lc).sort();
    const recorded = Object.values(ev.vaults ?? {}).map((v: any) => lc(v?.address ?? "")).sort();
    if (JSON.stringify(listed) !== JSON.stringify(recorded)) bad(`registry.listVaults() [${listed.join(",")}] differs from the manifest vaults [${recorded.join(",")}]`);
  } catch (e) { bad(`registry.listVaults() not readable (${(e as Error).message})`); }

  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const idsByStep = new Map<string, string>();
  let prevExecTs: { step: string; ts: number } | undefined;
  const byStep = (ev.govern ?? []).slice().sort((x: any, y: any) => GOVERN_STEPS.indexOf(x?.step) - GOVERN_STEPS.indexOf(y?.step));
  for (const g of byStep) {
    const sc = await status(`govern ${g.step} schedule`, g.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled");
    if (scheduled.length === 0) { bad(`govern ${g.step}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    for (const e of scheduled) if (!(e.delay !== undefined && e.delay >= BigInt(MAINNET_DELAY_FLOOR))) bad(`govern ${g.step}: CallScheduled delay ${e.delay} is under ${MAINNET_DELAY_FLOOR} s`);
    // one round per step: a timelock operation id belongs to one step only, and a step is scheduled after the previous step executed
    for (const e of scheduled) {
      const other = idsByStep.get(e.id);
      if (other !== undefined && other !== g.step) bad(`govern ${g.step}: the timelock operation ${e.id} is also the operation of step '${other}' (one round per step, no shared rounds)`);
      idsByStep.set(e.id, g.step);
    }
    const schedTs = await ts(sc);
    if (prevExecTs && schedTs < prevExecTs.ts) bad(`govern ${g.step}: scheduled on chain at ${schedTs}, before step '${prevExecTs.step}' executed at ${prevExecTs.ts} (rounds run one at a time)`);
    if (g.step === "cancel") {
      const cc = await status(`govern ${g.step} cancel`, g.cancel_tx);
      if (cc && !timelockEvents(cc, ev.timelock.address, "Cancelled").some((e) => scheduled.some((s) => s.id === e.id))) bad(`govern ${g.step}: the cancel tx has no Cancelled event for the scheduled id`);
      continue;
    }
    const ex = await status(`govern ${g.step} execute`, g.execute_tx);
    if (!ex) continue;
    if (!timelockEvents(ex, ev.timelock.address, "CallExecuted").some((e) => scheduled.some((s) => s.id === e.id))) bad(`govern ${g.step}: the execute tx has no CallExecuted event for the scheduled id`);
    const execTs = await ts(ex);
    prevExecTs = { step: g.step, ts: execTs };
    const gap = execTs - schedTs;
    if (!(gap >= MAINNET_DELAY_FLOOR)) bad(`govern ${g.step}: on-chain schedule-to-execute gap ${gap} s is under ${MAINNET_DELAY_FLOOR} s`);
  }
  // The unpause govern rows and the depositsPaused() reads must tell one story: a basket vault is unpaused on chain exactly when its unpause step executed.
  for (const b of BASKETS) {
    const row = (ev.govern ?? []).find((g: any) => g?.step === `unpause-${b}`);
    const vault = ev.vaults?.[`rm${b}`]?.address;
    if (!vault) continue;
    let paused: unknown;
    try { paused = await chain.readContract({ address: vault, abi: PAUSED_ABI, functionName: "depositsPaused" }); }
    catch (e) { bad(`rm${b}.depositsPaused() not readable (${(e as Error).message})`); continue; }
    const executed = !!row && row.execute_status === 1 && TX.test(row.execute_tx ?? "");
    if (executed && paused !== false) bad(`govern unpause-${b} executed with receipt status 1, but rm${b}.depositsPaused() reads ${String(paused)} on chain, want false`);
    if (!executed && paused === false) bad(`rm${b}.depositsPaused() reads false on chain, but govern unpause-${b} has no executed receipt`);
  }
  return p;
}

// ---- recorded chain fixture: the chain reads of one run, kept as data so the check can run offline ----

/** What a run's chain reads looked like. Every number is a decimal string or a JSON number; no secret is ever in it. */
export interface ChainFixture {
  chainId: number;
  nonces: Record<string, number>;
  /** A list with a `hash` field, not a map keyed by hash: the evidence secret scan reads a bare 64-hex key as key material. */
  receipts: { hash: string; status: "success" | "reverted"; blockNumber: string; logs: { address: string; topics: Hex[]; data: Hex }[] }[];
  blocks: Record<string, number>;
  reads: Record<string, unknown>;
}

const readKey = (address: string, fn: string) => `${lc(address)}:${fn}`;

/** A ChainReader that answers from a fixture. A read the fixture lacks is an error: an offline check never guesses. */
export function chainReaderFromFixture(fx: ChainFixture): ChainReader {
  const miss = (what: string): never => { throw new Error(`the chain fixture has no ${what}`); };
  return {
    getChainId: async () => fx.chainId,
    getTransactionCount: async ({ address }) => fx.nonces[lc(address)] ?? miss(`nonce of ${address}`),
    getTransactionReceipt: async ({ hash }) => {
      const r = fx.receipts.find((x) => lc(x.hash) === lc(hash)) ?? miss(`receipt ${hash}`);
      return { status: r.status, blockNumber: BigInt(r.blockNumber), logs: r.logs };
    },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(fx.blocks[blockNumber.toString()] ?? miss(`block ${blockNumber}`)) }),
    readContract: async ({ address, functionName }) => {
      const k = readKey(address, functionName);
      return k in fx.reads ? fx.reads[k] : miss(`read ${k}`);
    },
  };
}

/** Wraps a live reader and records every answer into a fixture. Run the real check through it once, then write `fixture` to disk. */
export function recordingChainReader(inner: ChainReader): { reader: ChainReader; fixture: ChainFixture } {
  const fixture: ChainFixture = { chainId: 0, nonces: {}, receipts: [], blocks: {}, reads: {} };
  const reader: ChainReader = {
    getChainId: async () => (fixture.chainId = await inner.getChainId()),
    getTransactionCount: async (a) => (fixture.nonces[lc(a.address)] = await inner.getTransactionCount(a)),
    getTransactionReceipt: async (a) => {
      const r = await inner.getTransactionReceipt(a);
      fixture.receipts = fixture.receipts.filter((x) => lc(x.hash) !== lc(a.hash));
      fixture.receipts.push({ hash: lc(a.hash), status: r.status, blockNumber: r.blockNumber.toString(), logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) });
      return r;
    },
    getBlock: async (a) => {
      const b = await inner.getBlock(a);
      fixture.blocks[a.blockNumber.toString()] = Number(b.timestamp);
      return b;
    },
    readContract: async (a) => {
      const v = await inner.readContract(a);
      fixture.reads[readKey(a.address, a.functionName)] = typeof v === "bigint" ? v.toString() : v;
      return v;
    },
  };
  return { reader, fixture };
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["64-hex value (private key shape)", /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["keystore json", /"ciphertext"\s*:|"crypto"\s*:\s*\{/],
  ["mnemonic-like phrase", /\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/],
  ["secret assignment", /\b(PRIVATE_KEY|MNEMONIC|ETH_PASSWORD|PASSWORD|API_KEY|TOKEN)\s*[=:]\s*\S{6,}/i],
];

/** Scan one evidence folder for secrets. Transaction hashes are 64-hex by design: they are allowed in the fields that name a tx. */
export function scanEvidenceFolder(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        for (const [name, re] of SECRET_PATTERNS) {
          if (name.startsWith("64-hex") && /(tx|hash|transaction|block|codehash|salt|digest|sha|0x[0-9a-fA-F]{64}",?\s*$)/i.test(line)) continue;
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}`);
        }
      });
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, frozen: { type: "string" }, "deploy-sha": { type: "string" }, rpc: { type: "string" }, "chain-fixture": { type: "string" }, "record-chain-fixture": { type: "string" } } });
  if (!values.evidence) { console.error("missing --evidence FILE"); process.exit(2); }
  const ev = JSON.parse(readFileSync(values.evidence, "utf8"));
  let counts: Record<string, number> | undefined;
  if (values.frozen) {
    const j = JSON.parse(readFileSync(values.frozen, "utf8"));
    if (values["deploy-sha"] && j.deploySha !== values["deploy-sha"]) { console.error(`evidence: frozen file is for ${j.deploySha}, not ${values["deploy-sha"]}`); process.exit(1); }
    counts = j.counts ?? j;
  }
  const problems = [...checkEvidence(ev, counts), ...scanEvidenceFolder(join(values.evidence, ".."))];
  if (values.rpc && values["chain-fixture"]) { console.error("evidence: give --rpc or --chain-fixture, not both"); process.exit(2); }
  if (values["record-chain-fixture"] && !values.rpc) { console.error("evidence: --record-chain-fixture needs --rpc"); process.exit(2); }
  if ((values.rpc || values["chain-fixture"]) && !counts) { console.error("evidence: reading the chain needs --frozen FILE (and --deploy-sha SHA): the nonce is checked against the frozen counts"); process.exit(2); }
  if (values["chain-fixture"] && !values["deploy-sha"]) { console.error("evidence: --chain-fixture needs --deploy-sha SHA, so the frozen file is the one for this deploy"); process.exit(2); }
  if (values.rpc) {
    const { createPublicClient, http } = await import("viem");
    const live = createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader;
    const rec = values["record-chain-fixture"] ? recordingChainReader(live) : undefined;
    problems.push(...(await checkEvidenceOnChain(ev, rec?.reader ?? live, counts!)));
    if (rec && problems.length === 0) { writeFileSync(values["record-chain-fixture"]!, JSON.stringify(rec.fixture, null, 2) + "\n"); console.error(`evidence: chain fixture written to ${values["record-chain-fixture"]}`); }
  } else if (values["chain-fixture"]) {
    problems.push(...(await checkEvidenceOnChain(ev, chainReaderFromFixture(JSON.parse(readFileSync(values["chain-fixture"], "utf8"))), counts!)));
  }
  if (problems.length) { for (const m of problems) console.error(`evidence: ${m}`); process.exit(1); }
  console.log(values.rpc ? "evidence ok (chain read)" : values["chain-fixture"] ? "evidence ok (recorded chain fixture, offline)" : "evidence ok (offline shape only)");
}
if (import.meta.main) main();
