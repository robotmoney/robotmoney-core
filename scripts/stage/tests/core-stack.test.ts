// Offline test for scripts/stage/core-stack.ts (ported from the old shell selftest).
// core-stack deploys and governs by calling publish contracts (devops, Bun TypeScript). Here the
// publish contracts call is a fake runner that records argv. Checked: the exact argument list, the
// keystore signer string, exit-code passthrough, the govern row gate, the usage errors, the record
// contract with its schema drift guard, parity, and that a redeploy from a new SHA mints a fresh
// keystore set. No network, no docker, no chain.
import { allManifests, expectedManifestCount } from "../stage-manifests.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const PC = join(WORK, "pc");
mkdirSync(join(PC, "src"), { recursive: true });
writeFileSync(join(PC, "src/cli.ts"), "");
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
      return nextResult;
    },
    spawnDetached: () => -1,
    has: () => true,
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    nowMs: () => 1_700_000_000_000,
    sleep: async () => {},
    env,
    repoRoot: REPO,
    rpcChainId: async () => "0xe03b5",
    httpOk: async () => true,
    procStart: () => undefined,
    procCmdline: () => "",
    procGroup: () => undefined,
    signal: () => false,
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
  env = { PUBLISH_CONTRACTS_DIR: PC, BUN: "bun-fake" };
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
      submitter: a(16), approver: a(17), voters: [a(18), a(19)], emergency: a(11), keystore_dir: join(OUT, "keys"),
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
