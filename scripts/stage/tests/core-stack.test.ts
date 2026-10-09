// Offline test for scripts/stage/core-stack.ts (ported from the old shell selftest).
// core-stack deploys and governs by calling publish contracts (publish-contracts/ in this repo, Bun TypeScript). Here the
// publish contracts call is a fake runner that records argv. Checked: the exact argument list, the
// keystore signer string, exit-code passthrough, the govern row gate, the usage errors, the record
// contract with its schema drift guard, parity, and that a redeploy from a new SHA mints a fresh
// keystore set. The chain up, chain down, chain status and dapp status verbs run against a fake `docker compose`
// (core 1549): every stage service is a container, so the tool starts no host process. No network, no docker, no chain.
import { allManifests, expectedManifestCount } from "../stage-manifests.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_STACK_FORBIDDEN } from "../check-deleted-stage-scripts.ts";
import { RECORD_REQUIRED_FIELDS, runCli, type Deps, type RunOpts, type RunResult } from "../core-stack.ts";

const HERE = import.meta.dir;
const CORE_ROOT = join(HERE, "../../..");
const WORK = mkdtempSync(join(tmpdir(), "core-stack-test-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const REPO = join(WORK, "repo");
const OUT = join(WORK, "out");
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: REPO, encoding: "utf8" }).trim();
mkdirSync(REPO, { recursive: true });
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "init");
const SHA = git("rev-parse", "HEAD");

interface Calls {
  cmds: { cmd: string[]; opts?: RunOpts }[];
}
let calls: Calls;
let nextResult: RunResult;
let out: string;
let err: string;
let env: Record<string, string>;
/** Answers a command instead of the default fake. Return undefined to fall through. */
let handler: ((cmd: string[], opts?: RunOpts) => RunResult | undefined) | undefined;
let rpcAnswer: string;
let httpAnswers: Record<string, boolean>;

function summary(extra: Record<string, string> = {}): string {
  const base = {
    chain_id: "918453",
    sheet_path: join(OUT, "sheet.env"),
    key_dir: join(OUT, "keys"),
    password_file: join(OUT, "pw"),
    manifest_dir: join(OUT, "manifests"),
    core_sha: SHA,
    ...extra,
  };
  return `--- endpoint summary ---\n${Object.entries(base).map(([k, v]) => `${k}=${v}`).join("\n")}\n--- end endpoint summary ---\n`;
}

function fakeDeps(): Deps {
  return {
    async run(cmd, opts) {
      // git runs for real in the scratch repo; everything else is the fake publish contracts.
      if (cmd[0] === "git") {
        try {
          return { code: 0, stdout: execFileSync("git", cmd.slice(1), { cwd: REPO, encoding: "utf8" }), stderr: "" };
        } catch {
          return { code: 1, stdout: "", stderr: "" };
        }
      }
      calls.cmds.push({ cmd, opts });
      return handler?.(cmd, opts) ?? nextResult;
    },
    has: () => true,
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    nowMs: () => 1_700_000_000_000,
    sleep: async () => {},
    env,
    repoRoot: REPO,
    rpcChainId: async () => rpcAnswer,
    httpOk: async (url) => httpAnswers[url] ?? true,
    procStart: () => undefined,
  };
}

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  out = "";
  err = "";
  const code = await runCli([...args, "--out-dir", OUT], fakeDeps());
  return { code, out, err };
}

const publishCall = () => calls.cmds.find((c) => c.cmd[1]?.endsWith("src/cli.ts"))!;

beforeEach(() => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "manifests"), { recursive: true });
  mkdirSync(join(OUT, "keys"), { recursive: true });
  writeFileSync(join(OUT, "sheet.env"), "");
  writeFileSync(join(OUT, "pw"), "x".repeat(48), { mode: 0o600 });
  writeFileSync(join(OUT, "core-smoke.log"), summary());
  calls = { cmds: [] };
  nextResult = { code: 0, stdout: "", stderr: "" };
  handler = undefined;
  rpcAnswer = "0xe03b5";
  httpAnswers = {};
  mkdirSync(join(REPO, "publish-contracts/src"), { recursive: true });
  writeFileSync(join(REPO, "publish-contracts/src/cli.ts"), "");
  env = { BUN: "bun-fake" };
});

describe("usage", () => {
  test("no arguments is a usage error", async () => expect((await run()).code).toBe(64));
  test("an unknown chain verb is a usage error", async () => expect((await run("chain", "sideways")).code).toBe(64));
  test("dapp up is gone", async () => expect((await run("dapp", "up")).code).toBe(64));
  test("an unknown governance verb is a usage error", async () => expect((await run("governance", "bogus")).code).toBe(64));
  test("governance release needs --receipt-id", async () => expect((await run("governance", "release")).code).toBe(64));
  test("an unknown flag is a usage error", async () => expect((await run("record", "write", "--bogus-flag")).code).toBe(64));
  test("a bad --timeout is a usage error", async () => expect((await run("chain", "status", "--timeout", "0")).code).toBe(64));
});

