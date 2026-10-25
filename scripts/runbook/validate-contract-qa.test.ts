// Drift test for scripts/runbook/validate-contract-qa.ts: the committed contract QA runbook is clean, and each planted drift fails.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_DIR, ROOT, loadModel, parseSheetText, runnableProblems, sheetProblems, unwindGuardProblems, validateAll } from "./validate-contract-qa.ts";

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

test("a three-vault sheet (USDC, PROTO, RWA, no AGENT cap) passes on the twin target (issue 1916)", () => {
  const real = parseSheetText(readFileSync(join(ROOT, "deployments", "twin-918453", "stage-sheet.env"), "utf8"));
  expect(sheetProblems(real, "twin", 0)).toEqual([]);
  expect(sheetProblems(parseSheetText(TWIN_SHEET), "rehearsal", 3).filter((x) => x.includes("_CAP is missing"))).toEqual([]);
});

test("a sheet missing a USDC, PROTO or RWA cap fails, and an AGENT cap is no longer required (issue 1916)", () => {
  for (const k of ["USDC", "PROTO", "RWA"]) {
    for (const n of ["TVL_CAP", "PER_DEPOSIT_CAP"]) {
      const p = sheetProblems(parseSheetText(TWIN_SHEET.replace(new RegExp(`^VAULT_${k}_${n}=.*\\n`, "m"), "")), "rehearsal", 3);
      expect(p.join("\n")).toContain(`sheet: VAULT_${k}_${n} is missing`);
    }
  }
  expect(sheetProblems(parseSheetText(TWIN_SHEET), "rehearsal", 3).join("\n")).not.toContain("AGENT_");
});

test("an 8453 sheet needs an owner signer for every sheet owner", () => {
  const p = sheetProblems(parseSheetText(TWIN_SHEET), "rehearsal");
  expect(p.join("\n")).toContain("--owner-signers");
});

// Issue 1892: the gateway system has its own runbook (gateway.yaml). It is checked against the real CLIs, and it is the gateway system's: --system gateway, no vaults-only verb,
// no owner signer, no agent, and a publish that is irreversible and waits for the owner's governance decision (architecture 10: open).
test("the gateway runbook is committed, is a separate template and publishes only behind the owner's governance decision", () => {
  const text = readFileSync(join(ROOT, QA_DIR, "gateway.yaml"), "utf8");
  expect(text).toContain("template: contract-qa-gateway");
  expect(text).toContain('go: "gateway-governance"');
  expect(text).toContain("--system gateway");
  expect(readFileSync(join(ROOT, QA_DIR, "template.yaml"), "utf8")).not.toContain("--system gateway");
  for (const r of ["v0.4.0", "v0.5.0"]) expect(readFileSync(join(ROOT, QA_DIR, `releases/${r}.yaml`), "utf8")).not.toContain("--system gateway");
});

test("a gateway runbook step that runs a vaults-only verb, an owner signer, a control proof or an agent fails", () => {
  const swap = (from: string, to: string) => problemsWith("gateway.yaml", (t) => t.replace(from, to)).join("\n");
  expect(swap('"verify", "{gcommon}", "{gate}"]\n    env:\n      PUBLISH_MANIFEST_DIR: "{manifestDir}"\n    expectExit: 0\n    receipts:\n      - {"dir": "{runDir}/evidence-gateway"', '"govern", "{gcommon}", "{gate}"]\n    env:\n      PUBLISH_MANIFEST_DIR: "{manifestDir}"\n    expectExit: 0\n    receipts:\n      - {"dir": "{runDir}/evidence-gateway"')).toContain("vaults-only verb");
  expect(swap('"publish", "{gcommon}", "{gate}"]', '"publish", "{gcommon}", "{gate}", "--owner-signer", "{ownerSigner}"]')).toContain("no Safe owner signer");
  expect(swap('"publish", "{gcommon}", "--dry-run"]', '"publish", "{gcommon}", "--dry-run", "--stage", "prove-control"]')).toContain("no control proof");
  expect(swap("echo 'AGENT_ADDRESSES=0x000000000000000000000000000000000000a0aa'", "export AGENT_ADDRESSES=0x000000000000000000000000000000000000a0aa")).toContain("authorizes no agent");
});

test("a gateway publish with no owner decision gate, or not marked irreversible, fails; a gateway command without --system gateway fails", () => {
  const gated = problemsWith("gateway.yaml", (t) => t.replace('    go: "gateway-governance"\n', "")).join("\n");
  expect(gated).toContain("irreversible step needs notBefore");
  const flag = problemsWith("gateway.yaml", (t) => t.replace('"verify", "{gcommon}", "{gate}"]', '"verify", "--chain", "{chainId}", "--rpc", "{rpcUrl}", "--sheet", "{gatewaySheet}", "--signer", "{signer}", "--environment", "{environmentName}", "--core-sha", "{coreSha}", "--counts-dir", "{countsDir}", "{gate}"]')).join("\n");
  expect(flag).toContain("names --system gateway");
  const missing = problemsWith("gateway.yaml", (t) => t.replace("--system gateway --dry-run", "--dry-run")).join("\n");
  expect(missing).toContain("names --system gateway");
  expect(problemsWith("gateway.yaml", (t) => t.replace("contract-qa-gateway", "contract-qa")).join("\n")).toContain("names itself contract-qa");
});

test("a CLI flag the gateway runbook uses that the CLI does not have fails", () => {
  expect(problemsWith("gateway.yaml", (t) => t.replace('"publish", "{gcommon}", "{gate}"]', '"publish", "{gcommon}", "{gate}", "--system-two", "x"]')).join("\n")).toContain("--system-two is no publish-contracts flag");
});

