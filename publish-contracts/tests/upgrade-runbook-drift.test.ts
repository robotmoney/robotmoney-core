// Issue 1809 docs drift check: the release runbook's governed-proxy section (docs/operations/contract-release-runbooks.md 4.12) and the code agree. The stage order and the
// proxy table equal the stage table's `proxies`, the transactions per proxy and the CREATE2 assumption equal `upgradeAuthority`, the verifier labels and the sheet names are
// quoted exactly, and the exit codes named are the CLI's. A change on either side without the other fails CI (publish-contracts-tests, suite 28).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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
    expect(want.length).toBe(8);
    expect(rows).toEqual(want);
  });
  test("the upgrade authority is deployed last, at the stated CREATE2 address, and each proxy is the stated number of transactions", () => {
    expect(table.stages.filter((s) => s.system !== "gateway").at(-1)!.name).toBe(u.stage); // issue 1892: last of the vaults system; the gateway system runs after it
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
    for (const s of ["Deploying the new implementation with its library links", "re-recording the stage manifest", "gateway runtime hashes", "owned by the operator tooling follow-up (1842)", "`publish-contracts/src/ci/twin-upgrade-lifecycle.ts`"]) expect(own, s).toContain(s);
  });
});

// Issue 1859 docs drift check: 4.12 describes verify's per-proxy build directories (verify-stage.ts proxyBuildDirsOf) and no longer states the deployed-build-only limitation;
// it names the rerun and already-executed behavior of the rows, and the Twin harness runs both rows.
describe("per-proxy build directories and the row follow-ups (issue 1859)", () => {
  const after = SECTION.slice(SECTION.indexOf("**After a governed upgrade.**"), SECTION.indexOf("**Rollback is not assumed safe.**"));
  test("4.12 describes per-proxy build directories and no longer states the deployed-build-only limitation", () => {
    expect(after.length).toBeGreaterThan(0);
    for (const s of ["per-proxy build directories", `\`${CODE_LABEL}\``, "the `build` its last `proxy_upgrades` entry names", "every other contract with the DEPLOY_SHA's `out/`"]) expect(after, s).toContain(s);
    expect(SECTION).not.toContain("verify compares every contract with one build directory");
    expect(SECTION).not.toContain("re-records in its own harness");
    const stage = readFileSync(join(REPO, "publish-contracts", "src", "verify-stage.ts"), "utf8");
    expect(stage).toContain("...proxyBuildDirsOf(manifest, join(ctx.coreDir, \"out\"))");
  });
  test("4.12 names the stale-rerun guard, the already-executed repair and the null execute_tx note, and the Twin harness runs both rows", () => {
    for (const s of ["gated on the live implementation slot", "leaves the manifest and the entry unchanged", "`CallExecuted` log", "`execute_tx` null with a `note`", "`govern --row freeze-upgrades --no-warp --max-wait 0`"]) expect(SECTION, s).toContain(s);
    const harness = readFileSync(join(REPO, "publish-contracts", "src", "ci", "twin-upgrade-lifecycle.ts"), "utf8");
    for (const s of ['"--row", UPGRADE_ROW', '"--row", FREEZE_ROW, "--no-warp", "--max-wait", "0"]', "governedUpgradeProblems("]) expect(harness, s).toContain(s);
  });
});

