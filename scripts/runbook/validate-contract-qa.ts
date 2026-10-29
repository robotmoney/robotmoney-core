#!/usr/bin/env bun
// scripts/runbook/validate-contract-qa.ts: the checker of the contract QA runbook (docs/runbooks/contract-qa/README.md).
//
// The model is the frontend's release runbook (scripts/release/runbook.ts there): ONE template (docs/runbooks/contract-qa/template.yaml)
// and one add-only file per release (docs/runbooks/contract-qa/releases/<release>.yaml). A release file holds a full copy of the
// template's steps, unchanged and in order, plus the steps only that release adds, each marked `added: <release>`. This tool refuses
// a release file that drops, edits or reorders a template step, and checks the commands against the real CLIs, so the YAML cannot drift.
// The template itself may change. A finished release pins `templateSha`, the commit its template steps were copied from; it is then a
// record: it is checked add-only against the template at that commit (read from git), never against the current template or CLIs.
//
//   bun scripts/runbook/validate-contract-qa.ts                                    the template and every release file (CI)
//   bun scripts/runbook/validate-contract-qa.ts --release v0.4.0 --target T --runnable
//                                                                                   also: T is twin | rehearsal | production, and a production run
//                                                                                   refuses while a listed owner decision is open
//   bun scripts/runbook/validate-contract-qa.ts --check-sheet FILE --target T [--owner-signers N]
//                                                                                   the run sheet agrees with the environment (chain, kind, delay, 1 USDC seed, caps, owners)
// Exit 0: valid. Exit 1: problems (one per line on stderr). Exit 2: usage. No secret is read or written.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const QA_DIR = "docs/runbooks/contract-qa";
export const TEMPLATE_NAME = "contract-qa";
/** Issue 1892: the gateway system's own runbook, a second template checked on its own (docs/runbooks/contract-qa/gateway.yaml). */
export const GATEWAY_TEMPLATE_NAME = "contract-qa-gateway";

// ─── the environments (README.md "Targets") ─────────────────────────────────────────────────────────────────────
export const TARGET_NAMES = ["twin", "rehearsal", "production"] as const;
export type TargetName = (typeof TARGET_NAMES)[number];
export interface TargetModel {
  chainId: number;
  /** The environment variable that holds the RPC URL. Its value is never written down. */
  rpcEnv: string;
  /** The committed sheet the run sheet starts from; production starts from the reviewed frozen sheet the operator names. */
  sheetTemplate: string | null;
  /** The timelock delay band the sheet must sit in, in seconds. */
  delay: { min: number; max: number };
  /** The DEPLOYMENT_KIND line the sheet carries. */
  kinds: readonly string[];
}
export const TARGETS: Readonly<Record<TargetName, TargetModel>> = {
  twin: { chainId: 918453, rpcEnv: "TWIN_RPC_URL", sheetTemplate: "deployments/twin-918453/stage-sheet.env", delay: { min: 1, max: Infinity }, kinds: ["", "production", "rehearsal"] },
  rehearsal: { chainId: 8453, rpcEnv: "BASE_RPC_URL", sheetTemplate: "deployments/base-8453-rehearsal/stage-sheet.example.env", delay: { min: 900, max: 172799 }, kinds: ["rehearsal"] },
  production: { chainId: 8453, rpcEnv: "BASE_RPC_URL", sheetTemplate: null, delay: { min: 172800, max: Infinity }, kinds: ["", "production"] },
};

// ─── placeholders (README.md "Placeholders") ────────────────────────────────────────────────────────────────────
/** Values the operator or runner supplies, or derives from the target and the sheet. */
export const SCALARS = new Set([
  "coreSha", "release", "runDir", "target", "countsCheckout", "releaseTag", "versionTag", "rmpcConfig", "receiptFile", "receiptUri",
  "submitterSaltNonce", "unwindMinUsdcOut", "unwindMaxLossBps", "environmentName", "ownerSigner", "emergencySigner", "deployerKeystore",
  "chainId", "rpcUrl", "sheet", "sheetTemplate", "countsDir", "evidenceDir", "manifestDir", "signer", "yes", "usdc", "deploymentKind",
  "ownerSignerCount", "sheetOwnerCount", "castFlagsInline", "gateSha", "gatewaySheet",
  // issue 1927: the local end of the tunnel to the second Twin fork the v0.5.0 deployment runs on (P8.02, port 8547). On the rehearsal target it is the live RPC.
  "v050RpcUrl",
  // The stage host of a Twin run (README "Hosts"): its ssh alias, the host checkout of the core repo and the run's state dir (both relative to the host's home), and the local ports of the tunnels to the two forks.
  "stageHost", "stageCore", "stageDir", "tunnelPort", "tunnelPort2",
  // The live deployment an upgrade flow runs against (README "Flows"): on the Twin the v0.5.0 tag run of P8.03, on 8453 the Deploy 3 record. Each is a path, a signer spec
  // or cast flags the runner supplies; none is written down here.
  "v050Sheet", "v050CoreDir", "v050Signer", "v050CountsDir", "v050EvidenceDir", "v050ManifestDir", "v050OwnerSigner", "v050EmergencySigner", "v050DeployerKeystore", "v050CastFlagsInline",
]);
/** The flows a step belongs to (README "Flows"): a new deployment, or a governed upgrade of the live deployment. A step with no `flow` is of the new flow. */
export const FLOW_NAMES = ["new", "upgrade"] as const;
export type FlowName = (typeof FLOW_NAMES)[number];
/** A whole-element placeholder that expands to several argv elements (empty on the Twin chain where noted). */
export const LIST_PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  // issue 1892: the gateway system run (docs/runbooks/contract-qa/gateway.yaml): its own sheet, its own evidence directory, --system gateway
  gcommon: ["--chain", "{chainId}", "--rpc", "{rpcUrl}", "--sheet", "{gatewaySheet}", "--signer", "{signer}", "--environment", "{environmentName}", "--core-sha", "{coreSha}", "--counts-dir", "{countsDir}", "--evidence", "{runDir}/evidence-gateway", "--system", "gateway"],
  common: ["--chain", "{chainId}", "--rpc", "{rpcUrl}", "--sheet", "{sheet}", "--signer", "{signer}", "--environment", "{environmentName}", "--core-sha", "{coreSha}", "--counts-dir", "{countsDir}", "--evidence", "{evidenceDir}"],
  // issue 1927: the arguments of runbook 4.15's COMMON on the Twin, against the v0.5.0 deployment of P8.03: --core-dir and --core-sha of the v0.5.0 checkout (P8.01), the tag run's
  // sheet, keys, counts and evidence ({runDir}/v050-run, P8.03). The tag run's SAFE_OWNER keystores sign beside its DEPLOYER keystore (the Twin default), so no {owners}.
  // The same arguments on the rehearsal target name the Deploy 3 record: its sheet, the checkout its live build came from, its evidence and manifests (README "Flows").
  v050common: ["--chain", "{chainId}", "--rpc", "{v050RpcUrl}", "--sheet", "{v050Sheet}", "--core-dir", "{v050CoreDir}", "--core-sha", "57fbe61833e9d7f94557d69102138f7c410c1346", "--signer", "{v050Signer}", "--environment", "{environmentName}", "--counts-dir", "{v050CountsDir}", "--evidence", "{v050EvidenceDir}"],
  // The live deployment's signers and cast flags: empty on the Twin (the tag run's keystores sit beside its DEPLOYER keystore), one per owner on 8453.
  v050owners: ["--owner-signer", "{v050OwnerSigner}"],
  v050emergency: ["--emergency-signer", "{v050EmergencySigner}"],
  v050cast: ["--keystore", "{v050DeployerKeystore}"],
  owners: ["--owner-signer", "{ownerSigner}"],
  gate: ["--counts-require-origin-dev"],
  wait: ["--max-wait", "0"],
  emergency: ["--emergency-signer", "{emergencySigner}"],
  cast: ["--keystore", "{deployerKeystore}"],
};
export const MANIFEST_FILES = ["libs", "recorder", "vault", "registry", "router", "gateway", "ic-policy", "receipt", "governance", "protocol-asset-vault", "agent-token-vault", "rwa-basket-vault", "gateway-handover", "timelock", "safe"];
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)(?::([A-Za-z0-9_.\-]+))?\}/g;

