// Drift test for scripts/runbook/validate-contract-qa.ts: the committed contract QA runbook is clean, and each planted drift fails.
import { expect, test } from "bun:test";
import { clearVectorProblems } from "./validate-contract-qa.ts";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FUND_MANIFEST_FILES, FUND_SHEET, FUND_VAULT_MANIFESTS, QA_DIR, ROOT, applicableSteps, commandProblems, isFundSheet, loadModel, parseRelease, parseSteps, localForkProblems, stateSelfReadProblems, qaSupersetProblems, recordStepProblems, sends, parseSheetText, runnableProblems, sheetProblems, gateAbsentPaths, mainOutProblems, rebalanceRoundProblems, keeperGasProblems, holdWaitProblems, fundExecuteProblems, unwindGuardProblems, upgradeBuildGateProblems, validateAll } from "./validate-contract-qa.ts";

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

test("the template can change while every committed release is pinned; only the unpinned release being prepared must follow it", () => {
  const p = problemsWith("template.yaml", (t) => t.replace(stepBlock(t, "P0.04-checkout"), (b) => b.replace("The core checkout is clean", "The core checkout")));
  const pinned = [...validateAll(ROOT, model).releases.values()].filter((r) => r.templateSha !== undefined).map((r) => r.release);
  expect(pinned.length).toBeGreaterThan(0);
  for (const r of pinned) expect(p.filter((x) => x.includes(`runbook ${r}`) || x.includes(`releases/${r}.yaml`))).toEqual([]);
  // every problem names a release being prepared (unpinned): Deploy 4's v0.7.0-onevault copies the current template, so the edit is refused there
  const unpinnedReleases = [...validateAll(ROOT, model).releases.values()].filter((r) => r.templateSha === undefined).map((r) => r.release);
  expect(unpinnedReleases).toContain("v0.7.0-onevault");
  expect(unpinnedReleases).toContain("v0.8.0-onevault");
  expect(p.length).toBeGreaterThan(0);
  expect(p.every((x) => unpinnedReleases.some((r) => x.includes(`runbook ${r}`) || x.includes(`releases/${r}.yaml`)))).toBe(true);
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

test("a step that sends a cast-send.sh receipt to /dev/null fails: the sign-off would flag its transaction as sent outside the runbook", () => {
  const p = problemsWith("releases/v0.6.0.yaml", (t) => t.replace(stepBlock(t, "P8.31-v050-gateway-deposit-vaults"), (b) => b.replace("500000 {v050CastFlagsInline} || exit 1", "500000 {v050CastFlagsInline} > /dev/null || exit 1")));
  expect(p.join("\n")).toContain("P8.31-v050-gateway-deposit-vaults: a cast-send.sh receipt is sent to /dev/null");
  expect(problemsWith("releases/v0.6.0.yaml", (t) => t.replace(stepBlock(t, "P8.31-v050-gateway-deposit-vaults"), (b) => b.replace("500000 {v050CastFlagsInline} || exit 1", "500000 {v050CastFlagsInline} 2> /dev/null || exit 1")))).toEqual([]);
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
    "$PWD": "{runDir}/v060", "$GATEWAY_IMPL": "{state:v050-gateway-impl}", "$RECEIPT_IMPL": "{state:v050-receipt-impl}", "$RMAGENT": "{state:v050-rmagent}", "$TIMELOCK": "{state:v050-timelock}",
    "$GOVERNANCE": "{state:v050-governance}", "$REGISTRY": "{state:v050-registry}", "$EVIDENCE": "{v050EvidenceDir}", "$BASE_RPC_URL": "{v050RpcUrl}",
  };
  const toYaml = (line: string): string[] => [...line.matchAll(/"([^"]*)"|(\S+)/g)].flatMap((m) => {
    const tok = m[1] ?? m[2]!;
    if (m[2] === "$COMMON") return ["{v050common}", "{gate}"];
    return [tok.replace(/\$[A-Z_0-9]+/g, (n) => { if (!(n in NAMES)) throw new Error(`no yaml name for ${n}`); return NAMES[n]!; })];
  });
  const added = r.steps.filter((s) => s.added === "v0.6.0" && s.phase === 8);
  expect(added.length).toBeGreaterThanOrEqual(UPGRADE_FROM_V050_COMMANDS.length);
  let from = 0;
  // issue 1980 (owner decision): the runbook never clears the router's voted vector, so the yaml runs every 4.15 command but the clear, and never the clear
  const CLEAR = "govern --row clear-voted-weights";
  expect(UPGRADE_FROM_V050_COMMANDS.filter((l) => l.includes(CLEAR))).toHaveLength(1);
  expect(added.some((s) => s.cmds.some((c) => c.join(" ").includes(CLEAR)))).toBe(false);
  for (const line of UPGRADE_FROM_V050_COMMANDS.filter((l) => !l.includes(CLEAR))) {
    const want = JSON.stringify(toYaml(line));
    const at = added.findIndex((s, i) => i >= from && s.cmds.some((c) => JSON.stringify(c) === want));
    expect(at, line).toBeGreaterThanOrEqual(from);
    const s = added[at]!;
    expect(s.expectExit, `${s.id}: ${line}`).toBe(0);
    expect(s.onlyFor, s.id).toEqual(["twin", "rehearsal"]);
    expect(s.flow, s.id).toBe("upgrade");
    from = at;
  }
  // the v0.5.0 publish is the tag's own CLI and sheet at the fixed pin, with the unlowered rmAGENT pool floor, and {v050common} names the v0.5.0 checkout and its sha
  const publish = added.find((s) => s.id === "P8.03-v050-publish")!;
  expect(publish.cmds[0]).toEqual(["bun", "{runDir}/v050/publish-contracts/src/ci/twin-publish.ts"]);
  expect(publish.env).toMatchObject({ GITHUB_WORKSPACE: "{runDir}/v050", PIN_BLOCK_IN: "52881000", REHEARSAL_IN: "true", SHEET_OVERLAY_IN: "deployments/twin-918453/upgrade-rehearsal.env" });
  expect(publish.cmds[1]!.join(" ")).toContain("VAULT_AGENT_MIN_POOL_LIQUIDITY=1000000000000000");
  expect(added.find((s) => s.id === "P8.02-v050-twin-fork")!.cmds[0]!.join(" ")).toContain("--pin-block 52881000");
  const { LIST_PLACEHOLDERS } = await import("./validate-contract-qa.ts");
  const common = LIST_PLACEHOLDERS.v050common!;
  expect(common[common.indexOf("--core-dir") + 1]).toBe("{v050CoreDir}");
  expect(common[common.indexOf("--core-sha") + 1]).toBe(V050_SHA);
  expect(added.find((s) => s.id === "P8.01-v050-checkout")!.cmds.flat().join(" ")).toContain(V050_SHA);
});

// Issue 1980 (owner decision): the runbook never clears the router's voted vector. The rule covers the template and the release being prepared; a pinned record is not reopened.
test("a step that clears the router's voted vector fails, by govern row or by a direct call", () => {
  const step = (id: string, cmd: string[]) => ({ id, cmds: [cmd] });
  expect(clearVectorProblems([step("P8.14-x", ["bun", "publish-contracts/src/cli.ts", "govern", "--row", "clear-voted-weights", "{v050common}"])], "releases/v0.6.0.yaml")).toHaveLength(1);
  expect(clearVectorProblems([step("P8.14-x", ["bash", "-c", "bun publish-contracts/src/cli.ts govern --row=clear-voted-weights"])], "template.yaml")).toHaveLength(1);
  expect(clearVectorProblems([step("P5.90-x", ["bash", "scripts/runbook/cast-send.sh", "{m:governance.governance}", "clearVotedWeights()"])], "template.yaml")).toHaveLength(1);
  expect(clearVectorProblems([step("P5.03-apply-receipt", ["bun", "publish-contracts/src/cli.ts", "govern", "--row", "apply-receipt"]), step("P8.24-x", ["bash", "-c", 'test "$(cast call r "votedWeightsActive()(bool)")" = true'])], "template.yaml")).toEqual([]);
  const clear = `  - id: "P8.14-v050-clear-voted-weights"
    standing: ["4.15"]
    description: "the Safe clears the active vector before the retire"
    host: "control"
    phase: 8
    cmds:
      - ["bun", "publish-contracts/src/cli.ts", "govern", "--row", "clear-voted-weights", "{v050common}", "{gate}"]
    env:
      PUBLISH_MANIFEST_DIR: "{v050ManifestDir}"
      YES: "{yes}"
    expectExit: 0
    receipts: []
    irreversible: false
    flow: "upgrade"
    onlyFor: ["twin", "rehearsal"]
    maxMinutes: 60
    added: "v0.6.0"
`;
  const p = problemsWith("releases/v0.6.0.yaml", (t) => unpinned(t).replace('  - id: "P8.15-v050-retire-vault"', `${clear}  - id: "P8.15-v050-retire-vault"`));
  expect(p.filter((x) => x.includes("never clears the router's voted vector"))).toEqual(["releases/v0.6.0.yaml P8.14-v050-clear-voted-weights: the runbook never clears the router's voted vector (govern --row clear-voted-weights, owner decision, issue 1980)"]);
  // the pinned records keep their history: v0.4.0 and v0.5.0 still validate, and the rule is not run on them
  expect(validateAll(ROOT, model).problems).toEqual([]);
  const plant = (t: string): string => t.replace(/(\n  - id: "P5\.54-apply-receipt-execute"[\s\S]*?cmds:\n)/, `$1      - ["bun", "publish-contracts/src/cli.ts", "govern", "--row", "clear-voted-weights", "{common}", "{gate}"]\n`);
  expect(plant(readFileSync(join(ROOT, QA_DIR, RELEASE), "utf8"))).toContain("clear-voted-weights\", \"{common}");
  const pinned = problemsWith(RELEASE, plant);
  expect(pinned.filter((x) => x.includes("never clears the router's voted vector"))).toEqual([]);
});

