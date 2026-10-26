#!/usr/bin/env bun
// scripts/runbook/run-record.ts: writes the run records the contract QA runbook (docs/runbooks/contract-qa/) checks, so no step waits on a hand-made file.
//   bun scripts/runbook/run-record.ts go --kind publish|freeze --run-dir D --sha S --target T --sheet F [--rpc URL --sender A[,B] --evidence-dir E]
//       writes D/go/<kind>.json: the sha, the target and the sheet hash the run proceeds with. A freeze go is refused off the Twin chain:
//       on 8453 the freeze is an owner decision, never a runbook default. With --rpc and --sender, the publish go also records each sender's
//       nonce and the evidence directory its CLI runs write: the report then proves every transaction those senders made during the run is one
//       the run recorded (a step's journal, or the run manifest the CLI wrote there).
//   bun scripts/runbook/run-record.ts nonce --run-dir D --mark NAME --sender A --rpc URL --evidence-dir E
//       writes D/go/nonce-NAME.json: a later sender's nonce (the live deployment's deployer of an upgrade flow), checked by the report like the go's senders.
//   bun scripts/runbook/run-record.ts report --run-dir D --evidence-dir E --manifest-dir M --rpc URL --sha S --target T --chain-id C --sheet F --tag TAG --release R [--vaults a,b,c] [--step ID]
//       writes D/rollout-report.md from the run itself: the sha, the network, the sheet hash, the tag, the journal of every step and the
//       evidence files with their sha256. A vault whose deposits are still paused at report time (read with cast from the vault
//       manifests in M: the four of VAULT_MANIFESTS, or only those --vaults names, a comma list) is an issue. A declared vault with no manifest is an issue.
//       v0.6.0 is three vaults (ADR-0017) and passes --vaults vault,protocol-asset-vault,rwa-basket-vault. A pause report (rollout-report-<chain>.json) is listed, not an issue: the pause drills write one.
//       Each step's outcome is D/journal/<id>.result: "pass", "skip <reason>" or "fail exit <n>". A failed step, or a journaled step with
//       no result, is an issue. --step names the report's own step, which is still running and has no result yet. A skip is listed.
//       --release is required: every step of that release file that runs on the target (onlyFor and the release's flows, README "Flows") and has no result
//       is an issue: a run cannot be complete with a step it never ran. With recorded sender nonces, every nonce a sender used since its mark must
//       be a transaction the journal names (read back with cast tx); one the journal does not name is an issue: nothing was sent outside the runbook.
//   bun scripts/runbook/run-record.ts signoff --run-dir D --sha S --target T --sheet F --evidence-dir E --manifest-dir M --rpc URL --chain-id C --tag TAG --release R [--vaults a,b,c] [--step ID]
//       writes D/go/signoff.json when the report exists and lists no issue, the report computed again from the run's journal, chain and release file lists no issue
//       (a hand-edited report does not sign off) and the run matches the publish go. Exit 1 otherwise. This record, and nothing an operator or an agent says,
//       is what "the run is complete" means.
// A record that exists is kept when it matches and refused when it differs. Exit 1 is a refusal, exit 2 a usage error. No secret is read or written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VERBS = ["go", "nonce", "report", "signoff"] as const;
export const FLAGS = ["kind", "run-dir", "evidence-dir", "manifest-dir", "rpc", "sha", "target", "chain-id", "sheet", "tag", "step", "vaults", "release", "sender", "mark"] as const;
export const VAULT_MANIFESTS = ["vault", "protocol-asset-vault", "agent-token-vault", "rwa-basket-vault"] as const;
const TARGETS = ["twin", "rehearsal", "production"];

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i]!.startsWith("--") ? args[i]!.slice(2) : undefined;
    if (!k || !(FLAGS as readonly string[]).includes(k)) throw new Error(`unknown argument '${args[i]}'`);
    const v = args[++i];
    if (v === undefined || v === "") throw new Error(`--${k} needs a value`);
    out[k] = v;
  }
  return out;
}
const need = (f: Record<string, string>, k: string): string => { if (!f[k]) throw new Error(`--${k} is required`); return f[k]!; };

class Refusal extends Error {}

