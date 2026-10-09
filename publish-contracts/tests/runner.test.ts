import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { encodeErrorResult, encodeFunctionData, parseAbi } from "viem";
import { basename, join } from "node:path";
import { PROOF_TX_NONCES } from "../src/counts.ts";
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
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.recorder, SCRIPT.vault, SCRIPT.registry, SCRIPT.router, SCRIPT.gateway,
      SCRIPT.governance, SCRIPT["ic-policy"], SCRIPT.proto, SCRIPT.agent, SCRIPT.rwa, SCRIPT.timelock]);
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
    // the deploy authorizes no agent (core 1527): stage 11 passes AGENT_ADDRESSES=none and stage 5 reads no AGENT_* name
    const timelock = forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(t.stages.find((s) => s.name === "timelock")!.script) && c.args.includes("--broadcast"));
    expect(timelock.env.AGENT_ADDRESSES).toBe("none");
    for (const c of forgeScripts(w).filter((x: any) => String(x.args[1]).startsWith(t.stages.find((s) => s.name === "gateway")!.script))) {
      expect(Object.keys(c.env).filter((k) => k.startsWith("AGENT_"))).toEqual([]);
    }
  });

  test("the run stops at the first failing stage with a non-zero exit code", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.simFails = SCRIPT.registry;
    const code = await w.run(["--stage", "deploy"]);
    expect(code).toBe(EXIT_CODES.SIMULATION);
    expect(code).not.toBe(0);
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.recorder, SCRIPT.vault]);
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
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.recorder]);
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
    expect(simulations(w).length).toBe(12);
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
    expect(w.logs().filter((l) => l.event === "stage.skipped").map((l) => l.stage)).toEqual(["safe", "libs", "recorder"]);
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
