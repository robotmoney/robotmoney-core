// Reconstructed baseline frozen counts (issue 1733).
//
// The problem. Every Twin fork pinned at or after Base block 52401633 already holds the CREATE2 libraries, so every Twin measuring run ADOPTS them (issue 1721)
// and writes a counts file whose adopted stages are reduced (libs 0, proto 7). Such a file is marked, and 8453 and freeze-counts refuse it. A NEW sha could
// therefore never get a frozen file, and stopped at COUNTS_MISSING on 8453.
//
// The fix. The adopted measuring run keeps an adoption record per adopted stage (library, address, code hash, deployer txs). The count a fresh chain would
// show for that stage is exactly: measured deployer txs + the number of adopted creations (libs 0 + 1, proto 7 + 3 = 10). This module rebuilds that
// BASELINE and marks it `measured.reconstructed`, so nobody mistakes it for a pure measurement. It never weakens the frozen counts, because the baseline is
// BOUNDED on both sides and CHECKED:
//   - below by the measurement: baseline(stage) = measured(stage) + adopted creations, nothing else is added to any stage;
//   - above by the stage table: a stage adopts EXACTLY the libraries the table lists for it (libs: `libraries`, a basket stage: its `create2Libraries`), so at most
//     that many creations are ever added; a partial or inflated adoption list is refused;
//   - each adopted library is re-derived from the BUILD (CREATE2 address of the artifact, runtime code hash) and its code hash is read back from the chain;
//   - optionally cross-checked against the frozen counts of an earlier release: any difference is refused unless the operator names the stage in --accept-diff,
//     and the accepted differences are written into the file.
// A wrong baseline either blocks the run (fail closed) or is refused here. A hand-set marker is verified against the embedded records on every load
// (verifyReconstruction, offline) and the plan on 8453 re-verifies the records against the build and the chain (verifyReconstructionOnChain).
import { isAddress, type Address } from "viem";
import { TWIN_CHAIN_ID } from "./chains.ts";
import { LIBS_STAGE } from "./core-wiring.ts";
import { PublishError } from "./errors.ts";
import { buildCreate2Libraries, verifyAdoptedCreate2, verifyAdoptedLibraries } from "./libs-adopt.ts";
import type { StageTable } from "./stage-table.ts";
import type { FrozenCounts, FrozenFile } from "./counts.ts";

/** One adopted CREATE2 creation of a measuring run. */
export interface ReconstructedLibrary { stage: string; library: string; artifact: string; address: string; codeHash: string }
export interface CrossCheckRecord { against: string; accepted: { stage: string; old: number | null; new: number | null }[] }
/** `measured.reconstructed` of a frozen file. */
export interface Reconstruction {
  /** The adopted Twin measuring run the baseline was rebuilt from. Its sha is the sha of the file. */
  fromRun: { sha: string; chainId: number; pinBlock?: number };
  adopted: ReconstructedLibrary[];
  /** The per-stage counts the measuring run recorded (adopted stages reduced). baseline = this + the adopted creations of the stage. */
  measuredCounts: FrozenCounts;
  crossCheck?: CrossCheckRecord;
}

const refuse = (msg: string, details: Record<string, unknown> = {}): never => { throw new PublishError("COUNTS_MISSING", `reconstructed baseline refused: ${msg}`, details); };
const ADDR_HEX = /^0x[0-9a-fA-F]{40}$/, HASH_HEX = /^0x[0-9a-fA-F]{64}$/;
const lc = (s: string): string => s.toLowerCase();

/** The libraries a stage can adopt, by the table: the libs stage its `libraries`, a basket stage its `create2Libraries`. Other stages adopt none. */
export function adoptableOf(table: StageTable, stage: string): { library: string; artifact: string }[] {
  if (stage === LIBS_STAGE) return table.libraries.map((l) => ({ library: l.name, artifact: l.artifact }));
  const st = table.stages.find((s) => s.name === stage);
  return (st?.create2Libraries ?? []).map((n) => { const l = table.create2Libraries!.find((x) => x.name === n)!; return { library: l.name, artifact: l.artifact }; });
}

const stageKeys = (table: StageTable): string[] => ["safe", ...table.stages.map((s) => s.name)];

/**
 * Offline check of a reconstruction block against the table. Throws COUNTS_MISSING on the first problem. Pure: it reads no chain and no build, so loadFrozen
 * can run it on every load. It proves the file is internally consistent and bounded by the table; verifyReconstructionOnChain proves the records are real.
 */