const unwindRounds = (r: { steps: { cmds?: string[][] }[] }): number => r.steps.flatMap((s) => s.cmds ?? []).filter((c) => c.includes("set-unwind-guard")).length;

test("the committed v0.6.0 runbook sets the unwind guard on rmPROTO and rmRWA only", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  expect(unwindRounds(r)).toBe(4);
  expect(unwindGuardProblems(r)).toEqual([]);
  const cmds = r.steps.flatMap((s) => s.cmds ?? []).filter((c) => c.includes("set-unwind-guard")).map((c) => c.join(" "));
  expect(cmds.some((c) => c.includes("vault=AGENT"))).toBe(false);
  const ids = r.steps.map((s) => s.id);
  expect(ids.indexOf("P3.51-unwind-guard-schedule")).toBeLessThan(ids.indexOf("P3.52-unwind-guard-execute"));
  expect(ids.indexOf("P3.52-unwind-guard-execute")).toBeLessThan(ids.indexOf("P4.01-verify-post-govern"));
});

test("a v0.6.0 yaml with an open basket vault and no set-unwind-guard step fails", () => {
  const p = problemsWith("releases/v0.6.0.yaml", (t) => t.replace(stepBlock(t, "P3.51-unwind-guard-schedule"), "").replace(stepBlock(t, "P3.52-unwind-guard-execute"), ""));
  const text = p.join("\n");
  expect(text).toContain("vault (PROTO) has no set-unwind-guard step");
  expect(text).toContain("vault (RWA) has no set-unwind-guard step");
});

test("a v0.6.0 yaml that guards only rmPROTO fails for rmRWA", () => {
  const p = problemsWith("releases/v0.6.0.yaml", (t) => t.replace(/.*vault=RWA.*\n/g, ""));
  expect(p.join("\n")).toContain("vault (RWA) has no set-unwind-guard step");
});

// Issue 1927: the v0.6.0 yaml rehearses runbook 4.15 on the Twin from a real v0.5.0 deployment. Its added steps run the 4.15 publish-contracts commands, in order, as the runbook
// spells them (UPGRADE_FROM_V050_COMMANDS, which upgrade-runbook-drift.test.ts holds equal to the runbook), each with expectExit 0. The 4.15 names map to the yaml's placeholders.
test("the committed v0.6.0 runbook runs the runbook 4.15 commands against the v0.5.0 deployment, in order, each with expectExit 0", async () => {
  const { UPGRADE_FROM_V050_COMMANDS, V050_SHA } = await import("../../publish-contracts/src/ci/upgrade-from-v050-commands.ts");
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const NAMES: Record<string, string> = {
    "$PWD": ".", "$GATEWAY_IMPL": "{state:v050-gateway-impl}", "$RECEIPT_IMPL": "{state:v050-receipt-impl}", "$RMAGENT": "{state:v050-rmagent}", "$TIMELOCK": "{state:v050-timelock}",
    "$GOVERNANCE": "{state:v050-governance}", "$REGISTRY": "{state:v050-registry}", "$EVIDENCE": "{runDir}/v050-run/evidence", "$BASE_RPC_URL": "{v050RpcUrl}",
  };
  const toYaml = (line: string): string[] => [...line.matchAll(/"([^"]*)"|(\S+)/g)].flatMap((m) => {
    const tok = m[1] ?? m[2]!;
    if (m[2] === "$COMMON") return ["{v050common}", "{gate}"];
    return [tok.replace(/\$[A-Z_0-9]+/g, (n) => { if (!(n in NAMES)) throw new Error(`no yaml name for ${n}`); return NAMES[n]!; })];
  });
  const added = r.steps.filter((s) => s.added === "v0.6.0" && s.phase === 8);
  expect(added.length).toBeGreaterThanOrEqual(UPGRADE_FROM_V050_COMMANDS.length);
  let from = 0;
  for (const line of UPGRADE_FROM_V050_COMMANDS) {
    const want = JSON.stringify(toYaml(line));
    const at = added.findIndex((s, i) => i >= from && s.cmds.some((c) => JSON.stringify(c) === want));
    expect(at, line).toBeGreaterThanOrEqual(from);
    const s = added[at]!;
    expect(s.expectExit, `${s.id}: ${line}`).toBe(0);
    expect(s.onlyFor, s.id).toBe("twin");
    from = at;
  }
  // the v0.5.0 publish is the tag's own CLI and sheet at the fixed pin, with the unlowered rmAGENT pool floor, and {v050common} names the v0.5.0 checkout and its sha
  const publish = added.find((s) => s.id === "P8.03-v050-publish")!;
  expect(publish.cmds[0]).toEqual(["bun", "{runDir}/v050/publish-contracts/src/ci/twin-publish.ts"]);
  expect(publish.env).toMatchObject({ GITHUB_WORKSPACE: "{runDir}/v050", PIN_BLOCK_IN: "52881000", REHEARSAL_IN: "true", SHEET_OVERLAY_IN: "deployments/twin-918453/upgrade-rehearsal.env" });
  expect(publish.cmds[1]!.join(" ")).toContain("VAULT_AGENT_MIN_POOL_LIQUIDITY=1000000000000000");
  expect(added.find((s) => s.id === "P8.02-v050-twin-fork")!.cmds[0]).toContain("52881000");
  const { LIST_PLACEHOLDERS } = await import("./validate-contract-qa.ts");
  const common = LIST_PLACEHOLDERS.v050common!;
  expect(common[common.indexOf("--core-dir") + 1]).toBe("{runDir}/v050");
  expect(common[common.indexOf("--core-sha") + 1]).toBe(V050_SHA);
  expect(added.find((s) => s.id === "P8.01-v050-checkout")!.cmds.flat().join(" ")).toContain(V050_SHA);
});
