// The consumer contract of core's Twin harness (core testing/smoke-test/src/publish.rs, run_cli and publish_args; scripts/stage/core-stack.ts).
// Core is the consumer: this test spawns the CLI as a child process with EXACTLY the argument vector and environment core builds, and asserts what
// core reads back: exit codes, the govern stdout JSON lines {row, txHash, status}, the verifier labels on stdout and the manifest directory.
//
// What core builds (publish.rs):
//   argv  = [verb, --chain 918453, --rpc RPC, --sheet SHEET, --signer keystore:KEYDIR/DEPLOYER:PASSFILE, --environment stage, --core-sha SHA, ...extra]
//           verb is publish, verify or govern. `govern` adds `--row ROW` for one row. No --core-dir, --counts-dir or --evidence.
//   env   = the harness environment plus PUBLISH_MANIFEST_DIR=<work dir>/manifests. stdin is null. The child's stdout is parsed, its stderr is shown.
// The test doubles (stub forge and cast, a fake Safe API and timelock) stand in for tools and the chain. They prove the CLI surface only.
// They are no evidence for the Safe, its signers or governance: that is proven on the real deployment (repo CLAUDE.md, item b).
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { GOVERN_ROWS } from "../src/govern.ts";
import { getStageTable } from "../src/stages.ts";
import { manifestFile } from "../src/stage-table.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { SHA, tmp } from "./fixtures.ts";
import { world } from "./harness.ts";
import { writeGovernManifests } from "./govern-world.ts";

const ENTRY = join(import.meta.dir, "stubs", "cli-entry.ts");
export const FIXTURE = join(import.meta.dir, "fixtures", "govern-stdout.jsonl");
const RPC = "http://127.0.0.1:18545"; // core's DEFAULT_RPC_URL

/** publish_args in publish.rs, in order. */
export function coreArgs(verb: string, sheet: string, signer: string, extra: string[] = []): string[] {
  return [verb, "--chain", "918453", "--rpc", RPC, "--sheet", sheet, "--signer", signer, "--environment", "stage", "--core-sha", SHA, ...extra];
}

/** core's parse_govern_output: every stdout line that starts with `{` and parses as {row, txHash, status}. */
export function parseGovernOutput(stdout: string): { row: string; txHash: string; status: number }[] {
  const rows: { row: string; txHash: string; status: number }[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try { const j = JSON.parse(line); if (typeof j.row === "string") rows.push({ row: j.row, txHash: j.txHash ?? "", status: j.status ?? 0 }); } catch { /* not a row */ }
  }
  return rows;
}

interface Case { dir: string; cwd: string; manifestDir: string; sheet: string; signer: string; env: Record<string, string>; w: ReturnType<typeof world> }

/** One harness boot: a work dir with the keystores layout core makes (DEPLOYER and SAFE_OWNER_* under one passphrase file), the manifest dir, and a cwd inside a core checkout. */
function boot(o: { withEnv?: Record<string, string>; noYes?: boolean } = {}): Case {
  const w = world({ chainId: 918453 });
  const keyDir = join(w.dir, "keys");
  mkdirSync(keyDir, { recursive: true });
  for (const n of ["DEPLOYER", "SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"]) writeFileSync(join(keyDir, n), "{}");
  const pw = join(w.dir, "passphrase");
  writeFileSync(pw, "not-a-real-passphrase-fixture"); chmodSync(pw, 0o600);
  // core runs the CLI from inside its own checkout (the cargo test directory), with no --core-dir and no --counts-dir
  const cwd = join(w.coreDir, "testing", "smoke-test");
  mkdirSync(join(cwd, "deployments", "frozen-counts"), { recursive: true });
  copyFileSync(join(w.countsDir, `${SHA}.json`), join(cwd, "deployments", "frozen-counts", `${SHA}.json`));
  const manifestDir = join(w.dir, "manifests");
  mkdirSync(manifestDir, { recursive: true });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/PRIVATE_KEY|ETH_PASSWORD|MNEMONIC|CHAIN_SIGNER|^YES$|^CONFIRM$/.test(k))) as Record<string, string>;
  const env: Record<string, string> = {
    ...clean, PATH: `${join(import.meta.dir, "stubs")}:${process.env.PATH}`, STUB_STATE: w.statePath, STUB_CONFIG: w.cfgPath, CONTRACT_TEST_WORLD: w.dir,
    PUBLISH_MANIFEST_DIR: manifestDir, ...(o.noYes ? {} : { YES: "1" }), ...(o.withEnv ?? {}),
  };
  return { dir: w.dir, cwd, manifestDir, sheet: w.sheetPath, signer: `keystore:${keyDir}/DEPLOYER:${pw}`, env, w };
}