describe("publish", () => {
  test("publish args is the Twin chain argument list, with the keystore signer string, exactly", async () => {
    const r = await run("publish", "args");
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n")).toEqual([
      "publish", "--chain", "918453", "--rpc", "http://127.0.0.1:18545", "--sheet", join(OUT, "sheet.env"),
      "--signer", `keystore:${join(OUT, "keys", "DEPLOYER")}:${join(OUT, "pw")}`,
      "--environment", "stage", "--core-sha", SHA,
    ]);
  });

  test("TWIN_RPC_URL (the stage host Twin fork service) is the rpc, trailing slashes removed", async () => {
    env = { ...env, TWIN_RPC_URL: "http://127.0.0.1:8545/" };
    const r = await run("publish", "args");
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[lines.indexOf("--rpc") + 1]).toBe("http://127.0.0.1:8545");
  });

  test("the signer is keystore:PATH:PASSFILE, never the bare word keystore", async () => {
    const r = await run("publish", "args");
    const lines = r.out.trimEnd().split("\n");
    const signer = lines[lines.indexOf("--signer") + 1]!;
    expect(signer).toMatch(/^keystore:[^:]+:[^:]+$/);
    expect(signer).not.toBe("keystore");
  });

  test("publish args without a keystore directory in the summary is bad input", async () => {
    writeFileSync(join(OUT, "core-smoke.log"), "--- endpoint summary ---\nsheet_path=/x\n--- end endpoint summary ---\n");
    expect((await run("publish", "args")).code).toBe(65);
  });

  test("publish run fails when the table's manifests are not all there", async () => {
    const r = await run("publish", "run");
    expect(r.code).toBe(66);
    expect(r.err).toContain(`0 of ${expectedManifestCount()}`);
  });

  test("publish run passes with every manifest the stage table names and hands publish contracts the right argv", async () => {
    for (const f of allManifests()) writeFileSync(join(OUT, "manifests", f), '{"vault":"0x1"}');
    const r = await run("publish", "run");
    expect(r.code).toBe(0);
    const c = publishCall();
    const argv = c.cmd.slice(2);
    expect(argv.slice(0, 3)).toEqual(["publish", "--chain", "918453"]);
    expect(argv).toContain("--environment");
    expect(argv[argv.indexOf("--core-sha") + 1]).toBe(SHA);
    expect(argv[argv.indexOf("--signer") + 1]).toBe(`keystore:${join(OUT, "keys/DEPLOYER")}:${join(OUT, "pw")}`);
    expect(c.opts?.stream).toBe(true);
    expect(c.opts?.env?.PUBLISH_MANIFEST_DIR).toBe(join(OUT, "manifests"));
    expect(c.opts?.env?.YES).toBe("1");
    expect(c.opts?.env?.CONFIRM).toBeUndefined();
    expect(argv.join(" ")).not.toMatch(/--private-key|--password/);
  });

  test("a failing publish contracts exit code passes through unchanged", async () => {
    nextResult = { code: 7, stdout: "", stderr: "" };
    expect((await run("publish", "run")).code).toBe(7);
  });
});

describe("governance", () => {
  const rows = (...r: object[]) => r.map((x) => JSON.stringify(x)).join("\n") + "\n";

  test("verify calls publish contracts verify", async () => {
    await run("governance", "verify");
    expect(publishCall().cmd[2]).toBe("verify");
  });
  test("ensure passes when every row has a tx hash and status 1", async () => {
    nextResult = { code: 0, stdout: rows({ row: "set-quorum", txHash: h(1), status: 1 }, { row: "set-voting-power", txHash: h(2), status: 1 }), stderr: "" };
    const r = await run("governance", "ensure");
    expect(r.code).toBe(0);
    expect(publishCall().cmd.slice(2, 5)).toEqual(["govern", "--chain", "918453"]);
  });
  test("ensure fails when one row has receipt status 0", async () => {
    nextResult = { code: 0, stdout: rows({ row: "a", txHash: h(1), status: 1 }, { row: "b", txHash: h(2), status: 0 }), stderr: "" };
    const r = await run("governance", "ensure");
    expect(r.code).toBe(66);
    expect(r.err).toContain("status");
  });
  test("ensure fails when a row has no tx hash", async () => {
    nextResult = { code: 0, stdout: rows({ row: "a", status: 1 }), stderr: "" };
    expect((await run("governance", "ensure")).code).toBe(66);
  });
  test("ensure fails when the run printed no rows", async () => {
    nextResult = { code: 0, stdout: "govern finished with no rows\n", stderr: "" };
    expect((await run("governance", "ensure")).code).toBe(66);
  });
  test("release asks for the release-receipt row", async () => {
    nextResult = { code: 0, stdout: rows({ row: "release-receipt", txHash: h(3), status: 1 }), stderr: "" };
    const r = await run("governance", "release", "--receipt-id", "0xabc");
    expect(r.code).toBe(0);
    expect(publishCall().cmd.join(" ")).toContain("--row release-receipt --receipt-id 0xabc");
  });
  test("a govern exit code passes through", async () => {
    nextResult = { code: 9, stdout: "", stderr: "" };
    expect((await run("governance", "ensure")).code).toBe(9);
  });
});