export function verifyReconstruction(file: Pick<FrozenFile, "deploySha" | "measured" | "counts">, table: StageTable): Reconstruction {
  const r = file.measured.reconstructed as Reconstruction | undefined;
  if (!r || typeof r !== "object") return refuse("no reconstruction block");
  if (Array.isArray(file.measured.adopted) && file.measured.adopted.length > 0) refuse("the file is marked as adopted AND reconstructed");
  if (r.fromRun?.sha !== file.deploySha) refuse(`it was rebuilt from a run at ${String(r.fromRun?.sha)}, the file is for ${file.deploySha}: a baseline is rebuilt from a measuring run at the SAME sha`);
  if (r.fromRun.chainId !== TWIN_CHAIN_ID || file.measured.chainId !== TWIN_CHAIN_ID) refuse(`the measuring run must be a Twin chain (${TWIN_CHAIN_ID}) run, got ${String(r.fromRun.chainId)} / ${String(file.measured.chainId)}`);
  if (r.fromRun.pinBlock !== undefined && !(Number.isInteger(r.fromRun.pinBlock) && r.fromRun.pinBlock > 0)) refuse("pinBlock is not a positive integer");
  if (!Array.isArray(r.adopted) || r.adopted.length === 0) refuse("it records no adopted creation: with nothing adopted the counts are a plain measurement, not a reconstruction");
  const keys = stageKeys(table);
  const have = Object.keys(file.counts).sort().join(), want = [...keys].sort().join();
  if (have !== want) refuse(`its counts name stages [${have}], the stage table names [${want}]`);
  const mhave = Object.keys(r.measuredCounts ?? {}).sort().join();
  if (mhave !== want) refuse(`its measuredCounts name stages [${mhave}], the stage table names [${want}]`);
  for (const [k, v] of Object.entries(r.measuredCounts)) if (!Number.isInteger(v) || v < 0) refuse(`measuredCounts.${k} is not a non-negative integer`);

  const perStage = new Map<string, ReconstructedLibrary[]>();
  const seen = new Set<string>();
  for (const a of r.adopted) {
    if (typeof a?.stage !== "string" || !keys.includes(a.stage)) refuse(`adopted entry names stage '${String(a?.stage)}', which is not a deployer stage`);
    if (!ADDR_HEX.test(String(a.address))) refuse(`adopted ${a.library} has no valid address`);
    if (!HASH_HEX.test(String(a.codeHash))) refuse(`adopted ${a.library} has no valid code hash`);
    const dup = `${a.stage}/${a.library}`;
    if (seen.has(dup) || seen.has(`addr/${lc(a.address)}`)) refuse(`adopted ${dup} is listed twice`);
    seen.add(dup); seen.add(`addr/${lc(a.address)}`);
    perStage.set(a.stage, [...(perStage.get(a.stage) ?? []), a]);
  }
  for (const [stage, list] of perStage) {
    const table_ = adoptableOf(table, stage);
    const listed = list.map((a) => `${a.library}:${a.artifact}`).sort().join(), expected = table_.map((l) => `${l.library}:${l.artifact}`).sort().join();
    if (listed !== expected) refuse(`stage ${stage} adopts [${listed || "nothing"}], the stage table lets it adopt exactly [${expected || "nothing"}]: a baseline is rebuilt only from a fully adopted stage, so it cannot be inflated or hide a dropped creation`, { stage });
  }
  for (const k of keys) {
    const want_ = r.measuredCounts[k]! + (perStage.get(k)?.length ?? 0);
    if (file.counts[k] !== want_) refuse(`stage ${k}: the count is ${file.counts[k]}, the measured count ${r.measuredCounts[k]} plus ${perStage.get(k)?.length ?? 0} adopted creation(s) is ${want_}`, { stage: k });
  }
  const cc = file.measured.crossChecked;
  if (cc !== undefined && (!/^[0-9a-f]{40}$/.test(String(cc?.sha)) || !/^[0-9a-f]{64}$/.test(String(cc?.fileHash)) || cc.sha === file.deploySha)) refuse("crossChecked is malformed");
  if ((r.crossCheck === undefined) !== (cc === undefined)) refuse("crossCheck and crossChecked must both be present or both absent");
  if (r.crossCheck !== undefined && cc !== undefined && r.crossCheck.against !== cc.sha) refuse("crossCheck and crossChecked name different files");
  if (r.crossCheck !== undefined) {
    const c = r.crossCheck;
    if (!/^[0-9a-f]{40}$/.test(String(c?.against)) || !Array.isArray(c.accepted)) refuse("crossCheck is malformed");
    for (const d of c.accepted) if (typeof d?.stage !== "string" || !keys.includes(d.stage)) refuse("crossCheck names an unknown stage");
  }
  return r;
}

/** Where the verifier finds build artifacts: the libs stage artifacts (nothing linked) and the create2 library artifacts (built with TickMath linked). */
export interface BuildOut { linkOut: string; c2Out: string }
const libsFail = (msg: string, details: Record<string, unknown> = {}): never => { throw new PublishError("LIBS_ADOPTION", `reconstructed baseline: ${msg}`, details); };