/** The fields every record carries: what the run proceeds with. */
function basis(f: Record<string, string>) {
  const target = need(f, "target");
  if (!TARGETS.includes(target)) throw new Error(`--target is ${TARGETS.join("|")}`);
  const sha = need(f, "sha");
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("--sha is a hex commit sha");
  const sheet = need(f, "sheet");
  if (!existsSync(sheet)) throw new Refusal(`the sheet ${sheet} does not exist`);
  return { coreSha: sha, target, sheetSha256: sha256(sheet) };
}

/** Writes JSON once. A second write with the same basis keeps the first record; a different basis is refused. */
function writeOnce(file: string, record: Record<string, unknown>, same: (old: Record<string, unknown>) => boolean): void {
  if (existsSync(file)) {
    if (same(JSON.parse(readFileSync(file, "utf8")))) return;
    throw new Refusal(`${file} exists for another sha, target or sheet: start a new run directory`);
  }
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}
const sameBasis = (b: Record<string, unknown>) => (old: Record<string, unknown>) => old.coreSha === b.coreSha && old.target === b.target && old.sheetSha256 === b.sheetSha256;

/** PURE. The issues of a run: every vault whose deposits are still paused (`depositsPaused()` read as "true", or unreadable). */
export function issuesOf(paused: { manifest: string; vault: string; read: string }[]): string[] {
  return paused.filter((p) => p.read !== "false").map((p) => `${p.manifest} ${p.vault}: depositsPaused() is ${p.read === "true" ? "true at report time" : `unreadable (${p.read})`}`);
}
/** PURE. The issues in the step results: a step that did not pass or skip, and a journaled step with no result (`self` is the report's own step). */
export function stepIssuesOf(journaled: string[], results: Record<string, string>, self?: string): string[] {
  const missing = journaled.filter((id) => id !== self && results[id] === undefined).map((id) => `${id}: no result recorded`);
  const failed = Object.entries(results).filter(([, r]) => r !== "pass" && !/^skip( |$)/.test(r)).map(([id, r]) => `${id}: ${r || "empty result"}`);
  return [...failed, ...missing].sort();
}
/** PURE. The steps the release runs on the target that have no result at all: never run. The report's own step and the sign-off after it are still to come. */
export function notRunOf(applicable: string[], results: Record<string, string>, self?: string): string[] {
  const at = self === undefined ? applicable.length : applicable.indexOf(self);
  return applicable.filter((id, i) => results[id] === undefined && !(at >= 0 && i >= at)).map((id) => `${id}: not run`);
}
/** PURE. The skipped steps and their reasons: listed, not an issue (a dress run skips the throwaway-key and funding steps). */
export const skipsOf = (results: Record<string, string>): string[] => Object.entries(results).filter(([, r]) => /^skip( |$)/.test(r)).map(([id, r]) => `${id}: ${r}`).sort();

/** PURE. The pause reports in an evidence folder listing: listed, never an issue by themselves (the pause drills write one). */
export const pauseReportsOf = (evidenceFiles: string[]): string[] => evidenceFiles.filter((f) => /^rollout-report-[0-9]+\.json$/.test(f));

/** PURE. The manifest names of --vaults: the default four when absent. An empty, unknown or duplicate name throws (a usage error). */
export function vaultsOf(raw: string | undefined): readonly string[] {
  if (raw === undefined) return VAULT_MANIFESTS;
  const names = raw.split(",").map((n) => n.trim());
  for (const n of names) if (n === "" || !(VAULT_MANIFESTS as readonly string[]).includes(n)) throw new Error(`--vaults names ${VAULT_MANIFESTS.join("|")}, got '${n}'`);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`--vaults names '${dup}' twice`);
  return names;
}

