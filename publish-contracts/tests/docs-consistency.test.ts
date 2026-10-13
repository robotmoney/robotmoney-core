import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
function markdown(path: string): string[] {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (["docs/archive", "docs/code-review", "docs/audits.md"].includes(child)) return [];
    return entry.isDirectory() ? markdown(child) : entry.name.endsWith(".md") ? [child] : [];
  });
}
const files = [...markdown("docs"), ...markdown("plugins")];
const inv4 = read("docs/prd.md").split("**INV-4")[1].split("**INV-5")[0];

test("INV-4 names the weight setter and the Safe", () => {
  for (const name of ["WEIGHT_SETTER_ROLE", "TimelockController", "Safe"]) expect(inv4).toContain(name);
});

test("committee vote-submit is described as a signed tilt", () => {
  const mentions = files.filter((file) => read(file).includes("vote-submit"));
  expect(mentions.length).toBeGreaterThan(0);
  for (const file of mentions) {
    expect(read(file), file).toMatch(/signed\s+(?:allocation\s+)?tilt/);
    expect(read(file), file).not.toMatch(/vote-submit[^\n]*(?:casts?|submits?) a governance vote/i);
  }
});

test("no supersession trails", () => {
  for (const passage of [inv4, read("docs/technical/governance-decisions.md")]) {
    expect(passage).not.toMatch(/\b(?:superseded|amended|previously)\b/i);
  }
});

test("signals remain advisory until member authentication lands", () => {
  for (const file of ["docs/technical/governance-decisions.md", "docs/technical/consensus-receipt-submitter-runbook.md"]) {
    const text = read(file);
    expect(text).toContain("signals are advisory only");
    expect(text).toContain("does not authenticate the member until core issue 1790 lands");
    expect(text).toContain("caller bound and ADMIN released");
    expect(text).toContain("receipts are the only rebalance input");
  }
});
