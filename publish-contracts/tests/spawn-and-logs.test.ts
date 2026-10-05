import { describe, expect, test } from "bun:test";
import { PublishError, EXIT_CODES } from "../src/errors.ts";
import { childEnv, forgeFailureTail, spawnTool } from "../src/runner.ts";
import { SCRIPT, world } from "./harness.ts";

describe("what the CLI spawns and what it logs", () => {
  test("every spawned process is forge, cast or the read-only git status", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const calls = w.state().calls;
    expect(calls.length).toBeGreaterThan(20);
    for (const c of calls) {
      expect(["forge", "cast", "git"]).toContain(c.tool);
      expect(c.argv0).toBe(c.tool);
      if (c.tool === "git") expect(c.args.slice(0, 1).concat(c.args.slice(2, 4))).toEqual(["-C", "status", "--porcelain"]);
    }
  });

  test("forge gets the RPC as FOUNDRY_ETH_RPC_URL too: forge script ignores ETH_RPC_URL and would simulate in memory", () => {
    const e = childEnv({ baseEnv: {}, rpc: "http://rpc.test", chainId: 918453 });
    expect(e.ETH_RPC_URL).toBe("http://rpc.test");
    expect(e.FOUNDRY_ETH_RPC_URL).toBe("http://rpc.test");
  });

  test("a failed forge run reports the error lines, not the compiler warning list", () => {
    const err = "Warning: unused\n - /a/b.sol\n - /c/d.sol\n - /e/f.sol\n";
    expect(forgeFailureTail("", `${err}Error: script failed: DEPLOYMENT_OUT must be set\n${" - /g/h.sol\n"}`)).toContain("DEPLOYMENT_OUT must be set");
    expect(forgeFailureTail("a\nb\nc\nd", "")).toBe("b c d");
  });

  test("the spawner refuses any other program", async () => {
    await expect(spawnTool("git" as never, ["status"], { env: {} })).rejects.toThrow(PublishError);
    await expect(spawnTool("bash" as never, ["-c", "true"], { env: {} })).rejects.toThrow("read-only git status only");
  });

  test("the RPC reaches children through ETH_RPC_URL, never as an argument", async () => {
    const w = world({ startNonce: 0 });
    await w.run(["--stage", "deploy"]);
    for (const c of w.state().calls) {
      expect(c.hasRpcEnv).toBe(true);
      expect(c.args.join(" ")).not.toContain("rpc.test");
      expect(c.args).not.toContain("--rpc-url");
    }
  });

  // Loopback chain 918453 with a keystore signer. The secrets sit in env names the floor does not police, so the run goes through
  // and the test can prove the logs and the children never carry them. The floor itself is not weakened (next test).
  test("all log output is JSON and carries no signer passphrase or key material", async () => {
    const SENTINELS = ["SENTINEL-PASSPHRASE-91c2", "SENTINEL-KEY-77ab", "SENTINEL-MNEMONIC-3d3d"];
    const w = world({ startNonce: 0 });
    const code = await w.run(["--stage", "deploy"], {
      env: { DEPLOYER_UNLOCK_PHRASE: SENTINELS[0], VENDOR_API_KEY: SENTINELS[1], NOTES_SEED_WORDS: SENTINELS[2] },
    });
    expect(code).toBe(0);
    expect(w.lines.length).toBeGreaterThan(20);
    for (const line of w.lines) {
      const j = JSON.parse(line); // every line parses as JSON
      expect(typeof j.event).toBe("string");
      expect(typeof j.ts).toBe("string");
      for (const s of SENTINELS) expect(line).not.toContain(s);
    }
    // the children never saw plaintext signing material either
    for (const c of w.state().calls) expect(c.secretEnv).toEqual([]);
  });

  test("a plaintext key env is refused by the floor and its value never reaches a log line", async () => {
    const SENTINELS = ["SENTINEL-PASSPHRASE-91c2", "SENTINEL-KEY-77ab", "SENTINEL-MNEMONIC-3d3d"];
    const w = world({ startNonce: 0 });
    const code = await w.run(["--stage", "deploy"], { env: { ETH_PASSWORD: SENTINELS[0], PRIVATE_KEY: SENTINELS[1], MNEMONIC: SENTINELS[2] } });
    expect(code).not.toBe(0);
    for (const line of w.lines) { JSON.parse(line); for (const s of SENTINELS) expect(line).not.toContain(s); }
    expect(w.state().calls.filter((c: any) => c.tool === "forge")).toEqual([]);
  });

  test("a failing run also logs only JSON", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.simFails = SCRIPT.vault;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SIMULATION);
    for (const line of w.lines) JSON.parse(line);
    expect(w.logs().at(-1).event).toBe("run.failed");
  });

  test("the redaction masks secret-looking field names even if a caller logs one by mistake", async () => {
    const { publishLogger } = await import("../src/log.ts");
    const out: string[] = [];
    publishLogger((l) => out.push(l)).log("info", "x", { passphrase: "hunter2", private_key: "0xabc", mnemonic: "words", ok: "fine" });
    expect(out[0]).not.toContain("hunter2");
    expect(out[0]).not.toContain("0xabc");
    expect(out[0]).not.toContain("words");
    expect(out[0]).toContain("fine");
  });
});