const cast = (args: string[]): string | undefined => {
  const r = spawnSync("cast", args, { encoding: "utf8", env: process.env });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** depositsPaused() of the vaults the manifests name (the default four, or the --vaults list). */
function vaultReads(manifestDir: string, rpc: string, vaults: readonly string[]): { manifest: string; vault: string; read: string }[] {
  return vaults.map((m) => {
    const p = join(manifestDir, `${m}.json`);
    if (!existsSync(p)) return { manifest: m, vault: "?", read: "no manifest" };
    const vault = String(JSON.parse(readFileSync(p, "utf8")).vault ?? "?");
    const r = spawnSync("cast", ["call", vault, "depositsPaused()(bool)", "--rpc-url", rpc], { encoding: "utf8", env: process.env });
    return { manifest: m, vault, read: r.status === 0 ? r.stdout.trim() : `cast exit ${r.status}` };
  });
}

/** PURE. The senders of --sender: a comma list of addresses. */
export function sendersOf(raw: string): string[] {
  const out = raw.split(",").map((a) => a.trim());
  for (const a of out) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`--sender is a comma list of addresses, got '${a}'`);
  return out.map((a) => a.toLowerCase());
}
const nonceOf = (rpc: string, sender: string): number => {
  const n = cast(["nonce", sender, "--rpc-url", rpc]);
  if (n === undefined || !/^\d+$/.test(n)) throw new Refusal(`cast nonce ${sender} failed on ${rpc}`);
  return Number(n);
};
/**
 * PURE. Every transaction hash the run recorded: the value, or the list of values, of every key that names a transaction or a hash, in the JSON logs of the CLIs
 * (tx_hash, deploy_tx, schedule_tx, execute_tx), the receipts cast-send.sh prints (transactionHash) and the run manifests the CLIs write (txHashes). A hash of
 * something else (a code hash, a Safe transaction hash) is read back with cast tx, finds no transaction and counts for nothing.
 */
export function journalHashesOf(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/"?\w*(?:tx|Tx|TX|hash|Hash)\w*"?\s*[:=]\s*(\[[^\]]*\]|"?0x[0-9a-fA-F]{64})/g)) {
      for (const h of m[1]!.matchAll(/0x[0-9a-fA-F]{64}/g)) out.add(h[0].toLowerCase());
    }
  }
  return [...out].sort();
}
/** PURE. The issues of one sender's window: every nonce from the mark to now that no journaled transaction of that sender carries. */
export function senderIssuesOf(sender: string, from: number, now: number, journaled: { from: string; nonce: number }[]): string[] {
  const seen = new Set(journaled.filter((t) => t.from.toLowerCase() === sender.toLowerCase()).map((t) => t.nonce));
  const out: string[] = [];
  for (let n = from; n < now; n++) if (!seen.has(n)) out.push(`sender ${sender}: its transaction at nonce ${n} is not in the run's journal (sent outside the runbook)`);
  return out;
}
type Mark = { sender: string; nonce: number; rpc: string; evidenceDir?: string };
/** The marked senders of a run: the publish go's and every nonce-<mark>.json. */
function markedSenders(runDir: string): Mark[] {
  const out: Mark[] = [];
  const goDir = join(runDir, "go");
  if (!existsSync(goDir)) return out;
  for (const f of readdirSync(goDir).sort()) {
    const j = JSON.parse(readFileSync(join(goDir, f), "utf8")) as Record<string, unknown>;
    if (f === "publish.json" && Array.isArray(j.senders)) for (const s of j.senders as Mark[]) out.push(s);
    if (/^nonce-.*\.json$/.test(f)) out.push({ sender: String(j.sender), nonce: Number(j.nonce), rpc: String(j.rpc), evidenceDir: j.evidenceDir === undefined ? undefined : String(j.evidenceDir) });
  }
  return out;
}
const jsonTexts = (dir: string | undefined): string[] => (dir === undefined ? [] : listFiles(dir).filter((x) => x.endsWith(".json")).map((x) => readFileSync(join(dir, x), "utf8")));
/** The sender issues of the run: each marked sender's nonce now against the transactions the run recorded (the journal, and the run manifests in every marked evidence directory), each read back with cast tx. */
function senderIssues(runDir: string, journalTexts: string[]): string[] {
  const marks = markedSenders(runDir);
  if (marks.length === 0) return [];
  journalTexts = [...journalTexts, ...[...new Set(marks.map((m) => m.evidenceDir).filter((d): d is string => d !== undefined))].flatMap(jsonTexts)];
  const byRpc = new Map<string, { from: string; nonce: number }[]>();
  const txs = (rpc: string): { from: string; nonce: number }[] => {
    if (!byRpc.has(rpc)) {
      const list: { from: string; nonce: number }[] = [];
      for (const h of journalHashesOf(journalTexts)) {
        const j = cast(["tx", h, "--json", "--rpc-url", rpc]);
        if (!j) continue;
        try { const t = JSON.parse(j) as { from?: string; nonce?: string | number }; if (t.from && t.nonce !== undefined) list.push({ from: t.from, nonce: Number(t.nonce) }); } catch { /* not a transaction of this chain */ }
      }
      byRpc.set(rpc, list);
    }
    return byRpc.get(rpc)!;
  };
  return marks.flatMap((m) => senderIssuesOf(m.sender, m.nonce, nonceOf(m.rpc, m.sender), txs(m.rpc)));
}

