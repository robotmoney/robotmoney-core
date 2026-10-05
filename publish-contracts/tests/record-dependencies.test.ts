import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishLogger } from "../src/log.ts";
import { RECORDER_SCRIPT, recordDependencyManifest, type RecordCtx, type RecorderSpawn } from "../src/record-dependencies.ts";
import { SHA, tmp } from "./fixtures.ts";

const RPC = "https://rpc.example.invalid/SECRETKEY";
function setup(chainId = 8453, withScript = true) {
  const coreDir = tmp("pc-record-");
  if (withScript) { mkdirSync(join(coreDir, "scripts", "release"), { recursive: true }); writeFileSync(join(coreDir, RECORDER_SCRIPT), "// stub"); }
  const lines: string[] = [];
  const ctx: RecordCtx = { chainId, rpc: RPC, coreDir, coreSha: SHA, log: publishLogger((l) => lines.push(l)), baseEnv: { PATH: "/bin", PRIVATE_KEY: "nope" }, dryRun: false };
  const events = () => lines.map((l) => JSON.parse(l));
  return { ctx, coreDir, events };
}
const writes = (coreDir: string): RecorderSpawn => async () => {
  const out = join(coreDir, "deployments", "dependency-manifests", "8453", `${SHA}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ chainId: 8453 }));
  return { code: 0, stdout: `noise\n${out}\n`, stderr: "" };
};

describe("release dependency manifest recorder call", () => {
  test("on 8453 it runs core's recorder with the rpc in the environment only and copies the output", async () => {
    const { ctx, coreDir } = setup();
    const calls: any[] = [];
    const spawn: RecorderSpawn = async (cmd, opts) => { calls.push({ cmd, opts }); return writes(coreDir)(cmd, opts); };
    const r = await recordDependencyManifest(ctx, spawn);
    expect(r.recorded).toBe(true);
    expect(calls[0].cmd).toEqual(["bun", RECORDER_SCRIPT, "--chain-id", "8453", "--release", SHA]);
    expect(calls[0].cmd.join(" ")).not.toContain("SECRETKEY");
    expect(calls[0].opts.env.DEPENDENCY_MANIFEST_RPC_URL).toBe(RPC);
    expect(calls[0].opts.env.PRIVATE_KEY).toBeUndefined();
    expect(JSON.parse(readFileSync(join(coreDir, "deployments", "8453", "dependency-manifest.json"), "utf8")).chainId).toBe(8453);
  });

  test("other chains and dry runs do not call the recorder", async () => {
    const a = setup(918453);
    const never: RecorderSpawn = async () => { throw new Error("must not run"); };
    expect((await recordDependencyManifest(a.ctx, never)).recorded).toBe(false);
    const b = setup();
    expect((await recordDependencyManifest({ ...b.ctx, dryRun: true }, never)).recorded).toBe(false);
  });

  test("a recorder failure is a WARN with a named code, never a throw, and the rpc is redacted", async () => {
    const { ctx, events } = setup();
    const r = await recordDependencyManifest(ctx, async () => ({ code: 3, stdout: "", stderr: `boom ${RPC}` }));
    expect(r).toEqual({ recorded: false, code: "DEPENDENCY_MANIFEST_RECORDER_FAILED" });
    const e = events().find((x) => x.event === "release.dependency_manifest_not_recorded");
    expect(e.level).toBe("warn");
    expect(e.code).toBe("DEPENDENCY_MANIFEST_RECORDER_FAILED");
    expect(JSON.stringify(e)).not.toContain("SECRETKEY");
  });

  test("a spawn that throws, a missing script and a missing output are each a named WARN", async () => {
    const a = setup();
    expect((await recordDependencyManifest(a.ctx, async () => { throw new Error("no bun"); })).code).toBe("DEPENDENCY_MANIFEST_RECORDER_FAILED");
    const b = setup(8453, false);
    expect((await recordDependencyManifest(b.ctx, async () => { throw new Error("x"); })).code).toBe("DEPENDENCY_MANIFEST_SCRIPT_MISSING");
    const c = setup();
    expect((await recordDependencyManifest(c.ctx, async () => ({ code: 0, stdout: "/nope.json\n", stderr: "" }))).code).toBe("DEPENDENCY_MANIFEST_OUTPUT_MISSING");
    expect(existsSync(join(c.coreDir, "deployments", "8453", "dependency-manifest.json"))).toBe(false);
  });
});
