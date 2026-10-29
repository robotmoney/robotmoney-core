// Issue 1926: every release-build entry point reads `forge --version` first and refuses any forge but the pinned one (src/forge-version.ts), with an error that
// names both versions, and accepts the pinned one. Stub forge binaries (tiny shell scripts) print 1.7.1, 1.8.3 and 1.8.5. The stub's `build` copies the committed
// fixture artifacts into --out, so the accepted libs build really finishes. The CI Foundry installs must name the same version (read from the workflow files).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { PINNED_FORGE_TAG, PINNED_FORGE_VERSION, assertPinnedForge, assertPinnedForgeWith, checkForgeVersionOutput, parseForgeVersion } from "../src/forge-version.ts";
import { buildLibraryArtifacts } from "../src/libs-build.ts";
import { runDeployImplementation, type DeployImplApi } from "../src/deploy-implementation.ts";
import { runStages, type RunContext } from "../src/runner.ts";
import { getStageTable } from "../src/stages.ts";
import { REPO } from "./fixtures.ts";

const PC = join(import.meta.dir, "..");
const FIXTURE_OUT = join(import.meta.dir, "fixtures", "build-out");
const scratch = mkdtempSync(join(tmpdir(), "forge-version-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stub forge printing `forge Version: <v>-v<v>`. `build --out DIR` copies the fixture build output into DIR. Anything else fails. */
function stubForge(v: string): string {
  const p = join(scratch, `forge-${v}`);
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'forge Version: ${v}-v${v}\\nCommit SHA: stub\\n'; exit 0; fi
if [ "$1" = "build" ]; then
  out=""; prev=""
  for a in "$@"; do if [ "$prev" = "--out" ]; then out="$a"; fi; prev="$a"; done
  mkdir -p "$out" && cp -R "${FIXTURE_OUT}/." "$out/" && exit 0
fi
echo "stub forge: unsupported $*" >&2; exit 1
`);
  chmodSync(p, 0o755);
  return p;
}
const OLD = ["1.7.1", "1.8.3"];
const forgeRun = (bin: string) => async (args: string[]) => { const r = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; };
const refusal = (v: string) => `is forge ${v}, but release builds use exactly forge ${PINNED_FORGE_VERSION}`;

describe("issue 1926: the pinned forge version", () => {
  test("the module pins 1.8.5 (the version the Twin action installs) and parses both forge --version formats", () => {
    expect(PINNED_FORGE_VERSION).toBe("1.8.5");
    expect(PINNED_FORGE_TAG).toBe("v1.8.5");
    expect(parseForgeVersion("forge Version: 1.8.5-v1.8.5\nCommit SHA: x")).toBe("1.8.5");
    expect(parseForgeVersion("forge 0.2.0 (abc 2024-01-01T00:00:00)")).toBe("0.2.0");
    expect(parseForgeVersion("nothing here")).toBeUndefined();
    expect(() => checkForgeVersionOutput("garbage")).toThrow("unreadable version");
  });

  test("assertPinnedForge and assertPinnedForgeWith refuse 1.7.1 and 1.8.3 (TOOL, both versions named) and accept 1.8.5", async () => {
    for (const v of OLD) {
      expect(() => assertPinnedForge(stubForge(v))).toThrow(refusal(v));
      await expect(assertPinnedForgeWith(forgeRun(stubForge(v)))).rejects.toMatchObject({ kind: "TOOL", details: { found: v, pinned: PINNED_FORGE_VERSION } });
    }
    expect(assertPinnedForge(stubForge("1.8.5"))).toBe("1.8.5");
    expect(await assertPinnedForgeWith(forgeRun(stubForge("1.8.5")))).toBe("1.8.5");
  });
});

describe("issue 1926: each release-build entry point refuses any forge but 1.8.5 and accepts 1.8.5", () => {
  test("libs-build.ts buildLibraryArtifacts", () => {
    for (const v of OLD) expect(() => buildLibraryArtifacts(REPO, getStageTable(), stubForge(v))).toThrow(refusal(v));
    const b = buildLibraryArtifacts(REPO, getStageTable(), stubForge("1.8.5"));
    expect(existsSync(join(b.linkOut, "TickMath.sol", "TickMath.json"))).toBe(true);
    expect(b.create2.length).toBeGreaterThan(0);
  });

  test("predeploy-libs (the CLI): exit 18 before anything is built; the pinned forge passes the check", () => {
    const run = (forge: string) => Bun.spawnSync(["bun", join(PC, "src", "ci", "predeploy-libs.ts"), "--rpc", "http://127.0.0.1:9", "--core-dir", REPO], { env: { ...process.env, FORGE: forge }, stdout: "pipe", stderr: "pipe" });
    for (const v of OLD) {
      const r = run(stubForge(v));
      expect(r.exitCode).toBe(EXIT_CODES.TOOL);
      expect(r.stderr.toString()).toContain(refusal(v));
    }
    const ok = run(stubForge("1.8.5"));
    expect(ok.exitCode).not.toBe(EXIT_CODES.TOOL); // it goes on to the (unreachable) RPC and fails there, never on the version
    expect(ok.stderr.toString()).not.toContain("release builds use exactly forge");
  });

  test("freeze-counts --from-adopted-run (the CLI): exit 18 before the checkout or the RPC is touched; the pinned forge passes the check", () => {
    const run = (forge: string) => Bun.spawnSync(["bun", join(PC, "scripts", "freeze-counts.ts"), "--from-adopted-run", join(scratch, "none.json"), "--sha", "a".repeat(40), "--rpc", "http://127.0.0.1:9", "--core-dir", join(scratch, "no-checkout")], { env: { ...process.env, FORGE: forge }, stdout: "pipe", stderr: "pipe" });
    for (const v of OLD) {
      const r = run(stubForge(v));
      expect(r.exitCode).toBe(EXIT_CODES.TOOL);
      expect(r.stderr.toString()).toContain(refusal(v));
    }
    const ok = run(stubForge("1.8.5"));
    expect(ok.exitCode).toBe(EXIT_CODES.USAGE); // past the version check: the next refusal is the missing checkout at the sha
    expect(ok.stderr.toString()).toContain("not " + "a".repeat(40));
  });

  test("deploy-implementation: refused before any file or chain read; the pinned forge goes on to the next check", async () => {
    const reads: string[] = [];
    const api = (bin: string): DeployImplApi => ({
      forgeVersion: async () => forgeRun(bin)(["--version"]),
      getCode: async () => { reads.push("getCode"); return "0x"; }, implementationOf: async () => { reads.push("impl"); return "0x0000000000000000000000000000000000000001"; },
      upgradesFrozen: async () => { reads.push("frozen"); return false; }, create: async () => { reads.push("create"); throw new Error("sent"); },
    });
    const ctx = { evidenceDir: join(scratch, "no-evidence"), coreDir: join(scratch, "no-core"), chainId: 918453 } as unknown as RunContext;
    for (const v of OLD) await expect(runDeployImplementation(ctx, { proxy: "gateway" }, api(stubForge(v)))).rejects.toMatchObject({ kind: "TOOL", message: expect.stringContaining(refusal(v)) });
    expect(reads).toEqual([]);
    await expect(runDeployImplementation(ctx, { proxy: "gateway" }, api(stubForge("1.8.5")))).rejects.toMatchObject({ kind: "RESUME" }); // the next check: no run manifest
    expect(reads).toEqual([]);
  });

  test("the stage runner: refused before the signer is asked for anything; the pinned forge reaches the signer", async () => {
    const mk = (bin: string, seen: string[]) => ({
      run: async (tool: string, args: string[]) => { seen.push(`${tool} ${args.join(" ")}`); return tool === "forge" ? forgeRun(bin)(args) : { code: 1, stdout: "", stderr: "unexpected" }; },
      signer: { address: async () => { seen.push("signer"); throw new Error("signer reached"); } },
      baseEnv: {}, rpc: "http://127.0.0.1:9", chainId: 918453, coreDir: scratch, evidenceDir: join(scratch, "ev"),
    }) as unknown as RunContext;
    for (const v of OLD) {
      const seen: string[] = [];
      await expect(runStages(mk(stubForge(v), seen), ["libs"], {} as never)).rejects.toMatchObject({ kind: "TOOL", message: expect.stringContaining(refusal(v)) });
      expect(seen).toEqual(["forge --version"]);
    }
    const seen: string[] = [];
    await expect(runStages(mk(stubForge("1.8.5"), seen), ["libs"], {} as never)).rejects.toThrow("signer reached");
    expect(seen).toEqual(["forge --version", "signer"]);
  });
});

describe("issue 1926: every Foundry install in CI names the pinned version", () => {
  /** Every `foundry-rs/foundry-toolchain` step of a workflow or action file and the `version:` of its `with:`. */
  function installs(file: string): { line: number; version?: string }[] {
    const lines = readFileSync(file, "utf8").split("\n");
    const out: { line: number; version?: string }[] = [];
    lines.forEach((l, i) => {
      if (!/^\s*(-\s+)?uses:\s*foundry-rs\/foundry-toolchain@/.test(l)) return;
      const indent = l.search(/\S/) + (l.trimStart().startsWith("-") ? 2 : 0);
      let version: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!;
        if (t.trim() === "" || t.trim().startsWith("#")) continue;
        if (t.search(/\S/) < indent || (t.search(/\S/) === indent - 2 && t.trimStart().startsWith("-"))) break;
        const m = /^\s*version:\s*["']?([^"'\s#]+)/.exec(t);
        if (m) { version = m[1]; break; }
      }
      out.push({ line: i + 1, version });
    });
    return out;
  }
  const files = (dir: string, match: (f: string) => boolean): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter(match).map((f) => join(dir, f)) : []);

  test("every foundry-toolchain step in .github/workflows and .github/actions sets version: v1.8.5", () => {
    const all = [...files(join(REPO, ".github", "workflows"), (f) => /\.ya?ml$/.test(f)), ...files(join(REPO, ".github", "actions"), (f) => /action\.ya?ml$/.test(f))];
    const found = all.flatMap((f) => installs(f).map((x) => ({ file: f.slice(REPO.length + 1), ...x })));
    expect(found.length).toBeGreaterThan(10);
    expect(found.filter((x) => x.version !== PINNED_FORGE_TAG)).toEqual([]);
    expect(found.some((x) => x.file === join(".github", "actions", "twin-fork", "action.yml"))).toBe(true);
  });

  test("the scan catches a step that names another version or none", () => {
    const d = join(scratch, "wf");
    mkdirSync(d, { recursive: true });
    const f = join(d, "x.yml");
    writeFileSync(f, ["jobs:", "  a:", "    steps:", "      - uses: foundry-rs/foundry-toolchain@v1", "        with:", "          version: stable", "      - name: b", "        uses: foundry-rs/foundry-toolchain@v1", "      - run: echo", ""].join("\n"));
    expect(installs(f)).toEqual([{ line: 4, version: "stable" }, { line: 8, version: undefined }]);
  });
});
