import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check, countScanned } from "../check-deleted-stage-scripts.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

test("a clean tree passes with core-stack.ts called directly", () => {
  const root = tree({ "scripts/stage/core-stack.ts": "// verbs\nexport const x = 1;\n" });
  expect(check(root)).toEqual([]);
});

test("the core-stack.sh shim is no longer allowed", () => {
  const root = tree({ "scripts/stage/core-stack.sh": '#!/usr/bin/env bash\nexec bun core-stack.ts "$@"\n' });
  expect(check(root).join("\n")).toContain("scripts/stage/core-stack.sh must be absent");
});

test("a caller that names core-stack.sh fails", () => {
  const root = tree({ "scripts/fusion/x.sh": "scripts/stage/core-stack.sh governance release\n" });
  expect(check(root).join("\n")).toContain("core-stack.sh shim");
});

test("core-stack.ts holding deploy logic fails", () => {
  const root = tree({ "scripts/stage/core-stack.ts": 'run("cast send 0x1");\n// cast send in a comment is fine\n' });
  expect(check(root).join("\n")).toContain("core-stack.ts");
});

test("the ban-list script may name the deleted paths", () => {
  const root = tree({ "scripts/ci/check-no-test-only-code.ts": 'const x = "scripts/stage/deploy-core-stack.sh";\n' });
  expect(check(root)).toEqual([]);
});

test("each deleted file fails when it comes back", () => {
  for (const f of ["scripts/stage/fusion-ceremony.sh", "scripts/stage/deploy-core-stack.sh", ".github/workflows/deploy-contracts.yml"]) {
    expect(check(tree({ [f]: "x" })).join("\n")).toContain(f);
  }
});

test("a Rust forge deployment in the harness fails", () => {
  const root = tree({ "testing/smoke-test/src/lib.rs": "fn run_forge_deploy_registry() {}\n" });
  expect(check(root).join("\n")).toContain("run_forge_deploy");
});

test("an empty tree scans zero files, and the CLI exits 1 because zero checks ran", () => {
  const root = tree({});
  expect(countScanned(root)).toBe(0);
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "check-deleted-stage-scripts.ts"), root], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toContain("zero checks ran");
});

test("a doc that describes the deleted deploy workflow as a gate fails", () => {
  const root = tree({ "docs/technical/security-model.md": "CI gate: .github/workflows/deploy-contracts.yml\n", "scripts/x.ts": "export {};\n" });
  expect(check(root).join("\n")).toContain("docs/technical/security-model.md");
});