// Issue 1929: a forge build of the main checkout after the library-linked publish replaces the out/ that every later verify reads.
test("a forge build of the main checkout after P1.02-publish is rejected, naming the step", () => {
  const steps = (cmd: string[]) => [
    { id: "P1.02-publish", cmds: [["bun", "x"]] },
    { id: "P8.04-rebuild", cmds: [cmd] },
  ] as never;
  for (const cmd of [["forge", "build"], ["bash", "-c", "cd . && forge build"], ["forge", "clean"], ["forge", "build", "--root", "{runDir}/v060"], ["forge", "script", "--out", "{runDir}/x"]]) {
    expect(mainOutProblems({ release: "vX", steps: steps(cmd) }).join("\n"), cmd.join(" ")).toContain("P8.04-rebuild");
  }
  expect(mainOutProblems({ release: "vX", steps: steps(["forge", "build", "--root", "{runDir}/v060", "--out", "{runDir}/v060/out"]) })).toEqual([]);
  expect(mainOutProblems({ release: "vX", steps: [{ id: "P0.05-build", cmds: [["forge", "build"]] }, { id: "P1.02-publish", cmds: [["bun", "x"]] }] as never })).toEqual([]);
  const p = problemsWith("releases/v0.6.0.yaml", (t) => unpinned(t).replace('["forge", "build", "--root", "{runDir}/v060", "--out", "{runDir}/v060/out"]', '["forge", "build"]'));
  expect(p.join("\n")).toContain("P8.08-v060-upgrade-build");
});

// Issue 1996: the {runDir}/v060 build step is skipped exactly when every step that reads the build is skipped by its own gate.
test("the v0.6.0 upgrade build step's gate names the gate of every step that reads {runDir}/v060", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  expect(upgradeBuildGateProblems(r.steps, "v0.6.0")).toEqual([]);
  const readers = r.steps.filter((s) => s.cmds.some((c) => c.join(" ").includes("--upgrade-build {runDir}/v060")));
  expect(readers.map((s) => s.id)).toEqual(["P8.10-v050-deploy-gateway-impl", "P8.11-v050-upgrade-gateway", "P8.12-v050-deploy-receipt-impl", "P8.13-v050-upgrade-receipt"]);
  const build = r.steps.find((s) => s.id === "P8.08-v060-upgrade-build")!;
  expect([...gateAbsentPaths(build)].sort()).toEqual([...new Set(readers.flatMap(gateAbsentPaths))].sort());
  // the build reuses the main checkout's submodule objects, and no other step makes the checkout
  expect(build.cmds.map((c) => c.join(" "))).toContain("bash scripts/runbook/upgrade-submodules.sh {runDir}/v060");
  expect(r.steps.filter((s) => s.cmds.some((c) => c.join(" ").includes("worktree add --detach {runDir}/v060"))).map((s) => s.id)).toEqual([build.id]);
  // the template has no upgrade build, so the rule holds there trivially
  expect(upgradeBuildGateProblems(validateAll(ROOT, model).template.steps, "template.yaml")).toEqual([]);
});

test("an upgrade build gate that misses a reader, lists a stray path, or a reader with no gate is refused", () => {
  const v = "releases/v0.6.0.yaml";
  const gate = 'gateAbsent: ["{runDir}/state/done-gateway-upgrade", "{runDir}/state/done-receipt-upgrade"]';
  const missing = problemsWith(v, (t) => unpinned(t).replace(gate, 'gateAbsent: ["{runDir}/state/done-gateway-upgrade"]')).join("\n");
  expect(missing).toContain("P8.08-v060-upgrade-build: its gateAbsent does not list {runDir}/state/done-receipt-upgrade, the gate of P8.12-v050-deploy-receipt-impl");
  expect(missing).toContain("the gate of P8.13-v050-upgrade-receipt");
  const stray = problemsWith(v, (t) => unpinned(t).replace(gate, 'gateAbsent: ["{runDir}/state/done-gateway-upgrade", "{runDir}/state/done-receipt-upgrade", "{runDir}/state/done-retire-vault"]')).join("\n");
  expect(stray).toContain("lists {runDir}/state/done-retire-vault, which gates no step that reads {runDir}/v060");
  const ungated = problemsWith(v, (t) => unpinned(t).replace(stepBlock(t, "P8.11-v050-upgrade-gateway"), stepBlock(t, "P8.11-v050-upgrade-gateway").replace('    gateAbsent: "{runDir}/state/done-gateway-upgrade"\n', ""))).join("\n");
  expect(ungated).toContain("P8.11-v050-upgrade-gateway: it reads {runDir}/v060 but has no gateAbsent");
  const unbuilt = problemsWith(v, (t) => unpinned(t).replace(stepBlock(t, "P8.08-v060-upgrade-build"), "")).join("\n");
  expect(unbuilt).toContain("no step makes the --upgrade-build checkout {runDir}/v060");
  const late = upgradeBuildGateProblems([{ id: "P8.10-read", cmds: [["bun", "x", "--upgrade-build", "{runDir}/b"]], gateAbsent: "g" }, { id: "P8.20-make", cmds: [["git", "worktree", "add", "{runDir}/b"]], gateAbsent: "g" }] as never, "t");
  expect(late).toEqual(["t P8.10-read: it reads {runDir}/b before P8.20-make makes it"]);
});

test("every --upgrade-build of the committed v0.6.0 yaml names the separate checkout, never the main one", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const uses = r.steps.flatMap((s) => s.cmds.filter((c) => c.includes("--upgrade-build")));
  expect(uses.length).toBe(4);
  for (const c of uses) expect(c[c.indexOf("--upgrade-build") + 1]).toBe("{runDir}/v060");
});

test("the README whole-element placeholder sentence names every key of LIST_PLACEHOLDERS", async () => {
  const { LIST_PLACEHOLDERS } = await import("./validate-contract-qa.ts");
  const line = readFileSync(join(ROOT, QA_DIR, "README.md"), "utf8").split("\n").find((l) => l.startsWith("A whole-element list placeholder"))!;
  for (const k of Object.keys(LIST_PLACEHOLDERS)) expect(line, k).toContain(`{${k}}`);
});

// Flows (README "Flows"): a step runs on a target when its onlyFor admits the target and its flow is one the release runs there.
test("the v0.6.0 release runs both flows on the Twin, the upgrade flow on the rehearsal and the new flow in production", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const ids = (t: string) => applicableSteps(r, t).map((s) => s.id);
  expect(ids("twin")).toContain("P1.02-publish");
  expect(ids("twin")).toContain("P8.10-v050-deploy-gateway-impl");
  expect(ids("twin")).toContain("P8.05-v050-twin-dirty-pre-state");
  expect(ids("rehearsal")).not.toContain("P1.02-publish");
  expect(ids("rehearsal")).not.toContain("P8.05-v050-twin-dirty-pre-state");
  for (const id of ["P0.01-runbook-valid", "P1.50-record-go", "P8.06-v050-pre-state", "P8.07-v050-done-markers", "P8.23-v050-apply-receipt", "P8.29-v050-router-deposit", "P8.34-v050-pause-all", "P8.37-v050-verify-final", "P10.53-write-three-vault-rollout-report", "P10.52-record-signoff"]) expect(ids("rehearsal"), id).toContain(id);
  expect(ids("production")).toContain("P1.02-publish");
  expect(ids("production")).not.toContain("P8.10-v050-deploy-gateway-impl");
  // a mainnet run sends only what QA sent: every step that sends on 8453 runs on the Twin
  for (const t of ["rehearsal", "production"]) for (const s of applicableSteps(r, t).filter(sends)) expect(ids("twin"), `${s.id} on ${t}`).toContain(s.id);
  expect(qaSupersetProblems(r)).toEqual([]);
});

test("a step that sends on 8453 and does not run on the Twin fails", () => {
  const p = problemsWith("releases/v0.6.0.yaml", (t) => t.replace(stepBlock(t, "P8.29-v050-router-deposit"), (b) => b.replace('    onlyFor: ["twin", "rehearsal"]', '    onlyFor: "rehearsal"')));
  expect(p.join("\n")).toContain("P8.29-v050-router-deposit sends on rehearsal but does not run on twin");
});

test("a step with an unknown flow, and a release whose flows name an unknown target or flow, fail", () => {
  expect(problemsWith("releases/v0.6.0.yaml", (t) => t.replace('    flow: "upgrade"\n', '    flow: "sideways"\n')).join("\n")).toContain("flow is new | upgrade");
  expect(problemsWith("releases/v0.6.0.yaml", (t) => t.replace('  rehearsal: ["upgrade"]', '  staging: ["upgrade"]')).join("\n")).toContain("flows maps a target");
  expect(problemsWith("releases/v0.6.0.yaml", (t) => t.replace('  rehearsal: ["upgrade"]', '  rehearsal: ["rollback"]')).join("\n")).toContain("flows maps a target");
});