/**
 * Proves every adopted record against the BUILD and the CHAIN. The address must be the CREATE2 address the build predicts, the chain must hold code there, and keccak256
 * of that code must equal the runtime hash the build derives AND the hash the record carries. Any difference is LIBS_ADOPTION. Used by the freeze verb and by the plan on 8453.
 */
export async function verifyReconstructionOnChain(r: Reconstruction, o: { table: StageTable; out: BuildOut; getCode: (a: Address) => Promise<string> }): Promise<void> {
  const libsEntries = r.adopted.filter((a) => a.stage === LIBS_STAGE);
  if (libsEntries.length > 0) {
    const libs = o.table.libraries.filter((l) => libsEntries.some((a) => a.library === l.name));
    const manifest = Object.fromEntries(libsEntries.map((a) => [o.table.libraries.find((l) => l.name === a.library)?.manifestKey ?? a.library, a.address]));
    const got = await verifyAdoptedLibraries({ libraries: libs, manifest, outDir: o.out.linkOut, getCode: o.getCode });
    for (const g of got) {
      const rec = libsEntries.find((a) => a.library === g.name)!;
      if (lc(g.address) !== lc(rec.address) || lc(g.codeHash) !== lc(rec.codeHash)) libsFail(`${g.name} record (${rec.address}, ${rec.codeHash}) differs from the build and chain (${g.address}, ${g.codeHash})`, { library: g.name });
    }
  }
  const c2Entries = r.adopted.filter((a) => a.stage !== LIBS_STAGE);
  if (c2Entries.length > 0) {
    const built = buildCreate2Libraries(o.table.create2Libraries ?? [], o.out.c2Out);
    const wanted = [...new Map(c2Entries.map((a) => {
      const b = built.get(a.artifact);
      if (!b) return libsFail(`${a.library} (${a.artifact}) is not a create2 library of the stage table`, { library: a.library });
      if (lc(b.address) !== lc(a.address)) return libsFail(`${a.library} is recorded at ${a.address}, the build deploys it to ${b.address}`, { library: a.library, recorded: a.address, build: b.address });
      if (lc(b.runtimeHash) !== lc(a.codeHash)) return libsFail(`${a.library} records code hash ${a.codeHash}, the build's runtime hash is ${b.runtimeHash}`, { library: a.library });
      return [lc(b.address), b] as const;
    })).values()];
    await verifyAdoptedCreate2({ adopted: wanted, getCode: o.getCode }); // code at the address, hash equal to the build's
  }
}

/** The stage-by-stage difference between a baseline and an earlier frozen file. */
export function crossCheckDiff(counts: FrozenCounts, old: FrozenCounts): { stage: string; old: number | null; new: number | null }[] {
  return [...new Set([...Object.keys(counts), ...Object.keys(old)])].sort().filter((k) => counts[k] !== old[k]).map((k) => ({ stage: k, old: old[k] ?? null, new: counts[k] ?? null }));
}

export interface AdoptedEntry { deployerTxs: number; libraries?: { name: string; artifact: string; address: string; codeHash: string }[]; factory?: string }
export interface CountsJsonLike { deploySha: string; chainId: number; counts: FrozenCounts; deployerNonce: number; adopted?: Record<string, AdoptedEntry>; deployerStartNonce?: number; pinBlock?: number; rehearsal?: { conclusion?: string } }

/**
 * Rebuilds the baseline file for `sha` from an adopted measuring counts.json. `verify` proves the adoption records against the build and the chain (injected: the
 * freeze verb passes the real one). `cross` is an earlier frozen file to compare with, `acceptDiff` the stages whose difference the operator accepted.
 * Returns the file body. Writing it is writeFrozen's job.
 */
