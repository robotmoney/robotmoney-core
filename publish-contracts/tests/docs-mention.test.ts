// The docs name the apply-receipt govern row, its refusals, its 8453 on-demand use and what the Twin proves (issue 1696). Each phrase is asserted in BOTH docs,
// so a rewrite that drops one fails here. The behaviour itself is tested in govern.test.ts and evidence-check.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = {
  "publish-contracts/README.md": readFileSync(join(ROOT, "publish-contracts", "README.md"), "utf8"),
  "docs/operations/contract-release-runbooks.md": readFileSync(join(ROOT, "docs", "operations", "contract-release-runbooks.md"), "utf8"),
};

const PHRASES: [string, RegExp][] = [
  ["the row and its arguments", /--row apply-receipt --receipt-id 0x<bytes32> --payload FILE/],
  ["one timelock call (issue 1698)", /ONE timelock call/],
  ["the weight setter's applyReceipt", /applyReceipt\(receiptId, payloadDigest, vaults, bps\)/],
  ["the digest refusal", /keccak256/],
  ["the sum refusal", /10000 bps/],
  ["the vault set refusal", /router-eligible vaults/],
  ["the order refusal", /registry order/],
  ["refusals exit USAGE and send nothing", /USAGE/],
  ["the read-back fails GOVERN", /GOVERN/],
  ["never part of stage 13", /stage 13/],
  ["on 8453 only when named, own delay", /172800 s delay/],
  ["GOVERN_PENDING resume", /GOVERN_PENDING/],
  ["receipt_applications evidence", /receipt_applications/],
  ["the Twin proves execution only", /Twin proves execution only/],
  ["not evidence that mainnet governance works", /not evidence that mainnet governance works|not that mainnet governance works/],
  ["no vote", /no vote/i],
];

describe("docs mention the apply-receipt row (issue 1696)", () => {
  for (const [file, text] of Object.entries(DOCS)) {
    for (const [what, re] of PHRASES) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
  }
  test("the runbook names the open owner decision and the verifier label lives in the README", () => {
    expect(DOCS["docs/operations/contract-release-runbooks.md"]).toContain("open owner decision");
    expect(DOCS["publish-contracts/README.md"]).toContain("receipt: applied receipt is released and its weights are on the router");
  });
});

// Issue 1743: the clear row is documented in both docs, and that an active vector does not block apply-receipt (issue 1698).
describe("docs mention the clear-voted-weights row and that applyReceipt overwrites an active vector (issue 1743, issue 1698)", () => {
  const P: [string, RegExp][] = [
    ["the row", /--row clear-voted-weights/],
    ["the single call", /RouterGovernance\.clearVotedWeights\(\)/],
    ["the role", /ADMIN_ROLE/],
    ["an active vector does not block the row", /An active vector already in effect does not block the row: `applyReceipt` overwrites it\./],
    ["the effective weights read-back", /getEffectiveWeights\(\)/],
    ["the evidence list", /voted_weights_clears/],
    ["the verifier labels", /router: votedWeightsActive is false after deploy/],
    ["no contract change", /No contract change/i],
    ["the live-router 0 bps leg warning (issue 1746)", /NEVER run clear-voted-weights on the LIVE 8453 router/],
  ];
  for (const [file, text] of Object.entries(DOCS)) for (const [what, re] of P) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
});

// Issue 1701: the two causes of exit 25 and the apply-receipt versus pause-all ordering gap are documented in both docs.
describe("docs name both causes of exit 25 and the apply-receipt ordering gap (issue 1701)", () => {
  const P: [string, RegExp][] = [
    ["the ordering gap", /An apply-receipt batch scheduled before a pause-all can still execute after it/],
    ["the pause check that ignores it", /`refuseIfPausedSince`.{0,60}ignores every row that is not an unpause/],
    ["exit 25: a vault not confirmed paused", /details\.unpaused/],
    ["exit 25: a pause not recorded", /details\.manifest_recorded: false/],
  ];
  for (const [file, text] of Object.entries(DOCS)) for (const [what, re] of P) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
  test("the README exit-code text lists both causes of 25", () => {
    const readme = DOCS["publish-contracts/README.md"];
    expect(readme).toContain("Exit 25 (`PAUSE`) has two causes");
    expect(readme).not.toContain("A vault not confirmed paused exits 25.");
    expect(readme.match(/pause not confirmed or not recorded 25/g)?.length).toBe(2);
  });
});