test("the committed v0.6.0 upgrade flow records and applies a receipt, deposits through each vault, the router and the gateway, drills the pause, and verifies at the end", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const joined = (id: string) => r.steps.find((s) => s.id === id)!.cmds.map((c) => c.join(" ")).join("\n");
  expect(joined("P8.20-v050-register-submitter")).toContain("--row register-submitter");
  expect(joined("P8.22-v050-record-receipt")).toContain("record-receipt");
  expect(joined("P8.23-v050-apply-receipt")).toContain("--row apply-receipt");
  expect(r.steps.find((s) => s.id === "P8.23-v050-apply-receipt")!.irreversible).toBe(true);
  expect(joined("P8.24-v050-receipt-read-back")).toContain("--receipt-applications");
  for (const id of ["P8.26-v050-deposit-rmusdc", "P8.27-v050-deposit-rmproto", "P8.28-v050-deposit-rmrwa"]) expect(joined(id)).toContain("deposit(uint256,address)");
  expect(joined("P8.29-v050-router-deposit")).toContain("deposit(uint256,uint256[])");
  expect(joined("P8.31-v050-gateway-deposit-vaults")).toContain("depositTo(");
  expect(joined("P8.33-v050-retired-vault")).toContain("redeemInKind");
  expect(joined("P8.34-v050-pause-all")).toContain("pause-all");
  expect(joined("P8.36-v050-unpause")).toContain("--row unpause-RWA");
  const order = r.steps.map((s) => s.id);
  for (const [a, b] of [["P8.15-v050-retire-vault", "P8.20-v050-register-submitter"], ["P8.22-v050-record-receipt", "P8.23-v050-apply-receipt"], ["P8.34-v050-pause-all", "P8.35-v050-redeem-while-paused"], ["P8.36-v050-unpause", "P8.37-v050-verify-final"], ["P10.52-record-signoff", "P10.06-v050-teardown"]]) expect(order.indexOf(a), `${a} before ${b}`).toBeLessThan(order.indexOf(b));
  // the governed operations are gated on the done-* markers P8.06 writes, so a rerun on an upgraded deployment skips them by their own gate
  for (const [id, marker] of [["P8.10-v050-deploy-gateway-impl", "done-gateway-upgrade"], ["P8.13-v050-upgrade-receipt", "done-receipt-upgrade"], ["P8.15-v050-retire-vault", "done-retire-vault"]]) expect(r.steps.find((s) => s.id === id)!.gateAbsent, id).toBe(`{runDir}/state/${marker}`);
  expect(r.steps.find((s) => s.id === "P8.07-v050-done-markers")!.writes).toEqual(["done-gateway-upgrade", "done-receipt-upgrade", "done-retire-vault"]);
  // issue 1980 (owner decision): the flow never clears the router's voted vector, so a rerun or a resume cannot drop the vector it applied
  expect(order.some((id) => id.startsWith("P8.14"))).toBe(false);
  expect(r.steps.flatMap((s) => s.cmds.map((c) => c.join(" "))).join("\n")).not.toMatch(/clear-voted-weights|clearVotedWeights/);
  // right before the post-rebalance router deposit the router still routes by the applied receipt: active, and the effective weights equal the payload's
  const deposit = r.steps.find((s) => s.id === "P8.29-v050-router-deposit")!.cmds.map((c) => c.join(" "));
  const send = deposit.findIndex((c) => c.includes("deposit(uint256,uint256[])"));
  const active = deposit.findIndex((c) => /votedWeightsActive\(\)\(bool\)"\)" = true/.test(c));
  const vector = deposit.findIndex((c) => c.includes("{receiptFile}") && c.includes("getEffectiveWeights()") && c.includes('test "$got" = "$want"'));
  expect(active).toBeGreaterThanOrEqual(0);
  expect(vector).toBeGreaterThanOrEqual(0);
  expect(Math.max(active, vector)).toBeLessThan(send);
});

test("the template applies the receipt it records and deposits through the router, and the go marks the senders", () => {
  const t = validateAll(ROOT, model).template;
  const step = (id: string) => t.steps.find((s) => s.id === id)!;
  expect(step("P5.03-apply-receipt").cmds[0]).toContain("apply-receipt");
  expect(step("P5.03-apply-receipt").irreversible).toBe(true);
  expect(step("P5.04-receipt-read-back").cmds.map((c) => c.join(" ")).join("\n")).toContain("--receipt-applications");
  expect(step("P6.30-router-deposit").cmds.map((c) => c.join(" ")).join("\n")).toContain("deposit(uint256,uint256[])");
  expect(t.steps.map((s) => s.id).indexOf("P6.31-sweep-positions")).toBeGreaterThan(t.steps.map((s) => s.id).indexOf("P6.30-router-deposit"));
  expect(step("P1.50-record-go").cmds[0]).toContain("--sender");
  for (const id of ["P0.01-runbook-valid", "P1.50-record-go", "P10.51-write-rollout-report", "P10.52-record-signoff"]) expect(step(id).flow, id).toEqual(["new", "upgrade"]);
});

test("a report or sign-off step that drops a flag the report needs fails; --release included", () => {
  const p = problemsWith("releases/v0.6.0.yaml", (t) => unpinned(t).replace('"--release", "{release}", "--step", "P10.52-record-signoff"', '"--step", "P10.52-record-signoff"'));
  expect(p.join("\n")).toContain("P10.52-record-signoff: run-record.ts signoff needs --release");
  expect(recordStepProblems([{ id: "P10.99", cmds: [["bun", "scripts/runbook/run-record.ts", "report", "--run-dir", "d"]] }]).length).toBe(9);
  expect(recordStepProblems([{ id: "P1.50", cmds: [["bun", "scripts/runbook/run-record.ts", "go", "--kind", "publish"]] }])).toEqual([]);
});

