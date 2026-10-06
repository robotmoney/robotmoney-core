// Core parity: every name the stage table (and this tool's wiring) uses must exist in the core checkout it was read from.
// Core is the source of truth. A row whose script, contract, required env name, manifest file, manifest field or artifact does not exist in
// core is a problem that names the row. Used by tests/core-parity.test.ts (a required job in ci.yml, core checked out at the pinned DEPLOY_SHA)
// and runnable alone: bun src/ci/core-parity.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_ENV, MANIFEST_FIELDS_READ, SAFE_STAGE, VAULT_ADDRESS_FIELD, resolveEnv } from "../core-wiring.ts";
import { loadStageTable, manifestFile, type StageTable, type TableStage } from "../stage-table.ts";
import { SHEET_SPEC } from "../sheet.ts";

const read = (coreDir: string, rel: string): string => readFileSync(join(coreDir, rel), "utf8");
const scriptFile = (s: TableStage): string => s.script.split(":")[0]!;
const scriptContract = (s: TableStage): string => s.script.split(":")[1]!;

/** The script source plus the local `./*.sol` files it imports (shared bases carry the env readers, the chain guard and the manifest writer), followed recursively. */
export function scriptSource(coreDir: string, rel: string, seen: Set<string> = new Set()): string {
  if (seen.has(rel)) return "";
  seen.add(rel);
  const dir = rel.replace(/[^/]+$/, "");
  const own = read(coreDir, rel);
  let src = own;
  for (const m of own.matchAll(/^import\s+(?:\{[^}]*\}\s+from\s+)?"(\.\/[^"]+\.sol)"/gm)) {
    const p = join(dir, m[1]!);
    if (existsSync(join(coreDir, p))) src += "\n" + scriptSource(coreDir, p, seen);
  }
  return src;
}

/** True when `"NAME"` appears in a quoted literal on a line that reads the environment (a vm.env* call, an env helper or a prefixed key handed to one). */
export function readsEnv(src: string, name: string): boolean {
  return src.split("\n").some((l) => l.includes(`"${name}"`) && /env|prefix/i.test(l));
}

/** The manifest file name a script writes: MANIFEST_FILE, or for a basket script the label (`protocol_asset_vault` -> `protocol-asset-vault.json`). */
export function manifestWritten(coreDir: string, s: TableStage): string | undefined {
  const own = read(coreDir, scriptFile(s));
  const direct = /MANIFEST_FILE\s*=\s*"([^"]+)"/.exec(own)?.[1];
  if (direct) return direct;
  const i = own.indexOf("function _label");
  const label = i >= 0 ? /return "([a-z_]+)";/.exec(own.slice(i))?.[1] : undefined;
  return label ? `${label.replaceAll("_", "-")}.json` : undefined;
}

function walkSol(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "test" && n !== "node_modules") walkSol(p, out); } else if (n.endsWith(".sol")) out.push(p);
  }
  return out;
}

/** True when `name` is a contract, library, interface or abstract contract declared under core contracts/ (not tests), or imported by name by one. */
export function artifactExists(coreDir: string, name: string): boolean {
  const decl = new RegExp(`^\\s*(?:abstract\\s+)?(?:contract|library)\\s+${name}\\b`, "m");
  const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
  return walkSol(join(coreDir, "contracts")).some((f) => { const t = readFileSync(f, "utf8"); return decl.test(t) || imp.test(t); });
}

/** Problems of one stage row. Each message starts with the row name. */
export function stageProblems(table: StageTable, coreDir: string, s: TableStage): string[] {
  const out: string[] = [];
  const bad = (m: string) => out.push(`stage ${s.name}: ${m}`);
  const file = scriptFile(s);
  if (!existsSync(join(coreDir, file))) { bad(`forge script file ${file} does not exist in core`); return out; }
  const own = read(coreDir, file);
  if (!new RegExp(`contract\\s+${scriptContract(s)}\\b`).test(own)) bad(`contract ${scriptContract(s)} is not declared in ${file}`);
  const src = scriptSource(coreDir, file);
  for (const e of s.requiredEnv) if (!readsEnv(src, e)) bad(`required env ${e} is not read by ${file} (no vm.env* call names it)`);
  for (const e of s.optionalEnv) if (!readsEnv(src, e)) bad(`optional env ${e} is not read by ${file}`);
  const written = manifestWritten(coreDir, s);
  if (written !== manifestFile(s.manifest)) bad(`manifest ${manifestFile(s.manifest)} is not the file ${file} writes (${written ?? "none found"})`);
  for (const e of s.requiredEnv) {
    if (resolveEnv(e, s.vault).from === "unmapped") bad(`publish contracts has no mapping for required env ${e} (core-wiring.ts)`);
  }
  for (const n of s.libraries) {
    const l = table.libraries.find((x) => x.name === n);
    if (!l) { bad(`links unknown library ${n}`); continue; }
    if (!existsSync(join(coreDir, l.path))) bad(`library source ${l.path} does not exist in core`);
    else if (!new RegExp(`library\\s+${l.artifact}\\b`).test(read(coreDir, l.path))) bad(`library ${l.artifact} is not declared in ${l.path}`);
  }
  const v = table.vaults.find((x) => x.stage === s.name);
  if (v && !artifactExists(coreDir, v.artifact)) bad(`vault artifact ${v.artifact} does not exist in core contracts`);
  return out;
}