describe("parity", () => {
  test("labels passes when stage and mainnet label sets are identical, and saves the verifier output", async () => {
    nextResult = { code: 0, stdout: "PASS safe.threshold\nPASS vault.rmUSDC.paused\nRESULT: VERIFIED\n", stderr: "" };
    writeFileSync(join(OUT, "mainnet-labels.json"), '{"label":"safe.threshold"}\n{"label":"vault.rmUSDC.paused"}\n');
    const r = await run("parity", "labels", "--mainnet", join(OUT, "mainnet-labels.json"));
    expect(r.code).toBe(0);
    expect(readFileSync(join(OUT, "verify-labels.txt"), "utf8")).toContain("PASS safe.threshold");
    expect(publishCall().cmd.slice(2, 5)).toEqual(["verify", "--chain", "918453"]);
  });
  test("labels exits 1 and names a label mainnet has and stage lacks", async () => {
    nextResult = { code: 0, stdout: "PASS safe.threshold\n", stderr: "" };
    writeFileSync(join(OUT, "mainnet-labels.json"), '{"label":"safe.threshold"}\n{"label":"timelock.delay"}\n');
    const r = await run("parity", "labels", "--mainnet", join(OUT, "mainnet-labels.json"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("only on mainnet: timelock.delay");
  });
  test("labels without --mainnet is a usage error", async () => expect((await run("parity", "labels")).code).toBe(64));
  test("labels with a missing mainnet file fails clearly (65)", async () => {
    const r = await run("parity", "labels", "--mainnet", join(OUT, "nope.txt"));
    expect(r.code).toBe(65);
    expect(r.err).toContain("parity input missing");
  });
  test("labels fails with the verifier's own exit code when the verifier fails", async () => {
    nextResult = { code: 7, stdout: "FAIL x\n", stderr: "" };
    writeFileSync(join(OUT, "m.txt"), '{"label":"x"}\n');
    expect((await run("parity", "labels", "--mainnet", join(OUT, "m.txt"))).code).toBe(7);
  });
  test("labels --stage-labels compares a file the smoke job wrote, with no chain", async () => {
    writeFileSync(join(OUT, "stage.txt"), "PASS a\nPASS b\n");
    writeFileSync(join(OUT, "m.txt"), "PASS a\nPASS b\n");
    const r = await run("parity", "labels", "--stage-labels", join(OUT, "stage.txt"), "--mainnet", join(OUT, "m.txt"));
    expect(r.code).toBe(0);
    expect(calls.cmds.length).toBe(0);
  });

  const prod = (extra: string) => writeFileSync(join(OUT, "prod.env"), extra);
  test("sheet passes when the sheets differ only in parameter and identity lines", async () => {
    writeFileSync(join(OUT, "sheet.env"), "CHAIN_ID=918453\nTIMELOCK_MIN_DELAY=60\nSAFE_THRESHOLD=2\nSAFE_OWNERS=0xa,0xb,0xc\nUSDC_ADDRESS=0x1\n");
    prod("CHAIN_ID=8453\nTIMELOCK_MIN_DELAY=172800\nSAFE_THRESHOLD=3\nSAFE_OWNERS=0xd,0xe,0xf\nUSDC_ADDRESS=0x1\n");
    expect((await run("parity", "sheet", "--production", join(OUT, "prod.env"))).code).toBe(0);
  });
  test("sheet exits 1 and names the key when a non-parameter line differs", async () => {
    writeFileSync(join(OUT, "sheet.env"), "CHAIN_ID=918453\nUSDC_ADDRESS=0x1\n");
    prod("CHAIN_ID=8453\nUSDC_ADDRESS=0x2\n");
    const r = await run("parity", "sheet", "--production", join(OUT, "prod.env"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("USDC_ADDRESS");
  });
  test("sheet refuses a sheet with an escape-hatch key", async () => {
    writeFileSync(join(OUT, "sheet.env"), "CHAIN_ID=918453\nREHEARSAL=1\nUSDC_ADDRESS=0x1\n");
    prod("CHAIN_ID=8453\nUSDC_ADDRESS=0x1\n");
    expect((await run("parity", "sheet", "--production", join(OUT, "prod.env"))).code).toBe(1);
  });
  test("sheet with a missing production file fails clearly", async () => {
    expect((await run("parity", "sheet", "--production", join(OUT, "nope.env"))).code).toBe(65);
  });
});

describe("a redeploy from a new SHA", () => {
  test("publish args after a new commit carries the new core sha", async () => {
    git("commit", "-q", "--allow-empty", "-m", "second");
    const sha2 = git("rev-parse", "HEAD");
    expect(sha2).not.toBe(SHA);
    const r = await run("publish", "args");
    const lines = r.out.trimEnd().split("\n");
    expect(lines[lines.indexOf("--core-sha") + 1]).toBe(sha2);
    expect(r.out).not.toContain(SHA);
  });

  // The harness mints the keystore set, one call per boot, in a directory no earlier boot used.
  const pubRs = readFileSync(join(CORE_ROOT, "testing/smoke-test/src/publish.rs"), "utf8");
  const libRs = readFileSync(join(CORE_ROOT, "testing/smoke-test/src/lib.rs"), "utf8");
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  test("make_keys names its directory with fresh_root_name (never a reused path)", () => {
    expect(count(pubRs, "parent.join(fresh_root_name())")).toBe(1);
  });
  test("the harness mints keys once per boot (one make_keys call in Fixture::new)", () => {
    expect(count(libRs, "publish::make_keys(")).toBe(1);
  });
  test("no keystore set is cached across boots", () => {
    expect(pubRs).not.toMatch(/static .*RehearsalKeys|OnceLock<RehearsalKeys>|lazy_static/);
  });
  test("a Rust unit test asserts every boot gets its own keystore directory", () => {
    expect(pubRs).toContain("every_boot_gets_its_own_keystore_directory");
  });
  test("a redeploy from a new SHA mints a fresh keystore set: the fresh-name test covers a second boot with a second SHA", () => {
    // The Rust test must cover many boots, and the signer string is built from the boot's own key dir.
    expect(pubRs).toMatch(/\(0\.\.\d+\)\.map\(\|_\| fresh_root_name\(\)\)/);
    expect(pubRs).toContain("signer_spec(&p.keys)");
  });
  test("a second boot's summary changes the signer string core-stack passes", async () => {
    const signerFor = async (keyDir: string): Promise<string> => {
      writeFileSync(join(OUT, "core-smoke.log"), summary({ key_dir: keyDir }));
      const r = await run("publish", "args");
      const lines = r.out.trimEnd().split("\n");
      return lines[lines.indexOf("--signer") + 1]!;
    };
    const first = await signerFor("/rehearsal-1-aaa/keys");
    const second = await signerFor("/rehearsal-2-bbb/keys");
    expect(first).not.toBe(second);
    expect(second).toContain("/rehearsal-2-bbb/keys/DEPLOYER");
  });
});

describe("summary", () => {
  test("publish run without a harness summary is bad input (65)", async () => {
    rmSync(join(OUT, "core-smoke.log"));
    expect((await run("publish", "run")).code).toBe(65);
  });
});

describe("record", () => {
  const SCHEMA = JSON.parse(readFileSync(join(CORE_ROOT, "schemas/fusion-stage-record.schema.json"), "utf8"));
  const good = () => ({
    chain_id: 918453, run_id: "r1", core_tag: "t", core_sha: SHA, generated_at: "2026-10-02T00:00:00Z", min_delay: 60, deployer: a(1),
    addresses: { gateway: a(2), vault: a(3), registry: a(4), router: a(5), governance: a(6), consensus_receipt: a(7), ic_policy: a(8), timelock: a(9), safe: a(10), emergency: a(11) },
    code_hashes: { gateway: h(12) },
    vault_addresses: { rmUSDC: a(3), rmPROTO: a(13), rmAGENT: a(14), rmRWA: a(15) },
    ephemeral: {
      approver: a(17), voters: [a(18), a(19)], emergency: a(11), keystore_dir: join(OUT, "keys"),
      safe_signers: [{ role: "approver", address: a(17) }, { role: "approver-b", address: a(20) }, { role: "approver-c", address: a(21) }],
    },
  });
  const put = (rec: unknown, name = "record.json") => {
    writeFileSync(join(OUT, name), JSON.stringify(rec));
    return join(OUT, name);
  };

  test("the schema's required array equals the script's required fields (drift guard)", async () => {
    const r = await run("record", "show", "--list-required-fields");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(SCHEMA.required);
    expect(RECORD_REQUIRED_FIELDS).toEqual(SCHEMA.required);
  });
  test("a complete record passes record show", async () => {
    const r = await run("record", "show", "--record", put(good()), "--path");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(join(OUT, "record.json"));
  });
  test("a record without the timelock is refused (65) with a classed line", async () => {
    const rec: any = good();
    delete rec.addresses.timelock;
    const r = await run("record", "show", "--record", put(rec));
    expect(r.code).toBe(65);
    expect(r.out).toContain("record-field-missing");
  });
  test("a record for another chain is refused", async () => {
    const rec: any = good();
    rec.chain_id = 8453;
    expect((await run("record", "show", "--record", put(rec))).out).toContain("record-wrong-chain");
  });
  test("a zero Safe address is refused", async () => {
    const rec: any = good();
    rec.addresses.safe = a(0);
    expect((await run("record", "show", "--record", put(rec))).out).toContain("record-field-malformed");
  });
  test("a Safe roster below three owners is refused", async () => {
    const rec: any = good();
    rec.ephemeral.safe_signers = rec.ephemeral.safe_signers.filter((x: any) => x.role !== "approver-c");
    expect((await run("record", "show", "--record", put(rec))).code).toBe(65);
  });
  test("a missing record is refused with record-missing", async () => {
    expect((await run("record", "show", "--record", join(OUT, "none.json"))).out).toContain("record-missing");
  });
  test("an approver that is not the approver signer is refused", async () => {
    const rec: any = good();
    rec.ephemeral.approver = a(99);
    expect((await run("record", "show", "--record", put(rec))).code).toBe(65);
  });
});

describe("the tool holds no deploy or ceremony logic", () => {
  for (const file of ["core-stack.ts", "parity.ts"]) {
    const code = readFileSync(join(HERE, "..", file), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const re of CORE_STACK_FORBIDDEN) {
      test(`${file} does not match ${re}`, () => expect(re.test(code)).toBe(false));
    }
  }
});

// ─── the stage stack in containers (core 1549) ───────────────────────────────
// A fake `docker`: the chain container, the one-shot deploy job and the dapp stack are compose projects whose state
// this test models. Nothing here may start a host process: every command is git, cargo (rmpc), docker or rmpc itself.
const head = () => git("rev-parse", "HEAD");
const STAMP = () => join(OUT, "core-stack.stamp");
const WORKDIR = () => join(OUT, "work");
const stampBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ commit: head(), chain_project: "robotmoney-stage-chain", ...extra });

interface World {
  chainRunning: boolean;
  dappHealthy: number;
  chainUpExit: number;
  deployExit: number;
  writeSummary: boolean;
  dappUpExit: number;
  rmpcCommit: string;
}
let world: World;
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

function dockerWorld(cmd: string[]): RunResult | undefined {
  if (cmd[0]?.endsWith("target/debug/rmpc") && cmd[1] === "build-info") return ok(JSON.stringify({ commit: world.rmpcCommit }));
  if (cmd[0] === "cargo") return ok();
  if (cmd[0] !== "docker") return undefined;
  const line = cmd.join(" ");
  if (cmd[1] === "ps") {
    if (line.includes("label=com.docker.compose.project=robotmoney-stage-chain")) return ok(world.chainRunning ? "stage-twin-chain\n" : "");
    if (line.includes("health=healthy")) return ok("dapp-frontend\n".repeat(world.dappHealthy));
    return ok();
  }
  if (cmd[1] !== "compose") return undefined;
  const project = cmd[cmd.indexOf("--project-name") + 1];
  const verb = cmd.find((c, i) => i > 3 && ["up", "run", "down", "build"].includes(c) && cmd[i - 1] !== "-f");
  if (project === "robotmoney-stage-chain") {
    if (verb === "up") {
      if (world.chainUpExit === 0) world.chainRunning = true;
      return { code: world.chainUpExit, stdout: "", stderr: "" };
    }
    if (verb === "run") {
      if (world.deployExit === 0) {
        const out = cmd[cmd.indexOf("--dapp-env-out") + 1]!;
        const sum = cmd[cmd.indexOf("--summary-out") + 1]!;
        mkdirSync(join(out, ".."), { recursive: true });
        writeFileSync(out, JSON.stringify({ DAPP_PORT: "5173", INDEXER_RPC_URL: "http://twin-chain:8545", COMPOSE_PROFILES: "" }));
        if (world.writeSummary) writeFileSync(sum, summary());
      }
      return { code: world.deployExit, stdout: "", stderr: "" };
    }
    if (verb === "down") {
      world.chainRunning = false;
      return ok();
    }
    return ok();
  }
  if (project === "robotmoney-dapp") {
    if (verb === "up") {
      if (world.dappUpExit === 0) world.dappHealthy = 1;
      return { code: world.dappUpExit, stdout: "", stderr: "" };
    }
    if (verb === "down") {
      world.dappHealthy = 0;
      return ok();
    }
  }
  return ok();
}

function containerWorld(): void {
  world = { chainRunning: false, dappHealthy: 0, chainUpExit: 0, deployExit: 0, writeSummary: true, dappUpExit: 0, rmpcCommit: head() };
  handler = (cmd) => dockerWorld(cmd);
  env.STAGE_WORK_DIR = WORKDIR();
  mkdirSync(join(REPO, "target/debug"), { recursive: true });
  writeFileSync(join(REPO, "target/debug/rmpc"), "");
  mkdirSync(join(REPO, "deployments/twin-918453"), { recursive: true });
  writeFileSync(join(REPO, "deployments/twin-918453/stage-sheet.env"), "");
  rmSync(join(OUT, "core-smoke.log"), { force: true });
}

const compose = () => calls.cmds.filter((c) => c.cmd[0] === "docker" && c.cmd[1] === "compose");
const verbOf = (c: string[]) => c.find((x, i) => i > 3 && ["up", "run", "down", "build"].includes(x) && c[i - 1] !== "-f")!;
const OK_LINE = new RegExp(`^ok: chain 0xe03b5, 1 healthy robotmoney-dapp container\\(s\\), rmpc built from ${"[0-9a-f]{40}"}$`);

describe("chain up in containers", () => {
  beforeEach(containerWorld);

  test("starts the chain container, runs the deploy job, then starts the dapp stack, in that order, and exits 0", async () => {
    const r = await run("chain", "up");
    expect(r.code).toBe(0);
    const seq = compose().map((c) => `${c.cmd[c.cmd.indexOf("--project-name") + 1]}:${verbOf(c.cmd)}`);
    expect(seq).toEqual(["robotmoney-stage-chain:up", "robotmoney-stage-chain:build", "robotmoney-stage-chain:run", "robotmoney-dapp:up"]);
  });

  test("starts no host process: every command is git, cargo for rmpc, docker or rmpc", async () => {
    await run("chain", "up");
    const tools = new Set(calls.cmds.map((c) => c.cmd[0]!.split("/").pop()));
    expect([...tools].sort()).toEqual(["cargo", "docker", "rmpc"]);
    const flat = calls.cmds.map((c) => c.cmd.join(" ")).join("\n");
    expect(flat).not.toMatch(/anvil|stdbuf|twin-fork\.ts|cargo run|-p smoke-test|bun /);
  });

  test("prints the unchanged status line and no other line on stdout", async () => {
    const r = await run("chain", "up");
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    expect(r.out.trimEnd()).toMatch(OK_LINE);
  });

  test("the chain container is built and waited for, healthy, before the deploy job runs", async () => {
    await run("chain", "up");
    const up = compose()[0]!.cmd;
    expect(up).toContain("--wait");
    expect(up).toContain("--build");
    expect(up[up.length - 1]).toBe("twin-chain");
    expect(up).toContain("--profile");
  });

  test("the deploy job is the real ceremony against the chain: --deploy-only with the stage ports and the public urls", async () => {
    await run("chain", "up");
    const job = compose().find((c) => verbOf(c.cmd) === "run")!.cmd;
    const tail = job.slice(job.indexOf("stage-harness") + 1);
    expect(tail.slice(0, 1)).toEqual(["--deploy-only"]);
    const flag = (name: string) => tail[tail.indexOf(name) + 1];
    expect(flag("--explorer-port")).toBe("18546");
    expect(flag("--dapp-port")).toBe("5173");
    expect(flag("--public-rpc-url")).toBe("https://stage-rpc.robotmoney-labs.dev");
    expect(flag("--public-explorer-url")).toBe("https://stage-explorer.robotmoney-labs.dev");
    expect(flag("--public-dapp-url")).toBe("https://stage-dapp.robotmoney-labs.dev");
    expect(tail).toContain("--no-receipt-fixtures");
    expect(flag("--dapp-env-out")).toBe(join(WORKDIR(), "dapp-env.json"));
    expect(job).toContain("--rm");
    expect(job).toContain("--no-deps");
  });

  test("the compose projects get the invoking user, the checkout and the work directory", async () => {
    await run("chain", "up");
    const envOf = compose().find((c) => verbOf(c.cmd) === "run")!.opts!.env!;
    expect(envOf.STAGE_REPO).toBe(REPO);
    expect(envOf.STAGE_WORK_DIR).toBe(WORKDIR());
    expect(envOf.STAGE_UID).toBe(String(process.getuid!()));
    expect(envOf.STAGE_GID).toBe(String(process.getgid!()));
  });

  test("the dapp stack starts from the environment the deploy job wrote, with the stage overlay", async () => {
    await run("chain", "up");
    const dapp = compose().find((c) => c.cmd.includes("robotmoney-dapp") && verbOf(c.cmd) === "up")!;
    expect(dapp.opts!.env).toEqual({ DAPP_PORT: "5173", INDEXER_RPC_URL: "http://twin-chain:8545", COMPOSE_PROFILES: "" });
    expect(dapp.cmd.filter((x) => x.endsWith(".yaml")).map((x) => x.split("/").pop())).toEqual(["docker-compose.dapp.yaml", "docker-compose.dapp.stage.yaml"]);
    expect(dapp.cmd).toContain("--wait");
  });

  test("the endpoint summary the deploy job wrote becomes the summary every later verb reads", async () => {
    await run("chain", "up");
    expect(readFileSync(join(OUT, "core-smoke.log"), "utf8")).toBe(summary());
    const r = await run("publish", "args");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`keystore:${join(OUT, "keys")}/DEPLOYER:${join(OUT, "pw")}`);
  });

  test("writes a stamp that names the commit and the chain project, and no pid", async () => {
    await run("chain", "up");
    const st = JSON.parse(readFileSync(STAMP(), "utf8"));
    expect(st.commit).toBe(head());
    expect(st.chain_project).toBe("robotmoney-stage-chain");
    expect(st.pid).toBeUndefined();
  });

  test("a second chain up on the healthy candidate starts nothing", async () => {
    await run("chain", "up");
    calls.cmds = [];
    const r = await run("chain", "up");
    expect(r.code).toBe(0);
    expect(r.out.trimEnd()).toMatch(OK_LINE);
    expect(compose()).toHaveLength(0);
  });

  test("a TWIN_RPC_URL that names another chain is refused (65) before any docker command", async () => {
    env.TWIN_RPC_URL = "http://10.0.0.5:8545";
    const r = await run("chain", "up");
    expect(r.code).toBe(65);
    expect(r.err).toContain("unset TWIN_RPC_URL");
    expect(calls.cmds.filter((c) => c.cmd[0] === "docker")).toHaveLength(0);
  });

  test("TWIN_RPC_URL set to the container's own address is allowed", async () => {
    env.TWIN_RPC_URL = "http://127.0.0.1:18545/";
    expect((await run("chain", "up")).code).toBe(0);
  });

  test("a chain container that is running but is not the healthy candidate must be taken down first (66)", async () => {
    world.chainRunning = true;
    const r = await run("chain", "up");
    expect(r.code).toBe(66);
    expect(r.err).toContain("chain down");
    expect(compose()).toHaveLength(0);
  });

  test("a chain container that never becomes healthy fails chain up (66) and runs no deploy job", async () => {
    world.chainUpExit = 1;
    const r = await run("chain", "up");
    expect(r.code).toBe(66);
    expect(compose().map((c) => verbOf(c.cmd))).toEqual(["up"]);
  });

  test("a failing deploy job fails chain up (66), starts no dapp stack and writes no stamp", async () => {
    world.deployExit = 3;
    const r = await run("chain", "up");
    expect(r.code).toBe(66);
    expect(r.err).toContain("deploy job exited 3");
    expect(compose().some((c) => c.cmd.includes("robotmoney-dapp"))).toBe(false);
    expect(existsSync(STAMP())).toBe(false);
  });

  test("a deploy job that printed no endpoint summary fails chain up (66)", async () => {
    world.writeSummary = false;
    const r = await run("chain", "up");
    expect(r.code).toBe(66);
    expect(r.err).toContain("printed no endpoint summary");
    expect(existsSync(STAMP())).toBe(false);
  });

  test("a dapp stack that never becomes healthy fails chain up (66) and writes no stamp", async () => {
    world.dappUpExit = 1;
    const r = await run("chain", "up");
    expect(r.code).toBe(66);
    expect(existsSync(STAMP())).toBe(false);
  });

  test("a stack whose rmpc was built from another commit is not the candidate: chain up fails (66)", async () => {
    world.rmpcCommit = "f".repeat(40);
    const r = await run("chain", "up");
    expect(r.code).toBe(66);
    expect(r.err).toContain("candidate-mismatch");
  });

  test("a work directory that is too shallow or is the checkout is refused (65) before anything runs or is deleted", async () => {
    for (const bad of ["/", "/tmp", REPO, OUT]) {
      env.STAGE_WORK_DIR = bad;
      expect((await run("chain", "up")).code).toBe(65);
      expect((await run("chain", "down")).code).toBe(65);
    }
    expect(calls.cmds.filter((c) => c.cmd[0] === "docker")).toHaveLength(0);
  });

  test("the keystore set of the last boot is gone before the deploy job runs (a redeploy never reuses a deployer)", async () => {
    mkdirSync(WORKDIR(), { recursive: true });
    writeFileSync(join(WORKDIR(), "stale-keystore"), "old");
    await run("chain", "up");
    expect(existsSync(join(WORKDIR(), "stale-keystore"))).toBe(false);
  });
});

describe("chain down in containers", () => {
  beforeEach(containerWorld);

  test("removes the dapp project and the chain project, the stamp and the work directory", async () => {
    await run("chain", "up");
    expect(existsSync(STAMP())).toBe(true);
    calls.cmds = [];
    const r = await run("chain", "down");
    expect(r.code).toBe(0);
    const seq = compose().map((c) => `${c.cmd[c.cmd.indexOf("--project-name") + 1]}:${verbOf(c.cmd)}`);
    expect(seq).toEqual(["robotmoney-dapp:down", "robotmoney-stage-chain:down"]);
    expect(existsSync(STAMP())).toBe(false);
    expect(existsSync(WORKDIR())).toBe(false);
  });

  test("chain status exits 1 with not-booted afterwards", async () => {
    await run("chain", "up");
    await run("chain", "down");
    const r = await run("chain", "status");
    expect(r.code).toBe(1);
    expect(r.out.trimEnd()).toBe(`not-booted: no completed \`chain up\` stamp at ${STAMP()}`);
  });

  test("a compose down that fails fails chain down (66) and keeps the lock free", async () => {
    handler = (cmd) => (cmd[0] === "docker" && cmd.includes("down") ? { code: 1, stdout: "", stderr: "boom" } : undefined);
    expect((await run("chain", "down")).code).toBe(66);
    expect(existsSync(join(OUT, ".core-stack.lock"))).toBe(false);
  });

  test("starts no host process and signals nothing", async () => {
    await run("chain", "down");
    expect(new Set(calls.cmds.map((c) => c.cmd[0]))).toEqual(new Set(["docker"]));
  });

  test("the teardown env satisfies the compose files' mandatory variables", async () => {
    await run("chain", "down");
    const dapp = compose().find((c) => c.cmd.includes("robotmoney-dapp"))!;
    for (const k of ["INDEXER_GATEWAY", "INDEXER_VAULT", "VITE_GATEWAY_ADDRESS", "VITE_VAULT_ADDRESS", "VITE_GATEWAY_EXPECTED_CODE_HASH"]) expect(dapp.opts!.env![k]).toBeDefined();
    const chain = compose().find((c) => c.cmd.includes("robotmoney-stage-chain"))!;
    for (const k of ["STAGE_UID", "STAGE_GID", "STAGE_REPO", "STAGE_WORK_DIR"]) expect(chain.opts!.env![k]).toBeDefined();
  });
});

describe("chain status and dapp status keep their lines and exit codes", () => {
  beforeEach(() => {
    containerWorld();
    world.chainRunning = true;
    world.dappHealthy = 1;
    writeFileSync(STAMP(), stampBody());
  });
  const status = async () => (await run("chain", "status"));

  test("ok: the booted candidate prints one ok line and exits 0", async () => {
    const r = await status();
    expect(r.code).toBe(0);
    expect(r.out.trimEnd()).toMatch(OK_LINE);
  });
  test("not-booted: no stamp", async () => {
    rmSync(STAMP());
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, `not-booted: no completed \`chain up\` stamp at ${STAMP()}`]);
  });
  test("not-booted: the host-process era stamp (a pid, no chain project) is refused as malformed", async () => {
    writeFileSync(STAMP(), JSON.stringify({ commit: head(), pid: 123, start_time: "9" }));
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, `not-booted: ${STAMP()} is malformed`]);
  });
  test("boot-mismatch: a stamp that is not JSON names no commit", async () => {
    writeFileSync(STAMP(), "{");
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, `boot-mismatch: the running chain was booted from 'unknown', candidate is ${head()}`]);
  });
  test("boot-mismatch: the stack was booted from another commit", async () => {
    writeFileSync(STAMP(), stampBody({ commit: "a".repeat(40) }));
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, `boot-mismatch: the running chain was booted from '${"a".repeat(40)}', candidate is ${head()}`]);
  });
  test("harness-gone: the chain container is not running", async () => {
    world.chainRunning = false;
    const r = await status();
    expect(r.code).toBe(1);
    expect(r.out.trimEnd()).toBe("harness-gone: the chain container of compose project robotmoney-stage-chain that booted this chain is no longer running");
  });
  test("rpc-unreachable: nothing answers eth_chainId", async () => {
    rpcAnswer = "";
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, "rpc-unreachable: nothing answering eth_chainId at http://127.0.0.1:18545"]);
  });
  test("wrong-chain: the rpc answers another chain id", async () => {
    rpcAnswer = "0x2105";
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, "wrong-chain: http://127.0.0.1:18545 answers 0x2105, want 0xe03b5"]);
  });
  test("no-healthy-container: the dapp project has no healthy container", async () => {
    world.dappHealthy = 0;
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, "no-healthy-container: no healthy container in compose project robotmoney-dapp"]);
  });
  test("rmpc-missing: the binary is not there", async () => {
    rmSync(join(REPO, "target/debug/rmpc"));
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, `rmpc-missing: ${join(REPO, "target/debug/rmpc")}`]);
  });
  test("candidate-mismatch: rmpc was built from another commit", async () => {
    world.rmpcCommit = "b".repeat(40);
    const r = await status();
    expect([r.code, r.out.trimEnd()]).toEqual([1, `candidate-mismatch: rmpc built from '${"b".repeat(40)}', candidate is ${head()}`]);
  });
  test("ref-unresolved: a ref this checkout does not know", async () => {
    const r = await run("chain", "status", "--ref", "no-such-ref");
    expect([r.code, r.out.trimEnd()]).toEqual([1, "ref-unresolved: 'no-such-ref' is not a branch, tag or commit in this checkout"]);
  });
  test("status reads state and starts nothing", async () => {
    await status();
    expect(compose()).toHaveLength(0);
  });

  test("dapp status: ok when the rpc, the explorer-api and the dapp answer", async () => {
    const r = await run("dapp", "status");
    expect([r.code, r.out.trimEnd()]).toEqual([0, "ok: rpc, explorer-api and dapp all answer"]);
  });
  test("dapp status: rpc-unready, explorer-unready and dapp-unready each exit 1 with their class", async () => {
    rpcAnswer = "";
    expect(await run("dapp", "status")).toMatchObject({ code: 1, out: "rpc-unready: http://127.0.0.1:18545 answers 'nothing', want 0xe03b5\n" });
    rpcAnswer = "0xe03b5";
    httpAnswers = { "http://127.0.0.1:18546/health": false };
    expect(await run("dapp", "status")).toMatchObject({ code: 1, out: "explorer-unready: explorer-api /health on 18546 does not answer\n" });
    httpAnswers = { "http://127.0.0.1:5173/": false };
    expect(await run("dapp", "status")).toMatchObject({ code: 1, out: "dapp-unready: the dapp on 5173 does not answer\n" });
  });
  test("dapp up stays gone", async () => expect((await run("dapp", "up")).code).toBe(64));
});

describe("core-stack holds no host process machinery", () => {
  const code = readFileSync(join(HERE, "..", "core-stack.ts"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const re of [/spawnDetached/, /node:child_process/, /stdbuf/, /cargo", "run"/, /smoke-test", "--full-stack"/, /twin-fork\.ts/, /\banvil\b/, /docker\.sock/]) {
    test(`core-stack.ts does not match ${re}`, () => expect(re.test(code)).toBe(false));
  }
  test("the Deps interface has no process-control member left", () => {
    for (const member of ["spawnDetached", "procCmdline", "procGroup", "signal("]) expect(code).not.toContain(member);
  });
});
