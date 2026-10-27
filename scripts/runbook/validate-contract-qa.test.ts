// Drift test for scripts/runbook/validate-contract-qa.ts: the committed contract QA runbook is clean, and each planted drift fails.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_DIR, ROOT, applicableSteps, loadModel, localForkProblems, qaSupersetProblems, recordStepProblems, sends, parseSheetText, runnableProblems, sheetProblems, mainOutProblems, unwindGuardProblems, validateAll } from "./validate-contract-qa.ts";

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
  expect(p.every((x) => x.includes("v0.6.0"))).toBe(true);
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
  for (const line of UPGRADE_FROM_V050_COMMANDS) {
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
  expect(p.join("\n")).toContain("P8.04-v050-addresses");
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
  for (const id of ["P0.01-runbook-valid", "P1.50-record-go", "P8.06-v050-pre-state", "P8.23-v050-apply-receipt", "P8.29-v050-router-deposit", "P8.34-v050-pause-all", "P8.37-v050-verify-final", "P10.53-write-three-vault-rollout-report", "P10.52-record-signoff"]) expect(ids("rehearsal"), id).toContain(id);
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
  expect(joined("P8.31-v050-gateway-deposit-router")).toContain("depositTo(");
  expect(joined("P8.33-v050-retired-vault")).toContain("redeemInKind");
  expect(joined("P8.34-v050-pause-all")).toContain("pause-all");
  expect(joined("P8.36-v050-unpause")).toContain("--row unpause-RWA");
  const order = r.steps.map((s) => s.id);
  for (const [a, b] of [["P8.15-v050-retire-vault", "P8.20-v050-register-submitter"], ["P8.22-v050-record-receipt", "P8.23-v050-apply-receipt"], ["P8.34-v050-pause-all", "P8.35-v050-redeem-while-paused"], ["P8.36-v050-unpause", "P8.37-v050-verify-final"], ["P8.38-v050-evidence-final", "P8.90-v050-teardown"]]) expect(order.indexOf(a), `${a} before ${b}`).toBeLessThan(order.indexOf(b));
  // the governed operations are gated on the done-* markers P8.06 writes, so a rerun on an upgraded deployment skips them by their own gate
  for (const [id, marker] of [["P8.10-v050-deploy-gateway-impl", "done-gateway-upgrade"], ["P8.13-v050-upgrade-receipt", "done-receipt-upgrade"], ["P8.14-v050-clear-voted-weights", "done-clear-voted-weights"], ["P8.15-v050-retire-vault", "done-retire-vault"]]) expect(r.steps.find((s) => s.id === id)!.gateAbsent, id).toBe(`{runDir}/state/${marker}`);
  expect(r.steps.find((s) => s.id === "P8.06-v050-pre-state")!.writes).toEqual(expect.arrayContaining(["done-gateway-upgrade", "done-receipt-upgrade", "done-clear-voted-weights", "done-retire-vault"]));
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