// ─── the step schema ────────────────────────────────────────────────────────────────────────────────────────────
export const HOSTS = ["control", "stage"] as const;
const STEP_KEYS = new Set(["id", "standing", "description", "host", "phase", "cmds", "env", "expectExit", "receipts", "irreversible", "onlyFor", "flow", "refresh", "notBefore", "gateAbsent", "sheetIs", "go", "triage", "maxMinutes", "writes", "added", "exercises"]);
export const ID_PATTERN = /^P(\d{1,2})\.(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RunbookStep {
  id: string; standing: string[]; description: string; host: string; phase: number; cmds: string[][];
  env?: Record<string, string>; expectExit: number | number[]; receipts: { dir: string; pattern: string; required: boolean }[];
  irreversible: boolean; onlyFor?: string | string[]; flow?: string | string[]; refresh?: boolean; notBefore?: { afterStep: string; hours: number | "timelockDelay" };
  gateAbsent?: string | string[]; sheetIs?: Record<string, string>; go?: string; triage?: boolean; maxMinutes?: number; writes?: string[]; added?: string;
  exercises?: Exercise;
}
/**
 * Issue 1984: what a user-facing round step proves on the vaults, named on the step (`exercises:`): a direct vault deposit, a deposit through the router, or a redeem.
 * The rebalance rule (rebalanceRoundProblems) counts these steps before and after the apply-receipt step of each flow.
 */
export const EXERCISES = ["vault-deposit", "router-deposit", "redeem"] as const;
export type Exercise = (typeof EXERCISES)[number];
export interface ScopeEntry { pr: number; what: string; check?: string; none?: string }
export interface Decision { id: string; question: string; status: "open" | "decided"; answer: string | null; decidedOn: string | null; ref: string | null }
export interface ReleaseRunbook { release: string; template: string; templateSha?: string; productionReady: boolean; notes?: string; recovery: string; decisions: Decision[]; scope: ScopeEntry[]; flows?: Partial<Record<TargetName, FlowName[]>>; vaults?: string[]; steps: RunbookStep[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const onlyForList = (s: Pick<RunbookStep, "onlyFor">): string[] => (s.onlyFor === undefined ? [] : Array.isArray(s.onlyFor) ? s.onlyFor : [s.onlyFor]);
/** The flows a step belongs to: `flow`, or the new flow when absent. */
export const flowsOf = (s: Pick<RunbookStep, "flow">): FlowName[] => (s.flow === undefined ? ["new"] : Array.isArray(s.flow) ? (s.flow as FlowName[]) : [s.flow as FlowName]);
/** The flows a release runs on a target: its `flows` entry, or the new flow when the release names none. */
export const targetFlows = (r: Pick<ReleaseRunbook, "flows">, target: string): FlowName[] => r.flows?.[target as TargetName] ?? ["new"];
/** PURE. The steps of a release that run on a target, in order: every step whose onlyFor admits the target and whose flow the release runs there. Nothing else runs, and each of these must. */
export function applicableSteps(r: Pick<ReleaseRunbook, "flows" | "steps">, target: string): RunbookStep[] {
  const flows = targetFlows(r, target);
  return r.steps.filter((s) => (onlyForList(s).length === 0 || onlyForList(s).includes(target)) && flowsOf(s).some((f) => flows.includes(f)));
}

/** Stable JSON: object keys sorted, so equality never depends on the order a file wrote them. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** A cast-send.sh call whose stdout (the receipt the sender check reads its hash from) is redirected to /dev/null before the command ends. */
const DISCARDED_SEND = /cast-send\.sh[^;|&]*?(?:&|(?<!2))>\s*\/dev\/null/;

/** PURE. One step from its parsed YAML, or the reasons it is not one. */
export function parseStep(raw: unknown, where: string): { step: RunbookStep } | { errors: string[] } {
  if (!isObject(raw)) return { errors: [`${where}: a step is a mapping`] };
  const errors: string[] = [];
  const at = `${where} ${typeof raw.id === "string" ? raw.id : "(no id)"}`;
  for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) errors.push(`${at}: unknown key ${k}`);
  const m = typeof raw.id === "string" ? ID_PATTERN.exec(raw.id) : null;
  if (!m) errors.push(`${at}: id is P<phase>.<nn>-<slug>, got ${JSON.stringify(raw.id)}`);
  if (!isStringArray(raw.standing) || raw.standing.length === 0) errors.push(`${at}: standing is a non-empty list of runbook sections`);
  if (typeof raw.description !== "string" || raw.description.trim() === "") errors.push(`${at}: description is the non-empty one-line why`);
  if (!(HOSTS as readonly string[]).includes(raw.host as string)) errors.push(`${at}: host is one of ${HOSTS.join(", ")}`);
  if (!Number.isInteger(raw.phase) || (raw.phase as number) < 0 || (raw.phase as number) > 10) errors.push(`${at}: phase is an integer 0 to 10`);
  else if (m && Number(m[1]) !== raw.phase) errors.push(`${at}: the id names phase ${m[1]} but phase is ${String(raw.phase)}`);
  if (!Array.isArray(raw.cmds) || raw.cmds.length === 0 || !raw.cmds.every((c) => isStringArray(c) && c.length > 0)) errors.push(`${at}: cmds is a non-empty list of argv lists`);
  if (Array.isArray(raw.cmds) && raw.cmds.some((c) => isStringArray(c) && c.some((a) => DISCARDED_SEND.test(a)))) errors.push(`${at}: a cast-send.sh receipt is sent to /dev/null, so its transaction hash never reaches the journal and the sign-off flags it as sent outside the runbook`);
  if (raw.env !== undefined && !(isObject(raw.env) && Object.values(raw.env).every((v) => typeof v === "string"))) errors.push(`${at}: env maps names to strings`);
  const ee = raw.expectExit;
  if (!(Number.isInteger(ee) || (Array.isArray(ee) && ee.length > 0 && ee.every((x) => Number.isInteger(x))))) errors.push(`${at}: expectExit is an integer or a list of integers`);
  if (!Array.isArray(raw.receipts) || !raw.receipts.every((r) => isObject(r) && typeof r.dir === "string" && typeof r.pattern === "string" && typeof r.required === "boolean" && Object.keys(r).length === 3)) errors.push(`${at}: receipts is a list of {dir, pattern, required}`);
  if (typeof raw.irreversible !== "boolean") errors.push(`${at}: irreversible is a boolean`);
  if (raw.onlyFor !== undefined) {
    const l = Array.isArray(raw.onlyFor) ? raw.onlyFor : [raw.onlyFor];
    if (l.length === 0 || !l.every((x) => (TARGET_NAMES as readonly string[]).includes(x as string))) errors.push(`${at}: onlyFor is ${TARGET_NAMES.join(" | ")}, or a list of them`);
  }
  if (raw.refresh !== undefined && typeof raw.refresh !== "boolean") errors.push(`${at}: refresh is a boolean`);
  if (raw.flow !== undefined) {
    const l = Array.isArray(raw.flow) ? raw.flow : [raw.flow];
    if (l.length === 0 || !l.every((x) => (FLOW_NAMES as readonly string[]).includes(x as string)) || new Set(l).size !== l.length) errors.push(`${at}: flow is ${FLOW_NAMES.join(" | ")}, or a list of them`);
  }
  const nb = raw.notBefore;
  if (nb !== undefined && !(isObject(nb) && typeof nb.afterStep === "string" && (nb.hours === "timelockDelay" || (typeof nb.hours === "number" && nb.hours >= 0)) && Object.keys(nb).length === 2)) errors.push(`${at}: notBefore is {afterStep, hours} with hours a number (0 or more) or "timelockDelay"`);
  const ga = raw.gateAbsent;
  if (ga !== undefined && !((typeof ga === "string" && ga !== "") || (isStringArray(ga) && ga.length > 0 && ga.every((x) => x !== "") && new Set(ga).size === ga.length))) errors.push(`${at}: gateAbsent is a non-empty path, or a list of distinct paths (the step is skipped when every one exists)`);
  if (raw.sheetIs !== undefined && !(isObject(raw.sheetIs) && Object.keys(raw.sheetIs).length > 0 && Object.entries(raw.sheetIs).every(([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) && typeof v === "string"))) errors.push(`${at}: sheetIs maps sheet names to values`);
  if (raw.go !== undefined && !(typeof raw.go === "string" && /^[a-z][a-z0-9-]*$/.test(raw.go))) errors.push(`${at}: go is a lower-case name`);
  if (raw.triage !== undefined && typeof raw.triage !== "boolean") errors.push(`${at}: triage is a boolean`);
  if (raw.maxMinutes !== undefined && !(Number.isInteger(raw.maxMinutes) && (raw.maxMinutes as number) > 0)) errors.push(`${at}: maxMinutes is a positive integer`);
  if (raw.writes !== undefined && !(isStringArray(raw.writes) && raw.writes.length > 0 && raw.writes.every((w) => /^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(w)))) errors.push(`${at}: writes is a list of state names`);
  if (raw.added !== undefined && (typeof raw.added !== "string" || raw.added === "")) errors.push(`${at}: added is a non-empty release name`);
  if (raw.exercises !== undefined && !(EXERCISES as readonly string[]).includes(raw.exercises as string)) errors.push(`${at}: exercises is ${EXERCISES.join(" | ")}`);
  if (errors.length > 0) return { errors };
  const step: Record<string, unknown> = {};
  for (const k of ["id", "standing", "description", "host", "phase", "cmds", "env", "expectExit", "receipts", "irreversible", "onlyFor", "flow", "refresh", "notBefore", "gateAbsent", "sheetIs", "go", "triage", "maxMinutes", "writes", "added", "exercises"]) if (raw[k] !== undefined) step[k] = raw[k];
  return { step: step as unknown as RunbookStep };
}

/** The steps of a list: every one parses, ids are unique, phases never go back, irreversible steps are gated, references point backwards. */
export function parseSteps(raw: unknown, where: string, errors: string[]): RunbookStep[] {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push(`${where}: steps is a non-empty list`); return []; }
  const steps: RunbookStep[] = [];
  for (const r of raw) {
    const p = parseStep(r, where);
    if ("errors" in p) errors.push(...p.errors); else steps.push(p.step);
  }
  const ids = steps.map((s) => s.id);
  for (const d of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`${where}: step id ${d} appears twice`);
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.phase < steps[i - 1]!.phase) errors.push(`${where}: ${steps[i]!.id} (phase ${steps[i]!.phase}) comes after ${steps[i - 1]!.id} (phase ${steps[i - 1]!.phase}); the phases run 0 to 10 in order`);
  }
  const seen = new Set<string>();
  const written = new Set<string>();
  // The run sheet exists from the first step that writes it (merge-sheet ... --out {sheet}); a {sheet:X} read before that has nothing to read.
  let sheetWritten = false;
  for (const s of steps) {
    const at = `${where} ${s.id}`;
    if (s.irreversible && s.notBefore === undefined && s.go === undefined) errors.push(`${at}: an irreversible step needs notBefore (the step that must come first) or go (a recorded owner decision)`);
    if (s.notBefore !== undefined && !seen.has(s.notBefore.afterStep)) errors.push(`${at}: notBefore names ${s.notBefore.afterStep}, which is no earlier step`);
    for (const ref of placeholdersOf(s)) {
      if (ref.kind === "state" && !written.has(ref.arg!) && !(s.writes ?? []).includes(ref.arg!)) errors.push(`${at}: {state:${ref.arg}} is read before any step writes it`);
      if (ref.kind === "journal" && !seen.has(ref.arg!) && ref.arg !== s.id) errors.push(`${at}: {journal:${ref.arg}} is no earlier step`);
      if (ref.kind === "sheet" && ref.arg !== undefined && !sheetWritten) errors.push(`${at}: {sheet:${ref.arg}} is read before any step writes the run sheet (--out {sheet})`);
    }
    if (s.cmds.some((c) => c.some((a, i) => a === "--out" && c[i + 1] === "{sheet}"))) sheetWritten = true;
    for (const w of s.writes ?? []) written.add(w);
    seen.add(s.id);
  }
  return steps;
}

