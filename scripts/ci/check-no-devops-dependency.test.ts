// Unit test for scripts/ci/check-no-devops-dependency.ts: planted violations fail, clean and allowed text passes.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main, scan } from "./check-no-devops-dependency.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "no-devops-"));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const hitsOf = (files: Record<string, string>) => { const r = tree(files); try { return scan(r).hits; } finally { rmSync(r, { recursive: true, force: true }); } };

const VIOLATIONS: [string, string, string][] = [
  ["workflow checkout of devops", ".github/workflows/x.yml", "      - uses: actions/checkout@v4\n        with:\n          repository: robotmoney/devops\n"],
  ["DEVOPS_READ_TOKEN", ".github/workflows/y.yml", "          token: ${{ secrets.DEVOPS_READ_TOKEN }}\n"],
  ["PUBLISH_CONTRACTS_DIR in a script", "scripts/z.ts", "const d = process.env.PUBLISH_CONTRACTS_DIR;\n"],
  ["PUBLISH_CONTRACTS_DIR in a doc", "docs/a.md", "Set PUBLISH_CONTRACTS_DIR to the devops checkout.\n"],
  ["import into a devops checkout", "scripts/i.ts", 'import { x } from "../../devops/publish-contracts/src/x.ts";\n'],
  ["require of a devops path", "tests/r.js", 'const x = require("devops/src/x");\n'],
  ["relative path into devops in a test", "tests/p.test.ts", 'const p = join(root, "../devops/publish-contracts");\n'],
];

for (const [name, file, text] of VIOLATIONS) {
  test(`planted violation fails: ${name}`, () => {
    const h = hitsOf({ [file]: text });
    expect(h.length).toBeGreaterThan(0);
    expect(h[0]!.file).toBe(file);
  });
}

test("main exits 1 on a violation and 0 on a clean tree", () => {
  const bad = tree({ "scripts/a.ts": "// DEVOPS_READ_TOKEN\n" });
  const good = tree({ "scripts/a.ts": "// fine\n", "docs/b.md": "Devops checks core out at the deploy sha.\n" });
  const q = console.error, l = console.log; console.error = () => {}; console.log = () => {};
  try { expect(main(["--root", bad])).toBe(1); expect(main(["--root", good])).toBe(0); }
  finally { console.error = q; console.log = l; rmSync(bad, { recursive: true, force: true }); rmSync(good, { recursive: true, force: true }); }
});

test("a sentence saying devops checks core out is allowed", () => {
  expect(hitsOf({ "docs/a.md": "The dependency direction is devops to core only. Devops checks core out (robotmoney/devops is never read by core).\n" })).toEqual([]);
  expect(hitsOf({ "docs/a.md": "Devops checks core out, then runs the CLI.\n" })).toEqual([]);
});

test("the allowlisted ban-list files may name the strings", () => {
  expect(hitsOf({ "scripts/stage/check-deleted-stage-scripts.ts": "DEVOPS_READ_TOKEN PUBLISH_CONTRACTS_DIR robotmoney/devops\n" })).toEqual([]);
});

test("plain prose naming devops (a caller, a format) is not a violation", () => {
  expect(hitsOf({ "scripts/a.ts": "// devops publish contracts prints [verify]\n", "docs/a.md": "Devops calls this CLI.\n" })).toEqual([]);
});

test("an empty root scans zero files and exits 2", () => {
  const e = tree({});
  const q = console.error; console.error = () => {};
  try { expect(main(["--root", e])).toBe(2); } finally { console.error = q; rmSync(e, { recursive: true, force: true }); }
});

test("the real repo is clean", () => {
  const r = scan(join(import.meta.dir, "..", ".."));
  expect(r.scanned).toBeGreaterThan(50);
  expect(r.hits).toEqual([]);
});