/** The ids of the steps a release runs on a target, in order, read with the validator (the one reader of the yaml). */
async function applicableIds(release: string, target: string): Promise<string[]> {
  const v = await import("./validate-contract-qa.ts");
  const r = v.validateAll().releases.get(release);
  if (!r) throw new Refusal(`no release runbook ${v.QA_DIR}/releases/${release}.yaml`);
  return v.applicableSteps(r, target).map((s) => s.id);
}
/** The vault manifests the release deploys: its `vaults:`, else the four of v0.4.0 and v0.5.0. */
async function releaseVaults(release: string): Promise<string | undefined> {
  const v = await import("./validate-contract-qa.ts");
  return v.validateAll().releases.get(release)?.vaults?.join(",");
}

/** PURE. The rollout report text. */
export function reportText(r: { coreSha: string; target: string; chainId: string; sheetSha256: string; tag: string; journal: { id: string; lines: number; last: string }[]; evidence: { file: string; sha256: string }[]; issues: string[]; skips: string[]; pauseReports: string[] }): string {
  const out = [
    `# Rollout report`, ``,
    `Written by scripts/runbook/run-record.ts from the run directory. Nothing in it is typed by hand.`, ``,
    `| Field | Value |`, `| --- | --- |`,
    `| Core sha | ${r.coreSha} |`, `| Target | ${r.target} |`, `| Chain id | ${r.chainId} |`, `| Sheet sha256 | ${r.sheetSha256} |`, `| Release tag | ${r.tag} |`, ``,
    `## Issues`, ``, ...(r.issues.length ? r.issues.map((i) => `- ${i}`) : ["None."]), ``,
    `## Skipped steps`, ``, ...(r.skips.length ? r.skips.map((s) => `- ${s}`) : ["None."]), ``,
    `## Pause reports`, ``, ...(r.pauseReports.length ? r.pauseReports.map((f) => `- ${f} (a pause drill or a failed verify; the vault reads above decide whether it is still open)`) : ["None."]), ``,
    `## Steps (journal)`, ``, `| Step | Lines | Last line |`, `| --- | --- | --- |`,
    ...r.journal.map((j) => `| ${j.id} | ${j.lines} | ${j.last.replace(/\|/g, "\\|").slice(0, 160)} |`), ``,
    `## Evidence`, ``, `| File | sha256 |`, `| --- | --- |`, ...r.evidence.map((e) => `| ${e.file} | ${e.sha256} |`), ``,
  ];
  return out.join("\n");
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? listFiles(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]).sort();
}

/** The report of the run as it stands: its text, and its issues. `report` writes it, and `signoff` computes it again, so a hand-edited report cannot sign off. */
async function buildReport(f: Record<string, string>, b: ReturnType<typeof basis>, runDir: string, applicable: (release: string, target: string) => Promise<string[]>): Promise<{ text: string; issues: string[] }> {
  const evidenceDir = need(f, "evidence-dir");
  const journalDir = join(runDir, "journal");
  const journalFiles = listFiles(journalDir);
  const journal = journalFiles.filter((x) => x.endsWith(".out")).map((x) => {
    const lines = readFileSync(join(journalDir, x), "utf8").split("\n").filter((l) => l.trim() !== "");
    return { id: x.replace(/\.out$/, ""), lines: lines.length, last: lines.at(-1) ?? "" };
  });
  const results = Object.fromEntries(journalFiles.filter((x) => x.endsWith(".result")).map((x) => [x.replace(/\.result$/, ""), readFileSync(join(journalDir, x), "utf8").trim()]));
  const vaults = vaultsOf(f.vaults ?? (applicable === applicableIds ? await releaseVaults(need(f, "release")) : undefined));
  const stepIssues = stepIssuesOf(journal.map((j) => j.id), results, f.step);
  const notRun = notRunOf(await applicable(need(f, "release"), b.target), results, f.step);
  const texts = journalFiles.filter((x) => x.endsWith(".out") || x.endsWith(".err")).map((x) => readFileSync(join(journalDir, x), "utf8"));
  const files = listFiles(evidenceDir);
  const names = files.map((x) => x.split("/").at(-1)!);
  const issues = [...stepIssues, ...notRun, ...issuesOf(vaultReads(need(f, "manifest-dir"), need(f, "rpc"), vaults)), ...senderIssues(runDir, texts)];
  const text = reportText({ ...b, chainId: need(f, "chain-id"), tag: need(f, "tag"), journal, evidence: files.map((x) => ({ file: x, sha256: sha256(join(evidenceDir, x)) })), issues, skips: skipsOf(results), pauseReports: pauseReportsOf(names) });
  return { text, issues };
}

