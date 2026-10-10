// Issue 1727: the docs name the rehearsal kind, how it is selected, what it records, the per-row decisions, the funding and the owner question. A rewrite that drops one fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";

const ROOT = join(import.meta.dir, "..", "..");
const RUNBOOK = readFileSync(join(ROOT, "docs", "operations", "contract-release-runbooks.md"), "utf8");
const README = readFileSync(join(ROOT, "publish-contracts", "README.md"), "utf8");

const BOTH: [string, RegExp][] = [
  ["the sheet line", /DEPLOYMENT_KIND=rehearsal/], ["900 s", /900/], ["the tag kind", /release\/<version>-rehearsal/], ["the tag error", /RELEASE_TAG_KIND/],
  ["the start nonce", /deployerStartNonce/], ["the Safe salt refusal", /SAFE_SALT_NONCE_REUSED/], ["register-committee", /register-committee/], ["record-receipt", /record-receipt/],
];
const RUNBOOK_ONLY: [string, RegExp][] = [
  ["the production floor is unchanged", /172800/], ["funding ETH", /0\.00237 ETH/], ["funding USDC", /5 USDC/], ["the owner question on the submitter key", /OWNER QUESTION/],
  ["the per-row table", /\| `batch` \| yes, explicit `--row`/], ["no fixture", /no fixture|REAL/], ["rmpc refuses a software signer on 8453", /ErrProductionSignerRequired/], ["libs adoption", /effectiveCounts/],
  ["explicit selection, never default", /nothing selects it by default/],
];
describe("docs for the rehearsal kind (issue 1727)", () => {
  for (const [what, re] of BOTH) { test(`the runbook documents ${what}`, () => expect(RUNBOOK).toMatch(re)); test(`the README documents ${what}`, () => expect(README).toMatch(re)); }
  for (const [what, re] of RUNBOOK_ONLY) test(`the runbook documents ${what}`, () => expect(RUNBOOK).toMatch(re));
  test("the exit code of the tag kind refusal is documented as it is coded", () => {
    expect(EXIT_CODES.RELEASE_TAG_KIND).toBe(28);
    expect(README).toContain("release tag kind 28");
  });
});

// Issue 1750: the submitter is a multisig. The three docs say so, plainly, and name the owner-key overlap.
const SUBMITTER_RUNBOOK = readFileSync(join(ROOT, "docs", "technical", "consensus-receipt-submitter-runbook.md"), "utf8");
describe("docs for the multisig submitter (issue 1750)", () => {
  const ALL: [string, RegExp][] = [
    ["a multisig, no single key", /no single key/], ["the owner decision date", /2026-10-10/], ["SafeL2 1.4.1", /SafeL2 1\.4\.1/], ["the submitter flag", /--submitter/],
    ["the same owner keys control both Safes", /same three owner keys control BOTH Safes/], ["the separation is the multisig and the nonces", /nonce/], ["the deployer pays gas", /gas/],
  ];
  for (const [what, re] of ALL) {
    test(`the submitter runbook documents ${what}`, () => expect(SUBMITTER_RUNBOOK).toMatch(re));
    test(`the release runbook documents ${what}`, () => expect(RUNBOOK).toMatch(re));
  }
  for (const [what, re] of ALL.slice(0, 5)) test(`the README documents ${what}`, () => expect(README).toMatch(re));
});
