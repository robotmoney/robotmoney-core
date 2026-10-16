// Issue 1809 docs drift check: the release runbook's governed-proxy section (docs/operations/contract-release-runbooks.md 4.12) and the code agree. The stage order and the
// proxy table equal the stage table's `proxies`, the transactions per proxy and the CREATE2 assumption equal `upgradeAuthority`, the verifier labels and the sheet names are
// quoted exactly, and the exit codes named are the CLI's. A change on either side without the other fails CI (publish-contracts-tests, suite 28).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { SHEET_SPEC, UPGRADE_MODES } from "../src/sheet.ts";
import { getStageTable } from "../src/stages.ts";
import { CLAIM_LABEL, CODE_LABEL, DEADLINE_LABEL, MODE_LABEL, PROXY_LABELS } from "../src/verify/upgradeability.ts";
import { UPGRADEABILITY_MANIFEST } from "../src/verify-stage.ts";
import { REPO } from "./fixtures.ts";

const RUNBOOK = readFileSync(join(REPO, "docs", "operations", "contract-release-runbooks.md"), "utf8");
const SECTION = (() => {
  const start = RUNBOOK.indexOf("### 4.12. Governed proxies");
  const end = RUNBOOK.indexOf("\n## 5. ", start);
  if (start < 0 || end < 0) throw new Error("the runbook has no section 4.12 Governed proxies before section 5");
  return RUNBOOK.slice(start, end);
})();
const table = getStageTable();
const u = table.upgradeAuthority!;

describe("runbook 4.12 and the stage table agree (issue 1809)", () => {
  test("the proxy table lists the stage table's proxies, in stage order, with the same fields and contracts", () => {
    const rows = [...SECTION.matchAll(/^\| `([\w-]+)` \| `(\w+)` \| `(\w+)` \| `(\w+)` \|$/gm)].map((m) => [m[1], m[2], m[3], m[4]]);
    const want = table.stages.flatMap((s) => (s.proxies ?? []).map((p) => [s.name, p.field, p.implementationField, p.contract]));
    expect(want.length).toBe(10);
    expect(rows).toEqual(want);
  });
  test("the upgrade authority is deployed last, at the stated CREATE2 address, and each proxy is the stated number of transactions", () => {
    expect(table.stages[table.stages.length - 1]!.name).toBe(u.stage);
    expect(SECTION).toContain(`the \`${u.stage}\` stage, which deploys the upgrade authority LAST`);
    expect(SECTION).toContain(`Each proxy is ${u.transactionsPerProxy} deployer transactions`);
    expect(SECTION).toContain(`\`${u.factory}\``);
    expect(SECTION).toContain(`\`${u.salt}\``);
    for (const i of u.inputs) expect(SECTION).toContain(`\`${i}\``);
    expect(SECTION).toContain(`\`${u.contract}\``);
  });
  test("the sheet names and modes are the parser's", () => {
    for (const n of ["UPGRADE_MODE", "UPGRADE_FREEZE_DEADLINE"]) { expect(SHEET_SPEC).toHaveProperty(n); expect(SECTION).toContain(`\`${n}\``); }
    expect(u.modeEnv).toBe("UPGRADE_MODE");
    for (const m of UPGRADE_MODES) { expect(u.modes).toContain(m); expect(SECTION).toContain(`\`${m}\``); }
  });
  test("every upgradeability label of the verifier is quoted exactly, and the record file is the one verify writes", () => {
    for (const l of [...PROXY_LABELS, CODE_LABEL, MODE_LABEL, DEADLINE_LABEL, CLAIM_LABEL]) expect(SECTION, l).toContain(`\`${l}\``);
    expect(SECTION).toContain(`deployments/<chain>/${UPGRADEABILITY_MANIFEST}`);
  });
  test("the exit codes the section names are the CLI's", () => {
    for (const [kind, code] of [["RESUME", 16], ["MANIFEST", 12], ["VERIFY", 13]] as const) {
      expect(EXIT_CODES[kind]).toBe(code);
      expect(SECTION).toContain(`\`${kind}\`, exit ${code}`);
    }
  });
  test("the section assigns freeze ownership, the deadline, the missed-deadline alerts, says the deadline is not on chain, and plans the cutover under ADR-0009 without executing it", () => {
    for (const s of ["**Freeze ownership.**", "**Missed-deadline alerts.**", "**The deadline is not an on-chain freeze.**", "Nothing on chain freezes a proxy", "freezeUpgrades(expectedImplementation, expectedCodeHash)", "**Voluntary cutover", "not executed by this issue", "ADR-0009-vault-retirement-no-assisted-migration.md", "`redeemInKind`"]) expect(SECTION, s).toContain(s);
  });
});

