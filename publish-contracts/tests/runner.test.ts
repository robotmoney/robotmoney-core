import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { encodeErrorResult, encodeFunctionData, parseAbi } from "viem";
import { basename, join } from "node:path";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { STAGE_NAMES, getStageTable, stageByName, useStageTable } from "../src/stages.ts";
import { predictCoreTimelock } from "../src/timelock-pin.ts";
import { COUNTS, SHA, exampleText, tmp } from "./fixtures.ts";
import { ADMIN, LOCAL_RPC, SCRIPT, world } from "./harness.ts";
import { realGovernApi, resumeCommand } from "../src/govern.ts";
import { buildCreate2Libraries } from "../src/libs-adopt.ts";

const sheetValue = (name: string): string => new RegExp(`^${name}=(\\S+)`, "m").exec(exampleText())![1]!;
const DEPLOY = STAGE_NAMES.slice(0, STAGE_NAMES.indexOf("timelock") + 1);
const forgeScripts = (w: ReturnType<typeof world>) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcasts = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
/** Broadcasts that did not go to the local preflight chain: in a dry run there must be none. */
const targetBroadcasts = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast") && c.rpcEnv !== LOCAL_RPC).map((c: any) => c.args[1]);
const simulations = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => !c.args.includes("--broadcast"));
const manifest = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
/** The deployment manifest a stage's simulation and broadcast write (deployments/<chain>/ in the core checkout). */
const stageManifest = (w: ReturnType<typeof world>, stage: string) => join(w.coreDir, "deployments", String(w.cfg.chainId), stageByName(stage).manifest!);
/** Snapshot a file now; the returned function writes it back (undo a test's change). */
const keep = (f: string) => { const t = readFileSync(f, "utf8"); return () => writeFileSync(f, t); };