test("a Twin fork or anvil started as a command of this machine fails; the committed fork steps are ssh commands on the stage host", () => {
  expect(localForkProblems([{ id: "P0.12", cmds: [["bun", "scripts/devnet/twin-fork.ts", "start", "--port", "8545"]] }]).join("\n")).toContain("twin-fork.ts start runs on this machine");
  expect(localForkProblems([{ id: "P0.12", cmds: [["bun", "/x/scripts/devnet/twin-fork.ts", "stop"]] }])).toHaveLength(1);
  expect(localForkProblems([{ id: "P0.12", cmds: [["anvil", "--port", "8545"]] }, { id: "P0.13", cmds: [["bash", "-c", "nohup anvil --fork-url x &"]] }])).toHaveLength(2);
  expect(localForkProblems([{ id: "P0.12", cmds: [["ssh", "-o", "BatchMode=yes", "{stageHost}", "cd {stageCore} && bun scripts/devnet/twin-fork.ts start --port 8545"]] }])).toEqual([]);
  const p = problemsWith("releases/v0.6.0.yaml", (t) => unpinned(t).replace(/\["ssh", "-o", "BatchMode=yes", "\{stageHost\}", "export PATH=\$HOME\/\.foundry\/bin:\$PATH; cd \{stageCore\} && bun scripts\/devnet\/twin-fork\.ts wait-ready --port 8547[^\]]*\]/, '["bun", "scripts/devnet/twin-fork.ts", "wait-ready", "--port", "8547"]'));
  expect(p.join("\n")).toContain("P8.02-v050-twin-fork: twin-fork.ts wait-ready runs on this machine");
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  for (const id of ["P0.12-twin-fork", "P8.02-v050-twin-fork"]) {
    const cmds = r.steps.find((s) => s.id === id)!.cmds.map((c) => c.join(" "));
    expect(cmds.filter((c) => c.startsWith("ssh ")).length, id).toBeGreaterThanOrEqual(2);
    expect(cmds.some((c) => /-L \{tunnelPort2?\}:127\.0\.0\.1:854[57]/.test(c)), id).toBe(true);
    expect(cmds.some((c) => c.includes("scp -q {stageHost}:")), id).toBe(true);
  }
});

test("a tunnel step removes a stale control socket before it reopens the tunnel, so the teardown's -O exit reaches the live master", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  for (const id of ["P0.12-twin-fork", "P8.02-v050-twin-fork"]) {
    const tunnel = r.steps.find((s) => s.id === id)!.cmds.map((c) => c.join(" ")).find((c) => c.includes("-O check"))!;
    const sock = /-S (\S+\.sock) -O check/.exec(tunnel)![1]!;
    expect(tunnel, id).toContain(`|| { rm -f ${sock}; ssh `);
    expect(tunnel.indexOf("rm -f"), id).toBeLessThan(tunnel.indexOf("-f -N -M"));
  }
});

test("the ssh scripts of the stage-host steps name the host state dir absolutely: they cd into the checkout first, so a relative path lands inside it", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const remote = r.steps.flatMap((s) => s.cmds.filter((c) => c[0] === "ssh" && c.some((a) => a.includes("{stageDir}"))).map((c) => ({ id: s.id, script: c.at(-1)! })));
  expect(remote.length).toBeGreaterThanOrEqual(6);
  for (const { id, script } of remote) {
    expect(script.match(/\{stageDir\}/g)!.length, id).toBe(script.match(/\$HOME\/\{stageDir\}/g)!.length);
  }
  // the scp that copies anvil.json back names the path relative to the host's home, which scp resolves itself
  const scp = r.steps.find((s) => s.id === "P0.12-twin-fork")!.cmds.map((c) => c.join(" ")).find((c) => c.includes("scp -q"))!;
  expect(scp).toContain("{stageHost}:{stageDir}/twin/anvil.json");
});

test("the retired-vault step reads the run manifest every run writes, never the operator-assembled evidence.json", () => {
  const t = validateAll(ROOT, model).template.steps.find((s) => s.id === "P6.24-redeem-retired-vault")!;
  const script = t.cmds.flat().join(" ");
  expect(script).toContain('test -f "{evidenceDir}/publish-run.json"');
  expect(script).toContain('"{evidenceDir}/publish-run.json")');
  expect(script).not.toContain("evidence.json");
});

test("the agent policies of the v0.6.0 gateway steps keep the retired withdraw members zero (the gateway reverts RetiredPolicyFieldNonZero otherwise)", () => {
  const Z = "0x0000000000000000000000000000000000000000";
  const root = join(ROOT, QA_DIR);
  for (const [file, id, state] of [["releases/v0.6.0.yaml", "P8.30-v050-gateway-agent", "v050-agent-policy"], ["gateway.yaml", "P3.01-agent-policy", "agent-policy"]] as const) {
    const text = readFileSync(join(root, file), "utf8");
    const block = text.slice(text.indexOf(`id: "${id}"`));
    const line = block.split("\n").find((l) => l.includes(`> {runDir}/state/${state}`))!;
    // (active,validUntil,maxPerPayment,maxPerWindow,shareReceiver,[destinations],assetRecipient,maxWithdrawPerPayment,maxWithdrawPerWindow,[sourceVaults])
    expect(line, `${file} ${id}`).toContain(`],${Z},0,0,[])`);
  }
});

test("the agent of a v0.6.0 gateway step may deposit only into the three vaults: the router is never a destination (architecture 5.2)", () => {
  const root = join(ROOT, QA_DIR);
  for (const [file, policyState, depositId] of [["releases/v0.6.0.yaml", "v050-agent-policy", "P8.31-v050-gateway-deposit-vaults"], ["gateway.yaml", "agent-policy", "P3.04-gateway-deposit-vaults"]] as const) {
    const text = readFileSync(join(root, file), "utf8");
    const policy = text.split("\n").find((l) => l.includes(`> {runDir}/state/${policyState}`))!;
    expect(policy, file).not.toMatch(/router/);
    const dests = /\[([^\[\]]*)\],0x0000000000000000000000000000000000000000,0,0,\[\]/.exec(policy)![1]!.split(",");
    expect(dests, file).toHaveLength(3);
    const block = text.slice(text.indexOf(`id: "${depositId}"`));
    const step = block.slice(0, block.indexOf("irreversible:"));
    expect(step, file).toContain("depositTo(bytes32,uint256,uint64,bytes32,address,uint256[])");
    expect(step, file).toContain("AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)");
    expect(step, file).not.toMatch(/router/i);
  }
});

// Issue 1984: the router rebalance is the apply-receipt step. Each flow that runs one deposits into a vault, deposits through the router and redeems before AND after it.
const send = (call: string): string[] => ["bash", "scripts/runbook/cast-send.sh", "0xV", call, "1", "{cast}"];
const roundStep = (id: string, extra: Record<string, unknown> = {}) => ({ id, standing: ["4.4"], description: "d", host: "control", phase: 5, cmds: [["true"]], expectExit: 0, receipts: [], irreversible: false, ...extra });
const ROUND = (tag: string) => [
  roundStep(`P5.1${tag}-deposit`, { cmds: [send("deposit(uint256,address)")], exercises: "vault-deposit" }),
  roundStep(`P5.2${tag}-router`, { cmds: [send("deposit(uint256,uint256[])")], exercises: "router-deposit" }),
  roundStep(`P5.3${tag}-redeem`, { cmds: [["bash", "-c", 'bash scripts/runbook/cast-send.sh "$v" "$fn(uint256,address,address)" "$s" {castFlagsInline}']], exercises: "redeem" }),
];
const APPLY = roundStep("P5.03-apply-receipt", { cmds: [["bun", "publish-contracts/src/cli.ts", "govern", "--row", "apply-receipt", "{common}"]], irreversible: true, onlyFor: ["twin", "rehearsal"] });

test("a flow that deposits, routes and redeems before and after its apply-receipt step passes the rebalance rule (issue 1984)", () => {
  expect(rebalanceRoundProblems([...ROUND("a"), APPLY, ...ROUND("b")] as never, "t")).toEqual([]);
  // a flow with no apply-receipt step has no rebalance to bracket
  expect(rebalanceRoundProblems(ROUND("a") as never, "t")).toEqual([]);
  // the committed template and the unpinned v0.6.0 pass in both flows; the pinned v0.4.0 and v0.5.0 records are not reopened
  const all = validateAll(ROOT, model);
  expect(rebalanceRoundProblems(all.template.steps, "template.yaml")).toEqual([]);
  expect(rebalanceRoundProblems(all.releases.get("v0.6.0")!.steps, "v0.6.0")).toEqual([]);
  expect(all.problems).toEqual([]);
});

test("a flow with no deposit, router deposit or redeem before the apply-receipt step is refused (issue 1984)", () => {
  const p = rebalanceRoundProblems([APPLY, ...ROUND("b")] as never, "t").join("\n");
  for (const k of ["vault-deposit", "router-deposit", "redeem"]) expect(p).toContain(`the new flow on twin has no ${k} step before P5.03-apply-receipt`);
  expect(p).toContain("the new flow on rehearsal has no redeem step before");
  // on production the apply step does not run, so nothing is required there
  expect(p).not.toContain("on production");
  // the committed v0.6.0 without its upgrade-flow round before P8.23 is refused
  const v = problemsWith("releases/v0.6.0.yaml", (t) => ["P8.41-v050-pre-deposit-rmusdc", "P8.42-v050-pre-deposit-rmproto", "P8.43-v050-pre-deposit-rmrwa"].reduce((x, id) => x.replace(stepBlock(x, id), ""), unpinned(t))).join("\n");
  expect(v).toContain("the upgrade flow on rehearsal has no vault-deposit step before P8.23-v050-apply-receipt");
  // and the template without its round before P5.03 is refused
  const tpl = problemsWith("template.yaml", (t) => t.replace(stepBlock(t, "P5.30-pre-router-deposit"), "")).join("\n");
  expect(tpl).toContain("template.yaml: the new flow on twin has no router-deposit step before P5.03-apply-receipt");
});

test("a flow with no deposit, router deposit or redeem after the apply-receipt step is refused (issue 1984)", () => {
  const p = rebalanceRoundProblems([...ROUND("a"), APPLY] as never, "t").join("\n");
  for (const k of ["vault-deposit", "router-deposit", "redeem"]) expect(p).toContain(`the new flow on twin has no ${k} step after P5.03-apply-receipt`);
  // the committed v0.6.0 with no redeem after P8.23 (the sweep and the paused redeem dropped) is refused
  const v = problemsWith("releases/v0.6.0.yaml", (t) => unpinned(t).replace(stepBlock(t, "P8.50-v050-sweep-positions"), "").replace(stepBlock(t, "P8.35-v050-redeem-while-paused"), "")).join("\n");
  expect(v).toContain("the upgrade flow on twin has no redeem step after P8.23-v050-apply-receipt");
  // a step of the other flow, or one that does not run on that target, does not count
  const other = rebalanceRoundProblems([...ROUND("a").map((s) => ({ ...s, flow: "upgrade" })), APPLY, ...ROUND("b")] as never, "t").join("\n");
  expect(other).toContain("the new flow on twin has no vault-deposit step before");
  const prodOnly = rebalanceRoundProblems([...ROUND("a").map((s) => ({ ...s, onlyFor: "production" })), APPLY, ...ROUND("b")] as never, "t").join("\n");
  expect(prodOnly).toContain("the new flow on rehearsal has no router-deposit step before");
});

test("an exercises label with no matching journaled send, or an unknown label, is refused: a label never stands in for the send (issue 1984)", () => {
  const p = rebalanceRoundProblems([roundStep("P5.10-fake", { cmds: [["bash", "-c", "cast call 0xV 'deposit(uint256,address)'"]], exercises: "vault-deposit" }), roundStep("P5.11-wrong", { cmds: [send("deposit(uint256,address)")], exercises: "router-deposit" })] as never, "t");
  expect(p).toEqual(["t P5.10-fake: exercises vault-deposit, but no command sends that call through scripts/runbook/cast-send.sh", "t P5.11-wrong: exercises router-deposit, but no command sends that call through scripts/runbook/cast-send.sh"]);
  expect(problemsWith("template.yaml", (t) => t.replace('    exercises: "redeem"\n', '    exercises: "withdraw"\n')).join("\n")).toContain("exercises is vault-deposit | router-deposit | redeem");
  // the setup deposit of the Twin's dirty pre-state and the cleanup redeem of the live pre-state carry no label: they prove no round
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  for (const id of ["P8.05-v050-twin-dirty-pre-state", "P8.06-v050-pre-state", "P8.33-v050-retired-vault", "P6.24-redeem-retired-vault"]) expect(r.steps.find((s) => s.id === id)!.exercises, id).toBeUndefined();
});

test("the rounds before the rebalance run before the receipt is recorded, check the router against the pre-rebalance vector and write their own state; the round after proves the split changed (issue 1984)", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const ids = r.steps.map((s) => s.id);
  const before = (a: string, b: string) => expect(ids.indexOf(a), `${a} before ${b}`).toBeLessThan(ids.indexOf(b));
  for (const [first, guard, router, record, apply, post, changed] of [
    ["P4.01-verify-post-govern", "P5.05-receipt-changes-split", "P5.30-pre-router-deposit", "P5.02-record-receipt", "P5.03-apply-receipt", "P6.30-router-deposit", "P6.32-router-split-changed"],
    ["P8.17-v050-evidence", "P8.40-v050-receipt-changes-split", "P8.47-v050-pre-router-deposit", "P8.22-v050-record-receipt", "P8.23-v050-apply-receipt", "P8.29-v050-router-deposit", "P8.49-v050-router-split-changed"],
  ]) {
    before(first!, guard!); before(guard!, router!); before(router!, record!); before(record!, apply!); before(apply!, post!); before(post!, changed!);
    const text = (id: string) => r.steps.find((s) => s.id === id)!.cmds.map((c) => c.join(" ")).join("\n");
    // the pre-rebalance vector is the effective vector, whatever votedWeightsActive reads: the runbook never clears a vector to reach the default (issue 1980)
    expect(text(guard!)).toContain("getEffectiveWeights()");
    expect(text(guard!)).not.toContain("votedWeightsActive");
    expect(text(guard!)).not.toContain("getDefaultWeights");
    expect(text(guard!)).toContain("receipt-changes-split");
    expect(r.steps.find((s) => s.id === guard)!.description).not.toContain("P8.14");
    // the pre-rebalance router deposit checks its legs against that same saved vector
    const saved = guard!.startsWith("P8") ? "v050-pre-router-weights" : "pre-router-weights";
    expect(text(guard!)).toContain(`> {runDir}/state/${saved}`);
    expect(text(router!)).toContain(`router-legs {runDir}/state/${saved.replace("weights", "deposit.json")} {runDir}/state/${saved}`);
    expect(text(router!)).toContain("router-legs");
    expect(text(changed!)).toContain("legs-differ");
  }
  // the funding check runs before the first send of the upgrade flow's rounds
  before("P8.25-v050-funding", "P8.41-v050-pre-deposit-rmusdc");
  // the pre-rebalance round never writes the state the round after it writes
  const writes = (pred: (id: string) => boolean) => new Set(r.steps.filter((s) => pred(s.id)).flatMap((s) => s.writes ?? []));
  const pre = writes((id) => /^P5\.(05|[123]\d)-|^P8\.4[0-8]-/.test(id));
  const post = writes((id) => /^P6\.|^P8\.(2[6-9]|49|50)-/.test(id));
  expect([...pre].filter((w) => post.has(w))).toEqual([]);
  // the Twin's receipt vectors weight every vault and differ from the default vector the sheet and the retire set, so the Twin run proves the split changed with three legs
  for (const id of ["P5.00-receipt-payload", "P8.19-v050-receipt-payload"]) expect(r.steps.find((s) => s.id === id)!.cmds[0]).toContain("USDC:8000,PROTO:1000,RWA:1000");
});