export async function reconstructBaseline(o: {
  j: CountsJsonLike; sha: string; table: StageTable; at: string;
  verify: (r: Reconstruction) => Promise<void>;
  cross?: { sha: string; counts: FrozenCounts; fileHash: string }; acceptDiff?: string[];
}): Promise<FrozenFile> {
  const usage = (m: string): never => { throw new PublishError("USAGE", `from-adopted-run: ${m}`); };
  const { j, sha, table } = o;
  if (j.rehearsal?.conclusion !== "success") usage(`the rehearsal did not conclude success (rehearsal.conclusion is ${JSON.stringify(j.rehearsal?.conclusion ?? null)}). A baseline is rebuilt only from a green core-stages-twin-chain run.`);
  if (j.deploySha !== sha) usage(`counts.json is for ${String(j.deploySha)}, --sha is ${sha}: rebuild from a measuring run at the sha the file is for`);
  if (j.chainId !== TWIN_CHAIN_ID) usage(`counts.json is from chain ${String(j.chainId)}, not the Twin chain (${TWIN_CHAIN_ID})`);
  const adoptedStages = Object.entries(j.adopted ?? {});
  if (adoptedStages.length === 0) usage("counts.json adopted nothing: it is a plain measurement, freeze it with --counts");
  const keys = stageKeys(table);
  const hasAll = keys.every((k) => Number.isInteger(j.counts?.[k]));
  if (!hasAll || Object.keys(j.counts).length !== keys.length) usage(`counts.json counts do not name exactly the stages of the stage table [${keys.join(", ")}]`);
  const start = j.deployerStartNonce ?? 0;
  const effSum = Object.values(j.counts).reduce((a, b) => a + b, 0);
  if (j.deployerNonce !== start + effSum + 1) usage(`counts.json deployerNonce ${j.deployerNonce} differs from the start ${start} plus the measured counts ${effSum} plus the prove-control transaction (1): the run sent a stray transaction`);
  const adopted: ReconstructedLibrary[] = [];
  const counts: FrozenCounts = { ...j.counts };
  for (const [stage, rec] of adoptedStages) {
    if (!keys.includes(stage)) usage(`counts.json adopts stage '${stage}', which the stage table does not have`);
    const recLibs = rec.libraries ?? [];
    if (recLibs.length === 0) usage(`counts.json carries no adoption records for stage ${stage} (libraries): it was built by an older rehearsal-counts. Rebuild it from the run manifest (publish-run.json) with the current tool`);
    if (rec.deployerTxs !== j.counts[stage]) usage(`stage ${stage}: the measured count ${j.counts[stage]} differs from the deployer transactions the run sent ${rec.deployerTxs}: the stage was partly resumed, so its count is not a clean measurement`);
    for (const l of recLibs) adopted.push({ stage, library: l.name, artifact: l.artifact, address: l.address, codeHash: l.codeHash });
    counts[stage] = j.counts[stage]! + recLibs.length;
  }
  for (const a of adopted) if (!isAddress(a.address, { strict: false }) || !HASH_HEX.test(a.codeHash)) usage(`adoption record of ${a.library} is malformed`);
  const reconstructed: Reconstruction = { fromRun: { sha, chainId: j.chainId, ...(j.pinBlock !== undefined ? { pinBlock: j.pinBlock } : {}) }, adopted, measuredCounts: { ...j.counts } };
  const file: FrozenFile = { deploySha: sha, measured: { chainId: j.chainId, at: o.at, reconstructed }, counts };
  verifyReconstruction(file, table); // bounded by the table, arithmetic holds
  await o.verify(reconstructed); // build and chain
  if (o.cross) {
    const diff = crossCheckDiff(counts, o.cross.counts);
    const unaccepted = diff.filter((d) => !(o.acceptDiff ?? []).includes(d.stage));
    if (unaccepted.length > 0) throw new PublishError("COUNT_MISMATCH", `the rebuilt baseline differs from the frozen counts of ${o.cross.sha} at stage(s): ${unaccepted.map((d) => `${d.stage} (old ${d.old ?? "none"}, new ${d.new ?? "none"})`).join(", ")}. If the stage script changed on purpose, review it and pass --accept-diff ${unaccepted.map((d) => d.stage).join(",")}; otherwise the measurement or the adoption record is wrong.`, { against: o.cross.sha });
    const stray = (o.acceptDiff ?? []).filter((s) => !diff.some((d) => d.stage === s));
    if (stray.length > 0) usage(`--accept-diff names stage(s) ${stray.join(", ")} that do not differ from ${o.cross.sha}: accept only a difference that exists`);
    reconstructed.crossCheck = { against: o.cross.sha, accepted: diff };
    file.measured.crossChecked = { sha: o.cross.sha, fileHash: o.cross.fileHash };
  } else if ((o.acceptDiff ?? []).length > 0) usage("--accept-diff needs --cross-check");
  verifyReconstruction(file, table);
  return file;
}

/** `cast code` with a bounded retry (3 tries, doubling backoff). A failure after the last try is CHAIN naming the RPC origin and method, never "no code". Fails closed. */
export async function codeWithRetry(exec: () => Promise<{ code: number; stdout: string; stderr: string }>, o: { address: string; rpc: string; sleep?: (ms: number) => Promise<void>; baseMs?: number }): Promise<string> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 0; i < 3; i++) {
    const r = await exec();
    if (r.code === 0) return r.stdout.trim();
    last = r.stderr.trim().split("\n").pop() ?? "";
    if (i < 2) await sleep((o.baseMs ?? 500) * 2 ** i);
  }
  let origin = "the RPC";
  try { origin = new URL(o.rpc).origin; } catch { /* keep the generic name */ }
  throw new PublishError("CHAIN", `eth_getCode for ${o.address} failed 3 times on ${origin} (cast code: ${last}). Nothing was verified; rerun when the RPC answers`, { address: o.address });
}