describe("the stage runner on stub forge and cast", () => {
  test("a full deploy runs every stage in table order and the final nonce equals the summed frozen counts", async () => {
    const w = world({ startNonce: 0 });
    const code = await w.run(["--stage", "deploy"]);
    expect(lastError(w)).toBeUndefined();
    expect(code).toBe(0);
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.vault, SCRIPT.registry, SCRIPT.router,
      SCRIPT.receipt, SCRIPT.governance, SCRIPT.proto, SCRIPT.rwa, SCRIPT.timelock]);
    expect(w.safeCalls[0]).toBe("createSafe");
    const m = manifest(w);
    expect(Object.keys(m.stages)).toEqual(DEPLOY);
    // the Safe control proof (core 1618) sits between stage 10 and the timelock stage; the deployer submits it (core 1712), one nonce outside every count
    expect(DEPLOY.slice(-2)).toEqual(["prove-control", "timelock"]);
    expect(m.stages["prove-control"]).toMatchObject({ status: "done", nonce: 0, txHash: `0x${"ee".repeat(32)}` });
    expect(m.stages["prove-control"].signers).toHaveLength(3);
    let n = 0;
    for (const s of DEPLOY.filter((x) => x !== "prove-control")) {
      const key = s;
      if (s === "timelock") n += PROOF_TX_NONCES;
      expect(m.stages[s].startNonce).toBe(n);
      expect(m.stages[s].count).toBe(COUNTS[key]!);
      expect(m.stages[s].dryRunCount).toBe(COUNTS[key]!);
      expect(m.stages[s].status).toBe("done");
      n += COUNTS[key]!;
    }
    expect(w.state().nonces["0x000000000000000000000000000000000000a001"]).toBe(n);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.nonce === n)).toBe(true);
    expect(m.firstBlock).toBe(7);
    // the timelock stage's last block is the handover block the verifier bounds its agent scan with
    expect(typeof m.stages.timelock.lastBlock).toBe("number");
    expect(m.stages.timelock.lastBlock).toBeGreaterThanOrEqual(m.stages.timelock.firstBlock);
  });

  test("one deploy: manifests per the core table, --libraries on the basket stages, every required env name set", async () => {
    const w = world({ startNonce: 0 });
    await w.run(["--stage", "deploy"]);
    expect(lastError(w)).toBeUndefined();
    const t = getStageTable();
    // each stage writes the manifest file the core table names
    for (const s of t.stages.filter((x) => x.system !== "gateway")) expect(existsSync(join(w.coreDir, "deployments", "918453", basename(s.manifest))), s.manifest).toBe(true);
    // the basket stages pass --libraries with the tick_math address from the libs manifest, the others do not
    const libsFile = JSON.parse(readFileSync(join(w.coreDir, "deployments", "918453", basename(t.stages.find((s) => s.name === "libs")!.manifest)), "utf8"));
    expect(libsFile.tick_math).toBeTruthy();
    for (const st of t.stages.filter((x) => x.system !== "gateway")) {
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
    for (const st of t.stages.filter((x) => x.system !== "gateway")) {
      const call = forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(st.script) && c.args.includes("--broadcast"));
      for (const name of st.requiredEnv) expect(call.env[name], `${st.name} ${name}`).toBeTruthy();
      expect(call.env.DEPLOYMENT_OUT).toBe(`deployments/918453/${basename(st.manifest)}`);
    }
    const proto = forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(t.stages.find((s) => s.vault === "PROTO")!.script));
    expect(proto.env.TVL_CAP).toBe(sheetValue("VAULT_PROTO_TVL_CAP"));
    expect(proto.env.FEE_RECIPIENT).toBeTruthy();
    expect(proto.env.VAULT_TVL_CAP).toBeUndefined();
    // the deploy authorizes no agent (core 1527): stage 11 passes AGENT_ADDRESSES=none and stage 5 reads no AGENT_* name
    const timelock = forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(t.stages.find((s) => s.name === "timelock")!.script) && c.args.includes("--broadcast"));
    expect(timelock.env.AGENT_ADDRESSES).toBeUndefined();
    // issue 1892: the vaults run deploys no gateway: no gateway-system script ran, and no AGENT_ name but the timelock's own literal reached any stage
    for (const gw of t.stages.filter((s) => s.system === "gateway")) expect(forgeScripts(w).some((c: any) => String(c.args[1]).startsWith(gw.script)), gw.name).toBe(false);
    for (const c of forgeScripts(w)) expect(Object.keys(c.env).filter((k) => k.startsWith("AGENT_")), String(c.args[1])).toEqual([]);
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
    // one owner spec per sheet owner, so the pre-stage-1 owner check (qa-plan B1) passes and the release gate (QA plan v1 E4) is what refuses the missing file
    const owners = ["A", "B", "C"].flatMap((o) => ["--owner-signer", `keystore:/k/OWNER_${o}`]);
    expect(await w.run(["--stage", "deploy", ...owners])).toBe(EXIT_CODES.COUNTS_MISSING);
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
    expect(simulations(w).length).toBe(getStageTable().stages.filter((s) => s.system !== "gateway").length);
    // only the control proof is skipped (a real Safe transaction signed by every owner), loudly, and the stage 11 gate with it
    expect(w.logs().filter((l) => l.event === "stage.dry_run_skipped").map((l) => l.stage)).toEqual(["prove-control"]);
    expect(w.logs().some((l) => l.event === "stage.control_proof_skipped")).toBe(true);
    expect(w.safeCalls.some((c) => c.startsWith("executeTx"))).toBe(false);
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
    expect(w.safeCalls.filter((c) => c === "createSafe" || c === "verifyCreatedSafe")).toEqual([]);
    expect(w.logs().filter((l) => l.event === "stage.skipped").map((l) => l.stage)).toEqual(["safe", "libs"]);
    const resumed = forgeScripts(w).filter((c: any) => c.args.includes("--resume")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
    expect(resumed).toEqual([SCRIPT.vault]);
    expect(w.state().nonces["0x000000000000000000000000000000000000a001"]).toBe(Object.values(COUNTS).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES);
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

  // Security round 1 (as QA plan v1 E2 for the redeploy): the predicted Safe address was saved BEFORE the typed confirmation, so a refused confirmation left a `started`
  // record of a Safe that was never created, and every --resume went into the adoption of it (NOT_A_SAFE against a real chain).
  test("a refused confirmation at the safe stage leaves no record: the --resume creates the Safe normally instead of adopting one that was never created", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "safe"], { prompt: async () => "nope" })).toBe(EXIT_CODES.REFUSED);
    expect(w.safeCalls).toEqual(["createSafe"]);
    expect(existsSync(join(w.evidence, "publish-run.json")) ? manifest(w).stages.safe : undefined).toBeUndefined();
    expect(await w.run(["--stage", "safe", "--resume"])).toBe(0);
    expect(w.safeCalls).toEqual(["createSafe", "createSafe"]);
    expect(w.safeCalls).not.toContain("connectSafe");
    expect(manifest(w).stages.safe).toMatchObject({ status: "done", safe: "0x00000000000000000000000000000000000050fe" });
    expect(JSON.parse(readFileSync(join(w.coreDir, "deployments", "918453", "safe.json"), "utf8")).adopted).toBeUndefined();
    // a rerun without --resume after a refusal is not refused either: there is no earlier stage
    const fresh = world({ startNonce: 0 });
    expect(await fresh.run(["--stage", "safe"], { prompt: async () => "nope" })).toBe(EXIT_CODES.REFUSED);
    expect(await fresh.run(["--stage", "safe"])).toBe(0);
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
    for (const v of Object.values(r.configHashes)) expect(v).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(r.codehashes).length).toBeGreaterThan(5);
    expect(r.notes.join(" ")).toContain("does not prove the real delay");
    expect(existsSync(join(w.evidence, "publish-run.json"))).toBe(true);
  });
});