// ─── The fund flow (releases/v0.8.0-onevault.yaml, the hardened successor of Deploy 4's v0.7.0-onevault.yaml) ────────────────────────────────────────────────────
const FUND_RELEASE = "releases/v0.8.0-onevault.yaml";
const fundRelease = () => validateAll(ROOT, model).releases.get("v0.8.0-onevault")!;
const deploy4Release = () => validateAll(ROOT, model).releases.get("v0.7.0-onevault")!;

test("the v0.8.0-onevault release keeps every template step and runs only the fund flow: no template step applies on any target, and production runs nothing", () => {
  const r = fundRelease();
  const t = validateAll(ROOT, model).template;
  expect(r.flows).toEqual({ twin: ["fund"], rehearsal: ["fund"], production: ["fund"] });
  const templateIds = new Set(t.steps.map((s) => s.id));
  expect(r.steps.filter((s) => templateIds.has(s.id)).map((s) => s.id)).toEqual(t.steps.map((s) => s.id));
  for (const target of ["twin", "rehearsal"]) {
    const ids = applicableSteps(r, target).map((s) => s.id);
    expect(ids.length, target).toBeGreaterThan(30);
    expect(ids.filter((id) => templateIds.has(id)), target).toEqual([]);
  }
  expect(applicableSteps(r, "production")).toEqual([]);
  expect(runnableProblems(r, "production").join("\n")).toContain("has no step that runs on production");
  expect(runnableProblems(r, "rehearsal")).toEqual([]);
  // every added step is of the fund flow, carries the release's added and never runs in production
  for (const s of r.steps.filter((x) => !templateIds.has(x.id))) {
    expect(s.added, s.id).toBe("v0.8.0-onevault");
    expect(s.flow, s.id).toBe("fund");
    expect(["twin", "rehearsal"].includes(s.onlyFor as string) || JSON.stringify(s.onlyFor) === JSON.stringify(["twin", "rehearsal"]), s.id).toBe(true);
  }
  // a mainnet run sends only what QA sent
  for (const s of applicableSteps(r, "rehearsal").filter(sends)) expect(applicableSteps(r, "twin").map((x) => x.id), s.id).toContain(s.id);
  expect(qaSupersetProblems(r)).toEqual([]);
});

test("Deploy 4: the fund steps publish and verify with --system fund, never run a vaults-only verb, and govern only through the Safe tool on the fund-system timelock", () => {
  const r = fundRelease();
  const fund = r.steps.filter((s) => s.flow === "fund");
  const joined = fund.flatMap((s) => s.cmds.map((c) => ({ id: s.id, j: c.join(" ") })));
  for (const { id, j } of joined.filter((x) => /publish-contracts\/src\/cli\.ts (publish|verify|record-receipt|deploy-implementation)\b/.test(x.j) || x.j.includes("--stage plan"))) expect(j, id).toContain("--system fund");
  // record-receipt --system fund records on the fund register (P6.72, the only step that runs it)
  expect(joined.filter((x) => /publish-contracts\/src\/cli\.ts record-receipt\b/.test(x.j)).map((x) => x.id)).toEqual(["P6.72-fund-record-receipt"]);
  // deploy-implementation --system fund deploys the rebalancer's second implementation (P9.69, the only step that runs it); the upgrade itself is the fund Safe's
  expect(joined.filter((x) => /publish-contracts\/src\/cli\.ts deploy-implementation\b/.test(x.j)).map((x) => x.id)).toEqual(["P9.69-fund-deploy-implementation"]);
  expect(joined.find((x) => x.id === "P9.69-fund-deploy-implementation")!.j).toContain("--proxy rebalancer --contract RebalancerV2");
  expect(joined.filter((x) => /publish-contracts\/src\/cli\.ts (govern|pause-all|redeploy-vault)\b/.test(x.j))).toEqual([]);
  const proposals = joined.filter((x) => x.j.includes("publish-contracts/src/safe/cli.ts propose"));
  expect(proposals.length).toBe(10);
  for (const { id, j } of proposals) expect(j, id).toContain("--timelock {m:fund-timelock.timelock}");
  const step = (id: string) => r.steps.find((s) => s.id === id)!;
  expect(step("P1.61-fund-publish").irreversible).toBe(true);
  expect(step("P1.61-fund-publish").notBefore).toEqual({ afterStep: "P1.60-fund-record-go", hours: 0 });
  expect(step("P6.62-fund-claim-deposit").notBefore).toEqual({ afterStep: "P6.61-fund-settle-deposits", hours: 1 }); // decision D4-11: a 1 h hold
  for (const id of ["P3.62-fund-register-submitter-execute", "P6.74-fund-apply-receipt-execute", "P9.62-fund-unpause-execute", "P9.71-fund-upgrade-execute", "P9.72-fund-verify-final"]) expect(step(id).notBefore?.hours, id).toBe("timelockDelay");
  // Deploy 4: the upgrade lifecycle changes code and reads the change back (P9.71: the slot is RebalancerV2 and upgradeMarker() answers 2), then upgrades back so the final
  // verify (P9.72, unchanged: every proxy's code the build's) runs on the release build
  expect(step("P9.70-fund-upgrade-schedule").cmds.map((c) => c.join(" ")).join("\n")).toContain('upgradeToAndCall(address,bytes)" "{state:rebalancer-v2-implementation}"');
  expect(step("P9.71-fund-upgrade-execute").cmds.map((c) => c.join(" ")).join("\n")).toContain('"upgradeMarker()(uint256)")" = 2');
  expect(step("P9.72-fund-verify-final").cmds.at(-1)).toEqual(["bun", "publish-contracts/src/cli.ts", "verify", "{common}", "--system", "fund", "{gate}"]);
  expect(step("P9.72-fund-verify-final").notBefore).toEqual({ afterStep: "P9.71-fund-upgrade-execute", hours: "timelockDelay" });
  expect(step("P0.67-fund-sheet").cmds[0]).toEqual(["cp", FUND_SHEET, "{sheet}"]);
  expect(step("P1.60-fund-record-go").cmds[0]!.join(" ")).toContain("{sheet:KEEPER_ADDRESS}");
  // the decisions of Deploy 4: the owner's exception, the owner's conditional go (D4-2) and the keeper key (D4-3, recorded in D4-8)
  expect(r.decisions.find((d) => d.id === "D4-1")).toMatchObject({ status: "decided", decidedOn: "2026-11-12", ref: "owner instruction in the Deploy 4 planning session, 2026-11-12" });
  expect(r.decisions.find((d) => d.id === "D4-2")).toMatchObject({ status: "decided", decidedOn: "2026-11-12", ref: "owner, Deploy 4 planning session, 2026-11-12" });
  expect(r.decisions.find((d) => d.id === "D4-3")).toMatchObject({ status: "decided", decidedOn: "2026-11-13", ref: "D4-8" });
  for (const id of ["D4-4", "D4-5", "D4-6", "D4-7", "D4-8"]) expect(r.decisions.find((d) => d.id === id)?.status, id).toBe("decided");
  expect(r.productionReady).toBe(false);
});

test("Deploy 4: a fund flow step is accepted, an unknown flow is refused with fund named, and a fund release may not run the new flow without the template's own rules", () => {
  expect(problemsWith("releases/v0.6.0.yaml", (t) => t.replace('    flow: "upgrade"\n', '    flow: "sideways"\n')).join("\n")).toContain("flow is new | upgrade | fund");
  expect(problemsWith(FUND_RELEASE, (t) => t.replace("  production: [\"fund\"]\n", "  production: [\"fund\", \"rollback\"]\n")).join("\n")).toContain("flows maps a target");
  // without production: ["fund"], production would default to the new flow and send the template's transactions that the Twin (fund only) never sent
  const noProd = problemsWith(FUND_RELEASE, (t) => t.replace("  production: [\"fund\"]\n", ""));
  expect(noProd.join("\n")).toContain("P1.02-publish sends on production but does not run on twin");
});