// Issue 1861 docs drift check: runbook 4.12 step 2 is the deploy-implementation verb (no longer "no command"), the ownership paragraph names it, and the Twin harness
// deploys through the verb instead of a raw cast send --create.
describe("the deploy-implementation verb in runbook 4.12 and the Twin harness (issue 1861)", () => {
  test("step 2 names deploy-implementation, its refusals and the record, and the ownership paragraph no longer says no command exists", async () => {
    const { DEPLOY_IMPL_VERB } = await import("../src/deploy-implementation.ts");
    const step2 = SECTION.slice(SECTION.indexOf("2. **Deploy the implementation.**"), SECTION.indexOf("3. **Schedule.**"));
    expect(step2.length).toBeGreaterThan(0);
    for (const s of [`bun publish-contracts/src/cli.ts ${DEPLOY_IMPL_VERB} --proxy NAME --upgrade-build DIR`, "`upgradesFrozen()` true", "append-only", "does not link", "does not name", "`implementation_deploys`", "`govern --row upgrade-proxy --implementation`", "sends nothing", "release gate"]) expect(step2, s).toContain(s);
    expect(step2).not.toContain("the Twin rehearsal's harness does the same");
    const own = SECTION.slice(SECTION.indexOf("**Ownership of the implementation deploy and the re-record.**"), SECTION.indexOf("**After a governed upgrade.**"));
    expect(own).toContain(`\`${DEPLOY_IMPL_VERB}\` verb (issue 1861)`);
    for (const s of ["ships no command", "until one lands", "only executed path", "cast send --create"]) expect(own, s).not.toContain(s);
    const usage = (await import("../src/cli.ts")).USAGE;
    expect(usage).toContain(`${DEPLOY_IMPL_VERB} = step 2 of a governed upgrade`);
    expect(readFileSync(join(REPO, "publish-contracts", "README.md"), "utf8")).toContain(`\`${DEPLOY_IMPL_VERB} --proxy NAME [--upgrade-build DIR]\` (issue 1861`);
  });
  test("the Twin harness deploys its second gateway implementation through the verb, never a raw CREATE", () => {
    const harness = readFileSync(join(REPO, "publish-contracts", "src", "ci", "twin-upgrade-lifecycle.ts"), "utf8");
    expect(harness).toContain('stage(DEPLOY_IMPL_VERB, stdoutTo, ["--proxy", UPGRADED_PROXY])');
    expect(harness).not.toContain('"--create"');
    expect(harness.indexOf("deployImpl(join(rh, \"deploy-implementation.txt\"))")).toBeLessThan(harness.indexOf('"--row", UPGRADE_ROW'));
  });
  test("the receipt migration step takes its new implementation from the verb, and the only raw CREATEs are the legacy fixture's (issue 1910)", () => {
    const harness = readFileSync(join(REPO, "publish-contracts", "src", "ci", "twin-upgrade-lifecycle.ts"), "utf8");
    const fixture = readFileSync(join(REPO, "publish-contracts", "src", "ci", "twin-legacy-receipt.ts"), "utf8");
    expect(harness).toContain('stage(DEPLOY_IMPL_VERB, join(rh, "deploy-implementation-receipt.txt"), ["--proxy", rcSpec.name])');
    expect(harness).toContain('"--migration", MIGRATION');
    expect(harness).not.toContain('"--create"');
    // the fixture creates the v0.5.0 proxy and its legacy implementation; it never creates what the rehearsal upgrades to, and it schedules nothing
    expect(fixture.match(/"--create"/g)?.length).toBe(2);
    expect(fixture).toContain("LegacyConsensusRecommendationReceipt");
    expect(fixture).not.toContain("upgradeToAndCall");
    expect(fixture.match(/artifactJson\(o\.outDir, [^)]+\)/g)).toEqual(["artifactJson(o.outDir, LEGACY_RECEIPT_CONTRACT)", 'artifactJson(o.outDir, "ERC1967Proxy")']);
  });
});