describe("a failed broadcast says why (core 1505)", () => {
  // The CI failure this covers: the vault stage's last transaction, the seed deposit, was mined and reverted
  // InsufficientGas(370589, 400000), and the run log said only "did not complete (exit 1)".
  const HASH = `0x${"3a".repeat(32)}`;
  const FROM = "0x4b082405ed655ca4a2b5ceb99b56146ce6a9416e";
  const VAULT = "0xd98d369a9be55c5a47dabc599a0873c1b6696ce5";
  const INPUT = encodeFunctionData({ abi: parseAbi(["function deposit(uint256,address) returns (uint256)"]), functionName: "deposit", args: [1_000_000n, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"] });
  const ERR_ABI = parseAbi(["error InsufficientGas(uint256 available, uint256 required)"]);
  const REVERT = encodeErrorResult({ abi: ERR_ABI, errorName: "InsufficientGas", args: [370_589n, 400_000n] });
  const PROVIDER_KEY = "k3yK3yK3yProviderSecret";
  const UPSTREAM = `https://base-mainnet.g.alchemy.com/v2/${PROVIDER_KEY}`;

  function failingVault() {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.vault;
    w.cfg.failBroadcastOutput = {
      stdout: "Transactions saved to: broadcast/DeployVault.s.sol/918453/run-latest.json\n",
      stderr: `Warning: unused\nerror sending request for url (${UPSTREAM}) at http://rpc.test:8545\npassword: hunter2hunter2\nError: Transaction Failure: ${HASH}\n`,
    };
    w.cfg.castReplies = {
      receipt: { stdout: JSON.stringify({ status: "0x0", gasUsed: "0xe3a9b", blockNumber: "0x10" }) },
      call: { code: 1, stderr: `Error: server returned an error response: error code 3: execution reverted: custom error 0x${REVERT.slice(2, 10)}, data: "${REVERT}" (${UPSTREAM})\n` },
    };
    // what forge leaves after a failed --slow broadcast: the broadcast file with the failed transaction in it, and the build
    const bdir = join(w.coreDir, "broadcast", SCRIPT.vault!, "918453");
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, "run-latest.json"), JSON.stringify({ transactions: [{ hash: HASH, contractName: "RobotMoneyVault", function: "deposit(uint256,address)", isFixedGasLimit: false, transaction: { from: FROM, to: VAULT, gas: "0x13d7ee", value: "0x0", input: INPUT } }] }));
    mkdirSync(join(w.coreDir, "out", "RobotMoneyVault.sol"), { recursive: true });
    writeFileSync(join(w.coreDir, "out", "RobotMoneyVault.sol", "RobotMoneyVault.json"), JSON.stringify({ abi: ERR_ABI }));
    return w;
  }

  test("the error and the log carry forge's failure line, the gas limit, the receipt and the decoded revert", async () => {
    const w = failingVault();
    expect(await w.run(["--stage", "deploy"], { env: { BASE_UPSTREAM_RPC: UPSTREAM } })).toBe(EXIT_CODES.BROADCAST);
    const msg: string = lastError(w).message;
    expect(msg).toContain(`Error: Transaction Failure: ${HASH}`);
    expect(msg).toContain("RobotMoneyVault.deposit(uint256,address), gas limit 1300462 (forge's estimate)");
    expect(msg).toContain("mined in block 16 with status 0, gas used 932507");
    expect(msg).toContain("reverts InsufficientGas(370589, 400000)");
    expect(msg).toContain("NOT resent by --resume");
    const logged = w.logs().find((l) => l.event === "stage.broadcast_failed");
    expect(logged.stage).toBe("vault");
    expect(logged.forge).toContain(HASH);
    expect(logged.failed_tx).toContain("InsufficientGas(370589, 400000)");
    // the replay is the same call with the same gas limit on the parent block, through cast and the RPC env, never an argv URL
    const call = w.state().calls.find((c: any) => c.tool === "cast" && c.args[0] === "call");
    expect(call.args).toEqual(["call", "--from", FROM, "--gas-limit", "1300462", "--value", "0", "--block", "15", VAULT, INPUT]);
  });

  test("no secret reaches the error or the log: provider URL and key, the RPC, a password", async () => {
    const w = failingVault();
    await w.run(["--stage", "deploy"], { env: { BASE_UPSTREAM_RPC: UPSTREAM } });
    const all = w.lines.join("\n");
    for (const secret of [PROVIDER_KEY, "alchemy.com", "rpc.test", "hunter2hunter2"]) expect(all).not.toContain(secret);
    expect(lastError(w).message).toContain("error sending request for url ([redacted])");
  });

  test("a broadcast that names no failed transaction still reports forge's words and reads nothing more", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.vault;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.BROADCAST);
    expect(lastError(w).message).toContain("forge: Error: RPC connection dropped");
    expect(lastError(w).message).not.toContain("NOT resent");
    expect(w.state().calls.some((c: any) => c.tool === "cast" && (c.args[0] === "receipt" || c.args[0] === "call"))).toBe(false);
  });
});

// Security round 1 (the issue 1686 interlock): a govern run against a fresh run manifest knew no pause-all entry, adopted the scheduled unpause from the chain and executed it.
describe("security round 1: follow-on runs continue the deployment's own run manifest", () => {
  /** A govern api whose connectSafe records that it ran: a refusal before it leaves `connected` false. */
  const spy = () => { const s = { connected: false }; return { s, api: { ...realGovernApi, connectSafe: (async () => { s.connected = true; throw new Error("stop: the Safe was read"); }) as never } }; };
  const seed = (w: ReturnType<typeof world>, stages: Record<string, unknown>) => {
    mkdirSync(w.evidence, { recursive: true });
    writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 918453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", stages }));
  };
  test("govern with an --evidence dir that holds no publish-run.json exits RESUME before the Safe is read", async () => {
    const w = world({ writeSafeManifest: true });
    const g = spy();
    expect(await w.run(["govern", "--evidence", tmp("pc-other-evidence-")], { govern: { api: g.api } })).toBe(EXIT_CODES.RESUME);
    expect(g.s.connected).toBe(false);
    expect(lastError(w).message).toContain("no run manifest in");
    expect(lastError(w).message).toContain("--evidence");
    // the same for --stage verify,govern and for verify alone
    expect(await w.run(["--stage", "verify,govern", "--evidence", tmp("pc-other-evidence-")], { govern: { api: g.api } })).toBe(EXIT_CODES.RESUME);
    expect(await w.run(["verify", "--evidence", tmp("pc-other-evidence-")])).toBe(EXIT_CODES.RESUME);
    expect(g.s.connected).toBe(false);
  });
  test("govern on a run manifest with no finished timelock stage exits RESUME; with it, the run goes on to the Safe", async () => {
    const before = world({ writeSafeManifest: true });
    seed(before, { safe: { status: "done", startedAt: "t" } });
    const g = spy();
    expect(await before.run(["govern"], { govern: { api: g.api } })).toBe(EXIT_CODES.RESUME);
    expect(lastError(before).message).toContain("no finished timelock stage");
    expect(g.s.connected).toBe(false);
    // mutation: the handover is done, so the RESUME refusal is not what stops the run
    const after = world({ writeSafeManifest: true });
    seed(after, { safe: { status: "done", startedAt: "t" }, timelock: { status: "done", startedAt: "t" } });
    expect(await after.run(["govern"], { govern: { api: g.api } })).not.toBe(EXIT_CODES.RESUME);
  });
  test("the printed resume command names the run's absolute --evidence dir and its counts flags", () => {
    const next = resumeCommand({ chainId: 8453, coreSha: SHA, evidenceDir: join("evidence", "publish-8453-x"), countsDir: "/c/deployments/frozen-counts", countsRequireOriginDev: true }, "unpause-PROTO");
    expect(next).toContain(`--evidence ${join(process.cwd(), "evidence", "publish-8453-x")}`);
    expect(next).toContain("--counts-dir /c/deployments/frozen-counts --counts-require-origin-dev");
    // a caller with no evidence dir in its context still tells the operator to pass one
    expect(resumeCommand({ chainId: 8453, coreSha: SHA })).toContain("--evidence DIR");
  });
});