test("Deploy 4: vaults: fund is accepted for a release that runs the fund flow and refused for any other", () => {
  expect(fundRelease().vaults).toEqual(["fund"]);
  expect(FUND_VAULT_MANIFESTS).toEqual(["fund"]);
  const v060 = readFileSync(join(ROOT, QA_DIR, "releases/v0.6.0.yaml"), "utf8");
  expect(() => parseRelease(v060.replace('vaults: ["vault", "protocol-asset-vault", "rwa-basket-vault"]', 'vaults: ["vault", "fund"]'), "v0.6.0")).toThrow("fund only for a release whose flows run the fund flow");
  const p = problemsWith("releases/v0.6.0.yaml", (t) => t.replace('vaults: ["vault", "protocol-asset-vault", "rwa-basket-vault"]', 'vaults: ["fund"]'));
  expect(p.join("\n")).toContain("runbook v0.6.0: vaults is a list of distinct vault manifest names");
  // the fund release itself still refuses an unknown name and a repeated one
  expect(problemsWith(FUND_RELEASE, (t) => t.replace('vaults: ["fund"]', 'vaults: ["fund", "router"]')).join("\n")).toContain("vaults is a list of distinct vault manifest names");
  expect(problemsWith(FUND_RELEASE, (t) => t.replace('vaults: ["fund"]', 'vaults: ["fund", "fund"]')).join("\n")).toContain("vaults is a list of distinct vault manifest names");
});

test("Deploy 4: a fund step reads only the fund sheet's names and the fund system's manifests; a vaults step never reads them", () => {
  expect(model.fundSheetNames.has("FUND_TVL_CAP")).toBe(true);
  expect(model.fundSheetNames.has("KEEPER_ADDRESS")).toBe(true);
  expect(model.sheetNames.has("FUND_TVL_CAP")).toBe(false);
  expect([...model.fundManifestFiles].sort()).toEqual([...FUND_MANIFEST_FILES].sort());
  const at = (flow: string | undefined, read: string) => commandProblems([{ id: "P6.99-x", standing: ["4.4"], description: "d", host: "control", phase: 6, cmds: [["bash", "-c", `echo ${read}`]], expectExit: 0, receipts: [], irreversible: false, ...(flow ? { flow } : {}) }] as never, model, null);
  expect(at("fund", "{sheet:FUND_TVL_CAP} {sheet:KEEPER_ADDRESS} {m:fund.fund} {m:fund-timelock.timelock} {m:fund-receipt.consensus_receipt} {m:safe.safe}")).toEqual([]);
  expect(at("fund", "{sheet:VAULT_USDC_TVL_CAP}")).toEqual(["P6.99-x: unknown placeholder {sheet:VAULT_USDC_TVL_CAP}"]);
  expect(at("fund", "{m:router.router}")).toEqual(["P6.99-x: unknown placeholder {m:router.router}"]);
  expect(at(undefined, "{sheet:FUND_TVL_CAP}")).toEqual(["P6.99-x: unknown placeholder {sheet:FUND_TVL_CAP}"]);
  expect(at("upgrade", "{m:queue.queue}")).toEqual(["P6.99-x: unknown placeholder {m:queue.queue}"]);
  expect(at(undefined, "{sheet:ADMIN_ADDRESS} {m:vault.vault}")).toEqual([]);
  // the committed fund release with a vaults name planted in a fund step is refused
  const p = problemsWith(FUND_RELEASE, (t) => t.replace('"--sender", "{sheet:ADMIN_ADDRESS},{sheet:EMERGENCY_ADDRESS},{sheet:KEEPER_ADDRESS}"', '"--sender", "{sheet:ADMIN_ADDRESS},{sheet:SHARE_RECEIVER_ADDRESS},{sheet:KEEPER_ADDRESS}"'));
  expect(p.join("\n")).toContain("P1.60-fund-record-go: unknown placeholder {sheet:SHARE_RECEIVER_ADDRESS}");
});

test("Deploy 4: a run sheet copied whole with cp FILE {sheet} counts as written, and a read before it is still refused", () => {
  const st = (id: string, cmd: string[]) => ({ id, standing: ["4.3"], description: "d", host: "control", phase: 0, cmds: [cmd], expectExit: 0, receipts: [], irreversible: false });
  const copy = st("P0.67-fund-sheet", ["cp", FUND_SHEET, "{sheet}"]);
  const read = st("P0.70-read", ["bash", "-c", "echo {sheet:TIMELOCK_MIN_DELAY}"]);
  const errs = (steps: unknown[]) => { const e: string[] = []; parseSteps(steps, "t", e); return e; };
  expect(errs([copy, read])).toEqual([]);
  expect(errs([read, copy])).toEqual(["t P0.70-read: {sheet:TIMELOCK_MIN_DELAY} is read before any step writes the run sheet (--out {sheet})"]);
  // a cp that does not end at {sheet}, or copies more than one file, writes no run sheet
  expect(errs([st("P0.67-x", ["cp", "{sheet}", "/elsewhere"]), read])).toHaveLength(1);
  expect(errs([st("P0.67-x", ["cp", "a", "b", "{sheet}"]), read])).toHaveLength(1);
  // the committed fund release copies the sheet before its first fund read
  const r = fundRelease();
  expect(r.steps.findIndex((s) => s.id === "P0.67-fund-sheet")).toBeLessThan(r.steps.findIndex((s) => s.id === "P0.70-fund-preflight-guards"));
});

test("Deploy 4: the Safe tool's action flags are read from its header (the usage line `safe-cli import` no longer cuts it), and a flag it does not have is refused", () => {
  const flags = model.tools.get("publish-contracts/src/safe/cli.ts")!.flags;
  for (const f of ["target", "data", "salt", "targets", "datas", "values", "bundle", "signer", "timelock", "action", "safe", "out"]) expect(flags.has(f), f).toBe(true);
  const p = problemsWith(FUND_RELEASE, (t) => t.replace('"--action", "schedule", "--target", "{state:target-apply-receipt}"', '"--action", "schedule", "--description", "x", "--target", "{state:target-apply-receipt}"'));
  expect(p.join("\n")).toContain("P6.73-fund-apply-receipt-schedule: --description is no publish-contracts/src/safe/cli.ts flag");
});

test("Deploy 4: the fund receipt tools are in the tool model: their flags are read from the scripts themselves, and a flag they do not have is refused", () => {
  const payload = model.tools.get("scripts/runbook/fund-receipt-payload.ts")!.flags;
  for (const f of ["out", "bps", "rpc", "fund-manifest", "assets", "asset-ids", "chain", "map-out", "session-id"]) expect(payload.has(f), f).toBe(true);
  const check = model.tools.get("scripts/prototype/check-receipt-assets.ts")!.flags;
  for (const f of ["map", "schema", "chain", "adapter"]) expect(check.has(f), f).toBe(true);
  expect(problemsWith(FUND_RELEASE, (t) => t)).toEqual([]);
  const p1 = problemsWith(FUND_RELEASE, (t) => t.replace("--fund-manifest {manifestDir}/fund.json", "--fund-manifest {manifestDir}/fund.json --weights USDC:10000"));
  expect(p1.join("\n")).toContain("P6.70-fund-receipt-payload: --weights is no scripts/runbook/fund-receipt-payload.ts flag");
  const p2 = problemsWith(FUND_RELEASE, (t) => t.replace("--map {runDir}/fund-asset-map.json", "--asset-map {runDir}/fund-asset-map.json"));
  expect(p2.join("\n")).toContain("P6.71-fund-receipt-offline: --asset-map is no scripts/prototype/check-receipt-assets.ts flag");
  // record-receipt is irreversible wherever it runs: the fund step keeps the rule
  const p3 = problemsWith(FUND_RELEASE, (t) => t.replace(/(  - id: "P6\.72-fund-record-receipt"[\s\S]*?)irreversible: true/, "$1irreversible: false"));
  expect(p3.join("\n")).toContain("P6.72-fund-record-receipt: it publishes, records a receipt or pushes a tag, so it is irreversible: true");
});

test("Deploy 4: the unwind guard rule follows where the govern step runs: the fund release never runs P3.01, a release that runs it still needs both guards", () => {
  const r = fundRelease();
  expect(r.steps.some((s) => s.id === "P3.01-govern-schedule")).toBe(true);
  expect(unwindGuardProblems(r)).toEqual([]);
  // the same steps with the new flow run on the Twin: P3.01 runs, so the PROTO and RWA guards are required
  expect(unwindGuardProblems({ ...r, flows: { ...r.flows, twin: ["fund", "new"] } }).join("\n")).toContain("vault (PROTO) has no set-unwind-guard step");
  // a release with no flows runs the new flow everywhere: unchanged
  expect(unwindGuardProblems({ release: "vX", steps: r.steps }).length).toBe(2);
});

test("Deploy 4: the rebalance rule iterates the fund flow; the fund's apply is a Safe call, not --row apply-receipt, so it brackets nothing there, and every fund exercises label sends its call", () => {
  const r = fundRelease();
  expect(rebalanceRoundProblems(r.steps, "v0.8.0-onevault")).toEqual([]);
  const labelled = r.steps.filter((s) => s.flow === "fund" && s.exercises !== undefined).map((s) => [s.id, s.exercises]);
  expect(labelled).toEqual([["P6.62-fund-claim-deposit", "vault-deposit"], ["P6.65-fund-claim-redeem", "redeem"], ["P6.68-fund-redeem-in-kind", "redeem"]]);
  expect(r.steps.some((s) => s.flow === "fund" && s.cmds.some((c) => c.join(" ").includes("--row apply-receipt")))).toBe(false);
  // a fund-flow step that did run --row apply-receipt would be bracketed like any other flow
  const fundApply = { ...APPLY, flow: "fund" };
  expect(rebalanceRoundProblems([fundApply] as never, "t").join("\n")).toContain("the fund flow on twin has no vault-deposit step before P5.03-apply-receipt");
  // a fund label whose step does not send its call is refused
  const p = problemsWith(FUND_RELEASE, (t) => t.replace(stepBlock(t, "P6.66-fund-request-cancel"), (b) => b.replace('    added: "v0.8.0-onevault"\n', '    exercises: "vault-deposit"\n    added: "v0.8.0-onevault"\n')));
  expect(p.join("\n")).toContain("P6.66-fund-request-cancel: exercises vault-deposit, but no command sends that call through scripts/runbook/cast-send.sh");
});

