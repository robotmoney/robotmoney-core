import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { STAGE_NAMES, getStageTable } from "../src/stages.ts";
import { COUNTS, exampleText } from "./fixtures.ts";
import { LOCAL_RPC, SCRIPT, world } from "./harness.ts";

const sheetValue = (name: string): string => new RegExp(`^${name}=(\\S+)`, "m").exec(exampleText())![1]!;
const DEPLOY = STAGE_NAMES.slice(0, STAGE_NAMES.indexOf("timelock") + 1);
const forgeScripts = (w: ReturnType<typeof world>) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcasts = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
/** Broadcasts that did not go to the local preflight chain: in a dry run there must be none. */
const targetBroadcasts = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast") && c.rpcEnv !== LOCAL_RPC).map((c: any) => c.args[1]);
const simulations = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => !c.args.includes("--broadcast"));
const manifest = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();

describe("the stage runner on stub forge and cast", () => {
  test("a full deploy runs every stage in table order and the final nonce equals the summed frozen counts", async () => {
    const w = world({ startNonce: 0 });
    const code = await w.run(["--stage", "deploy"]);
    expect(lastError(w)).toBeUndefined();
    expect(code).toBe(0);
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.vault, SCRIPT.registry, SCRIPT.router, SCRIPT.gateway,
      SCRIPT.governance, SCRIPT["ic-policy"], SCRIPT.proto, SCRIPT.agent, SCRIPT.rwa, SCRIPT.timelock]);
    expect(w.safeCalls[0]).toBe("createSafe");
    const m = manifest(w);
    expect(Object.keys(m.stages)).toEqual(DEPLOY);
    let n = 0;
    for (const s of DEPLOY) {
      const key = s;
      expect(m.stages[s].startNonce).toBe(n);
      expect(m.stages[s].count).toBe(COUNTS[key]!);
      expect(m.stages[s].dryRunCount).toBe(COUNTS[key]!);
      expect(m.stages[s].status).toBe("done");
      n += COUNTS[key]!;
    }
    expect(w.state().nonces["0x000000000000000000000000000000000000a001"]).toBe(n);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.nonce === n)).toBe(true);
    expect(m.firstBlock).toBe(7);
  });

  test("one deploy: manifests per the core table, --libraries on the basket stages, every required env name set", async () => {
    const w = world({ startNonce: 0 });
    await w.run(["--stage", "deploy"]);
    expect(lastError(w)).toBeUndefined();
    const t = getStageTable();
    // each stage writes the manifest file the core table names
    for (const s of t.stages) expect(existsSync(join(w.coreDir, "deployments", "918453", basename(s.manifest))), s.manifest).toBe(true);
    // the basket stages pass --libraries with the tick_math address from the libs manifest, the others do not
    const libsFile = JSON.parse(readFileSync(join(w.coreDir, "deployments", "918453", basename(t.stages.find((s) => s.name === "libs")!.manifest)), "utf8"));
    expect(libsFile.tick_math).toBeTruthy();
    for (const st of t.stages) {
      const calls = forgeScripts(w).filter((c: any) => String(c.args[1]).startsWith(st.script));
      expect(calls.length, st.name).toBeGreaterThan(0);
      for (const c of calls) {
        const libArgs: string[] = c.args.flatMap((a: string, i: number) => (a === "--libraries" ? [c.args[i + 1]] : []));
        const want = st.libraries.map((n) => { const l = t.libraries.find((x) => x.name === n)!; return `${l.path}:${l.artifact}:${libsFile[l.manifestKey]}`; });
        expect(libArgs, `${st.name} ${c.args.includes("--broadcast") ? "broadcast" : "simulation"}`).toEqual(want);
      }
    }
    expect(forgeScripts(w).some((c: any) => c.args.includes("--libraries"))).toBe(true);
    // every required env name the table lists is set, DEPLOYMENT_OUT names the table's manifest, per-vault values land under core's names
    for (const st of t.stages) {
      const call = forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(st.script) && c.args.includes("--broadcast"));
      for (const name of st.requiredEnv) expect(call.env[name], `${st.name} ${name}`).toBeTruthy();
      expect(call.env.DEPLOYMENT_OUT).toBe(`deployments/918453/${basename(st.manifest)}`);
    }
    const proto = forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(t.stages.find((s) => s.vault === "PROTO")!.script));
    expect(proto.env.TVL_CAP).toBe(sheetValue("VAULT_PROTO_TVL_CAP"));
    expect(proto.env.FEE_RECIPIENT).toBeTruthy();
    expect(proto.env.VAULT_TVL_CAP).toBeUndefined();
  });

  test("the run stops at the first failing stage with a non-zero exit code", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.simFails = SCRIPT.registry;
    const code = await w.run(["--stage", "deploy"]);
    expect(code).toBe(EXIT_CODES.SIMULATION);
    expect(code).not.toBe(0);
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.vault]);
    expect(lastError(w).kind).toBe("SIMULATION");
    expect(forgeScripts(w).some((c: any) => c.args[1].includes(SCRIPT.router.replace(".s.sol", "")))).toBe(false);
  });

  test("a count mismatch after the broadcast is a hard failure", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.sent = { [SCRIPT.registry]: COUNTS.registry! + 1 };
    const code = await w.run(["--stage", "deploy"]);
    expect(code).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(lastError(w).message).toContain("frozen count");
    expect(broadcasts(w).includes(SCRIPT.router)).toBe(false);
  });

  test("a dry-run count that differs from the frozen count stops before anything is sent", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.counts[SCRIPT.vault] = COUNTS.vault! + 2;
    const code = await w.run(["--stage", "deploy"]);
    expect(code).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(broadcasts(w)).toEqual([SCRIPT.libs]);
  });

  test("a missing frozen file on 8453 fails before any chain work (hard error)", async () => {
    const w = world({ chainId: 8453, startNonce: 0, writeFrozen: false });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(forgeScripts(w).length).toBe(0);
  });

  test("a Twin broadcast without a frozen file measures, says so and writes the file under the counts dir", async () => {
    const w = world({ startNonce: 0, writeFrozen: false });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(w.logs().some((l) => l.event === "counts.measuring")).toBe(true);
    const f = JSON.parse(readFileSync(join(w.countsDir, `${"a".repeat(40)}.json`), "utf8"));
    expect(f.counts).toEqual(COUNTS);
  });

  test("a dry run without a frozen file warns, prints the measured counts, writes nothing and broadcasts nothing", async () => {
    const w = world({ startNonce: 0, writeFrozen: false });
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    expect(w.logs().some((l) => l.event === "dry_run.counts_missing")).toBe(true);
    const done = w.logs().find((l) => l.event === "dry_run.counts_measured") as { counts?: Record<string, number> } | undefined;
    expect(done?.counts).toEqual(COUNTS);
    expect(existsSync(join(w.countsDir, `${"a".repeat(40)}.json`))).toBe(false);
    expect(targetBroadcasts(w)).toEqual([]);
  });

  test("a dry run with a frozen file that disagrees fails with COUNT_MISMATCH", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.counts[SCRIPT.vault] = COUNTS.vault! + 2;
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(EXIT_CODES.COUNT_MISMATCH);
  });

  test("a wrong start nonce is refused", async () => {
    const w = world({ startNonce: 3 });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.NONCE);
    expect(broadcasts(w)).toEqual([]);
  });

  test("--dry-run broadcasts nothing", async () => {
    const w = world({ startNonce: 0, writeSafeManifest: true });
    const code = await w.run(["--stage", "libs", "--dry-run"]);
    expect(code).toBe(0);
    expect(targetBroadcasts(w)).toEqual([]);
    expect(simulations(w).length).toBe(1);
  });

  test("--dry-run simulates the stages whose inputs come from earlier stages too (no skip), and broadcasts nothing", async () => {
    const w = world({ startNonce: 0 });
    const code = await w.run(["--stage", "deploy", "--dry-run"]);
    expect(code).toBe(0);
    expect(targetBroadcasts(w)).toEqual([]);
    expect(simulations(w).length).toBe(11);
    expect(w.logs().some((l) => l.event === "stage.dry_run_skipped")).toBe(false);
  });

  test("a stage that died partway continues only with --resume, and finished stages are skipped", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.vault;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.BROADCAST);
    expect(lastError(w).message).toContain("--resume");
    const m1 = manifest(w);
    expect(m1.stages.libs.status).toBe("done");
    expect(m1.stages.vault.status).toBe("started");
    // a rerun without --resume is refused
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.RESUME);
    // with --resume it adopts the Safe and the finished stages and continues
    w.safeCalls.length = 0;
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0);
    expect(w.safeCalls).toEqual([]);
    expect(w.logs().filter((l) => l.event === "stage.skipped").map((l) => l.stage)).toEqual(["safe", "libs"]);
    const resumed = forgeScripts(w).filter((c: any) => c.args.includes("--resume")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
    expect(resumed).toEqual([SCRIPT.vault]);
    expect(w.state().nonces["0x000000000000000000000000000000000000a001"]).toBe(Object.values(COUNTS).reduce((a, b) => a + b, 0));
  });

  test("resume adopts a Safe created before the run died", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = "safe"; // the fake dies after the plan was recorded
    expect(await w.run(["--stage", "deploy"])).not.toBe(0);
    expect(manifest(w).stages.safe.safe).toBe("0x00000000000000000000000000000000000050fe");
    // the creation had in fact gone through: the deployer nonce moved
    w.setNonce(1);
    w.cfg.failBroadcast = undefined;
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0);
    expect(w.safeCalls).toContain("verifyCreatedSafe");
    expect(w.safeCalls.filter((c) => c === "createSafe").length).toBe(1);
    expect(JSON.parse(readFileSync(join(w.coreDir, "deployments", "918453", "safe.json"), "utf8")).adopted).toBe(true);
  });

  test("--measure writes the frozen counts file for the SHA and refuses to run without a file otherwise", async () => {
    const w = world({ startNonce: 0, writeFrozen: false });
    expect(await w.run(["--stage", "deploy", "--measure"])).toBe(0);
    const f = JSON.parse(readFileSync(join(w.countsDir, `${"a".repeat(40)}.json`), "utf8"));
    expect(f.counts).toEqual(COUNTS);
    expect(f.measured.chainId).toBe(918453);
  });

  test("the confirmation is typed by the operator and the reviewer", async () => {
    const w = world({ startNonce: 0, writeSafeManifest: true });
    const asked: string[] = [];
    const code = await w.run(["--stage", "libs"], { prompt: async (q) => { asked.push(q); return "nope"; } });
    // safe.json exists and nonce is 0: libs expects nonce 1
    expect(code).not.toBe(0);
    const w2 = world({ startNonce: 1, writeSafeManifest: true });
    const code2 = await w2.run(["--stage", "libs"], { prompt: async (q) => { asked.push(q); return "nope"; } });
    expect(code2).toBe(EXIT_CODES.REFUSED);
    expect(asked.some((q) => q.includes("Operator, type the stage name"))).toBe(true);
    expect(broadcasts(w2)).toEqual([]);
  });

  test("YES=1 skips the typed confirmation on the Twin chain", async () => {
    const w = world({ startNonce: 1, writeSafeManifest: true });
    const code = await w.run(["--stage", "libs"], { env: { YES: "1" }, prompt: undefined });
    expect(code).toBe(0);
    expect(broadcasts(w)).toEqual([SCRIPT.libs]);
  });

  test("YES=1 on chain 8453 is refused before any call to forge", async () => {
    const w = world({ chainId: 8453, startNonce: 0 });
    const code = await w.run(["--stage", "deploy"], { env: { YES: "1" }, signer: "ledger" });
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(forgeScripts(w).length).toBe(0);
  });

  test("a short delay on 8453 is refused before any call to forge", async () => {
    const w = world({ chainId: 8453, startNonce: 0, sheet: { TIMELOCK_MIN_DELAY: "60" } });
    expect(await w.run(["--stage", "deploy"], { signer: "ledger" })).toBe(EXIT_CODES.FLOOR);
    expect(forgeScripts(w).length).toBe(0);
  });

  test("a sheet CHAIN_ID that differs from the RPC chain id is refused", async () => {
    const w = world({ startNonce: 0, sheet: { CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453" } });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.CHAIN);
    expect(forgeScripts(w).length).toBe(0);
  });

  test("the core checkout must be at the DEPLOY_SHA", async () => {
    const w = world({ startNonce: 0 });
    const args = ["--chain", "918453", "--rpc", "http://rpc.test", "--sheet", w.sheetPath, "--signer", "ledger", "--core-sha", "c".repeat(40), "--core-dir", w.coreDir, "--counts-dir", w.countsDir];
    const { main } = await import("../src/cli.ts");
    expect(await main(args, { env: { PATH: `${join(import.meta.dir, "stubs")}:${process.env.PATH}`, STUB_STATE: w.statePath, STUB_CONFIG: w.cfgPath }, cwd: w.dir, logSink: () => {} })).toBe(EXIT_CODES.USAGE);
  });

  test("an unknown stage name is a usage error", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "nope"])).toBe(EXIT_CODES.USAGE);
  });

  test("the isomorphism report is written with SHAs, config hashes, forge version and codehashes", async () => {
    const w = world({ startNonce: 0 });
    await w.run(["--stage", "deploy"]);
    const r = JSON.parse(readFileSync(join(w.evidence, "isomorphism-918453.json"), "utf8"));
    expect(r.coreSha).toBe("a".repeat(40));
    expect(r.coreHead).toBe("a".repeat(40));
    expect(r.forge.version).toContain("forge");
    expect(r.forge.optimizerRuns).toBe(100);
    expect(r.forge.evmVersion).toBe("cancun");
    expect(Object.keys(r.configHashes).sort()).toEqual(["config/agent-token-shortlist.json", "config/dex-pools.json", "config/protocol-assets.json", "config/rwa-assets.json"]);
    expect(Object.keys(r.codehashes).length).toBeGreaterThan(5);
    expect(r.notes.join(" ")).toContain("does not prove the real delay");
    expect(existsSync(join(w.evidence, "publish-run.json"))).toBe(true);
  });
});