// ─── placeholders ───────────────────────────────────────────────────────────────────────────────────────────────
export interface PlaceholderRef { raw: string; kind: string; arg?: string }
export const placeholdersIn = (s: string): PlaceholderRef[] => [...s.matchAll(PLACEHOLDER)].map((m) => ({ raw: m[0], kind: m[1]!, arg: m[2] }));
/** PURE. The paths of a step's gateAbsent: none, one, or a list (the step is skipped when every one exists). */
export const gateAbsentPaths = (s: Pick<RunbookStep, "gateAbsent">): string[] => (s.gateAbsent === undefined ? [] : Array.isArray(s.gateAbsent) ? s.gateAbsent : [s.gateAbsent]);
/** Every placeholder the step reads: commands, env values, receipts, gateAbsent. */
export function placeholdersOf(s: RunbookStep): PlaceholderRef[] {
  const texts = [...s.cmds.flat(), ...Object.values(s.env ?? {}), ...s.receipts.flatMap((r) => [r.dir, r.pattern]), ...gateAbsentPaths(s)];
  return texts.flatMap(placeholdersIn);
}
const reads = (s: RunbookStep) => s.cmds.flat().concat(Object.values(s.env ?? {}));

// ─── the real CLIs ──────────────────────────────────────────────────────────────────────────────────────────────
export interface CliModel {
  publish: { verbs: Set<string>; flags: Set<string>; rows: Set<string>; exitCodes: Set<number> };
  coreStack: { verbs: Map<string, Set<string>>; flags: Set<string>; exitCodes: Set<number> };
  tools: Map<string, { verbs?: Set<string>; flags: Set<string> }>;
  rmpc: { commands: Set<string>; nested: Map<string, Set<string>>; flags: Set<string> };
  sections: Set<string>;
  sheetNames: Set<string>;
  manifestFiles: Set<string>;
}
const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");
const flagsIn = (text: string): Set<string> => new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
const kebab = (v: string): string => v.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const optionKeys = (text: string): Set<string> => new Set([...text.matchAll(/(?:^|[\s{,])"?([a-z][a-z-]*)"?:\s*\{\s*type:/g)].map((m) => m[1]!));

/** The CLIs' own usage text and option tables, read from the checkout: a verb, row or flag the runbook uses must be in them. */
export function loadModel(root: string = ROOT): CliModel {
  const cli = read(root, "publish-contracts/src/cli.ts");
  const usage = /export const USAGE = `([\s\S]*?)`;/.exec(cli)?.[1] ?? "";
  const verbs = new Set([...(/export const VERBS = \[([^\]]*)\]/.exec(cli)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
  const rows = new Set<string>(usage.match(/unpause-[A-Z]+/g) ?? []);
  for (const m of usage.matchAll(/--row ([a-z][a-z|-]*)/g)) for (const r of m[1]!.split("|")) rows.add(r);
  for (const r of ["update-delay", "batch", "cancel"]) if (usage.includes(r)) rows.add(r);
  const errors = read(root, "publish-contracts/src/errors.ts");
  const exitCodes = new Set<number>([0, 1, ...[...(/EXIT_CODES[^=]*=\s*\{([\s\S]*?)\};/.exec(errors)?.[1] ?? "").matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]))]);
  const publish = { verbs, flags: flagsIn(usage), rows, exitCodes };

  const cs = read(root, "scripts/stage/core-stack.ts");
  const csUsage = /const USAGE_TEXT = `([\s\S]*?)`;/.exec(cs)?.[1] ?? "";
  const csVerbs = new Map<string, Set<string>>();
  for (const m of csUsage.matchAll(/\b(chain|publish|governance|parity|dapp|rmpc|record)\s+([a-z|]+)/g)) {
    const set = csVerbs.get(m[1]!) ?? new Set<string>();
    for (const v of m[2]!.split("|").filter(Boolean)) set.add(v);
    csVerbs.set(m[1]!, set);
  }
  const csExit = new Set<number>([0, ...[...(/export const EXIT = \{([^}]*)\}/.exec(cs)?.[1] ?? "").matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]))]);
  for (const c of exitCodes) csExit.add(c);
  const coreStack = { verbs: csVerbs, flags: optionKeys(cs), exitCodes: csExit };

  const tools = new Map<string, { verbs?: Set<string>; flags: Set<string> }>();
  const safe = read(root, "publish-contracts/src/safe/cli.ts");
  tools.set("publish-contracts/src/safe/cli.ts", { verbs: new Set([...safe.matchAll(/safe-cli (\w+)/g)].map((m) => m[1]!)), flags: flagsIn(safe.split("import ")[0]!) });
  const reh = read(root, "publish-contracts/src/rehearsal/cli.ts");
  const rehHeader = /\/\*\*([\s\S]*?)\*\//.exec(reh)?.[1] ?? "";
  tools.set("publish-contracts/src/rehearsal/cli.ts", { verbs: new Set([...rehHeader.matchAll(/^\s*\*\s{3}([a-z][a-z0-9-]*)\s/gm)].map((m) => m[1]!)), flags: flagsIn(rehHeader) });
  const tw = read(root, "scripts/devnet/twin-fork.ts");
  tools.set("scripts/devnet/twin-fork.ts", { verbs: new Set((/<([a-z|-]+)>/.exec(tw.split("\n").slice(0, 5).join("\n"))?.[1] ?? "").split("|")), flags: optionKeys(tw) });
  tools.set("publish-contracts/src/evidence-check.ts", { flags: optionKeys(read(root, "publish-contracts/src/evidence-check.ts")) });
  tools.set("scripts/ci/check-sha-green.ts", { flags: flagsIn(read(root, "scripts/ci/check-sha-green.ts").split("import ")[0]!) });
  tools.set("publish-contracts/src/ci/merge-sheet.ts", { flags: new Set(["template", "fragment", "out"]) });
  tools.set("publish-contracts/src/ci/scan-rehearsal-secrets.ts", { flags: new Set(["evidence", "password-file"]) });
  tools.set("scripts/stage/dapp-served-check.ts", { flags: new Set() });
  tools.set("scripts/release/preflight-guards.sh", { flags: new Set(["dependency-manifest", "contract"]) });
  tools.set("scripts/runbook/validate-contract-qa.ts", { flags: new Set(["release", "target", "runnable", "check-sheet", "owner-signers", "root"]) });
  tools.set("scripts/runbook/qa-assert.ts", { verbs: new Set(["eq", "ge", "within-bps", "receipt-id", "receipt-digest", "sub", "router-legs", "legs-differ", "receipt-changes-split"]), flags: new Set() });
  tools.set("scripts/runbook/run-record.ts", { verbs: new Set(["go", "nonce", "report", "signoff"]), flags: new Set(["kind", "run-dir", "evidence-dir", "manifest-dir", "rpc", "sha", "target", "chain-id", "sheet", "tag", "step", "vaults", "release", "sender", "mark"]) });
  tools.set("scripts/runbook/receipt-payload.ts", { flags: new Set(["out", "weights", "session-id"]) });

  const rs = read(root, "clients/rust-payment-client/src/cli.rs");
  const variants = (enumName: string): Set<string> => {
    const body = new RegExp(`pub enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(rs)?.[1] ?? "";
    return new Set([...body.matchAll(/^    ([A-Z][A-Za-z0-9]*)\s*(?:\{|,)/gm)].map((m) => kebab(m[1]!)));
  };
  const rmFlags = new Set<string>(["config", "help", "version"]);
  for (const m of rs.matchAll(/long = "([a-z0-9-]+)"/g)) rmFlags.add(m[1]!);
  for (const m of rs.matchAll(/#\[arg\(long[^\]]*\)\]\s*(?:\/\/\/[^\n]*\s*)*(?:pub )?([a-z_]+):/g)) rmFlags.add(m[1]!.replace(/_/g, "-"));
  for (const m of rs.matchAll(/^\s+([a-z_]+): (?:String|bool|u16|u64|Option<[^>]+>|Vec<[^>]+>|PathBuf),/gm)) rmFlags.add(m[1]!.replace(/_/g, "-"));
  const rmpc = { commands: variants("Command"), nested: new Map([["receipt", variants("ReceiptSubcommand")], ["committee", variants("CommitteeSubcommand")]]), flags: rmFlags };

  const doc = read(root, "docs/operations/contract-release-runbooks.md");
  const sections = new Set([...doc.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\./gm)].map((m) => m[1]!));
  const sheetNames = new Set([...read(root, TARGETS.twin.sheetTemplate!).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
  return { publish, coreStack, tools, rmpc, sections, sheetNames, manifestFiles: new Set(MANIFEST_FILES) };
}

/** Argv elements with list placeholders expanded (the flags they stand for are checked here, once). */
export function expandArgv(argv: string[]): string[] {
  return argv.flatMap((a) => {
    const m = /^\{([a-z]+)\}$/.exec(a);
    return m && LIST_PLACEHOLDERS[m[1]!] ? [...LIST_PLACEHOLDERS[m[1]!]!] : [a];
  });
}
/** Words of a `bash -c` string, quotes and shell punctuation removed. */
export const wordsOf = (script: string): string[] => script.replace(/["'`]/g, " ").split(/[\s;|&()<>]+/).filter(Boolean);