// The fund sheet (--check-sheet): the shared rules and the fund's own.
const fundSheet = (edit: (t: string) => string = (t) => t) => parseSheetText(edit(readFileSync(join(ROOT, FUND_SHEET), "utf8").replace(/^KEEPER_ADDRESS=$/m, "KEEPER_ADDRESS=0x1111111111111111111111111111111111111111")));
const line = (name: string, value: string) => (t: string) => t.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`);

test("Deploy 4: the committed fund sheet (keeper decided, D4-8) passes on the rehearsal target, and a blank keeper is refused", () => {
  expect(isFundSheet(fundSheet())).toBe(true);
  expect(sheetProblems(fundSheet(), "rehearsal", 3)).toEqual([]);
  const committed = parseSheetText(readFileSync(join(ROOT, FUND_SHEET), "utf8"));
  expect(committed.KEEPER_ADDRESS).toBe("0x75E3f84949d5e0aB621EEb06537A1a944274768B");
  expect(sheetProblems(committed, "rehearsal", 3)).toEqual([]);
  expect(sheetProblems({ ...committed, KEEPER_ADDRESS: "" }, "rehearsal", 3)).toEqual(["sheet: KEEPER_ADDRESS is missing"]);
});

test("Deploy 4: each fund sheet rule refuses its own violation", () => {
  const p = (edit: (t: string) => string, target = "rehearsal", signers: number | undefined = 3) => sheetProblems(fundSheet(edit), target, signers);
  expect(p(line("FUND_TVL_CAP", "1000000001"))).toContain("sheet: FUND_TVL_CAP 1000000001 is above 1000 USDC; a rehearsal is a contained test");
  expect(p(line("FUND_TVL_CAP", "1000000001"), "production", 3).join("\n")).not.toContain("FUND_TVL_CAP 1000000001 is above");
  expect(p(line("FUND_PER_DEPOSIT_CAP", "1000000001"))).toContain("sheet: FUND_PER_DEPOSIT_CAP is above FUND_TVL_CAP");
  expect(p(line("FUND_PER_DEPOSIT_CAP", "999999"))).toContain("sheet: FUND_PER_DEPOSIT_CAP 999999 is below the 1 USDC test request (1000000)");
  expect(p(line("FUND_MIN_SEED_USDC", "1000001"))).toContain("sheet: FUND_MIN_SEED_USDC 1000001 is above SEED_DEPOSIT_USDC 1000000: the seed stage would refuse the seed");
  expect(p((t) => line("FLOW_MIN_REQUEST_USDC", "200000000")(t))).toContain("sheet: FLOW_MIN_REQUEST_USDC 200000000 is above FUND_PER_DEPOSIT_CAP 100000000: no request could be made");
  expect(p(line("KEEPER_ADDRESS", ""))).toContain("sheet: KEEPER_ADDRESS is missing");
  expect(p(line("KEEPER_ADDRESS", "0x0000000000000000000000000000000000000003"))).toContain("sheet: KEEPER_ADDRESS is still the example placeholder 0x0000000000000000000000000000000000000003; type the real public address");
  expect(p(line("KEEPER_ADDRESS", "keeper.eth"))).toContain("sheet: KEEPER_ADDRESS 'keeper.eth' is not an address");
  expect(p(line("FUND_TVL_CAP", "1e9"))).toContain("sheet: FUND_TVL_CAP is '1e9', not a non-negative integer");
  for (const n of ["FUND_PER_DEPOSIT_CAP", "FUND_MIN_SEED_USDC", "FLOW_MIN_REQUEST_USDC"]) expect(p((t) => t.replace(new RegExp(`^${n}=.*\\n`, "m"), "")), n).toContain(`sheet: ${n} is missing`);
  for (const n of ["VAULT_USDC_TVL_CAP=1", "ROUTER_WEIGHTS=USDC:10000", "SHARE_RECEIVER_ADDRESS=0x1111111111111111111111111111111111111111", "GOVERN_UNPAUSE_VAULTS=1", "GATEWAY_ADMIN_ADDRESS=0x1"]) expect(p((t) => `${t}\n${n}\n`).join("\n"), n).toContain(`sheet: ${n.split("=")[0]} is refused in a fund sheet`);
  // a fund sheet needs no vault cap
  expect(p((t) => t).join("\n")).not.toContain("VAULT_");
});

test("Deploy 4: a fund sheet keeps every shared rule: chain, kind, delay band, the 1 USDC seed, the Safe owners and threshold, placeholders, the salt and the owner signer count", () => {
  const p = (edit: (t: string) => string, target = "rehearsal", signers: number | null = 3) => sheetProblems(fundSheet(edit), target, signers ?? undefined).join("\n");
  expect(p(line("CHAIN_ID", "1"))).toContain("sheet: CHAIN_ID is 1, rehearsal runs on 8453");
  expect(p(line("DEPLOYMENT_KIND", "production"))).toContain("sheet: DEPLOYMENT_KIND is 'production', rehearsal needs 'rehearsal'");
  expect(p(line("TIMELOCK_MIN_DELAY", "60"))).toContain("sheet: TIMELOCK_MIN_DELAY 60 is outside 900..172799 for rehearsal");
  expect(p(line("SEED_DEPOSIT_USDC", "2000000"))).toContain("sheet: SEED_DEPOSIT_USDC is 2000000; the standing rule is 1 USDC (1000000)");
  expect(p(line("SAFE_OWNERS", "0xa5dAD878b268bCf5c31E61b3bd665AEF61feA5CE,0x5c6b2a1fa3A59aCc9C943Cc93FAD204fBfB0935a"), "rehearsal", 2)).toContain("sheet: SAFE_OWNERS lists 2 owners, at least 3 are needed");
  expect(p(line("SAFE_THRESHOLD", "3"))).toContain("sheet: SAFE_THRESHOLD 3 is not 2 to 2");
  expect(p(line("EMERGENCY_ADDRESS", "0x0000000000000000000000000000000000000004"))).toContain("sheet: EMERGENCY_ADDRESS is still the example placeholder");
  expect(p((t) => t.replace(/^SAFE_SALT_NONCE=.*\n/m, ""))).toContain("sheet: a rehearsal needs an explicit SAFE_SALT_NONCE no earlier run used");
  expect(p((t) => t, "rehearsal", null)).toContain("no --owner-signers count");
  expect(p((t) => t, "rehearsal", 2)).toContain("2 owner signer specs for 3 sheet owners");
  expect(p(line("UPGRADE_MODE", "sometimes"))).toContain("sheet: UPGRADE_MODE is 'sometimes', not upgradeable or frozen");
  // on the Twin the placeholder, salt and signer rules are the Twin's, as for a vaults sheet
  expect(sheetProblems(fundSheet((t) => line("CHAIN_ID", "918453")(line("EXPECTED_CHAIN_ID", "918453")(t))), "twin", 0)).toEqual([]);
});

test("Deploy 4: a vaults sheet is checked exactly as before: never as a fund sheet, with every vault cap rule and no fund rule", () => {
  const twin = parseSheetText(TWIN_SHEET);
  expect(isFundSheet(twin)).toBe(false);
  // the exact lists the checker gave before Deploy 4 (the same rules, in the same order)
  expect(sheetProblems(twin, "rehearsal", 3)).toEqual([
    "sheet: CHAIN_ID is 918453, rehearsal runs on 8453",
    "sheet: EXPECTED_CHAIN_ID is 918453, rehearsal runs on 8453",
    "sheet: DEPLOYMENT_KIND is 'twin', rehearsal needs 'rehearsal'",
    "sheet: TIMELOCK_MIN_DELAY 60 is outside 900..172799 for rehearsal",
    "sheet: VAULT_USDC_TVL_CAP 100000000000 is above 1000 USDC; a rehearsal is a contained test",
    "sheet: VAULT_PROTO_TVL_CAP 100000000000 is above 1000 USDC; a rehearsal is a contained test",
    "sheet: VAULT_RWA_TVL_CAP 100000000000 is above 1000 USDC; a rehearsal is a contained test",
    "sheet: a rehearsal needs an explicit SAFE_SALT_NONCE no earlier run used",
  ]);
  expect(sheetProblems(parseSheetText(TWIN_SHEET.replace("VAULT_USDC_TVL_CAP=100000000000", "VAULT_USDC_TVL_CAP=1")), "twin")).toEqual(["sheet: DEPLOYMENT_KIND is 'twin', twin needs '' or 'production' or 'rehearsal'", "sheet: VAULT_USDC_PER_DEPOSIT_CAP is above its TVL cap"]);
  expect(sheetProblems(parseSheetText(TWIN_SHEET), "rehearsal", 3).join("\n")).not.toMatch(/FUND_|KEEPER_|FLOW_/);
  // a keeper line alone does not make a vaults sheet a fund sheet: its caps are still required
  expect(sheetProblems(parseSheetText(`${TWIN_SHEET.replace(/^VAULT_RWA_TVL_CAP=.*\n/m, "")}KEEPER_ADDRESS=0x1111111111111111111111111111111111111111\n`), "twin").join("\n")).toContain("sheet: VAULT_RWA_TVL_CAP is missing");
  const real = parseSheetText(readFileSync(join(ROOT, "deployments", "twin-918453", "stage-sheet.env"), "utf8"));
  expect(sheetProblems(real, "twin", 0)).toEqual([]);
});

test("a command that writes a state file and reads it back as {state:X} is refused: the runner resolves it before the command runs (P6.60, Deploy 4)", () => {
  expect(stateSelfReadProblems([{ id: "P6.60", cmds: [["bash", "-c", "cast call x > {runDir}/state/a && test {state:a} = 1"]] }]).join()).toContain("reads {state:a}");
  expect(stateSelfReadProblems([{ id: "P6.60", cmds: [["bash", "-c", 'cast call x > {runDir}/state/a && test "$(cat {runDir}/state/a)" = 1']] }])).toEqual([]);
  // reading a value an EARLIER command wrote, then writing it again, is fine
  expect(stateSelfReadProblems([{ id: "P6.61", cmds: [["bash", "-c", "echo {state:a} > {runDir}/state/a"]] }])).toEqual([]);
});

// ─── Deploy 4 hardening (owner, 2026-11-13) ────────────────────────────────────────────────────────────────────
test("hardening: on every target the fund flow's first keeper send has a hard keeper-gas check before it (P3.63 on 8453, P0.71 on the Twin)", () => {
  const r = fundRelease();
  expect(keeperGasProblems(r)).toEqual([]);
  for (const target of ["twin", "rehearsal"]) {
    const run = applicableSteps(r, target);
    const first = run.findIndex((s) => s.cmds.some((c) => c.includes("{keepercast}")));
    expect(first, target).toBeGreaterThan(0);
  }
  expect(applicableSteps(r, "rehearsal").map((s) => s.id).indexOf("P3.63-fund-keeper-gas")).toBeLessThan(applicableSteps(r, "rehearsal").map((s) => s.id).indexOf("P6.61-fund-settle-deposits"));
});

test("hardening: a release whose keeper sends without a hard keeper-gas check is refused on that target", () => {
  const r = fundRelease();
  const drop = (id: string) => ({ ...r, steps: r.steps.filter((s) => s.id !== id) });
  // without P3.63 the 8453 rehearsal has only P0.72's advisory balance line (|| echo advisory), which is no gate
  const noFunding = keeperGasProblems(drop("P3.63-fund-keeper-gas"));
  expect(noFunding.join("\n")).toContain("on rehearsal");
  expect(noFunding.join("\n")).not.toContain("on twin"); // the Twin's P0.71 still sets and asserts the keeper's balance
  expect(keeperGasProblems(drop("P0.71-fund-twin-fund")).join("\n")).toBe(""); // P3.63 runs on the Twin too
  // the check turned advisory (a || fallback) is refused
  const soft = { ...r, steps: r.steps.map((s) => (s.id === "P3.63-fund-keeper-gas" || s.id === "P0.71-fund-twin-fund" ? { ...s, cmds: s.cmds.map((c) => c.map((a) => a.includes("qa-assert.ts ge") ? `${a} || echo advisory` : a)) } : s)) };
  expect(keeperGasProblems(soft).length).toBe(2);
  // a gate that a rerun may skip (gateAbsent) does not count
  const skippable = { ...r, steps: r.steps.map((s) => (s.id === "P3.63-fund-keeper-gas" || s.id === "P0.71-fund-twin-fund" ? { ...s, gateAbsent: "{runDir}/state/x" } : s)) };
  expect(keeperGasProblems(skippable).length).toBe(2);
  // P3.63 moved after the first keeper send no longer gates it on 8453
  const i = r.steps.findIndex((s) => s.id === "P3.63-fund-keeper-gas");
  const late = [...r.steps.slice(0, i), ...r.steps.slice(i + 1)];
  late.splice(late.findIndex((s) => s.id === "P6.62-fund-claim-deposit"), 0, r.steps[i]!);
  expect(keeperGasProblems({ ...r, steps: late }).join("\n")).toContain("P6.61-fund-settle-deposits sends from the keeper's key ({keepercast}) on rehearsal");
});

test("hardening: the planted drift (P3.63 dropped) fails the whole validator", () => {
  const p = problemsWith(FUND_RELEASE, (t) => t.replace(stepBlock(t, "P3.63-fund-keeper-gas"), ""));
  expect(p.join("\n")).toContain("no earlier step on rehearsal funds or checks the keeper's ETH");
});

test("decision D4-11: the deposit claim waits at least the sheet's FLOW_MIN_HOLD", () => {
  const r = fundRelease();
  const sheet = parseSheetText(readFileSync(join(ROOT, FUND_SHEET), "utf8"));
  expect(sheet.FLOW_MIN_HOLD).toBe("3600");
  expect(holdWaitProblems(r, sheet)).toEqual([]);
  expect(holdWaitProblems(r, { ...sheet, FLOW_MIN_HOLD: "86400" }).join("\n")).toContain("P6.62-fund-claim-deposit claims deposit shares 1 h after P6.61-fund-settle-deposits, under the sheet's FLOW_MIN_HOLD of 86400 s");
  const noWait = { ...r, steps: r.steps.map((s) => (s.id === "P6.62-fund-claim-deposit" ? { ...s, notBefore: undefined } : s)) };
  expect(holdWaitProblems(noWait, sheet).join("\n")).toContain("P6.62-fund-claim-deposit claims deposit shares with no notBefore");
  expect(holdWaitProblems(r, {}).join("\n")).toContain("has no FLOW_MIN_HOLD");
  const d = r.decisions.find((x) => x.id === "D4-11")!;
  expect(d.status).toBe("decided");
  expect(d.answer).toContain("Owner, 2026-11-13: minHold 1 hour");
});

test("decision D4-10: every fund timelock execute goes through the Safe with two owner signatures, and the decision is recorded", () => {
  const r = fundRelease();
  expect(fundExecuteProblems(r)).toEqual([]);
  const d = r.decisions.find((x) => x.id === "D4-10")!;
  expect(d.status).toBe("decided");
  expect(d.answer).toStartWith("Owner, 2026-11-13: Safe-only executor for the fund timelock");
  const executes = r.steps.filter((s) => s.flow === "fund" && s.cmds.some((c) => c.join(" ").includes("--action execute")));
  expect(executes.map((s) => s.id)).toEqual(["P3.62-fund-register-submitter-execute", "P6.74-fund-apply-receipt-execute", "P9.62-fund-unpause-execute", "P9.71-fund-upgrade-execute", "P9.72-fund-verify-final"]);
  // one owner signature dropped: refused
  const oneSig = { ...r, steps: r.steps.map((s) => (s.id === "P6.74-fund-apply-receipt-execute" ? { ...s, cmds: s.cmds.filter((c) => !c.includes("{ownerSigner2}")) } : s)) };
  expect(fundExecuteProblems(oneSig).join("\n")).toContain("P6.74-fund-apply-receipt-execute proposes a fund timelock execute");
  // a direct execute on the fund timelock (the open-executor path): refused
  const direct = { ...r, steps: r.steps.map((s) => (s.id === "P9.62-fund-unpause-execute" ? { ...s, cmds: [...s.cmds, ["bash", "scripts/runbook/cast-send.sh", "{m:fund-timelock.timelock}", "execute(address,uint256,bytes,bytes32,bytes32)", "{cast}"]] } : s)) };
  expect(fundExecuteProblems(direct).join("\n")).toContain("P9.62-fund-unpause-execute calls the fund timelock's execute directly");
});

test("owner liveness: P2.61 runs after the fund verify on the Twin and the rehearsal and reads the prove-control record with every SAFE_OWNERS entry", () => {
  const r = fundRelease();
  for (const target of ["twin", "rehearsal"]) {
    const ids = applicableSteps(r, target).map((s) => s.id);
    expect(ids.indexOf("P2.61-fund-owner-liveness"), target).toBe(ids.indexOf("P2.60-fund-verify") + 1);
  }
  const s = r.steps.find((x) => x.id === "P2.61-fund-owner-liveness")!;
  const j = s.cmds.map((c) => c.join(" ")).join("\n");
  expect(j).toContain("publish-contracts/src/ci/owner-liveness.ts --run-manifest {evidenceDir}/publish-run.json --owners {sheet:SAFE_OWNERS}");
  expect(s.expectExit).toBe(0);
  expect(s.receipts.some((x) => x.pattern === "owner-liveness.json" && x.required)).toBe(true);
  // a flag the tool does not take is refused against the real CLI
  const bad = { ...s, cmds: [[...s.cmds[0]!, "--no-such-flag", "x"]] };
  expect(commandProblems([bad], model).join("\n")).toContain("--no-such-flag");
});

test("version bump (owner, 2026-11-13): v0.7.0-onevault stays Deploy 4's record and still validates, v0.8.0-onevault carries the hardening", () => {
  const old = deploy4Release(), now = fundRelease();
  expect(old.release).toBe("v0.7.0-onevault");
  expect(now.release).toBe("v0.8.0-onevault");
  // the record is unchanged: no D4-10 or D4-11, no owner liveness row, the 24 h hold
  expect(old.decisions.map((d) => d.id)).not.toContain("D4-10");
  expect(old.steps.map((s) => s.id)).not.toContain("P2.61-fund-owner-liveness");
  expect(old.steps.find((s) => s.id === "P6.62-fund-claim-deposit")!.notBefore).toEqual({ afterStep: "P6.61-fund-settle-deposits", hours: 24 });
  // it still passes the new rules (its keeper is funded by P3.63, its 24 h wait covers the 1 h hold, its executes go through the Safe)
  const sheet = parseSheetText(readFileSync(join(ROOT, FUND_SHEET), "utf8"));
  expect([...keeperGasProblems(old), ...fundExecuteProblems(old), ...holdWaitProblems(old, sheet)]).toEqual([]);
  // the successor holds every step of the record plus P2.61, each added by v0.8.0-onevault
  const added = (r: typeof old) => r.steps.filter((s) => s.added !== undefined).map((s) => s.id);
  expect(added(now).filter((id) => id !== "P2.61-fund-owner-liveness")).toEqual(added(old));
  expect(now.decisions.map((d) => d.id)).toEqual([...old.decisions.map((d) => d.id), "D4-10", "D4-11"]);
  expect(runnableProblems(now, "rehearsal")).toEqual([]);
  expect(runnableProblems(now, "twin")).toEqual([]);
});
