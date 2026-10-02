import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../check-deleted-stage-scripts.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

test("a clean tree passes, core-stack.sh may exist as a boot and health wrapper", () => {
  const root = tree({ "scripts/stage/core-stack.sh": "#!/usr/bin/env bash\n# deploys via publish contracts\nbun cli.ts publish\n" });
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

test("core-stack.sh holding deploy logic fails", () => {
  const root = tree({ "scripts/stage/core-stack.sh": "forge script contracts/script/Deploy.s.sol\n" });
  expect(check(root).join("\n")).toContain("core-stack.sh");
});