const KNOWN_TOOLS = ["publish-contracts/src/cli.ts", "scripts/stage/core-stack.ts", "target/debug/rmpc", "publish-contracts/src/safe/cli.ts", "publish-contracts/src/rehearsal/cli.ts", "scripts/devnet/twin-fork.ts", "publish-contracts/src/evidence-check.ts", "scripts/ci/check-sha-green.ts", "publish-contracts/src/ci/merge-sheet.ts", "publish-contracts/src/ci/scan-rehearsal-secrets.ts", "scripts/stage/dapp-served-check.ts", "scripts/release/preflight-guards.sh", "scripts/runbook/validate-contract-qa.ts", "scripts/runbook/qa-assert.ts", "scripts/runbook/run-record.ts", "scripts/runbook/receipt-payload.ts"];

/** The invocations of known tools in one command: the tool and the words after it. A `bash -c` script is searched word by word. */
export function invocations(argv: string[]): { tool: string; args: string[] }[] {
  const exp = expandArgv(argv);
  const out: { tool: string; args: string[] }[] = [];
  const scan = (words: string[]) => {
    for (let i = 0; i < words.length; i++) {
      const tool = KNOWN_TOOLS.find((t) => words[i] === t || words[i]!.endsWith(`/${t}`));
      if (!tool) continue;
      const rest: string[] = [];
      for (const w of words.slice(i + 1)) { if (w === "bun" || w === "cast" || w === "jq") break; rest.push(w); }
      out.push({ tool, args: rest.flatMap((w) => expandArgv([w])) });
    }
  };
  if (exp[0] === "bash" && exp[1] === "-c" && typeof exp[2] === "string") scan(wordsOf(exp[2]));
  else scan(exp);
  return out;
}

const looksLikeRepoPath = (s: string): boolean => /^(scripts|publish-contracts|deployments|docs|contracts|clients|config)\/[\w./-]+$/.test(s) && !s.includes("{");

/** PURE. Why the commands of these steps do not match the real CLIs, the placeholder grammar and the repository. */
export function commandProblems(steps: RunbookStep[], model: CliModel, root: string | null = ROOT): string[] {
  const out: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const at = s.id;
    const inCli = { publish: false, stack: false };
    // placeholders
    for (const ref of placeholdersOf(s)) {
      const ok =
        (ref.kind === "env" && /^[A-Z][A-Z0-9_]*$/.test(ref.arg ?? "")) ||
        (ref.kind === "sheet" && /^[A-Z][A-Z0-9_]*$/.test(ref.arg ?? "") && model.sheetNames.has(ref.arg!)) ||
        (ref.kind === "m" && model.manifestFiles.has((ref.arg ?? "").split(".")[0]!) && /^[\w-]+\.\w+$/.test(ref.arg ?? "")) ||
        (ref.kind === "state" && !!ref.arg) ||
        (ref.kind === "journal" && !!ref.arg && stepIds.has(ref.arg)) ||
        (ref.arg === undefined && (SCALARS.has(ref.kind) || ref.kind in LIST_PLACEHOLDERS));
      if (!ok) out.push(`${at}: unknown placeholder ${ref.raw}`);
    }
    for (const cmd of s.cmds) {
      // list placeholders belong in a whole element
      for (const a of cmd) for (const ref of placeholdersIn(a)) if (ref.arg === undefined && ref.kind in LIST_PLACEHOLDERS && a !== ref.raw) out.push(`${at}: list placeholder ${ref.raw} must be a whole argv element, got ${JSON.stringify(a)}`);
      for (const inv of invocations(cmd)) {
        const flagsOf = (args: string[]): string[] => args.filter((a) => /^--[a-z]/.test(a)).map((a) => a.slice(2).split("=")[0]!);
        if (inv.tool === "publish-contracts/src/cli.ts") {
          inCli.publish = true;
          const m = model.publish;
          const verb = inv.args.find((a) => !a.startsWith("-") && m.verbs.has(a));
          const stray = inv.args[0] && !inv.args[0].startsWith("-") && !m.verbs.has(inv.args[0]) ? inv.args[0] : undefined;
          if (stray !== undefined) out.push(`${at}: '${stray}' is no publish-contracts verb (${[...m.verbs].join(", ")})`);
          for (const f of flagsOf(inv.args)) if (!m.flags.has(f)) out.push(`${at}: --${f} is no publish-contracts flag`);
          const ri = inv.args.indexOf("--row");
          if (ri >= 0 && inv.args[ri + 1] && !inv.args[ri + 1]!.includes("{") && !m.rows.has(inv.args[ri + 1]!)) out.push(`${at}: --row ${inv.args[ri + 1]} is no govern row`);
          const dry = inv.args.includes("--dry-run"), plan = inv.args.includes("plan");
          const broadcasts = verb === "publish" || verb === "govern" || verb === "deploy-implementation" || plan;
          if (broadcasts && !dry && !inv.args.includes("--counts-require-origin-dev") && !(inv.args.includes("--counts-dir") && plan && !cmd.includes("{gate}"))) {
            if (!cmd.includes("{gate}")) out.push(`${at}: a ${verb ?? "stage"} command needs {gate}: on 8453 every broadcasting run repeats the release gate with --counts-require-origin-dev`);
          }
        } else if (inv.tool === "scripts/stage/core-stack.ts") {
          inCli.stack = true;
          const [noun, verb] = inv.args.filter((a) => !a.startsWith("-"));
          const vs = noun ? model.coreStack.verbs.get(noun) : undefined;
          if (!vs) out.push(`${at}: core-stack has no noun '${noun}'`);
          else if (!verb || !vs.has(verb)) out.push(`${at}: core-stack ${noun} has no verb '${verb}' (${[...vs].join(", ")})`);
          for (const f of flagsOf(inv.args)) if (!model.coreStack.flags.has(f)) out.push(`${at}: --${f} is no core-stack flag`);
        } else if (inv.tool === "target/debug/rmpc") {
          const words = inv.args.filter((a) => !a.startsWith("-") && !a.startsWith("{") && !a.includes("/") && !/^0x/.test(a));
          const top = words[0];
          if (!top || !model.rmpc.commands.has(top)) out.push(`${at}: rmpc has no subcommand '${top}'`);
          else if (model.rmpc.nested.has(top)) {
            const sub = words[1];
            if (!sub || !model.rmpc.nested.get(top)!.has(sub)) out.push(`${at}: rmpc ${top} has no subcommand '${sub}'`);
          }
          for (const f of flagsOf(inv.args)) if (!model.rmpc.flags.has(f)) out.push(`${at}: --${f} is no rmpc flag`);
        } else {
          const t = model.tools.get(inv.tool);
          if (!t) continue;
          if (t.verbs) {
            const verb = inv.args.find((a) => !a.startsWith("-") && !a.startsWith("{") && !a.includes("/"));
            if (!verb || !t.verbs.has(verb)) out.push(`${at}: ${inv.tool} has no verb '${verb}' (${[...t.verbs].join(", ")})`);
          }
          for (const f of flagsOf(inv.args)) if (!t.flags.has(f)) out.push(`${at}: --${f} is no ${inv.tool} flag`);
        }
      }
      if (root) for (const a of cmd.concat(...(cmd[0] === "bash" ? [wordsOf(cmd[2] ?? "")] : []))) if (looksLikeRepoPath(a) && !existsSync(join(root, a))) out.push(`${at}: ${a} does not exist in the checkout`);
    }
    const exits = Array.isArray(s.expectExit) ? s.expectExit : [s.expectExit];
    if (inCli.publish) for (const e of exits) if (!model.publish.exitCodes.has(e)) out.push(`${at}: expectExit ${e} is no publish-contracts exit code`);
    if (inCli.stack) for (const e of exits) if (!model.coreStack.exitCodes.has(e)) out.push(`${at}: expectExit ${e} is no core-stack exit code`);
    for (const e of exits) if (e < 0 || e > 255) out.push(`${at}: expectExit ${e} is no exit code`);
    for (const ref of s.standing) if (!model.sections.has(ref)) out.push(`${at}: standing ${ref} is no section of docs/operations/contract-release-runbooks.md`);
    for (const k of Object.keys(s.sheetIs ?? {})) if (!model.sheetNames.has(k)) out.push(`${at}: sheetIs names ${k}, which is no sheet line`);
  }
  // irreversible commands must be flagged
  for (const s of steps) {
    const joined = s.cmds.map((c) => expandArgv(c).join(" "));
    const publishes = joined.some((j) => /publish-contracts\/src\/cli\.ts publish\b/.test(j) && !j.includes("--dry-run"));
    const records = joined.some((j) => /cli\.ts record-receipt\b/.test(j));
    const pushes = joined.some((j) => /^git push\b/.test(j));
    if ((publishes || records || pushes) && !s.irreversible) out.push(`${s.id}: it publishes, records a receipt or pushes a tag, so it is irreversible: true`);
    if (joined.some((j) => /--row freeze-upgrades\b/.test(j)) && s.go === undefined) out.push(`${s.id}: a freeze step needs go: it is OFF unless the owner records it`);
  }
  for (const row of ["freeze-upgrades", "apply-receipt"]) {
    const rowSteps = steps.filter((s) => s.cmds.some((c) => c.join(" ").includes(`--row ${row}`)) && !Array.isArray(s.expectExit) && s.expectExit === 0);
    if (rowSteps.length > 0 && !rowSteps.some((s) => s.irreversible)) out.push(`${rowSteps[0]!.id}: the step that executes --row ${row} must be irreversible: true`);
  }
  return out;
}

