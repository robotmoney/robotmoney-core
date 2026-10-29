// Issue 1914 Task B: the comment-only contract guard exits 0 when only the metadata trailer differs, and non-zero on any logic byte, a missing artifact or an empty list.
// The synthetic out/ directories use forge's layout (<out>/<Name>.sol/<Name>.json) so the same masking code the verifier uses runs here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRef, BASELINE_SHA, CHANGED_SINCE_DEPLOY3, COMMENT_ONLY_CONTRACTS, compareBuilds } from "../src/ci/check-comment-only-contracts.ts";

const SCRIPT = join(import.meta.dir, "..", "src", "ci", "check-comment-only-contracts.ts");
const scratch = mkdtempSync(join(tmpdir(), "comment-only-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runtime code `6080` + logic + a CBOR trailer (map 0xa1, 3 bytes) whose payload is `meta`. */
const code = (logic: string, meta: string) => `0x6080${logic}a1${meta}0003`;
function build(dir: string, files: Record<string, string>): string {
  const out = join(scratch, dir);
  for (const [name, object] of Object.entries(files)) {
    mkdirSync(join(out, `${name}.sol`), { recursive: true });
    writeFileSync(join(out, `${name}.sol`, `${name}.json`), JSON.stringify({ deployedBytecode: { object, immutableReferences: {}, linkReferences: {} } }));
  }
  return out;
}
const run = (a: string, b: string, contracts?: string) => Bun.spawnSync(["bun", SCRIPT, "--baseline-out", a, "--candidate-out", b, ...(contracts ? ["--contracts", contracts] : [])], { stdout: "pipe", stderr: "pipe" });

describe("comment-only contract guard (issue 1914)", () => {
  test("the default list is the five contracts still comment-only since Deploy 3: issue 1988 changed PortfolioRouter and RouterGovernance on purpose", () => {
    expect(COMMENT_ONLY_CONTRACTS).toEqual(["VaultRegistry", "RobotMoneyVault", "ProtocolAssetVault", "AgentTokenVault", "RwaBasketVault"]);
    expect(CHANGED_SINCE_DEPLOY3).toEqual(["RouterGovernance", "PortfolioRouter"]);
    for (const c of CHANGED_SINCE_DEPLOY3) expect(COMMENT_ONLY_CONTRACTS).not.toContain(c);
  });
  test("a metadata-only difference passes and the CLI exits 0 reporting a non-zero count", () => {
    const a = build("a1", { Alpha: code("6001600255", "010a"), Beta: code("600360045500", "0b0c") });
    const b = build("b1", { Alpha: code("6001600255", "ffee"), Beta: code("600360045500", "1234") });
    expect(compareBuilds(a, b, ["Alpha", "Beta"]).every((r) => r.ok)).toBe(true);
    const r = run(a, b, "Alpha,Beta");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("compared 2 contract(s), 2 identical, 0 differ");
  });
  test("one changed logic byte fails and the CLI exits 1 naming the contract", () => {
    const a = build("a2", { Alpha: code("6001600255", "010a"), Beta: code("600360045500", "0b0c") });
    const b = build("b2", { Alpha: code("6001600255", "010a"), Beta: code("600360055500", "0b0c") });
    const rows = compareBuilds(a, b, ["Alpha", "Beta"]);
    expect(rows.map((x) => x.ok)).toEqual([true, false]);
    const r = run(a, b, "Alpha,Beta");
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("FAIL Beta");
    expect(r.stdout.toString()).toContain("RUNTIME LOGIC DIFFERS");
  });
  test("a contract missing from either build fails", () => {
    const a = build("a3", { Alpha: code("6001600255", "010a") });
    const b = build("b3", {});
    expect(run(a, b, "Alpha").exitCode).toBe(1);
    expect(run(b, a, "Alpha").exitCode).toBe(1);
  });
  test("an empty contract list is a tooling error, never a pass", () => {
    const a = build("a4", { Alpha: code("6001600255", "010a") });
    expect(run(a, a, ",").exitCode).toBe(2);
  });
  test("a baseline ref that does not resolve to the pinned commit 57fbe618 exits non-zero before any build (issue 1916)", () => {
    expect(BASELINE_SHA.startsWith("57fbe618")).toBe(true);
    const r = Bun.spawnSync(["bun", SCRIPT, "--baseline", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("not the pinned 57fbe618");
    const missing = Bun.spawnSync(["bun", SCRIPT, "--baseline", "no-such-ref-1916"], { stdout: "pipe", stderr: "pipe" });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("does not resolve");
  });
  test("an option-like ref (leading '-') is refused with exit 2 before git runs", () => {
    expect(() => assertSafeRef("--output=/x", "--baseline")).toThrow("cannot be empty or start with '-'");
    expect(() => assertSafeRef("", "--baseline")).toThrow();
    expect(assertSafeRef("release/v0.5.0-rehearsal", "--baseline")).toBe("release/v0.5.0-rehearsal");
    for (const flag of ["--baseline", "--candidate"]) {
      const r = Bun.spawnSync(["bun", SCRIPT, flag, "--upload-pack=x"], { stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("start with '-'");
    }
  });
});