// Issue 1914 docs drift check: every command and flag of runbook 4.15 (the v0.6.0 governed upgrade of the live Deploy 3) exists. A publish-contracts command is parsed by the real
// parseCli (a nonexistent verb, govern row or flag throws), an evidence-check flag must be one of its parseArgs options, a cast call must name a function the contracts declare,
// and a `govern --row NAME` mention in prose must name a row the CLI knows. The checker is itself tested against planted bad steps.
describe("runbook 4.15 names only govern rows, flags and functions that exist (issue 1914)", () => {
  const S415 = (() => {
    const start = RUNBOOK.indexOf("### 4.15. The v0.6.0 governed upgrade");
    const end = RUNBOOK.indexOf("\n## 5. ", start);
    if (start < 0 || end < 0) throw new Error("the runbook has no section 4.15 before section 5");
    return RUNBOOK.slice(start, end);
  })();
  const placeholder = (name: string): string => (name === "RC_SHA" ? "a".repeat(40) : name === "V050_SHA" ? "57fbe61833e9d7f94557d69102138f7c410c1346" : name === "BASE_RPC_URL" ? "http://127.0.0.1:8545" : name === "PWD" || name === "V050_DIR" ? "/x" : `0x${"1".repeat(40)}`);
  const split = (line: string): string[] => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  const expand = (line: string, common: string): string[] =>
    split(line.replace(/\$COMMON\b/g, common)).map((t) => t.replace(/\$\{?([A-Z_0-9]+)\}?/g, (_m, n: string) => placeholder(n)));
  const commands = (text: string): string[] => {
    const out: string[] = [];
    for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) out.push(...block[1]!.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("export ")));
    return out;
  };
  // hasRole is inherited from OpenZeppelin AccessControl, whose submodule is not part of the scan.
  const INHERITED = new Set(["hasRole", "PROPOSER_ROLE", "EXECUTOR_ROLE"]);
  // getOwners and getThreshold are the Safe's own (the vendored 1.4.1 OwnerManager the Twin deploys).
  const safeSrc = readFileSync(join(REPO, "contracts", "test", "vendor", "safe-1.4.1", "base", "OwnerManager.sol"), "utf8");
  const optionKeys = (src: string): Set<string> => new Set([...src.slice(src.indexOf("parseArgs({ options:")).split("\n")[0]!.matchAll(/"?([\w-]+)"?: \{ type:/g)].map((m) => m[1]!));
  const evidenceSrc = readFileSync(join(REPO, "publish-contracts", "src", "evidence-check.ts"), "utf8");
  const contractSrc = (() => {
    let all = "";
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { if (e.name !== "test") walk(p); } else if (e.name.endsWith(".sol")) all += readFileSync(p, "utf8"); } };
    walk(join(REPO, "contracts"));
    return all;
  })();
  const KNOWN_ROWS = async (): Promise<Set<string>> => {
    const g = await import("../src/govern.ts");
    const u = await import("../src/upgrade-rows.ts");
    const r = await import("../src/retire-vault.ts");
    const a = await import("../src/apply-receipt.ts");
    const s = await import("../src/submitter-register.ts");
    return new Set<string>([...g.GOVERN_ROWS, ...g.SELF_ADMIN_ROWS, g.RECEIPT_ROW, a.APPLY_ROW, s.REGISTER_ROW, r.RETIRE_ROW, u.UPGRADE_ROW, u.FREEZE_ROW]);
  };
  /** Returns the problems of one command line of the section (empty when every verb, row and flag exists). */
  const problems = async (line: string, common: string): Promise<string[]> => {
    if (line.startsWith("COMMON=")) return [];
    if (line.startsWith("git fetch ")) {
      // step 0 (review-operations): the rc commit is on the fetched release branch
      return /^git fetch origin (releases-\d+\.\d+\.x) && git merge-base --is-ancestor "\$RC_SHA" origin\/\1$/.test(line) ? [] : [`${line}: the release-branch check must fetch origin releases-A.B.x and test --is-ancestor "$RC_SHA" on it`];
    }
    if (line.startsWith("test ")) {
      // step 0: `test <lhs> = "$RC_SHA"` or `test -z "$(git status --porcelain)"` over a git read of the rc checkout (the working directory), and the same three reads of the v0.5.0
      // checkout with `git -C "$V050_DIR"`, whose rev-parse must equal "$V050_SHA" (issue 1927)
      const g = line.match(/\$\(git (-C "\$V050_DIR" )?([a-z-]+)([^)]*)\)/);
      if (!g) return [`${line}: a test line must read the checkout with git`];
      const want = g[1] ? "V050_SHA" : "RC_SHA";
      if (g[2] === "status") return /--porcelain\b/.test(g[3]!) && line.startsWith("test -z ") ? [] : [`${line}: git status must be --porcelain asserted empty`];
      if (g[2] === "rev-parse") return new RegExp(`= "\\$${want}"$`).test(line) && (g[3]!.trim() === "HEAD" || /\^\{commit\}/.test(g[3]!)) ? [] : [`${line}: git rev-parse must equal $${want}`];
      return [`${line}: git ${g[2]} is not a checkout check this runbook knows`];
    }
    const t = expand(line, common);
    if (t[0] === "bun" && t[1] === "publish-contracts/src/cli.ts") {
      const { parseCli } = await import("../src/cli.ts");
      try { parseCli(t.slice(2)); return []; } catch (e) { return [`${line}: ${(e as Error).message.split("\n")[0]}`]; }
    }
    if (t[0] === "bun" && t[1] === "publish-contracts/src/evidence-check.ts") {
      const keys = optionKeys(evidenceSrc);
      return t.filter((x) => x.startsWith("--")).filter((f) => !keys.has(f.slice(2))).map((f) => `${line}: evidence-check has no ${f}`);
    }
    if (t[0] === "cast" && (t[1] === "call" || t[1] === "send")) {
      const sig = t.find((x) => /^[A-Za-z_][\w]*\(.*\)/.test(x));
      const name = sig?.slice(0, sig.indexOf("("));
      if (name === undefined) return [`${line}: no function signature`];
      if (INHERITED.has(name)) return [];
      if (new RegExp(`function ${name}\\s*\\(`).test(safeSrc)) return [];
      return new RegExp(`function ${name}\\s*\\(|public[^;=]*\\b${name}\\b`).test(contractSrc) ? [] : [`${line}: no contract declares ${name}`];
    }
    if (t[0] === "cast" && (t[1] === "storage" || t[1] === "codehash")) return [];
    if (t[0] === "bun" && t[1] === "scripts/runbook/run-record.ts") {
      const src = readFileSync(join(REPO, "scripts", "runbook", "run-record.ts"), "utf8");
      return t.filter((x) => x.startsWith("--")).filter((f) => !src.includes(`"${f.slice(2)}"`)).map((f) => `${line}: run-record has no ${f}`);
    }
    return [`${line}: not a command this check knows`];
  };
  const common = (() => {
    const m = S415.match(/^COMMON="([^"]*)"$/m);
    if (!m) throw new Error("section 4.15 does not define COMMON");
    return m[1]!;
  })();

  test("the section defines the shared arguments and has the owner-gated numbered mainnet steps, not checkboxes", () => {
    for (const f of ["--chain 8453", "--rpc", "--sheet", "--core-sha", "--evidence", "--signer", "--owner-signer"]) expect(common, f).toContain(f);
    expect(S415).not.toMatch(/- \[[ x]\]/);
    expect([...S415.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const s of ["**Pause-all caveat.**", "900 s", "172800 s (48 hours)", "Never plan a production window from the 900 s figure", "`--owner-signer`, twice", "--migration receipt-submitter-roles", "govern --row retire-vault", "--governed-upgrades", "--rpc", "`gateway_implementation_runtime_hash`", "An agent never broadcasts to Base 8453"]) expect(S415, s).toContain(s);
  });
  test("every command in the section's code blocks parses against the real CLI, evidence-check, run-record and the contracts", async () => {
    const lines = commands(S415);
    expect(lines.length).toBeGreaterThanOrEqual(15);
    const bad: string[] = [];
    for (const l of lines) bad.push(...(await problems(l, common)));
    expect(bad).toEqual([]);
    expect(lines.filter((l) => l.includes("--row upgrade-proxy")).length).toBe(2);
    expect(lines.some((l) => l.includes("--row retire-vault"))).toBe(true);
  });
  test("every `govern --row NAME` the prose and tables name is a row the CLI knows", async () => {
    const known = await KNOWN_ROWS();
    const named = [...S415.matchAll(/govern --row ([a-z][a-z-]*)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });
  const step = (n: number): string => S415.slice(S415.indexOf(`\n${n}. `), S415.indexOf(`\n${n + 1}. `));
  test("step 0 checks HEAD, a clean tree and the rc tag before any --upgrade-build use, and the checker validates those lines", async () => {
    const s0 = step(0);
    for (const l of ['test "$(git rev-parse HEAD)" = "$RC_SHA"', 'test -z "$(git status --porcelain)"', 'test "$(git rev-parse "$RC_TAG^{commit}")" = "$RC_SHA"']) { expect(s0, l).toContain(l); expect(await problems(l, common)).toEqual([]); }
    // the first command that uses a checkout comes after step 0 (the two-checkout table above the steps only names the flags)
    expect(S415.indexOf("\n0. ")).toBeLessThan(S415.indexOf('--upgrade-build "$PWD" $COMMON'));
    expect((await problems('test "$(git rev-parse HEAD)" = "$OTHER"', common)).length).toBe(1);
    expect((await problems('test -z "$(git status)"', common)).length).toBe(1);
    expect((await problems('test "$(git log HEAD)" = "$RC_SHA"', common)).length).toBe(1);
  });
  test("step 0 checks both checkouts: the rc checkout and the v0.5.0 checkout, each HEAD, clean and its tag, and both tags on the remote (issue 1927)", async () => {
    const s0 = step(0);
    const tests = s0.split("\n").filter((l) => l.startsWith("test "));
    expect(tests).toEqual([
      'test "$(git rev-parse HEAD)" = "$RC_SHA"', 'test -z "$(git status --porcelain)"', 'test "$(git rev-parse "$RC_TAG^{commit}")" = "$RC_SHA"',
      'test "$(git -C "$V050_DIR" rev-parse HEAD)" = "$V050_SHA"', 'test -z "$(git -C "$V050_DIR" status --porcelain)"', 'test "$(git -C "$V050_DIR" rev-parse "release/v0.5.0-rehearsal^{commit}")" = "$V050_SHA"',
    ]);
    for (const l of tests) expect(await problems(l, common), l).toEqual([]);
    for (const l of ['git ls-remote origin "refs/tags/$RC_TAG^{}"', 'git ls-remote origin "refs/tags/release/v0.5.0-rehearsal^{}"']) expect(s0, l).toContain(l);
    // review-operations: the rc commit is on the fetched release branch, and the env block names the token the CLI's gates read
    const branchLine = 'git fetch origin releases-0.6.x && git merge-base --is-ancestor "$RC_SHA" origin/releases-0.6.x';
    expect(s0).toContain(branchLine);
    expect(await problems(branchLine, common)).toEqual([]);
    expect((await problems('git fetch origin dev && git merge-base --is-ancestor "$RC_SHA" origin/releases-0.6.x', common)).length).toBe(1);
    expect(S415).toMatch(/^export GITHUB_TOKEN=/m);
    // the checker refuses a v0.5.0 read compared with the rc sha, and an rc read compared with the v0.5.0 sha
    expect((await problems('test "$(git -C "$V050_DIR" rev-parse HEAD)" = "$RC_SHA"', common)).length).toBe(1);
    expect((await problems('test "$(git rev-parse HEAD)" = "$V050_SHA"', common)).length).toBe(1);
    const { V050_SHA, V050_TAG } = await import("../src/ci/twin-upgrade-from-v050.ts");
    expect(S415).toContain(`export V050_SHA=${V050_SHA}`);
    expect(s0).toContain(V050_TAG);
  });
  test("every deploy-implementation and govern command carries --core-dir and --core-sha of the v0.5.0 checkout, and every upgrade command --upgrade-build of the rc checkout (issue 1927)", () => {
    expect(common).toContain("--core-dir $V050_DIR --core-sha $V050_SHA");
    expect(common).not.toContain("$RC_SHA");
    const lines = commands(S415).filter((l) => l.startsWith("bun publish-contracts/src/cli.ts "));
    const cli = lines.filter((l) => / (deploy-implementation|govern|verify) /.test(l));
    expect(cli.length).toBe(6); // issue 1988: no clear row before the retire
    for (const l of cli) expect(l, l).toMatch(/ \$COMMON$/);
    const upgrade = cli.filter((l) => l.includes("deploy-implementation") || l.includes("--row upgrade-proxy"));
    expect(upgrade.length).toBe(4);
    for (const l of upgrade) expect(l, l).toContain('--upgrade-build "$PWD"');
    for (const l of lines.filter((x) => !upgrade.includes(x))) expect(l, l).not.toContain("--upgrade-build");
  });
  test("the section's publish-contracts commands are, in order, the commands the Twin driver runs (issue 1927)", async () => {
    const { UPGRADE_FROM_V050_COMMANDS } = await import("../src/ci/twin-upgrade-from-v050.ts");
    const lines = commands(S415).filter((l) => /^bun publish-contracts\/src\/(cli|evidence-check)\.ts /.test(l));
    expect(lines).toEqual([...UPGRADE_FROM_V050_COMMANDS]);
    // review-operations-001: the environment the driver gives those commands is exported in the section, and the step 8 record is read from it
    const { UPGRADE_FROM_V050_ENV } = await import("../src/ci/upgrade-from-v050-commands.ts");
    for (const k of UPGRADE_FROM_V050_ENV) expect(S415, k).toMatch(new RegExp(`^export ${k}=`, "m"));
    expect(S415).toContain("writes the new `upgradeability.json` to `$PUBLISH_MANIFEST_DIR`");
    const driver = readFileSync(join(REPO, "publish-contracts", "src", "ci", "twin-upgrade-from-v050.ts"), "utf8");
    expect(driver).toContain("...runEnv");
    expect(driver).not.toMatch(/PUBLISH_MANIFEST_DIR: manifests, YES/);
    // the driver workflow job runs that driver
    const wf = readFileSync(join(REPO, ".github", "workflows", "suite-28-core-stages.yml"), "utf8");
    expect(wf).toContain("name: core-stages-twin-upgrade-from-v050");
    expect(wf).toContain("bun publish-contracts/src/ci/twin-upgrade-from-v050.ts");
  });
  test("step 2 reads the Safe owners and threshold, the Safe's timelock roles and the RouterGovernance code on chain", async () => {
    const s2 = step(2);
    for (const l of ['cast call $SAFE "getOwners()(address[])"', 'cast call $SAFE "getThreshold()(uint256)"', 'cast call $TIMELOCK "hasRole(bytes32,address)(bool)" $PROPOSER_ROLE $SAFE', 'cast call $TIMELOCK "hasRole(bytes32,address)(bool)" $EXECUTOR_ROLE 0x0000000000000000000000000000000000000000', "cast codehash $GOVERNANCE"]) expect(s2, l).toContain(l);
    // The executor is open (core 1521): the read is for address(0), never the Safe.
    expect(s2).not.toContain('$EXECUTOR_ROLE $SAFE');
    for (const l of s2.split("\n").filter((x) => x.startsWith("cast "))) expect(await problems(l, common), l).toEqual([]);
    expect(s2).toContain("`hasRole(EXECUTOR_ROLE, address(0))` must be true");
    expect(s2).toContain("The Safe must hold `PROPOSER_ROLE`");
    expect(s2).toContain("never from memory");
    // Stop rules stay for the delay and receipt version 2. An active receipt vector is recorded, not a stop: nothing clears it (issue 1988), the retire leaves it and the step 10 receipt replaces it.
    expect(s2).toContain("If the delay reads anything else, or if the receipt reads version 2");
    expect(s2).toContain("record it in the evidence and do not stop");
    expect(s2).not.toContain("or if an active receipt vector shows in the effective weights, stop and report");
    expect(s2).toContain("must read 2");
    expect(await problems('cast call $SAFE "getNoSuchOwners()(address[])" --rpc-url $BASE_RPC_URL', common)).toHaveLength(1);
    expect(S415.indexOf("export GOVERNANCE=")).toBeGreaterThan(-1);
  });
  test("steps 4 and 5 review govern.preview before the second signature, and step 6 retires with no clear of the receipt vector (issue 1988)", () => {
    expect(step(4)).toContain("`govern.preview`");
    for (const w of ["`new_implementation`", "`new_code_hash`", "second owner signs", "delay"]) expect(step(5), w).toContain(w);
    const s6 = step(6);
    expect(s6).toContain("--row retire-vault");
    expect(s6).toContain("nothing clears or resets the router's vector (issue 1988)");
    expect(s6).not.toMatch(/clear-voted-weights|clearVotedWeights/);
    expect(step(2)).not.toMatch(/clear-voted-weights|clearVotedWeights/);
  });
  test("section 4.15 repeats the build-pin check, compares OWNER_SIGNER with getOwners, re-reads the state before the retire executes and names the Twin procedure (issue 1916)", () => {
    expect(S415).toContain("This build-pin check is repeated immediately before every later use of `--upgrade-build`");
    expect(S415).toContain('git ls-remote origin "refs/tags/$RC_TAG^{}"');
    expect(step(2)).toContain("Compare each `OWNER_SIGNER` address");
    expect(step(2)).toContain("`getOwners`");
    expect(step(7)).toContain("re-reads the state it checked in step 6");
    expect(step(7)).toContain("requires the rmAGENT leg unavailable with amount 0");
    expect(S415).toContain("**The Twin procedure.**");
    expect(S415).toContain("`core-stages-twin-upgrade-lifecycle`");
    expect(S415).toContain("docs/runbooks/contract-qa/releases/v0.6.0.yaml");
  });
  test("Authority and gates states layout and Twin runs must pass before the rc tag, and does not assert they passed", () => {
    const auth = S415.slice(S415.indexOf("**Authority and gates.**"), S415.indexOf("**The delay.**"));
    expect(auth).toContain("must pass `scripts/ci/check-core-storage-layout.sh --baseline release/v0.5.0-rehearsal`");
    expect(auth).toContain("before the rc tag is cut");
    expect(auth).not.toMatch(/\bpassed\b/);
  });
  test("the checker fails a step that names a nonexistent govern row, a nonexistent flag or a nonexistent function", async () => {
    const ok = `bun publish-contracts/src/cli.ts govern --row retire-vault --admin-arg vault=$RMAGENT --admin-arg weights=USDC:9500,PROTO:500,RWA:0 $COMMON`;
    expect(await problems(ok, common)).toEqual([]);
    expect((await problems(ok.replace("retire-vault", "retire-everything"), common)).length).toBe(1);
    expect((await problems(ok.replace("--admin-arg weights", "--admin-weights"), common)).length).toBe(1);
    expect((await problems(`bun publish-contracts/src/evidence-check.ts --governed-upgrades-x F --rpc U`, common)).length).toBe(1);
    expect((await problems(`cast call $TIMELOCK "getNoSuchDelay()(uint256)" --rpc-url $BASE_RPC_URL`, common)).length).toBe(1);
    expect(await problems(`cast call $TIMELOCK "getMinDelay()(uint256)" --rpc-url $BASE_RPC_URL`, common)).toEqual([]);
    const named = [...`run govern --row nosuchrow now`.matchAll(/govern --row ([a-z][a-z-]*)/g)].map((m) => m[1]!);
    expect((await KNOWN_ROWS()).has(named[0]!)).toBe(false);
  });
});