/** Problems that are not about one row: artifacts, manifest fields the verifier reads, the manifest keys of the libs stage, wiring targets. */
export function tableProblems(table: StageTable, coreDir: string): string[] {
  const out: string[] = [];
  for (const [k, name] of Object.entries(table.artifacts)) if (!artifactExists(coreDir, name)) out.push(`artifacts.${k}: ${name} does not exist in core contracts`);
  for (const l of table.libraries) if (!artifactExists(coreDir, l.artifact)) out.push(`library ${l.name}: artifact ${l.artifact} does not exist in core contracts`);
  const stage = (n: string) => table.stages.find((s) => s.name === n);
  const fieldWritten = (stageName: string, field: string): boolean => {
    const s = stage(stageName);
    if (!s || !existsSync(join(coreDir, scriptFile(s)))) return false;
    const src = scriptSource(coreDir, scriptFile(s));
    // vm.serialize*(obj, "field", ...) or a raw JSON string `"field":` (the basket vault manifest is built by string concat)
    return src.split("\n").some((l) => l.includes(`"${field}"`) && /serialize/i.test(l)) || src.includes(`"${field}":`);
  };
  for (const v of table.vaults) if (!fieldWritten(v.stage, VAULT_ADDRESS_FIELD)) out.push(`vault ${v.key}: manifest field ${VAULT_ADDRESS_FIELD} is not written by the ${v.stage} stage script`);
  for (const { stage: st, field } of MANIFEST_FIELDS_READ) {
    if (st === SAFE_STAGE) continue;
    if (!stage(st)) out.push(`wiring reads manifest field ${field} of stage ${st}, which the table does not list`);
    else if (!fieldWritten(st, field)) out.push(`manifest field ${field} is not written by the ${st} stage script (vm.serialize* call)`);
  }
  for (const l of table.libraries) {
    const libs = stage("libs");
    if (libs && !fieldWritten("libs", l.manifestKey)) out.push(`library ${l.name}: manifest key ${l.manifestKey} is not written by the libs stage script`);
  }
  for (const [env, m] of Object.entries(MANIFEST_ENV)) if (m.stage !== SAFE_STAGE && !stage(m.stage)) out.push(`env ${env} reads stage ${m.stage}, which the table does not list`);
  for (const s of table.stages) {
    for (const e of s.requiredEnv) {
      const src = resolveEnv(e, s.vault);
      if (src.from === "sheet" && !(src.name in SHEET_SPEC)) out.push(`stage ${s.name}: env ${e} maps to sheet name ${src.name}, which is not a sheet name`);
    }
  }
  const seen = new Set<string>();
  for (const s of table.stages) {
    const f = manifestFile(s.manifest);
    if (seen.has(f)) out.push(`two stages write ${f}`);
    seen.add(f);
  }
  return out;
}

export function parityProblems(table: StageTable, coreDir: string): string[] {
  return [...table.stages.flatMap((s) => stageProblems(table, coreDir, s)), ...tableProblems(table, coreDir)];
}

if (import.meta.main) {
  const coreDir = new URL("../../..", import.meta.url).pathname; // the repo root: this package lives in core
  const problems = parityProblems(loadStageTable(coreDir), coreDir);
  for (const p of problems) console.error(`PARITY: ${p}`);
  console.log(problems.length ? `${problems.length} parity problem(s)` : "core parity ok");
  process.exit(problems.length ? 1 : 0);
}