describe("the core timelock: pinned at the first proxy stage, adopted when someone deployed it first (issue 1835)", () => {
  const OUT = join(import.meta.dir, "fixtures", "build-out");
  const SAFE = "0x00000000000000000000000000000000000050fe"; // the Safe the fake Safe API creates
  const TL = predictCoreTimelock(getStageTable().upgradeAuthority!, OUT, SAFE, 60n);
  const RUNTIME: string = JSON.parse(readFileSync(join(OUT, "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json"), "utf8")).deployedBytecode.object;
  const A = "0x000000000000000000000000000000000000a001";
  const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
  /** A griefer deployed the timelock at its prediction once the proxies were public: the stage script reuses it and plans one transaction fewer. */
  const pregrief = (code: string | null) => {
    const w = world({ startNonce: 0 });
    w.cfg.counts[SCRIPT.timelock!] = COUNTS.timelock! - 1;
    if (code === null) w.cfg.emptyCode = [SAFE, TL.address.toLowerCase()];
    else w.cfg.codeAt = { [TL.address.toLowerCase()]: code };
    return w;
  };

  test("the first proxy stage pins the predicted address and init code hash, every proxy manifest names it, and the timelock stage recomputes the same", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const m = manifest(w);
    expect(m.stages.vault.timelockPrediction).toEqual({ address: TL.address, initCodeHash: TL.initCodeHash, safe: SAFE, minDelay: "60" });
    expect(m.stages.timelock.adopted).toBeUndefined();
    // issue 1853: every proxy stage after the first and the timelock stage recompute the pin before they broadcast
    const ok = w.logs().filter((l) => l.event === "stage.timelock_pin_ok");
    expect(ok.map((l) => l.stage)).toEqual(["registry", "router", "receipt", "governance", "proto", "rwa", "timelock"]);
    for (const l of ok) expect(l).toMatchObject({ timelock: TL.address, init_code_hash: TL.initCodeHash });
  });

  test("the expected runtime code already at the prediction: the stage passes at the frozen count minus one and records the adoption", async () => {
    const w = pregrief(RUNTIME);
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(lastError(w)).toBeUndefined();
    const t = manifest(w).stages.timelock;
    expect(t).toMatchObject({ status: "done", adopted: true, count: COUNTS.timelock, dryRunCount: COUNTS.timelock! - 1, broadcastCount: COUNTS.timelock! - 1 });
    expect(t.adoption).toEqual({ libraries: [{ name: "ProposerFloorTimelock", artifact: "ProposerFloorTimelock", address: TL.address, codeHash: TL.runtimeHash }], factory: getStageTable().upgradeAuthority!.factory, deployerTxs: COUNTS.timelock! - 1 });
    // the end-of-deploy nonce check counts the transactions the deployer really sent
    expect(w.state().nonces[A]).toBe(sum - 1 + PROOF_TX_NONCES);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.nonce === sum - 1 + PROOF_TX_NONCES)).toBe(true);
    expect(broadcasts(w)).toContain(SCRIPT.timelock);
  });

  test("other runtime code at the prediction is not adopted: the shortfall is COUNT_MISMATCH and nothing is sent", async () => {
    const w = pregrief("0x6001600155aa");
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(lastError(w).message).toContain(`stage timelock: the dry-run sends ${COUNTS.timelock! - 1} transactions, the frozen count is ${COUNTS.timelock}`);
    expect(broadcasts(w)).not.toContain(SCRIPT.timelock);
    expect(manifest(w).stages.timelock).toBeUndefined();
    expect(existsSync(stageManifest(w, "timelock"))).toBe(false); // issue 1866: the refusal removes what the simulation wrote
    expect(w.logs().find((l) => l.event === "stage.timelock_not_adopted")).toMatchObject({ timelock: TL.address, runtime_hash: TL.runtimeHash });
  });

  test("a plain shortfall with no code at the prediction is COUNT_MISMATCH", async () => {
    const w = pregrief(null);
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(broadcasts(w)).not.toContain(SCRIPT.timelock);
  });

  /** A deploy that stopped in the timelock simulation, then resumed after `mutate`. */
  async function resumeTimelock(mutate: (w: ReturnType<typeof world>) => void) {
    const w = world({ startNonce: 0 });
    w.cfg.simFails = SCRIPT.timelock;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SIMULATION);
    w.cfg.simFails = undefined;
    mutate(w);
    return { w, code: await w.run(["--stage", "deploy", "--resume"]) };
  }

  test("another build between the first proxy stage and the timelock stage (other CBOR metadata) moves the prediction: the timelock stage refuses, nothing sent", async () => {
    const { w, code } = await resumeTimelock((w) => {
      const f = join(w.coreDir, "out", "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json");
      const j = JSON.parse(readFileSync(f, "utf8"));
      j.bytecode.object = `${j.bytecode.object.slice(0, -4)}0034`; // the CBOR length suffix of another compiler run
      writeFileSync(f, JSON.stringify(j));
    });
    expect(code).toBe(EXIT_CODES.MANIFEST);
    const msg: string = lastError(w).message;
    expect(msg).toContain("stage timelock: the core timelock prediction changed since stage vault");
    expect(msg).toContain(`pinned ${TL.address} (init code hash ${TL.initCodeHash}`);
    expect(broadcasts(w)).not.toContain(SCRIPT.timelock);
  });

  /** Edit the vault stage's record in the run manifest. */
  const editVault = (f: (vault: any) => void) => (w: ReturnType<typeof world>) => {
    const p = join(w.evidence, "publish-run.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    f(m.stages.vault);
    writeFileSync(p, JSON.stringify(m));
  };
  /** Another build of the ProposerFloorTimelock (the CBOR length suffix of another compiler run). */
  const rebuildTimelock = (w: ReturnType<typeof world>) => {
    const f = join(w.coreDir, "out", "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.bytecode.object = `${j.bytecode.object.slice(0, -4)}0034`;
    writeFileSync(f, JSON.stringify(j));
  };

  test("a recorded init code hash that differs from the recomputed one is refused", async () => {
    const hash = await resumeTimelock(editVault((v) => { v.timelockPrediction.initCodeHash = `0x${"11".repeat(32)}`; }));
    expect(hash.code).toBe(EXIT_CODES.MANIFEST);
    expect(lastError(hash.w).message).toContain(`init code hash 0x${"11".repeat(32)}`);
    expect(broadcasts(hash.w)).not.toContain(SCRIPT.timelock);
  });

  /** Issue 1853: a deploy that stopped in the registry simulation (the vault stage done and pinned), then resumed after `mutate`. */
  async function resumeRegistry(mutate: (w: ReturnType<typeof world>) => void) {
    const w = world({ startNonce: 0 });
    w.cfg.simFails = SCRIPT.registry;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SIMULATION);
    expect(manifest(w).stages.vault.status).toBe("done");
    w.cfg.simFails = undefined;
    mutate(w);
    return { w, code: await w.run(["--stage", "deploy", "--resume"]) };
  }

  const refusedBeforeRegistry = (w: ReturnType<typeof world>, code: number) => {
    expect(code).toBe(EXIT_CODES.MANIFEST);
    expect(broadcasts(w)).not.toContain(SCRIPT.registry);
    expect(simulations(w).some((c: any) => String(c.args[1]).includes(SCRIPT.registry!))).toBe(true); // refused after its simulation, before the broadcast
    expect(manifest(w).stages.registry).toBeUndefined();
    // issue 1866: the refusal removes the manifest the registry simulation wrote, so the same command runs again once the cause is fixed
    expect(existsSync(stageManifest(w, "registry"))).toBe(false);
  };
  /** Issue 1866: undo the cause, run the same command again: the deploy finishes (no "already ran" refusal). */
  const rerunSucceeds = async (w: ReturnType<typeof world>, undo: () => void) => {
    undo();
    const seen = w.lines.length;
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0);
    expect(w.logs().slice(seen).filter((l) => l.event === "run.failed")).toEqual([]);
    expect(manifest(w).stages.registry.status).toBe("done");
    expect(broadcasts(w)).toContain(SCRIPT.timelock);
  };
  const artifact = (w: ReturnType<typeof world>) => join(w.coreDir, "out", "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json");

  test("issue 1853, 1866: the ProposerFloorTimelock artifact changed since the vault stage: the registry stage refuses before its broadcast, and runs once it is restored", async () => {
    let undo = () => {};
    const { w, code } = await resumeRegistry((w) => { undo = keep(artifact(w)); rebuildTimelock(w); });
    refusedBeforeRegistry(w, code);
    expect(lastError(w).message).toContain("stage registry: the core timelock prediction changed since stage vault");
    expect(lastError(w).message).toContain(`pinned ${TL.address} (init code hash ${TL.initCodeHash}`);
    await rerunSucceeds(w, undo);
  });

  test("issue 1853, 1866: SAFE_ADDRESS changed since the vault stage: the registry stage refuses before its broadcast, and runs once it is restored", async () => {
    const other = "0x00000000000000000000000000000000000050ff";
    let undo = () => {};
    const { w, code } = await resumeRegistry((w) => {
      const f = join(w.coreDir, "deployments", "918453", "safe.json");
      undo = keep(f);
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), safe: other }));
    });
    refusedBeforeRegistry(w, code);
    expect(lastError(w).message).toContain("stage registry: the core timelock prediction changed since stage vault");
    expect(lastError(w).message).toContain(`Safe ${other}`);
    await rerunSucceeds(w, undo);
  });

  test("issue 1853, 1866: TIMELOCK_MIN_DELAY changed since the vault stage: the registry stage refuses before its broadcast, and runs once it is restored", async () => {
    let undo = () => {};
    const { w, code } = await resumeRegistry((w) => { undo = keep(w.sheetPath); writeFileSync(w.sheetPath, readFileSync(w.sheetPath, "utf8").replace(/^TIMELOCK_MIN_DELAY=60$/m, "TIMELOCK_MIN_DELAY=120")); });
    refusedBeforeRegistry(w, code);
    expect(lastError(w).message).toContain("stage registry: the core timelock prediction changed since stage vault");
    expect(lastError(w).message).toContain("delay 120");
    await rerunSucceeds(w, undo);
  });

  /** A run manifest from a release before 1835: the vault stage is done and recorded no pin. `onChain` is what the vault proxy's upgradeTimelock() reads. */
  const unpinned = (onChain: string, also: (w: ReturnType<typeof world>) => void = () => {}) => (w: ReturnType<typeof world>) => {
    editVault((v) => { delete v.timelockPrediction; })(w);
    w.cfg.castReplies = { call: { stdout: onChain } };
    also(w);
  };
  /** The refusal never sends the operator back to the vault stage: the runner refuses to rerun a stage whose manifest exists. */
  const noVaultRerun = (msg: string) => {
    expect(msg).not.toMatch(/from stage vault with|rerun|run (the deploy )?from stage/i);
    expect(msg).not.toContain("Run the deploy from stage vault");
  };

  test("issue 1853: a done vault stage without a pin is backfilled when its manifest, the chain and the recomputed prediction agree", async () => {
    const { w, code } = await resumeRegistry(unpinned(TL.address));
    expect(code).toBe(0);
    expect(manifest(w).stages.vault.timelockPrediction).toEqual({ address: TL.address, initCodeHash: TL.initCodeHash, safe: SAFE, minDelay: "60" });
    expect(w.logs().filter((l) => l.event === "stage.timelock_pin_backfilled")).toEqual([expect.objectContaining({ stage: "registry", pinned_by: "vault", timelock: TL.address, on_chain: TL.address })]);
    expect(w.state().calls.some((c: any) => c.tool === "cast" && c.args[0] === "call" && c.args[2] === "upgradeTimelock()(address)")).toBe(true);
    expect(broadcasts(w)).toContain(SCRIPT.timelock);
  });

  test("issue 1853: no backfill when the vault proxy names another timelock on chain: MANIFEST, nothing sent, no vault rerun advice", async () => {
    const { w, code } = await resumeRegistry(unpinned("0x00000000000000000000000000000000000000b0"));
    refusedBeforeRegistry(w, code);
    const msg: string = lastError(w).message;
    expect(msg).toContain("cannot be backfilled");
    expect(msg).toContain("reads upgradeTimelock() 0x00000000000000000000000000000000000000b0 on chain");
    noVaultRerun(msg);
    expect(manifest(w).stages.vault.timelockPrediction).toBeUndefined();
    // issue 1866: once the chain reads the recorded timelock the same command backfills the pin and runs the registry stage
    await rerunSucceeds(w, () => { w.cfg.castReplies = { call: { stdout: TL.address } }; });
    expect(manifest(w).stages.vault.timelockPrediction).toMatchObject({ address: TL.address });
  });

  test("issue 1853: no backfill when this build predicts another timelock than the vault manifest and the chain name: MANIFEST, nothing sent, no vault rerun advice", async () => {
    let undo = () => {};
    const { w, code } = await resumeRegistry(unpinned(TL.address, (w) => { undo = keep(artifact(w)); rebuildTimelock(w); }));
    refusedBeforeRegistry(w, code);
    const msg: string = lastError(w).message;
    expect(msg).toContain(`the vault proxies name the timelock ${TL.address}, this build predicts`);
    expect(msg).toContain("Rebuild core with the toolchain");
    noVaultRerun(msg);
    expect(manifest(w).stages.vault.timelockPrediction).toBeUndefined();
    // issue 1866: rebuilt with the vault stage's toolchain, the same command backfills the pin and runs the registry stage
    await rerunSucceeds(w, undo);
    expect(manifest(w).stages.vault.timelockPrediction).toMatchObject({ address: TL.address });
  });

  test("issue 1866: a transient cast failure (TOOL) in the backfill's upgradeTimelock() read leaves no registry manifest, and the next run with a working cast backfills and finishes", async () => {
    const { w, code } = await resumeRegistry(unpinned(TL.address, (w) => { w.cfg.castReplies = { call: { stderr: "error sending request: connection reset", code: 1 } }; }));
    expect(code).toBe(EXIT_CODES.TOOL);
    expect(lastError(w).message).toContain("cast call failed");
    expect(broadcasts(w)).not.toContain(SCRIPT.registry);
    expect(manifest(w).stages.registry).toBeUndefined();
    expect(existsSync(stageManifest(w, "registry"))).toBe(false);
    expect(manifest(w).stages.vault.timelockPrediction).toBeUndefined();
    await rerunSucceeds(w, () => { w.cfg.castReplies = { call: { stdout: TL.address } }; });
    expect(manifest(w).stages.vault.timelockPrediction).toMatchObject({ address: TL.address });
  });

  /** Issue 1866: a deploy from a release before 1835 that stopped in the router simulation: vault and registry done, no pin. */
  async function unpinnedAtRouter(mutate: (w: ReturnType<typeof world>) => void) {
    const w = world({ startNonce: 0 });
    w.cfg.simFails = SCRIPT.router;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SIMULATION);
    expect(manifest(w).stages.registry.status).toBe("done");
    w.cfg.simFails = undefined;
    unpinned(TL.address, mutate)(w);
    return { w, code: await w.run(["--stage", "deploy", "--resume"]) };
  }
  const refusedBeforeRouter = (w: ReturnType<typeof world>, code: number) => {
    expect(code).toBe(EXIT_CODES.MANIFEST);
    expect(broadcasts(w)).not.toContain(SCRIPT.router);
    expect(manifest(w).stages.router).toBeUndefined();
    expect(existsSync(stageManifest(w, "router"))).toBe(false);
    expect(manifest(w).stages.vault.timelockPrediction).toBeUndefined();
  };
  const OTHER = "0x00000000000000000000000000000000000000b0";

  test("issue 1866: no backfill when a done registry stage's manifest names another timelock than the vault manifest: MANIFEST, nothing sent, no pin", async () => {
    const { w, code } = await unpinnedAtRouter((w) => {
      const f = stageManifest(w, "registry");
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), upgrade_timelock: OTHER }));
    });
    refusedBeforeRouter(w, code);
    expect(lastError(w).message).toContain(`the manifest of stage registry records upgrade_timelock ${OTHER}, the vault manifest records ${TL.address}`);
  });

  test("issue 1866: no backfill when a done registry proxy reads another upgradeTimelock() on chain: MANIFEST, nothing sent, no pin", async () => {
    const { w, code } = await unpinnedAtRouter((w) => {
      const registry = JSON.parse(readFileSync(stageManifest(w, "registry"), "utf8")).registry as string;
      w.cfg.callAt = { [registry.toLowerCase()]: OTHER };
    });
    refusedBeforeRouter(w, code);
    expect(lastError(w).message).toContain(`the registry registry proxy`);
    expect(lastError(w).message).toContain(`reads upgradeTimelock() ${OTHER} on chain`);
  });

  test("issue 1866: every done proxy stage agrees: the backfill reads each one on chain, pins and finishes", async () => {
    const { w, code } = await unpinnedAtRouter(() => {});
    expect(code).toBe(0);
    expect(manifest(w).stages.vault.timelockPrediction).toMatchObject({ address: TL.address });
    const reads = w.state().calls.filter((c: any) => c.tool === "cast" && c.args[0] === "call" && c.args[2] === "upgradeTimelock()(address)").map((c: any) => c.args[1].toLowerCase());
    const proxyOf = (stage: string, field: string) => String(JSON.parse(readFileSync(stageManifest(w, stage), "utf8"))[field]).toLowerCase();
    expect(reads).toEqual([proxyOf("vault", "vault"), proxyOf("registry", "registry")]);
  });

  test("issue 1866: no backfill when the second proxy of the first proxy stage reads another upgradeTimelock() on chain: MANIFEST, no pin", async () => {
    const original = getStageTable();
    try {
      const { w, code } = await resumeRegistry(unpinned(TL.address, (w) => {
        // the vault stage deploys two proxies in this table: the second is the aave_adapter address the stub vault manifest holds
        const p = join(w.coreDir, "scripts", "deploy", "stage-table.json");
        const t = JSON.parse(readFileSync(p, "utf8"));
        const vault = t.stages.find((s: any) => s.name === "vault");
        vault.proxies.push({ ...vault.proxies[0], field: "aave_adapter" });
        writeFileSync(p, JSON.stringify(t));
        w.cfg.callAt = { [JSON.parse(readFileSync(stageManifest(w, "vault"), "utf8")).aave_adapter.toLowerCase()]: OTHER };
      }));
      refusedBeforeRegistry(w, code);
      expect(lastError(w).message).toContain(`the vault aave_adapter proxy`);
      expect(lastError(w).message).toContain(`reads upgradeTimelock() ${OTHER} on chain`);
      expect(manifest(w).stages.vault.timelockPrediction).toBeUndefined();
    } finally {
      useStageTable(original);
    }
  });

  test("issue 1866: a COUNT_MISMATCH after the simulation of a fresh real run leaves no stage manifest, and the run finishes once the count agrees", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.counts[SCRIPT.registry!] = COUNTS.registry! + 1;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(broadcasts(w)).not.toContain(SCRIPT.registry);
    expect(manifest(w).stages.registry).toBeUndefined();
    expect(existsSync(stageManifest(w, "registry"))).toBe(false);
    w.cfg.counts[SCRIPT.registry!] = COUNTS.registry!;
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0); // the run manifest exists, so the same deploy continues with --resume
    expect(manifest(w).stages.registry.status).toBe("done");
  });

  test("issue 1866: a dry run that refuses after its simulation keeps today's restore: a manifest that was there is put back, one the simulation created is gone", async () => {
    const w = world({ startNonce: 0, writeSafeManifest: true });
    w.cfg.counts[SCRIPT.registry!] = COUNTS.registry! + 1;
    const before = JSON.stringify({ registry: "0x00000000000000000000000000000000000000c1", note: "an earlier deploy" });
    mkdirSync(join(w.coreDir, "deployments", "918453"), { recursive: true });
    writeFileSync(stageManifest(w, "registry"), before);
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(targetBroadcasts(w)).toEqual([]);
    expect(readFileSync(stageManifest(w, "registry"), "utf8")).toBe(before);
    expect(existsSync(stageManifest(w, "vault"))).toBe(false);
  });

  test("issue 1853: a resumed vault stage whose earlier attempt landed transactions and recorded no pin is refused, never pinned to this build", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.vault;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.BROADCAST);
    editVault((v) => { expect(v.status).toBe("started"); delete v.timelockPrediction; })(w);
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(EXIT_CODES.MANIFEST);
    expect(lastError(w).message).toContain("stage vault: an earlier attempt of this stage, started by an earlier release of publish-contracts, already landed transactions and recorded no core timelock pin");
    expect(forgeScripts(w).some((c: any) => c.args.includes("--resume"))).toBe(false);
    expect(manifest(w).stages.vault.timelockPrediction).toBeUndefined();
  });

  test("a proxy stage whose manifest names another timelock than the pin stops after its broadcast (MANIFEST)", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.upgradeTimelock = { [SCRIPT.vault!]: "0x00000000000000000000000000000000000000b0" };
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.MANIFEST);
    expect(lastError(w).message).toContain(`the core timelock this run pinned from the build is ${TL.address}`);
    expect(manifest(w).stages.vault.status).toBe("started");
    expect(broadcasts(w)).not.toContain(SCRIPT.registry);
  });
});