/** `deps.applicable` is a test seam: the CLI never passes it, so a run is always checked against the committed release file. */
export async function main(argv: string[], deps: { applicable?: (release: string, target: string) => Promise<string[]> } = {}): Promise<number> {
  const applicable = deps.applicable ?? applicableIds;
  const [verb, ...rest] = argv;
  try {
    if (!(VERBS as readonly string[]).includes(verb ?? "")) throw new Error(`the verb is ${VERBS.join("|")}`);
    const f = flags(rest);
    const runDir = need(f, "run-dir");
    if (verb === "nonce") {
      const mark = need(f, "mark");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(mark)) throw new Error("--mark is a lower-case name");
      const [sender] = sendersOf(need(f, "sender"));
      const rpc = need(f, "rpc");
      writeOnce(join(runDir, "go", `nonce-${mark}.json`), { kind: "nonce", mark, sender, rpc, evidenceDir: need(f, "evidence-dir"), nonce: nonceOf(rpc, sender!), recordedAt: new Date().toISOString(), by: "scripts/runbook/run-record.ts" }, (old) => old.sender === sender);
      return 0;
    }
    const b = basis(f);
    if (verb === "go") {
      const kind = need(f, "kind");
      if (kind !== "publish" && kind !== "freeze") throw new Error("--kind is publish|freeze");
      if (kind === "freeze" && b.target !== "twin") throw new Refusal("a freeze go is recorded by the runbook only on the Twin chain: on 8453 it is an owner decision");
      const senders = f.sender === undefined ? undefined : sendersOf(f.sender).map((sender) => ({ sender, rpc: need(f, "rpc"), evidenceDir: need(f, "evidence-dir"), nonce: nonceOf(need(f, "rpc"), sender) }));
      writeOnce(join(runDir, "go", `${kind}.json`), { kind, ...b, ...(senders ? { senders } : {}), recordedAt: new Date().toISOString(), by: "scripts/runbook/run-record.ts" }, sameBasis(b));
      return 0;
    }
    if (verb === "report") {
      writeFileSync(join(runDir, "rollout-report.md"), (await buildReport(f, b, runDir, applicable)).text);
      return 0;
    }
    // signoff
    const report = join(runDir, "rollout-report.md");
    if (!existsSync(report)) throw new Refusal(`${report} does not exist: run the report verb first`);
    const text = readFileSync(report, "utf8");
    if (!/## Issues\n\nNone\.\n/.test(text)) throw new Refusal(`${report} lists an issue: no sign-off on a run with an issue`);
    const again = await buildReport(f, b, runDir, applicable);
    if (again.issues.length > 0) throw new Refusal(`the report computed again from the run lists ${again.issues.length} issue(s), so the report on disk is not the run's: ${again.issues.slice(0, 3).join("; ")}`);
    const goFile = join(runDir, "go", "publish.json");
    if (!existsSync(goFile) || !sameBasis(b)(JSON.parse(readFileSync(goFile, "utf8")))) throw new Refusal(`${goFile} is missing or names another sha, target or sheet`);
    writeOnce(join(runDir, "go", "signoff.json"), { kind: "signoff", ...b, rolloutReportSha256: sha256(report), recordedAt: new Date().toISOString(), by: "scripts/runbook/run-record.ts" }, sameBasis(b));
    return 0;
  } catch (e) {
    console.error(`run-record: ${(e as Error).message}`);
    return e instanceof Refusal ? 1 : 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
