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

// Issue 1988: both docs state that nothing clears the active vector and that a newer receipt replaces it; neither documents a clear row (issue 1743 removed).
describe("docs state that the active vector is never cleared and a newer receipt replaces it (issue 1988, issue 1698)", () => {
  const P: [string, RegExp][] = [
    ["the rule", /The active vector is never cleared \(issue 1988/],
    ["the recovery path", /replaced by a newer receipt/],
    ["an active vector does not block apply-receipt", /An active vector already in effect does not block the row: `applyReceipt` overwrites it\./],
    ["the effective weights read-back", /getEffectiveWeights\(\)/],
    ["the historical evidence list", /voted_weights_clears/],
    ["the verifier labels", /router: votedWeightsActive is false after deploy/],
  ];
  for (const [file, text] of Object.entries(DOCS)) {
    for (const [what, re] of P) test(`${file} documents ${what}`, () => expect(text).toMatch(re));
    test(`${file} documents no clear row`, () => {
      expect(text).not.toMatch(/govern --row clear-voted-weights/);
      expect(text).not.toMatch(/RouterGovernance\.clearVotedWeights\(\)/);
    });
  }
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
    ["the cap-parity label", /redeploy\[rmPROTO\]: router per-address cap equals approved old cap/],
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

// Issue 1831: the CLI help describes apply-receipt as the one RouterGovernance.applyReceipt call, and architecture 4.9 names both receipt ADMIN_ROLE holders.
describe("the CLI help and architecture 4.9 describe the one-call apply and both receipt ADMIN_ROLE holders (issue 1831)", () => {
  test("the cli.ts USAGE text for apply-receipt names RouterGovernance.applyReceipt and not ONE timelock batch", async () => {
    const { USAGE } = await import("../src/cli.ts");
    const start = USAGE.indexOf("--row apply-receipt --receipt-id");
    expect(start).toBeGreaterThan(0);
    const paragraph = USAGE.slice(start, USAGE.indexOf("--row retire-vault", start));
    expect(paragraph).toContain("RouterGovernance.applyReceipt");
    expect(paragraph).not.toContain("ONE timelock batch");
    expect(paragraph).toContain("lastAppliedRecordedAt");
    expect(paragraph).toMatch(/--row release-receipt .*is refused with USAGE/);
  });
  // Owner decision 2026-10-20: RouterGovernance holds a narrow release role on the receipt; the receipt ADMIN_ROLE stays with the timelock alone.
  test("docs/architecture.md section 4.9 gives RouterGovernance a release role and the timelock alone the receipt ADMIN_ROLE", () => {
    const arch = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");
    const s49 = arch.slice(arch.indexOf("### 4.9 "), arch.indexOf("\n## 5. "));
    expect(s49.length).toBeGreaterThan(0);
    expect(s49).not.toContain("exactly one holder");
    expect(s49).not.toContain("has two holders");
    expect(s49).toContain("RECEIPT_RELEASER_ROLE");
    expect(s49).toContain("held by the `TimelockController` alone");
    expect(s49).toContain("ReceiptNotNewerThanApplied");
    expect(s49).toMatch(/`release-receipt` is refused with USAGE/);
  });
});

// Issue 1861: the prolonged upstream outage path is named in the release runbook and the Twin fork README, and filter=latest is described as the API default pinned explicitly.
describe("the prolonged upstream outage path and the filter=latest wording (issue 1861)", () => {
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
  test("the runbook and README-twin-fork name another provider, then Re-run all jobs on WARN: STALE PIN", () => {
    for (const [f, text] of [["contract-release-runbooks.md", read("docs", "operations", "contract-release-runbooks.md")], ["README-twin-fork.md", read("scripts", "devnet", "README-twin-fork.md")]] as const) {
      expect(text, f).toMatch(/point the `BASE_UPSTREAM_RPC`\s+secret at another provider and re-run the failed job/);
      expect(text, f).toMatch(/If the re-run logs `WARN: STALE PIN`[^.]*, use \*\*Re-run all jobs\*\* so the pin job picks a fresh block/);
    }
  });
  test("ci-suites.md and check-sha-green.ts say filter=latest is pinned explicitly (the API default), not the change that makes re-runs recover", () => {
    const ci = read("docs", "development", "ci-suites.md");
    const gate = read("scripts", "ci", "check-sha-green.ts");
    for (const [f, text] of [["ci-suites.md", ci], ["check-sha-green.ts", gate]] as const) {
      expect(text, f).toMatch(/filter=latest[^\n]{0,160}pinned explicitly|pinned explicitly[^\n]{0,160}filter=latest/);
      expect(text, f).toContain("API default");
    }
    expect(ci).not.toContain("`filter=latest` (issue 1846) returns");
  });
});
