// The docs name the apply-receipt govern row, its refusals, its 8453 on-demand use and what the Twin proves (issue 1696, issue 1698). Each phrase is asserted in BOTH docs,
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
  ["the effective weights read-back", /getEffectiveWeights\(\)/],
  ["never part of stage 13", /stage 13/],
  ["on 8453 only when named, own delay", /172800 s delay/],
  ["GOVERN_PENDING resume", /GOVERN_PENDING/],
  ["receipt_applications evidence", /receipt_applications/],
  ["the Twin proves execution only", /Twin proves execution only/],
  ["not evidence that mainnet governance works", /not evidence that mainnet governance works|not that mainnet governance works/],
  ["no vote", /no vote/i],
];

describe("docs mention the apply-receipt row (issue 1696, issue 1698)", () => {
  for (const [file, text] of Object.entries(DOCS)) {
    for (const [what, re] of PHRASES) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
  }
  test("the runbook names the open owner decision and the verifier label lives in the README", () => {
    expect(DOCS["docs/operations/contract-release-runbooks.md"]).toContain("open owner decision");
    expect(DOCS["publish-contracts/README.md"]).toContain("receipt: applied receipt is released and its weights are on the router");
  });
  // issue 1698: the pre-1698 shape (a two-call batch, setDefaultWeights as the weight change, the VOTED_WEIGHTS_ACTIVE refusal) is gone from both docs
  for (const [file, text] of Object.entries(DOCS)) {
    test(`${file} no longer describes the two-call batch or the voted-vector refusal`, () => {
      expect(text).not.toMatch(/VOTED_WEIGHTS_ACTIVE/);
      expect(text).not.toMatch(/setDefaultWeights\(vaults, bps\)` on today's bytecode/);
      expect(text).not.toMatch(/ONE `scheduleBatch`/);
    });
  }
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
    ["the ordering gap", /An apply-receipt operation scheduled before a pause-all can still execute after it/],
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

// QA plan v1 D7 (review E5, issue 1705 Q2): the emergency unwind guard row is documented in both docs, with the post-govern verify that needs it.
describe("docs mention the set-unwind-guard row (QA plan v1 D7)", () => {
  const P: [string, RegExp][] = [
    ["the row and its arguments", /--row set-unwind-guard --admin-arg vault=PROTO\|AGENT\|RWA --admin-arg token=0x<address>\|all --admin-arg min-usdc-out=N --admin-arg max-loss-bps=N/],
    ["the setter", /setEmergencyUnwindGuard\(token, minUsdcOut, overrideAllowed, maxLossBps\)/],
    ["the override default (Decisions D3)", /`override-allowed` defaults to true/],
    ["the evidence record", /unwind_guards/],
    ["the stage 13 sitting", /stage 13 sitting|same sitting as the stage 13 unpauses/],
  ];
  for (const [file, text] of Object.entries(DOCS)) for (const [what, re] of P) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
  test("the README names the verifier label", () => expect(DOCS["publish-contracts/README.md"]).toContain("emergencyUnwindGuard minUsdcOut above zero on every active asset of an open vault"));
  test("the runbook's post-govern verify step names the label", () => expect(DOCS["docs/operations/contract-release-runbooks.md"]).toContain("`vault[...]: emergencyUnwindGuard minUsdcOut above zero on every active asset of an open vault`"));
});

// QA plan v1 E3 (review QD-7, F2): the redeploy script's header cites a runbook section and README rows. Before, neither existed. Both docs now name the verb, the row,
// the seven-call batch with the cap call, the cap-parity verifier label and --prior-out, and the runbook section the header names is a real heading.
describe("docs the redeploy script header cites exist (QA plan v1 E3)", () => {
  const HEADER = readFileSync(join(ROOT, "contracts", "script", "RedeployProtocolAssetVault.s.sol"), "utf8").split("\n").slice(0, 5).join("\n");
  const P: [string, RegExp][] = [
    ["the verb", /redeploy-vault --vault PROTO|`--vault PROTO`/],
    ["the row", /govern --row redeploy-vault/],
    ["the cap call", /router\.setVaultCap\(new, vaultCap\(old\)\)/],
    ["the cap-parity label", /redeploy\[rmPROTO\]: router\.vaultCap\(new\) equals router\.vaultCap\(old\)/],
    ["--prior-out", /--prior-out/],
    ["the evidence cap field", /router_vault_cap/],
  ];
  for (const [file, text] of Object.entries(DOCS)) for (const [what, re] of P) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
  test("the header names the runbook section, and the runbook has it as a heading", () => {
    const cited = /contract-release-runbooks\.md\s+—\s+"([^"]+)"/.exec(HEADER)?.[1];
    expect(cited).toBe("Redeploy one vault into a live deployment");
    expect(DOCS["docs/operations/contract-release-runbooks.md"]).toMatch(new RegExp(`^###? [0-9.]* ?${cited}`, "m"));
  });
  test("the header names the README's verb and row, and the README has a row for each", () => {
    expect(HEADER).toContain("publish-contracts/README.md — the `redeploy-vault` verb and the `redeploy-vault` govern row");
    expect(DOCS["publish-contracts/README.md"]).toMatch(/^\| `redeploy-vault` \|/m);
    expect(DOCS["publish-contracts/README.md"]).toMatch(/^- \*\*`govern --row redeploy-vault`/m);
  });
});

// QA plan v1 E4 (issue 1816, review T7): the runbook claimed the gate ran on publish, prove-control and govern, and named a COUNTS_UNTRACKED kind, while the code gated
// `--stage plan` only. Both docs now name the broadcasting runs the gate covers, the exemptions and the committed-and-clean proof for a plain baseline, and drop the old claims.
describe("docs name the release gate on every broadcasting 8453 run (QA plan v1 E4)", () => {
  const P: [string, RegExp][] = [
    ["the plan", /QA plan v1 E4/],
    ["the broadcasting runs", /`prove-control`/],
    ["the govern verb", /`govern` verb \(every row/],
    ["the exemptions", /`pause-all`, `record-receipt` and a `--dry-run`|Exempt: a verify-only run, `pause-all`, `record-receipt`, a `--dry-run`/],
    ["a plain baseline is proven committed too", /a plain measured file (is held to this )?as well as a reconstructed one/],
  ];
  for (const [file, text] of Object.entries(DOCS)) for (const [what, re] of P) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
  for (const [file, text] of Object.entries(DOCS)) {
    test(`${file} no longer says only the plan is gated, nor names an error kind the code lacks`, () => {
      expect(text).not.toMatch(/Only the `plan` stage checks the tag/);
      expect(text).not.toMatch(/COUNTS_UNTRACKED/);
    });
  }
});