// Issue 1811 docs drift check: the release checklist names the external security review a final mainnet release requires, and the runbook names the Twin lifecycle
// rehearsal the code runs (the CI job, the sheet overlay, the harness and the evidence flag all exist under those names).
describe("the release checklist and the Twin lifecycle rehearsal (issue 1811)", () => {
  const gate = (() => {
    const start = RUNBOOK.indexOf("### 4.1. Code-readiness gate");
    const end = RUNBOOK.indexOf("### 4.2.", start);
    if (start < 0 || end < 0) throw new Error("the runbook has no section 4.1 Code-readiness gate before 4.2");
    return RUNBOOK.slice(start, end);
  })();
  const tracking = RUNBOOK.slice(RUNBOOK.indexOf("## 6. Per-release GitHub tracking issue"), RUNBOOK.indexOf("## 7. "));
  test("the code-readiness gate requires an external security review before a final mainnet release, never waived, covering the proxy form", () => {
    for (const s of ["**External security review before a final mainnet release.**", "completed external security review of the exact contracts", "`GovernedUUPS`", "`freezeUpgrades`", "`docs/audits.md`", "never waived for a final release"]) expect(gate, s).toContain(s);
  });
  test("the tracking issue checklist carries the external review item and the lifecycle job", () => {
    expect(tracking).toContain("External security review completed for the release SHA");
    expect(tracking).toContain("`core-stages-twin-upgrade-lifecycle`");
  });
  test("the runbook names the rehearsal the code runs", () => {
    const wf = readFileSync(join(REPO, ".github", "workflows", "suite-28-core-stages.yml"), "utf8");
    expect(wf).toContain("name: core-stages-twin-upgrade-lifecycle");
    expect(wf).toContain("sheet-overlay: deployments/twin-918453/upgrade-rehearsal.env");
    expect(wf).toContain("bun publish-contracts/src/ci/twin-upgrade-lifecycle.ts");
    expect(readFileSync(join(REPO, "deployments", "twin-918453", "upgrade-rehearsal.env"), "utf8")).toMatch(/^UPGRADE_MODE=upgradeable$/m);
    expect(readFileSync(join(REPO, "publish-contracts", "src", "evidence-check.ts"), "utf8")).toContain('"upgrade-lifecycle": { type: "string" }');
    const required = JSON.parse(readFileSync(join(REPO, "scripts", "ci", "required-checks.json"), "utf8")).required.map((r: { name: string }) => r.name);
    expect(required).toContain("core-stages-twin-upgrade-lifecycle");
    for (const s of ["`core-stages-twin-upgrade-lifecycle`", "`deployments/twin-918453/upgrade-rehearsal.env`", "`publish-contracts/src/ci/twin-upgrade-lifecycle.ts`", "--upgrade-lifecycle FILE --rpc URL", "`UpgradesAreFrozen`", "**Rollback is not assumed safe.**", "**After a governed upgrade.**"]) expect(SECTION, s).toContain(s);
  });
});

