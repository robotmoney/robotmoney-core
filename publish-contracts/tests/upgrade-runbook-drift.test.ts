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