// Issue 1926: library addresses moved once (the build no longer embeds the checkout path), so a fresh run on 8453 finds NO code at the derived library addresses.
// On 8453 every library a stage links must hold code, have been created earlier in the run, or be created by the stage itself through the CREATE2 factory AHEAD of
// every other transaction; otherwise the run refuses before anything is sent. Exercised with an 8453 dry run (stub forge and cast; nothing reaches any chain).
describe("issue 1926: on 8453 no stage links a library address without code", () => {
  const OUT = join(import.meta.dir, "fixtures", "build-out");
  const BUILT = buildCreate2Libraries(getStageTable().create2Libraries!, OUT);
  const VAULT_LIBS = getStageTable().stages.find((s) => s.name === "vault")!.create2Libraries!.map((n) => BUILT.get(getStageTable().create2Libraries!.find((l) => l.name === n)!.artifact)!.address.toLowerCase());
  const TICK = "0x0000000000000000000000000000000000001009"; // the stub libs manifest's tick_math
  const OWNERS = ["A", "B", "C"].flatMap((o) => ["--owner-signer", `keystore:/k/OWNER_${o}`]);
  /** An 8453 world whose chain holds no code at tick_math or the vault stage's derived CREATE2 libraries. `vaultPlan`: the CREATE2 addresses the vault simulation plans, by transaction index. */
  const freshWorld = (vaultPlan: string[]) => {
    const w = world({ chainId: 8453, startNonce: 0 });
    cpSync(OUT, join(w.coreDir, "out"), { recursive: true });
    Object.assign(w.cfg, { emptyCode: ["0x00000000000000000000000000000000000050fe", TICK, ...VAULT_LIBS], creates: { [SCRIPT.libs]: [TICK], [SCRIPT.vault]: vaultPlan } });
    return w;
  };
  const gateLog = (w: ReturnType<typeof world>, stage: string) => w.logs().find((l) => l.event === "stage.linked_libraries_have_code" && l.stage === stage);
  const vaultBroadcasts = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast") && String(c.args[1]).includes(SCRIPT.vault));

  test("the libs stage and the vault stage create their libraries through the factory before any transaction that links them; later stages link what this run created", async () => {
    const w = freshWorld(VAULT_LIBS);
    expect(await w.run(["--stage", "deploy", "--dry-run", ...OWNERS])).toBe(0);
    expect(lastError(w)).toBeUndefined();
    expect(gateLog(w, "libs").libraries).toEqual([{ name: "tick_math", address: TICK, how: "created by this stage" }]);
    expect(gateLog(w, "vault").libraries).toEqual([
      { name: "tick_math", address: TICK, how: "created earlier in this run" },
      ...VAULT_LIBS.map((a, i) => ({ name: getStageTable().stages.find((s) => s.name === "vault")!.create2Libraries![i], address: a, how: "created by this stage before its first linking transaction" })),
    ]);
    // the registry links GovernedUpgrade, which the vault stage created in this run
    expect(gateLog(w, "registry").libraries).toContainEqual({ name: "GovernedUpgrade", address: VAULT_LIBS[0], how: "created earlier in this run" });
  });

  test("a stage that would link a derived library address with NO code, and plans no CREATE2 of it, is refused (LIBS_ADOPTION) before anything is sent", async () => {
    const w = freshWorld([]);
    expect(await w.run(["--stage", "deploy", "--dry-run", ...OWNERS])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w).message).toContain(`at its derived address ${VAULT_LIBS[0]} has NO code`);
    expect(lastError(w).message).toContain("Nothing was sent");
    expect(vaultBroadcasts(w)).toEqual([]); // not even applied to the local simulation chain
    expect(targetBroadcasts(w)).toEqual([]);
    expect(simulations(w).some((c: any) => String(c.args[1]).includes(SCRIPT.registry))).toBe(false);
  });

  test("a library CREATE2 planned AFTER a transaction that may link it is refused before anything is sent", async () => {
    const w = freshWorld(["", ...VAULT_LIBS]); // transaction 0 is the stage's own, the libraries come after it
    expect(await w.run(["--stage", "deploy", "--dry-run", ...OWNERS])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w).message).toContain("as transaction 1, after transaction 0");
    expect(vaultBroadcasts(w)).toEqual([]);
  });

  test("the gate is 8453 only: the same chain state on the Twin chain runs as before", async () => {
    const w = world({ startNonce: 0 });
    cpSync(OUT, join(w.coreDir, "out"), { recursive: true });
    Object.assign(w.cfg, { emptyCode: [TICK, ...VAULT_LIBS], creates: { [SCRIPT.vault]: [] } });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(w.logs().some((l) => l.event === "stage.linked_libraries_have_code")).toBe(false);
  });
});

describe("issue 1926: the stage runner reads forge --version first and refuses any forge but the pinned 1.8.5", () => {
  for (const v of ["1.7.1", "1.8.3"]) {
    test(`forge ${v} is refused (TOOL) with both versions named, before the signer or any forge script`, async () => {
      const w = world({ startNonce: 0 });
      (w.cfg as any).forgeVersion = `forge Version: ${v}-v${v}\nCommit SHA: stub`;
      expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.TOOL);
      expect(lastError(w).message).toContain(`is forge ${v}, but release builds use exactly forge 1.8.5`);
      expect(forgeScripts(w)).toEqual([]);
    });
  }
  test("the pinned forge 1.8.5 is accepted", async () => {
    const w = world({ startNonce: 1, writeSafeManifest: true });
    (w.cfg as any).forgeVersion = "forge Version: 1.8.5-v1.8.5\nCommit SHA: stub";
    expect(await w.run(["--stage", "libs"])).toBe(0);
    expect(w.state().calls.find((c: any) => c.tool === "forge").args).toEqual(["--version"]);
  });
});