// ─── the template and the release file ──────────────────────────────────────────────────────────────────────────
const TEMPLATE_KEYS = new Set(["template", "steps"]);
const RELEASE_KEYS = new Set(["release", "template", "templateSha", "productionReady", "notes", "recovery", "decisions", "scope", "flows", "vaults", "steps"]);
/** The vault manifests a release deploys (run-record.ts reads them for the report): the release's `vaults:`, else the four of v0.4.0 and v0.5.0. */
export const RELEASE_VAULT_MANIFESTS = ["vault", "protocol-asset-vault", "agent-token-vault", "rwa-basket-vault"] as const;

/** PURE. A template from its YAML text. Throws with every reason it is not one. */
export function parseTemplate(text: string, templateName: string = TEMPLATE_NAME): { name: string; steps: RunbookStep[] } {
  const doc = Bun.YAML.parse(text) as unknown;
  const where = "template";
  const errors: string[] = [];
  if (!isObject(doc)) throw new Error(`${where}: not a mapping`);
  for (const k of Object.keys(doc)) if (!TEMPLATE_KEYS.has(k)) errors.push(`${where}: unknown key ${k}`);
  if (doc.template !== templateName) errors.push(`${where}: names itself ${String(doc.template)}, not ${templateName}`);
  const steps = parseSteps(doc.steps, where, errors);
  for (const s of steps) if (s.added !== undefined) errors.push(`${where} ${s.id}: a template step carries no added`);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { name: templateName, steps };
}

/** PURE. Why a release's scope list is not one: every entry a PR with a check step of this runbook or a reason. */
export function scopeProblems(scope: unknown, steps: Pick<RunbookStep, "id">[], where: string): string[] {
  if (!Array.isArray(scope) || scope.length === 0) return [`${where}: scope lists every PR the release ships, each with check: <step> or none: <reason>`];
  const out: string[] = [];
  const ids = new Set(steps.map((s) => s.id));
  const seen = new Set<number>();
  for (const e of scope) {
    if (!isObject(e) || !Number.isInteger(e.pr) || (e.pr as number) <= 0 || typeof e.what !== "string" || e.what.trim() === "") { out.push(`${where}: a scope entry is {pr, what, check | none}; got ${JSON.stringify(e)}`); continue; }
    const at = `${where}: scope PR ${e.pr as number}`;
    for (const k of Object.keys(e)) if (!["pr", "what", "check", "none"].includes(k)) out.push(`${at}: unknown key ${k}`);
    if (seen.has(e.pr as number)) out.push(`${at} appears twice`);
    seen.add(e.pr as number);
    const hasCheck = typeof e.check === "string" && e.check !== "", hasNone = typeof e.none === "string" && e.none.trim() !== "";
    if (hasCheck === hasNone) out.push(`${at}: names exactly one of check: <step> or none: <reason>`);
    if (hasCheck && !ids.has(e.check as string)) out.push(`${at}: check ${e.check as string} is no step of this runbook`);
  }
  return out;
}

/** PURE. Why the decisions list is not one. */
export function decisionProblems(decisions: unknown, where: string): string[] {
  if (!Array.isArray(decisions)) return [`${where}: decisions is a list (empty when none is open)`];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    if (!isObject(d) || typeof d.id !== "string" || typeof d.question !== "string" || d.question.trim() === "" || !["open", "decided"].includes(d.status as string)) { out.push(`${where}: a decision is {id, question, status: open | decided, answer, decidedOn, ref}; got ${JSON.stringify(d)}`); continue; }
    if (seen.has(d.id)) out.push(`${where}: decision ${d.id} appears twice`);
    seen.add(d.id);
    if (d.status === "decided") {
      if (typeof d.answer !== "string" || d.answer.trim() === "") out.push(`${where}: decision ${d.id} is decided but has no answer`);
      if (typeof d.decidedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.decidedOn)) out.push(`${where}: decision ${d.id} is decided but has no decidedOn date (YYYY-MM-DD)`);
      if (typeof d.ref !== "string" || d.ref.trim() === "") out.push(`${where}: decision ${d.id} is decided but names no reference (an issue, ADR or commit)`);
    }
  }
  return out;
}