async function runCli(c: Case, verb: string, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", ENTRY, ...coreArgs(verb, c.sheet, c.signer, extra)], { cwd: c.cwd, env: c.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

describe("core harness contract: the argument vector and environment core builds", () => {
  test("publish: exit 0, every stage manifest in PUBLISH_MANIFEST_DIR, none in the core checkout, forge told the manifest dir", async () => {
    const c = boot();
    const r = await runCli(c, "publish");
    if (r.code !== 0) console.error(r.stderr.split("\n").slice(-8).join("\n"));
    expect(r.code).toBe(0);
    // the same stage set as --stage deploy: safe first, then every table stage through timelock
    const want = ["safe.json", ...getStageTable().stages.map((s) => manifestFile(s.manifest))].sort();
    expect(readdirSync(c.manifestDir).sort()).toEqual(want);
    expect(existsSync(join(c.w.coreDir, "deployments", "918453"))).toBe(false);
    const forge = c.w.state().calls.filter((x: any) => x.tool === "forge" && x.args.includes("--broadcast"));
    expect(forge.length).toBe(getStageTable().stages.length);
    for (const f of forge) expect(f.env.DEPLOYMENT_OUT.startsWith(`${c.manifestDir}/`)).toBe(true);
    // core reads stderr as logs: every line is JSON
    for (const line of r.stderr.split("\n").filter(Boolean)) JSON.parse(line);
    expect(r.stderr).toContain(`"event":"run.manifest_dir"`);
    // publish prints no row lines
    expect(parseGovernOutput(r.stdout)).toEqual([]);
  });

  test("verify after publish: exit 0 without --resume, the verifier labels on stdout under [verify]", async () => {
    const c = boot();
    expect((await runCli(c, "publish")).code).toBe(0);
    const r = await runCli(c, "verify");
    if (r.code !== 0) console.error(r.stderr.split("\n").slice(-4).join("\n"));
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["[verify]", "chain: id equals sheet", "manifest: vault.json present", "deployer: holds no role on any contract (log scan)"]);
  });

  test("govern: exit 0, one {row, txHash, status:1} stdout line per row, equal to the recorded sample core parses", async () => {
    const c = boot();
    writeGovernManifests(c.manifestDir);
    const r = await runCli(c, "govern");
    if (r.code !== 0) console.error(r.stderr.split("\n").slice(-8).join("\n"));
    expect(r.code).toBe(0);
    const rows = parseGovernOutput(r.stdout);
    expect(rows.map((x) => x.row)).toEqual([...GOVERN_ROWS]);
    for (const x of rows) { expect(x.txHash).toMatch(/^0x[0-9a-f]{64}$/); expect(x.status).toBe(1); }
    // stdout holds nothing but row lines; the structured log is on stderr
    for (const line of r.stdout.split("\n").filter(Boolean)) expect(JSON.parse(line).row).toBeDefined();
    expect(r.stderr).toContain(`"event":"govern.safe_tx"`);
    // the sample both repos test against is what the CLI prints
    if (process.env.RECORD_GOVERN_FIXTURE === "1") writeFileSync(FIXTURE, r.stdout); // re-record: RECORD_GOVERN_FIXTURE=1 bun test tests/core-harness-contract.test.ts, then copy to core
    expect(r.stdout).toBe(readFileSync(FIXTURE, "utf8"));
  });

  test("govern --row by name and by number runs one row and prints one line", async () => {
    for (const row of ["round1.schedule", "1"]) {
      const c = boot();
      writeGovernManifests(c.manifestDir);
      const r = await runCli(c, "govern", ["--row", row]);
      expect(r.code).toBe(0);
      expect(parseGovernOutput(r.stdout).map((x) => x.row)).toEqual(["round1.schedule"]);
      expect(r.stdout.split("\n").filter(Boolean).length).toBe(1);
    }
  });

  test("a stage that fails exits with its own non-zero code and prints no row", async () => {
    const c = boot(); // no manifests in PUBLISH_MANIFEST_DIR: govern has nothing to read
    const r = await runCli(c, "govern");
    expect(r.code).toBe(EXIT_CODES.INPUT_MISSING);
    expect(parseGovernOutput(r.stdout)).toEqual([]);
  });

  test("an unattended publish needs YES=1 in the inherited environment: without it the CLI refuses and sends nothing", async () => {
    const c = boot({ noYes: true });
    const r = await runCli(c, "publish");
    expect(r.code).toBe(EXIT_CODES.REFUSED);
    expect(c.w.state().calls.filter((x: any) => x.tool === "forge" && x.args.includes("--broadcast"))).toEqual([]);
  });

  test("usage errors: an unknown verb, a verb with --stage, --row on publish, an unknown row", async () => {
    const c = boot();
    expect((await runCli(c, "deploy")).code).toBe(EXIT_CODES.USAGE);
    expect((await runCli(c, "publish", ["--stage", "libs"])).code).toBe(EXIT_CODES.USAGE);
    expect((await runCli(c, "publish", ["--row", "1"])).code).toBe(EXIT_CODES.USAGE);
    expect((await runCli(c, "govern", ["--row", "nope"])).code).toBe(EXIT_CODES.USAGE);
    expect((await runCli(c, "govern", ["--row", "7"])).code).toBe(EXIT_CODES.USAGE);
  });
});

// Drift guard: when core's publish.rs is on disk (REPO_ROOT), its argument vector and env name must be the ones this test builds.
const RUST = join(REPO_ROOT, "testing", "smoke-test", "src", "publish.rs");
describe("core harness contract: drift guard against publish.rs", () => {
  test.skipIf(!existsSync(RUST))("publish_args and MANIFEST_DIR_ENV in core's publish.rs match the vector this test spawns", () => {
    const text = readFileSync(RUST, "utf8");
    expect(/MANIFEST_DIR_ENV: &str = "PUBLISH_MANIFEST_DIR"/.test(text)).toBe(true);
    const fn = /pub fn publish_args\([\s\S]*?\n\}\n/.exec(text)![0];
    const literals = [...fn.matchAll(/"([^"]+)"\.into\(\)/g)].map((m) => m[1]);
    expect(literals).toEqual(["--chain", "--rpc", "--sheet", "--signer", "--environment", "--core-sha"]);
    // the flags core passes are the flags this test passes, in the same order, verb first
    expect(coreArgs("v", "S", "G").filter((x) => x.startsWith("--"))).toEqual(literals);
    expect(coreArgs("v", "S", "G")[0]).toBe("v");
    expect(/TWIN_CHAIN_ID: u64 = 918453/.test(text)).toBe(true);
    expect(/STAGE_ENVIRONMENT: &str = "stage"/.test(text)).toBe(true);
  });
});
