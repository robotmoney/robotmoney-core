// Drift test for scripts/runbook/validate-contract-qa.ts: the committed contract QA runbook is clean, and each planted drift fails.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_DIR, ROOT, loadModel, parseSheetText, runnableProblems, sheetProblems, validateAll } from "./validate-contract-qa.ts";

const model = loadModel(ROOT);
const RELEASE = "releases/v0.5.0.yaml";

/** A copy of docs/runbooks/contract-qa/ in a temp root, with one file rewritten; returns the problems the validator reports. */
function problemsWith(file: string, edit: (text: string) => string): string[] {
  const root = mkdtempSync(join(tmpdir(), "contract-qa-"));
  try {
    cpSync(join(ROOT, QA_DIR), join(root, QA_DIR), { recursive: true });
    for (const d of ["publish-contracts", "scripts", "deployments"]) cpSync(join(ROOT, d), join(root, d), { recursive: true, filter: (s) => !s.includes("node_modules") });
    const p = join(root, QA_DIR, file);
    writeFileSync(p, edit(readFileSync(p, "utf8")));
    return validateAll(root, model).problems;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
/** The text of one step block: from its `- id:` line to the next step. */
const stepBlock = (text: string, id: string): string => new RegExp(`  - id: "${id}"\\n(?:(?!  - id: ).*\\n?)*`).exec(text)![0];
/** A release file as the release being prepared: no templateSha pin, so the add-only check applies. */
const unpinned = (text: string): string => text.replace(/^templateSha: .*\n/m, "");

test("the committed template and release runbooks are clean", () => {
  const all = validateAll(ROOT, model);
  expect(all.problems).toEqual([]);
  expect(all.releases.has("v0.4.0")).toBe(true);
  expect(all.releases.has("v0.5.0")).toBe(true);
});

test("an unpinned release that drops a template step fails", () => {
  const p = problemsWith(RELEASE, (t) => unpinned(t).replace(stepBlock(t, "P0.04-checkout"), ""));
  expect(p.length).toBeGreaterThan(0);
  expect(p.join("\n")).toContain("P0.04-checkout");
});

test("an unpinned release that edits a template step fails", () => {
  const p = problemsWith(RELEASE, (t) => unpinned(t).replace(stepBlock(t, "P0.04-checkout"), (b) => b.replace("The core checkout is clean", "The core checkout")));
  expect(p.join("\n")).toContain("P0.04-checkout");
});

test("the template can change while every committed release is pinned", () => {
  const p = problemsWith("template.yaml", (t) => t.replace(stepBlock(t, "P0.04-checkout"), (b) => b.replace("The core checkout is clean", "The core checkout")));
  expect(p).toEqual([]);
});

test("a pinned release that edits a template step fails against the template at its pin", () => {
  const p = problemsWith(RELEASE, (t) => t.replace(stepBlock(t, "P0.04-checkout"), (b) => b.replace("The core checkout is clean", "The core checkout")));
  expect(p.join("\n")).toContain("P0.04-checkout");
});

test("a pinned release that drops a template step fails against the template at its pin", () => {
  const p = problemsWith(RELEASE, (t) => t.replace(stepBlock(t, "P0.04-checkout"), ""));
  expect(p.join("\n")).toContain("P0.04-checkout");
});

test("a templateSha with no template in git fails", () => {
  const p = problemsWith(RELEASE, (t) => t.replace(/^templateSha: .*$/m, "templateSha: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
  expect(p.join("\n")).toContain("has no docs/runbooks/contract-qa/template.yaml in git");
});

test("a templateSha that is not a full commit fails", () => {
  const p = problemsWith(RELEASE, (t) => t.replace(/^templateSha: .*$/m, "templateSha: e362df0c"));
  expect(p.join("\n")).toContain("templateSha is the full 40-character commit");
});

test("a sheet value read before the run sheet is written fails", () => {
  const p = problemsWith("template.yaml", (t) => t.replace(stepBlock(t, "P0.04-checkout"), (b) => `${b}    env:\n      X: "{sheet:TIMELOCK_MIN_DELAY}"\n`));
  expect(p.join("\n")).toContain("is read before any step writes the run sheet");
});

test("a command that names a verb no CLI has fails", () => {
  const p = problemsWith("template.yaml", (t) => t.replace(stepBlock(t, "P2.01-verify-pre-govern"), (b) => b.replace('"publish-contracts/src/cli.ts", "verify"', '"publish-contracts/src/cli.ts", "no-such-verb"')));
  expect(p.join("\n")).toContain("P2.01-verify-pre-govern");
});

test("a planted credential fails", () => {
  const p = problemsWith("template.yaml", (t) => `${t}\n# api_key: abcdefghijklmnop1234\n`);
  expect(p.join("\n")).toContain("a credential assignment");
});

test("a production run refuses while an owner decision is open", () => {
  const r = validateAll(ROOT, model).releases.get("v0.5.0")!;
  expect(runnableProblems(r, "twin")).toEqual([]);
  expect(runnableProblems(r, "rehearsal")).toEqual([]);
  expect(runnableProblems(r, "production").length).toBeGreaterThan(0);
  expect(runnableProblems(r, "mainnet")[0]).toContain("--target is");
});

const TWIN_SHEET = `
CHAIN_ID=918453
EXPECTED_CHAIN_ID=918453
DEPLOYMENT_KIND=twin
TIMELOCK_MIN_DELAY=60
SEED_DEPOSIT_USDC=1000000
VAULT_USDC_TVL_CAP=100000000000
VAULT_USDC_PER_DEPOSIT_CAP=10000000000
VAULT_PROTO_TVL_CAP=100000000000
VAULT_PROTO_PER_DEPOSIT_CAP=10000000000
VAULT_AGENT_TVL_CAP=100000000000
VAULT_AGENT_PER_DEPOSIT_CAP=10000000000
VAULT_RWA_TVL_CAP=100000000000
VAULT_RWA_PER_DEPOSIT_CAP=10000000000
UPGRADE_MODE=upgradeable
SAFE_OWNERS=0x01,0x02,0x03
SAFE_THRESHOLD=2
`;

test("a sheet for the wrong chain or a bad seed fails", () => {
  const wrongChain = sheetProblems(parseSheetText(TWIN_SHEET.replace("CHAIN_ID=918453\nEXPECTED", "CHAIN_ID=1\nEXPECTED")), "twin");
  expect(wrongChain.join("\n")).toContain("CHAIN_ID");
  const badSeed = sheetProblems(parseSheetText(TWIN_SHEET.replace("SEED_DEPOSIT_USDC=1000000", "SEED_DEPOSIT_USDC=5")), "twin");
  expect(badSeed.join("\n")).toContain("SEED_DEPOSIT_USDC");
});

test("an 8453 sheet needs an owner signer for every sheet owner", () => {
  const p = sheetProblems(parseSheetText(TWIN_SHEET), "rehearsal");
  expect(p.join("\n")).toContain("--owner-signers");
});
