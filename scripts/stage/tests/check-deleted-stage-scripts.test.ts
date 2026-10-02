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

const SHIM = '#!/usr/bin/env bash\n# shim\nset -euo pipefail\nexec bun "$(dirname "$0")/core-stack.ts" "$@"\n';

test("a clean tree passes, core-stack.sh may exist as a one-screen shim that execs core-stack.ts", () => {
  const root = tree({ "scripts/stage/core-stack.sh": SHIM, "scripts/stage/core-stack.ts": "// verbs\nexport const x = 1;\n" });
  expect(check(root)).toEqual([]);
});

test("a long core-stack.sh fails: shell logic crept back", () => {
  const root = tree({ "scripts/stage/core-stack.sh": SHIM + "echo hi\n".repeat(30) });
  expect(check(root).join("\n")).toContain("shim");
});

test("a core-stack.sh that does not exec core-stack.ts fails", () => {
  const root = tree({ "scripts/stage/core-stack.sh": "#!/usr/bin/env bash\necho hi\n" });
  expect(check(root).join("\n")).toContain("must exec core-stack.ts");
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

test("core-stack.sh holding deploy logic fails", () => {
  const root = tree({ "scripts/stage/core-stack.sh": "forge script contracts/script/Deploy.s.sol\n" });
  expect(check(root).join("\n")).toContain("core-stack.sh");
});