// Issue 1842 docs drift check: runbook 4.12 names the two operator rows the code runs, the manifest re-record, the WARN and ESCALATE states verify reports, and the
// upgradeability plan no longer says publish passes a fixed frozen mode.
describe("the operator rows and the deadline alert states (issue 1842)", () => {
  test("runbook 4.12 names govern --row freeze-upgrades and govern --row upgrade-proxy, the re-record step and the WARN and ESCALATE states", async () => {
    const { FREEZE_ROW, UPGRADE_ROW } = await import("../src/upgrade-rows.ts");
    expect([FREEZE_ROW, UPGRADE_ROW]).toEqual(["freeze-upgrades", "upgrade-proxy"]);
    for (const s of [`govern --row ${FREEZE_ROW}`, `govern --row ${UPGRADE_ROW} --proxy NAME --implementation 0x<new>`, "--upgrade-build DIR", "**The governed upgrade procedure:", "**Layout review.**", "**Schedule.**", "**Execute.**", "**Re-record.**",
      "rewrites the proxy's stage manifest", "`gateway_implementation_runtime_hash` and `gateway_runtime_hash`", "`proxy_upgrades`", "`upgrade_freezes`", "`govern.preview`", "starts with `WARN`", "starts with `ESCALATE`", "starts with `MISSED`",
      "`freeze_block` and `freeze_tx`", "(`govern --row upgrade-proxy` back to the previous implementation), possible only while the proxy is unfrozen", "now + `TIMELOCK_MIN_DELAY` + 1 day"]) expect(SECTION, s).toContain(s);
    expect(SECTION).not.toContain("is not part of this procedure yet");
    // the verifier detail words are the ones the runbook quotes
    const src = readFileSync(join(REPO, "publish-contracts", "src", "verify", "upgradeability.ts"), "utf8");
    for (const w of ['"ESCALATE" : "WARN"', "MISSED: ", "govern --row freeze-upgrades"]) expect(src).toContain(w);
  });
  test("the upgradeability plan does not say publish passes a fixed frozen mode", () => {
    const plan = readFileSync(join(REPO, "docs", "technical", "contract-upgradeability-plan.md"), "utf8");
    expect(plan).not.toContain("publish passes `UPGRADE_MODE=frozen`");
    expect(plan).toContain("publish passes the sheet's `UPGRADE_MODE`");
  });
});

// Issue 1846 docs drift check: one required-check policy for the lifecycle job (the runbook and scripts/ci/required-checks.json agree), the 4.1 closing sentence scoped to the
// items that apply, and 4.12 naming who owns the implementation deploy with library linking and the manifest re-record.
describe("the lifecycle job's required-check policy and the 4.1 and 4.12 wording (issue 1846)", () => {
  const gate = RUNBOOK.slice(RUNBOOK.indexOf("### 4.1. Code-readiness gate"), RUNBOOK.indexOf("### 4.2."));
  const item4 = gate.slice(gate.indexOf("4. **Twin rehearsal of the governed proxy lifecycle.**"), gate.indexOf("Do not begin preflight"));
  const greenOnly = (() => {
    const start = RUNBOOK.indexOf("  - **Green rehearsal only.**");
    const end = RUNBOOK.indexOf("\n  - **", start + 1);
    if (start < 0 || end < 0) throw new Error("the runbook has no Green rehearsal only bullet");
    return RUNBOOK.slice(start, end);
  })();
  test("4.1 item 4 gates every DEPLOY_SHA with the lifecycle job, as the required list does", () => {
    expect(item4.length).toBeGreaterThan(0);
    expect(item4).not.toContain("For a release that deploys governed proxies");
    expect(item4).toContain("`core-stages-twin-upgrade-lifecycle` gates every `DEPLOY_SHA`");
    const required = JSON.parse(readFileSync(join(REPO, "scripts", "ci", "required-checks.json"), "utf8")).required.map((r: { name: string }) => r.name);
    expect(required).toContain("core-stages-twin-upgrade-lifecycle");
    expect(required).not.toContain("core-stages-twin-chain");
  });
  test("the Green rehearsal only bullet names both Twin jobs and the re-run recovery", () => {
    for (const s of ["`core-stages-twin-chain`", "`core-stages-twin-upgrade-lifecycle`", "gated indirectly", "directly through `check-sha-green`", "re-run the failed job", "`filter=latest`"]) expect(greenOnly, s).toContain(s);
  });
  test("the 4.1 closing sentence applies only the items that apply to this deployment", () => {
    expect(gate).toContain("that applies to this deployment");
    expect(gate).not.toContain("while any of the above is incomplete");
  });
  test("4.12 assigns the implementation deploy with library linking and the manifest re-record to the operator tooling follow-up (1842)", () => {
    const own = SECTION.slice(SECTION.indexOf("**Ownership of the implementation deploy and the re-record.**"), SECTION.indexOf("**After a governed upgrade.**"));
    expect(own.length).toBeGreaterThan(0);
    for (const s of ["Deploying the new implementation with its library links", "re-recording the stage manifest", "gateway runtime hashes", "owned by the operator tooling follow-up (1842)", "only executed path", "`publish-contracts/src/ci/twin-upgrade-lifecycle.ts`"]) expect(own, s).toContain(s);
  });
});