/** PURE. A release runbook from its YAML text, before the add-only check. Throws with every reason it is not one. */
export function parseRelease(text: string, release: string): ReleaseRunbook {
  const doc = Bun.YAML.parse(text) as unknown;
  const where = `runbook ${release}`;
  const errors: string[] = [];
  if (!isObject(doc)) throw new Error(`${where}: not a mapping`);
  for (const k of Object.keys(doc)) if (!RELEASE_KEYS.has(k)) errors.push(`${where}: unknown key ${k}`);
  if (doc.release !== release) errors.push(`${where}: names release ${String(doc.release)}`);
  if (doc.template !== TEMPLATE_NAME) errors.push(`${where}: template is ${TEMPLATE_NAME}, got ${String(doc.template)}`);
  if (doc.templateSha !== undefined && (typeof doc.templateSha !== "string" || !/^[0-9a-f]{40}$/.test(doc.templateSha))) {
    errors.push(`${where}: templateSha is the full 40-character commit the release's template steps were copied from`);
  }
  if (typeof doc.recovery !== "string" || doc.recovery.trim() === "") errors.push(`${where}: recovery is the release's recovery decision, as text`);
  if (doc.notes !== undefined && typeof doc.notes !== "string") errors.push(`${where}: notes is text`);
  if (typeof doc.productionReady !== "boolean") errors.push(`${where}: productionReady is a boolean`);
  if (doc.flows !== undefined) {
    const ok = isObject(doc.flows) && Object.entries(doc.flows).every(([t, l]) => (TARGET_NAMES as readonly string[]).includes(t) && Array.isArray(l) && l.length > 0 && l.every((f) => (FLOW_NAMES as readonly string[]).includes(f as string)));
    if (!ok) errors.push(`${where}: flows maps a target (${TARGET_NAMES.join(", ")}) to a non-empty list of ${FLOW_NAMES.join(" | ")}`);
  }
  if (doc.vaults !== undefined && !(Array.isArray(doc.vaults) && doc.vaults.length > 0 && new Set(doc.vaults).size === doc.vaults.length && doc.vaults.every((v) => (RELEASE_VAULT_MANIFESTS as readonly string[]).includes(v as string)))) errors.push(`${where}: vaults is a list of distinct vault manifest names (${RELEASE_VAULT_MANIFESTS.join(", ")})`);
  const steps = parseSteps(doc.steps, where, errors);
  errors.push(...scopeProblems(doc.scope, steps, where));
  errors.push(...decisionProblems(doc.decisions, where));
  if (doc.productionReady === true && Array.isArray(doc.decisions)) {
    const open = (doc.decisions as Decision[]).filter((d) => d?.status === "open").map((d) => d.id);
    if (open.length > 0) errors.push(`${where}: productionReady is true while owner decisions are open: ${open.join(", ")}`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return doc as unknown as ReleaseRunbook;
}

/**
 * PURE. Why a release runbook is not its template plus additions; empty when it is. Every template step must appear, unchanged, in the
 * template's order. Every other step must carry `added: <the release>` and an id the template lacks.
 */
export function checkAddOnly(template: { steps: RunbookStep[] }, runbook: { release: string; steps: RunbookStep[] }): string[] {
  const out: string[] = [];
  const where = `runbook ${runbook.release}`;
  const templateIds = new Set(template.steps.map((s) => s.id));
  let next = 0;
  for (const step of runbook.steps) {
    if (templateIds.has(step.id)) {
      const t = template.steps.findIndex((s) => s.id === step.id);
      if (t < next) out.push(`${where}: ${step.id} is out of the template's order`);
      else if (t > next) for (const missed of template.steps.slice(next, t)) out.push(`${where}: template step ${missed.id} is missing (a release never deletes a step)`);
      if (t >= next) next = t + 1;
      if (step.added !== undefined) out.push(`${where}: ${step.id} is a template step, so it carries no added`);
      const { added: _added, ...body } = step;
      if (stable(body) !== stable(template.steps[t])) out.push(`${where}: ${step.id} differs from the template's step (a release never edits a template step; add a step instead)`);
    } else if (step.added !== runbook.release) {
      out.push(`${where}: ${step.id} is not a template step, so it carries added: ${runbook.release}`);
    }
  }
  for (const missed of template.steps.slice(next)) out.push(`${where}: template step ${missed.id} is missing (a release never deletes a step)`);
  return out;
}

/** Secret-shaped values: a 64-hex string, a PEM block, a keyed URL, a credential assignment. */
export function secretProblems(text: string, what: string): string[] {
  const out: string[] = [];
  const rules: [RegExp, string][] = [
    [/\b0x[0-9a-fA-F]{64}\b/, "a 64-hex value (a key or a hash: a runbook holds neither)"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
    [/\/v[0-9]\/[A-Za-z0-9_-]{20,}/, "a keyed RPC URL"],
    [/(?:private[_-]?key|mnemonic|secret|password|passphrase|api[_-]?key|token)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i, "a credential assignment"],
  ];
  for (const [re, why] of rules) { const m = re.exec(text); if (m) out.push(`${what}: ${why}: ${m[0].slice(0, 24)}...`); }
  return out;
}

/** The template as committed at `sha`, read from this repo's history (the template's history lives here, whatever `root` is a copy of);
 *  undefined when the commit or the file is not there. */
export function templateAtCommit(sha: string): string | undefined {
  try {
    return execFileSync("git", ["-C", ROOT, "show", `${sha}:${QA_DIR}/template.yaml`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return undefined; }
}

/**
 * PURE (issue 1892). Why the steps of the gateway runbook are not the gateway system's: every gateway publish and verify command names `--system gateway`, no step runs a vaults-only
 * verb or row (govern, pause-all, prove-control, owner signers, a receipt), none reads an `AGENT_` name, and the step that publishes is irreversible and gated on the owner's
 * governance decision (architecture 10: the production gateway authority is an open decision).
 */
export function gatewayStepProblems(steps: RunbookStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const joinedAll = s.cmds.map((c) => expandArgv(c).join(" "));
    for (const joined of joinedAll) {
      if (/publish-contracts\/src\/cli\.ts\s+(publish|verify)\b/.test(joined) && !/--system gateway\b/.test(joined) && !s.id.endsWith("-vaults-verified")) out.push(`${s.id}: a gateway publish or verify command names --system gateway`);
      if (/\b(govern|pause-all|record-receipt|redeploy-vault|deploy-implementation)\b/.test(joined.replace(/validate-contract-qa/g, ""))) out.push(`${s.id}: ${JSON.stringify(joined.slice(0, 80))} runs a vaults-only verb: the gateway system has no govern row, receipt or vault verb`);
      if (/--owner-signer|prove-control|--emergency-signer/.test(joined)) out.push(`${s.id}: the gateway system has no Safe owner signer and no control proof`);
      if (/AGENT_(ADDRESS|ADDRESSES|VALID_UNTIL|MAX)/.test(joined) && !/echo /.test(joined)) out.push(`${s.id}: the gateway deploy authorizes no agent`);
    }
    const publishes = joinedAll.some((j) => /publish-contracts\/src\/cli\.ts\s+publish\b/.test(j) && !j.includes("--dry-run"));
    if (publishes) {
      if (!s.irreversible) out.push(`${s.id}: the step that publishes the gateway is irreversible: true`);
      if (s.go === undefined) out.push(`${s.id}: the gateway publish needs go: the owner's gateway governance decision (architecture 10, open) is recorded before it runs`);
    }
  }
  return out;
}

/** Everything about docs/runbooks/contract-qa/gateway.yaml: it parses as the gateway template, its commands match the real CLIs, it holds no secret and it is the gateway system's. */
export function gatewayRunbookProblems(root: string, model: CliModel): string[] {
  const p = join(root, QA_DIR, "gateway.yaml");
  if (!existsSync(p)) return [`${QA_DIR}/gateway.yaml is missing: the gateway system has its own runbook`];
  const text = readFileSync(p, "utf8");
  const out: string[] = [...secretProblems(text, "gateway.yaml")];
  try {
    const t = parseTemplate(text, GATEWAY_TEMPLATE_NAME);
    out.push(...commandProblems(t.steps, model, root), ...gatewayStepProblems(t.steps));
  } catch (e) { out.push(...(e as Error).message.split("\n").map((m) => `gateway.yaml: ${m}`)); }
  return out;
}

export interface Loaded { template: { name: string; steps: RunbookStep[] }; releases: Map<string, ReleaseRunbook>; problems: string[] }
/** Everything in docs/runbooks/contract-qa/: the template, every release file against it, and the commands against the real CLIs. */
/**
 * PURE. A release that deploys and unpauses basket vaults (it has the govern-schedule step) must set a non-zero emergency unwind
 * guard on every open basket, or the post-govern verify (P4.01, unwindGuardCheck) fails. So it needs a set-unwind-guard govern
 * round for each of PROTO and RWA. rmAGENT is retired from v0.6.0, so it is not required there.
 */
export function unwindGuardProblems(r: Pick<ReleaseRunbook, "release" | "steps">): string[] {
  if (!r.steps.some((s) => s.id === "P3.01-govern-schedule")) return [];
  const rounds = r.steps.flatMap((s) => s.cmds ?? []).filter((c) => c.includes("set-unwind-guard"));
  const out: string[] = [];
  for (const vault of ["PROTO", "RWA"]) {
    if (!rounds.some((c) => c.includes(`vault=${vault}`))) out.push(`releases/${r.release}.yaml: an open basket vault (${vault}) has no set-unwind-guard step, so the post-govern verify fails its emergency unwind guard check`);
  }
  return out;
}

/** PURE. Whether a step sends a transaction: a broadcasting publish-contracts verb, a cast send (through cast-send.sh or not) or a Safe creation. */
export function sends(s: Pick<RunbookStep, "cmds">): boolean {
  return s.cmds.some((c) => {
    const j = expandArgv(c).join(" ");
    if (/publish-contracts\/src\/cli\.ts\b.*\s(publish|govern|deploy-implementation|record-receipt|pause-all|redeploy-vault)(\s|$)/.test(j) && !j.includes("--dry-run")) return true;
    return /scripts\/runbook\/cast-send\.sh|\bcast send\b|publish-contracts\/src\/safe\/cli\.ts\b/.test(j);
  });
}

/** PURE. No step starts, serves, waits for or stops a Twin fork, or runs anvil, as a command of this machine: the fork lives on the stage host (README "Hosts"), so the command is an ssh command whose remote script names it. */
export function localForkProblems(steps: Pick<RunbookStep, "id" | "cmds">[]): string[] {
  const out: string[] = [];
  for (const s of steps) for (const c of s.cmds) {
    const forkVerb = c.findIndex((a) => a === "scripts/devnet/twin-fork.ts" || a.endsWith("/scripts/devnet/twin-fork.ts"));
    const verb = forkVerb < 0 ? undefined : c[forkVerb + 1];
    if (verb !== undefined && ["start", "serve", "wait-ready", "stop"].includes(verb)) out.push(`${s.id}: twin-fork.ts ${verb} runs on this machine; the fork lives on the stage host, so run it in an ssh command`);
    if (c[0] === "anvil" || (c[0] === "bash" && c[1] === "-c" && /(^|[\s;&|(])anvil\s/.test(c[2] ?? ""))) out.push(`${s.id}: anvil runs on this machine; the fork lives on the stage host`);
  }
  return out;
}
/**
 * PURE (issue 1980). No step clears the router's voted vector: neither the `govern --row clear-voted-weights` round nor a direct clearVotedWeights() call. The owner
 * decided the runbook never clears a vector (a rerun or a resume of the v0.6.0 upgrade flow cleared the vector it had applied itself, and later deposits routed on the
 * default). Checked on the template and the release being prepared; a pinned release is a record and is not reopened.
 */
export function clearVectorProblems(steps: Pick<RunbookStep, "id" | "cmds">[], where: string): string[] {
  const out: string[] = [];
  for (const s of steps) for (const c of s.cmds) {
    const joined = expandArgv(c).join(" ");
    if (/--row[\s=]+clear-voted-weights\b|\bclearVotedWeights\(/.test(joined)) out.push(`${where} ${s.id}: the runbook never clears the router's voted vector (govern --row clear-voted-weights, owner decision, issue 1980)`);
  }
  return out;
}
/** The flags run-record.ts needs to compute the report (README "Run it"): without one the step exits 2 at run time, so the validator refuses the file before a run. */
export const RECORD_FLAGS = ["run-dir", "evidence-dir", "manifest-dir", "rpc", "sha", "target", "chain-id", "sheet", "tag", "release"] as const;
/** PURE. Every step that runs run-record.ts report or signoff names every flag the report needs, `--release` included. */
export function recordStepProblems(steps: Pick<RunbookStep, "id" | "cmds">[]): string[] {
  const out: string[] = [];
  for (const s of steps) for (const c of s.cmds) {
    const verb = c.findIndex((a) => a === "scripts/runbook/run-record.ts" || a.endsWith("/scripts/runbook/run-record.ts"));
    if (verb < 0 || !["report", "signoff"].includes(c[verb + 1] ?? "")) continue;
    for (const f of RECORD_FLAGS) if (!c.includes(`--${f}`)) out.push(`${s.id}: run-record.ts ${c[verb + 1]} needs --${f}`);
  }
  return out;
}

/**
 * PURE. A mainnet run sends only what QA sent (policy 4.14, README "Assurances"): every step that sends on the rehearsal or production target must also run on
 * the twin target. A step that only reads (a gate, a funding check, the plan) may be mainnet-only.
 */
export function qaSupersetProblems(r: Pick<ReleaseRunbook, "release" | "flows" | "steps">): string[] {
  const twin = new Set(applicableSteps(r, "twin").map((s) => s.id));
  const out: string[] = [];
  for (const t of ["rehearsal", "production"]) for (const s of applicableSteps(r, t)) if (sends(s) && !twin.has(s.id)) out.push(`releases/${r.release}.yaml: ${s.id} sends on ${t} but does not run on twin: QA runs every transaction a mainnet run sends`);
  return out;
}

/**
 * PURE. Issue 1929: the library-linked publish stage leaves the main checkout's out/ equal to the chain, and every later verify reads it. A forge command after
 * P1.02-publish that writes that out/ (build, script, clean, test) replaces it with a build whose metadata hash differs, so the next verify fails. Such a command
 * must name both --root and --out under {runDir}, a separate checkout.
 */
export function mainOutProblems(r: Pick<ReleaseRunbook, "release" | "steps">): string[] {
  const at = r.steps.findIndex((s) => s.id === "P1.02-publish");
  if (at < 0) return [];
  const out: string[] = [];
  for (const s of r.steps.slice(at + 1)) {
    for (const c of s.cmds) {
      const forge = c[0] === "forge" ? [c] : c[0] === "bash" && c[1] === "-c" ? (c[2] ?? "").split(/&&|;|\|/).map((x) => x.trim().split(/\s+/)).filter((x) => x[0] === "forge") : [];
      for (const f of forge) {
        if (!["build", "script", "clean", "test"].includes(f[1] ?? "")) continue;
        const arg = (flag: string): string | undefined => f[f.indexOf(flag) + 1];
        const apart = (flag: string): boolean => f.includes(flag) && (arg(flag) ?? "").startsWith("{runDir}/");
        if (!(apart("--root") && apart("--out"))) out.push(`releases/${r.release}.yaml: ${s.id}: \`${f.join(" ")}\` writes the main checkout's out/ after the library-linked P1.02-publish, so a later verify reads a rebuilt out/ and fails; build in a separate checkout with --root and --out under {runDir}`);
      }
    }
  }
  return out;
}

/** The --upgrade-build checkout a step reads, if any (the argument after --upgrade-build). */
const upgradeBuildsOf = (s: Pick<RunbookStep, "cmds">): string[] => s.cmds.map(expandArgv).flatMap((c) => c.flatMap((a, i) => (a === "--upgrade-build" && c[i + 1] !== undefined ? [c[i + 1]!] : [])));
/** A step makes this checkout: a `git worktree add` of it. */
const makesCheckout = (s: Pick<RunbookStep, "cmds">, dir: string): boolean => s.cmds.some((c) => { const j = expandArgv(c).join(" "); return /\bgit\b.*\bworktree add\b/.test(j) && j.split(/\s+/).includes(dir); });

/**
 * PURE (issue 1996). The step that makes and builds a --upgrade-build checkout (a worktree, every submodule, forge build) is skipped once nothing reads the build:
 * its gateAbsent lists the gateAbsent of every step that reads the checkout, no more and no less, so it is skipped exactly when every reader is. Each reader must
 * have a gateAbsent (else the build can never be skipped by it), the build step comes before every reader and runs on every flow and target a reader runs on.
 */
export function upgradeBuildGateProblems(steps: RunbookStep[], where: string): string[] {
  const out: string[] = [];
  for (const dir of [...new Set(steps.flatMap(upgradeBuildsOf))]) {
    const readers = steps.filter((s) => upgradeBuildsOf(s).includes(dir));
    const builders = steps.filter((s) => makesCheckout(s, dir));
    if (builders.length !== 1) { out.push(`${where}: ${builders.length === 0 ? "no step makes" : `${builders.map((b) => b.id).join(", ")} each make`} the --upgrade-build checkout ${dir}; exactly one step makes and builds it`); continue; }
    const b = builders[0]!;
    const gate = new Set(gateAbsentPaths(b));
    const wanted = new Set<string>();
    for (const r of readers) {
      if (steps.indexOf(r) < steps.indexOf(b)) out.push(`${where} ${r.id}: it reads ${dir} before ${b.id} makes it`);
      const rf = flowsOf(r), bf = flowsOf(b), ro = onlyForList(r), bo = onlyForList(b);
      if (!rf.every((f) => bf.includes(f)) || (bo.length > 0 && (ro.length === 0 || !ro.every((t) => bo.includes(t))))) out.push(`${where} ${r.id}: it reads ${dir} on a flow or target where ${b.id} does not make it`);
      const paths = gateAbsentPaths(r);
      if (paths.length === 0) out.push(`${where} ${r.id}: it reads ${dir} but has no gateAbsent, so ${b.id} cannot tell when it no longer needs the build (issue 1996)`);
      for (const p of paths) { wanted.add(p); if (!gate.has(p)) out.push(`${where} ${b.id}: its gateAbsent does not list ${p}, the gate of ${r.id}, which reads ${dir}: list the gate of every step that reads it (issue 1996)`); }
    }
    for (const p of gate) if (!wanted.has(p)) out.push(`${where} ${b.id}: its gateAbsent lists ${p}, which gates no step that reads ${dir}`);
  }
  return out;
}

/** The command shape each `exercises` value must have: a journaled send (cast-send.sh) of the vault or router call it names. */
const EXERCISE_SHAPE: Readonly<Record<Exercise, RegExp>> = {
  "vault-deposit": /deposit\(uint256,address\)/,
  "router-deposit": /deposit\(uint256,uint256\[\]\)/,
  redeem: /(?:redeem|redeemInKind|\$fn)\(uint256,address,address\)/,
};
/** A step runs the apply-receipt govern row: the rebalance (publish-contracts/src/govern.ts, "that submission is the rebalance"). */
const appliesReceipt = (s: Pick<RunbookStep, "cmds">): boolean => s.cmds.some((c) => expandArgv(c).join(" ").includes("--row apply-receipt"));

/**
 * PURE (issue 1984). The router rebalance is the apply-receipt step. ADR-0003 routes only new deposits by the new vector, so a run proves the vaults and the router on
 * BOTH sides of it: for every flow and target where an apply-receipt step runs, a direct vault deposit, a router deposit and a redeem run before the first such step, and
 * again after the last one. A step counts by its explicit `exercises:` field, never by its command alone: a setup deposit (the Twin's dirty pre-state), a cleanup redeem
 * (the live pre-state), a conditional retired-vault redeem or a refused deposit probe has the same `cast send` shape and proves no round. A step that carries the field must
 * also have that shape (a journaled cast-send.sh of the call), so the label cannot stand in for the send.
 */
export function rebalanceRoundProblems(steps: RunbookStep[], where: string): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.exercises === undefined) continue;
    const joined = s.cmds.map((c) => expandArgv(c).join(" ")).filter((j) => j.includes("scripts/runbook/cast-send.sh"));
    if (!joined.some((j) => EXERCISE_SHAPE[s.exercises!].test(j))) out.push(`${where} ${s.id}: exercises ${s.exercises}, but no command sends that call through scripts/runbook/cast-send.sh`);
  }
  for (const flow of FLOW_NAMES) for (const target of TARGET_NAMES) {
    const run = steps.filter((s) => flowsOf(s).includes(flow) && (onlyForList(s).length === 0 || onlyForList(s).includes(target)));
    const applies = run.map((s, i) => (appliesReceipt(s) ? i : -1)).filter((i) => i >= 0);
    if (applies.length === 0) continue;
    const apply = run[applies[0]!]!.id;
    for (const [side, part] of [["before", run.slice(0, applies[0]!)], ["after", run.slice(applies.at(-1)! + 1)]] as const) {
      for (const kind of EXERCISES) if (!part.some((s) => s.exercises === kind)) out.push(`${where}: the ${flow} flow on ${target} has no ${kind} step ${side} ${apply} (the router rebalance): deposit, router deposit and redeem run on both sides of it (issue 1984)`);
    }
  }
  return out;
}

export function validateAll(root: string = ROOT, model: CliModel = loadModel(root), pinnedTemplate: (sha: string) => string | undefined = templateAtCommit): Loaded {
  const problems: string[] = [];
  const tplPath = join(root, QA_DIR, "template.yaml");
  const tplText = readFileSync(tplPath, "utf8");
  let template: { name: string; steps: RunbookStep[] } = { name: TEMPLATE_NAME, steps: [] };
  try { template = parseTemplate(tplText); } catch (e) { problems.push(...(e as Error).message.split("\n")); }
  problems.push(...secretProblems(tplText, "template.yaml"));
  problems.push(...commandProblems(template.steps, model, root));
  problems.push(...clearVectorProblems(template.steps, "template.yaml"));
  problems.push(...upgradeBuildGateProblems(template.steps, "template.yaml"));
  problems.push(...recordStepProblems(template.steps), ...localForkProblems(template.steps));
  problems.push(...rebalanceRoundProblems(template.steps, "template.yaml"));
  problems.push(...gatewayRunbookProblems(root, model));
  const releases = new Map<string, ReleaseRunbook>();
  const dir = join(root, QA_DIR, "releases");
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort() : []) {
    const name = f.slice(0, -".yaml".length);
    const text = readFileSync(join(dir, f), "utf8");
    problems.push(...secretProblems(text, `releases/${f}`));
    try {
      const r = parseRelease(text, name);
      releases.set(name, r);
      problems.push(...unwindGuardProblems(r));
      problems.push(...mainOutProblems(r));
      problems.push(...qaSupersetProblems(r));
      // A release pinned to templateSha is a record: its steps are checked against the template AT that commit, never the
      // current one, and its commands were checked against the CLIs at that commit, so a later template or CLI change does
      // not reopen it. The pin is read from git, so an edited record or a made-up commit is refused. An unpinned release is
      // the one being prepared: it must match the current template and the current CLIs.
      if (r.templateSha !== undefined) {
        const pinned = pinnedTemplate(r.templateSha);
        if (pinned === undefined) { problems.push(`releases/${f}: templateSha ${r.templateSha} has no ${QA_DIR}/template.yaml in git`); continue; }
        try { problems.push(...checkAddOnly(parseTemplate(pinned), r)); } catch (e) { problems.push(`releases/${f}: template at ${r.templateSha}: ${(e as Error).message}`); }
        continue;
      }
      problems.push(...checkAddOnly(template, r));
      problems.push(...commandProblems(r.steps, model, root));
      problems.push(...clearVectorProblems(r.steps, `releases/${f}`));
      problems.push(...upgradeBuildGateProblems(r.steps, `releases/${f}`));
      problems.push(...recordStepProblems(r.steps), ...localForkProblems(r.steps));
      problems.push(...rebalanceRoundProblems(r.steps, `releases/${f}`));
    } catch (e) { problems.push(...(e as Error).message.split("\n")); }
  }
  if (releases.size === 0) problems.push(`${QA_DIR}/releases/ holds no release runbook`);
  return { template, releases, problems: [...new Set(problems)] };
}

/** PURE. Why a release is not runnable on this target: a production run refuses while an owner decision is open. */
export function runnableProblems(r: ReleaseRunbook, target: string): string[] {
  if (!(TARGET_NAMES as readonly string[]).includes(target)) return [`--target is ${TARGET_NAMES.join(" | ")}, got '${target}'`];
  if (applicableSteps(r, target).length === 0) return [`release ${r.release} has no step that runs on ${target}`];
  if (target !== "production") return [];
  const open = r.decisions.filter((d) => d.status === "open");
  const out = open.map((d) => `owner decision '${d.id}' is open: ${d.question}`);
  if (!r.productionReady) out.push(`release ${r.release} is not marked productionReady: a production run needs the owner to set productionReady: true once every decision is decided`);
  return out;
}

// ─── the run sheet against the environment ──────────────────────────────────────────────────────────────────────
export function parseSheetText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*"?([^"#\n]*?)"?\s*(?:#.*)?$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}
const PLACEHOLDER_ADDRESS = /^0x0{30,}[0-9a-fA-F]{1,10}$/;
/** PURE. Why the run sheet does not agree with the target. The CLI's own sheet parser stays the authority; this is the early, runbook-level check. */
export function sheetProblems(sheet: Record<string, string>, target: string, ownerSigners?: number): string[] {
  if (!(TARGET_NAMES as readonly string[]).includes(target)) return [`--target is ${TARGET_NAMES.join(" | ")}, got '${target}'`];
  const t = TARGETS[target as TargetName];
  const out: string[] = [];
  const need = (n: string): string | undefined => { if (sheet[n] === undefined || sheet[n] === "") { out.push(`sheet: ${n} is missing`); return undefined; } return sheet[n]; };
  for (const n of ["CHAIN_ID", "EXPECTED_CHAIN_ID"]) if (need(n) !== undefined && Number(sheet[n]) !== t.chainId) out.push(`sheet: ${n} is ${sheet[n]}, ${target} runs on ${t.chainId}`);
  const kind = sheet.DEPLOYMENT_KIND ?? "";
  if (!t.kinds.includes(kind)) out.push(`sheet: DEPLOYMENT_KIND is '${kind}', ${target} needs ${t.kinds.map((k) => `'${k}'`).join(" or ")}`);
  const delay = Number(need("TIMELOCK_MIN_DELAY"));
  if (sheet.TIMELOCK_MIN_DELAY !== undefined && !(delay >= t.delay.min && delay <= t.delay.max)) out.push(`sheet: TIMELOCK_MIN_DELAY ${sheet.TIMELOCK_MIN_DELAY} is outside ${t.delay.min}..${t.delay.max === Infinity ? "any" : t.delay.max} for ${target}`);
  if (need("SEED_DEPOSIT_USDC") !== undefined && sheet.SEED_DEPOSIT_USDC !== "1000000") out.push(`sheet: SEED_DEPOSIT_USDC is ${sheet.SEED_DEPOSIT_USDC}; the standing rule is 1 USDC (1000000)`);
  for (const k of ["USDC", "PROTO", "RWA"]) {
    const tvl = need(`VAULT_${k}_TVL_CAP`), per = need(`VAULT_${k}_PER_DEPOSIT_CAP`);
    if (tvl === undefined || per === undefined) continue;
    if (BigInt(per) > BigInt(tvl)) out.push(`sheet: VAULT_${k}_PER_DEPOSIT_CAP is above its TVL cap`);
    if (BigInt(per) < 1000000n) out.push(`sheet: VAULT_${k}_PER_DEPOSIT_CAP ${per} is below the 1 USDC test deposit (1000000)`);
    if (target === "rehearsal" && BigInt(tvl) > 1000000000n) out.push(`sheet: VAULT_${k}_TVL_CAP ${tvl} is above 1000 USDC; a rehearsal is a contained test`);
  }
  const mode = need("UPGRADE_MODE");
  if (mode !== undefined && !["upgradeable", "frozen"].includes(mode)) out.push(`sheet: UPGRADE_MODE is '${mode}', not upgradeable or frozen`);
  if (target === "production" && mode === "upgradeable" && !sheet.UPGRADE_FREEZE_DEADLINE) out.push("sheet: an upgradeable production release needs UPGRADE_FREEZE_DEADLINE");
  if (mode === "frozen" && sheet.UPGRADE_FREEZE_DEADLINE) out.push("sheet: UPGRADE_FREEZE_DEADLINE goes with UPGRADE_MODE=upgradeable only");
  const owners = (need("SAFE_OWNERS") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const threshold = Number(need("SAFE_THRESHOLD"));
  if (owners.length < 3) out.push(`sheet: SAFE_OWNERS lists ${owners.length} owners, at least 3 are needed`);
  if (!(threshold >= 2 && threshold < owners.length)) out.push(`sheet: SAFE_THRESHOLD ${threshold} is not 2 to ${owners.length - 1}`);
  if (target !== "twin") {
    for (const n of ["ADMIN_ADDRESS", "PAUSER_ADDRESS", "EMERGENCY_ADDRESS", "SHARE_RECEIVER_ADDRESS", ...owners.map((_, i) => `SAFE_OWNERS[${i}]`)]) {
      const v = n.startsWith("SAFE_OWNERS[") ? owners[Number(/\d+/.exec(n)![0])]! : sheet[n];
      if (v !== undefined && PLACEHOLDER_ADDRESS.test(v)) out.push(`sheet: ${n} is still the example placeholder ${v}; type the real public address`);
    }
    if (target === "rehearsal" && !sheet.SAFE_SALT_NONCE) out.push("sheet: a rehearsal needs an explicit SAFE_SALT_NONCE no earlier run used");
    if (ownerSigners === undefined) out.push("no --owner-signers count: an 8453 run needs one owner signer spec per sheet owner");
    else if (ownerSigners !== owners.length) out.push(`${ownerSigners} owner signer specs for ${owners.length} sheet owners: prove-control needs a signer for EVERY owner`);
  } else if (ownerSigners !== undefined && ownerSigners !== 0 && ownerSigners !== owners.length) out.push(`${ownerSigners} owner signer specs for ${owners.length} sheet owners: give none (the Twin default keystores) or all`);
  return out;
}

// ─── the command line ───────────────────────────────────────────────────────────────────────────────────────────
async function main(argv: string[]): Promise<number> {
  const { parseArgs } = await import("node:util");
  let v;
  try {
    v = parseArgs({ args: argv, strict: true, options: { release: { type: "string" }, target: { type: "string" }, runnable: { type: "boolean" }, "check-sheet": { type: "string" }, "owner-signers": { type: "string" }, root: { type: "string" } } }).values;
  } catch (e) { console.error(`usage: ${(e as Error).message}`); return 2; }
  const root = v.root ? resolve(v.root) : ROOT;
  const problems: string[] = [];
  if (v["check-sheet"]) {
    if (!v.target) { console.error("usage: --check-sheet needs --target"); return 2; }
    const owners = v["owner-signers"] === undefined ? undefined : Number(v["owner-signers"]);
    problems.push(...sheetProblems(parseSheetText(readFileSync(v["check-sheet"], "utf8")), v.target, owners !== undefined && Number.isInteger(owners) ? owners : undefined));
  } else {
    const all = validateAll(root);
    problems.push(...all.problems);
    if (v.runnable) {
      if (!v.release || !v.target) { console.error("usage: --runnable needs --release and --target"); return 2; }
      const r = all.releases.get(v.release);
      if (!r) problems.push(`no release runbook ${QA_DIR}/releases/${v.release}.yaml`);
      else problems.push(...runnableProblems(r, v.target));
    }
  }
  for (const p of problems) console.error(p);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
