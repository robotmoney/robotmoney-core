// Canonical: core issue 1499, core stage table.
// Offline test: stage-table.json agrees with the real scripts. Run: bun test scripts/deploy/stage-table.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadStageTable } from "../stage/stage-table";
import { loadStageTable as cliLoadStageTable, VAULT_RULE_FIELDS, vaultRules } from "../../publish-contracts/src/stage-table";

const ROOT = join(import.meta.dir, "..", "..");
const table = loadStageTable();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Source of a script plus the shared bases it inherits env readers and manifest names from. */
function scriptSource(path: string): string {
  const own = read(path);
  const base = path.replace(/[^/]+$/, "");
  const extra = /BasketVaultDeployBase/.test(own) ? read(`${base}BasketVaultDeployBase.sol`) : "";
  return own + extra + read(`${base}ExpectedChainGuard.sol`);
}

const EXPECTED = ["libs", "recorder", "vault", "registry", "router", "gateway", "ic-policy", "governance", "proto", "agent", "rwa", "timelock"];

describe("stage-table.json", () => {
  test("version 1 with every stage, in deploy order", () => {
    expect(table.version).toBe(1);
    expect(table.stages.map((s) => s.name)).toEqual(EXPECTED);
  });

  test("every non-script deploy script in contracts/script has a stage", () => {
    const listed = new Set(table.stages.map((s) => s.script.split(":")[0].split("/").pop()));
    // the single-vault redeploy (issue 1796), a verb of its own with a `redeploys` row
    const skip = new Set(["RedeployProtocolAssetVault.s.sol"]);
    const missing = readdirSync(join(ROOT, "contracts/script"))
      .filter((f) => f.endsWith(".s.sol") && !skip.has(f) && !listed.has(f));
    expect(missing).toEqual([]);
  });

  for (const s of table.stages) {
    describe(`stage ${s.name}`, () => {
      const [file, contract] = s.script.split(":");
      test("script file and contract exist", () => {
        expect(existsSync(join(ROOT, file))).toBe(true);
        expect(read(file)).toMatch(new RegExp(`contract ${contract}\\b`));
      });
      test("every requiredEnv name is read by the script", () => {
        const src = scriptSource(file);
        for (const name of s.requiredEnv) expect(src).toContain(`"${name}"`);
      });
      test("DEPLOYMENT_OUT is required and the script has no default for it", () => {
        expect(s.requiredEnv).toContain("DEPLOYMENT_OUT");
        expect(s.optionalEnv).not.toContain("DEPLOYMENT_OUT");
        const src = scriptSource(file);
        expect(src).not.toContain("_defaultManifestPath");
        expect(src).not.toMatch(/envOr\(\s*"DEPLOYMENT_OUT"/);
      });
      test("no env default helper is left in the script", () => {
        expect(scriptSource(file)).not.toContain("_envOrDefault");
      });
      test("every optionalEnv name appears in the script", () => {
        const src = scriptSource(file);
        for (const name of s.optionalEnv) expect(src).toContain(`"${name}"`);
      });
      test("the manifest file name is written by the script", () => {
        const name = s.manifest.split("/").pop()!;
        expect(s.manifest).toContain("<chain>");
        const src = read(file);
        if (s.vault && s.vault !== "USDC") {
          // Basket scripts name the manifest by their label: protocol_asset_vault -> protocol-asset-vault.json.
          const label = /return "([a-z_]+)";/.exec(src.slice(src.indexOf("function _label")))![1];
          expect(`${label.replaceAll("_", "-")}.json`).toBe(name);
        } else {
          expect(src).toContain(`MANIFEST_FILE = "${name}"`);
        }
      });
      test("linked libraries are declared", () => {
        for (const l of s.libraries) expect(table.libraries.map((x) => x.name)).toContain(l);
      });
    });
  }

  test("vault rows point at a stage with the same vault key, and the vault contract exists", () => {
    expect(table.vaults.map((v) => v.key)).toEqual(["USDC", "PROTO", "AGENT", "RWA"]);
    for (const v of table.vaults) {
      const st = table.stages.find((s) => s.name === v.stage)!;
      expect(st.vault).toBe(v.key);
      expect(st.manifest).toBe(v.manifest);
      expect(existsSync(join(ROOT, "contracts", v.artifact === "RobotMoneyVault" ? "RobotMoneyVault.sol" : `vaults/${v.artifact}.sol`))).toBe(true);
    }
    expect(table.vaults.find((v) => v.key === "RWA")!.artifact).toBe("RwaBasketVault");
  });

  test("library rows name a real library source and the stage manifest key", () => {
    for (const l of table.libraries) {
      expect(read(l.path!)).toMatch(new RegExp(`library ${l.artifact}\\b`));
      expect(read("contracts/script/DeployLibs.s.sol")).toContain(`"${l.manifestKey}"`);
    }
  });

  test("create2Libraries name real library sources, and a stage lists them only if it deploys a vault that links them (issue 1721)", () => {
    const c2 = (table as any).create2Libraries as { name: string; artifact: string; path: string }[];
    expect(c2.map((l) => l.artifact)).toEqual(["BasketAssetConfigGuard", "TwapTickMath", "BasketViews"]);
    for (const l of c2) expect(read(l.path)).toMatch(new RegExp(`library ${l.artifact}\\b`));
    for (const s of table.stages as any[]) for (const n of s.create2Libraries ?? []) {
      expect(c2.map((l) => l.name)).toContain(n);
      expect(s.vault && s.vault !== "USDC").toBe(true);
      expect(read("contracts/vaults/BasketVault.sol")).toMatch(new RegExp(`import \\{[^}]*\\b${n}\\b`));
    }
    expect((table.stages as any[]).filter((s) => s.create2Libraries?.length).map((s) => s.name)).toEqual(["proto", "agent", "rwa"]);
  });

  test("artifacts name contracts that exist under contracts/", () => {
    const all = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (["test", "script", "lib"].includes(e.name) && dir === "contracts" ? [] : all(`${dir}/${e.name}`)) : e.name.endsWith(".sol") ? [read(`${dir}/${e.name}`)] : [],
      );
    const src = all("contracts").join("\n");
    for (const [k, name] of Object.entries(table.artifacts)) {
      if (name === "TimelockController") continue; // OpenZeppelin, deployed by DeployTimelock
      expect([k, new RegExp(`contract ${name}\\b`).test(src)]).toEqual([k, true]);
    }
    expect(Object.keys(table.artifacts).sort()).toEqual(["gateway", "governance", "icPolicy", "receipt", "recorder", "registry", "router", "timelock", "v4Adapter"]);
  });

  test("stage 13 is the four vault unpauses only, with the deploy-time configuration set in stages 4 to 10 (issue 1520)", () => {
    const g = (table as unknown as { govern: { stage: number; description: string; mainnetRows: string[]; twinOnlyRows: string[] } }).govern;
    expect(g.stage).toBe(13);
    expect(g.mainnetRows).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA"]);
    expect(g.twinOnlyRows).toEqual(["update-delay", "batch", "cancel"]);
    expect(g.description).toContain("only mainnet operation is the unpause of each of the four vaults");
    expect(g.description).toContain("deploy-time configuration set by the deployer in stages 4 to 10");
    expect(g.description).toContain("Twin-only");
    // no 13-row list survives: none of the old matrix rows is named
    for (const old of ["voting-power-quorum", "other-setters", "migrate-eligibility", "router-weights"]) expect(JSON.stringify(g)).not.toContain(old);
    // the deploy-time configuration is read by the stages that set it
    const env = (n: string) => table.stages.find((s) => s.name === n)!.requiredEnv;
    // issue 1698: RouterGovernance has no voting, so the governance stage reads no voter, quorum or period, and it needs the receipt register
    expect(env("governance")).toContain("CONSENSUS_RECEIPT_ADDRESS");
    for (const gone of ["VOTER_ADDRESSES", "VOTER_POWER", "QUORUM_THRESHOLD", "VOTING_PERIOD", "EXECUTION_DELAY"]) expect(env("governance")).not.toContain(gone);
    for (const n of ["proto", "agent", "rwa"]) expect(env(n)).toContain("ROUTER_DEFAULT_BPS");
  });

  describe("redeploys (issue 1796)", () => {
    const rows = (table as unknown as { redeploys?: { vault: string; script: string; requiredEnv: string[]; optionalEnv: string[]; manifest: string; libraries: string[]; create2Libraries?: string[] }[] }).redeploys ?? [];
    test("only rmPROTO has a redeploy row, on the vault's own manifest, and it is not a stage", () => {
      expect(rows.map((r) => r.vault)).toEqual(["PROTO"]);
      expect(table.stages.map((s) => s.script)).not.toContain(rows[0]!.script);
      expect(rows[0]!.manifest).toBe(table.vaults.find((v) => v.key === "PROTO")!.manifest);
    });
    for (const r of rows) {
      const [file, contract] = r.script.split(":");
      test(`${r.vault}: script and contract exist and every env name is read by it`, () => {
        expect(existsSync(join(ROOT, file))).toBe(true);
        expect(read(file)).toMatch(new RegExp(`contract ${contract}\\b`));
        const src = scriptSource(file) + read("contracts/script/DeployProtocolAssetVault.s.sol") + read("contracts/script/BasketVaultDeployBase.sol");
        for (const name of [...r.requiredEnv, ...r.optionalEnv]) expect(src).toContain(`"${name}"`);
        expect(r.requiredEnv).toContain("DEPLOYMENT_OUT");
      });
      test(`${r.vault}: the redeploy reads the same sheet inputs as the vault's launch stage, plus the timelock and the emergency key`, () => {
        const stage = table.stages.find((s) => s.vault === r.vault)!;
        const launch = stage.requiredEnv.filter((n) => n !== "ROUTER_DEFAULT_BPS");
        expect([...r.requiredEnv].sort()).toEqual([...launch, "TIMELOCK_ADDRESS", "EMERGENCY_ADDRESS"].sort());
        expect(r.libraries).toEqual(stage.libraries);
        expect(r.create2Libraries).toEqual(stage.create2Libraries);
      });
      test(`${r.vault}: the redeploy script never registers the vault and never touches router eligibility`, () => {
        const src = read(file);
        expect(src).not.toMatch(/registerVault|migrateEligibility|setRouterEligible/);
      });
    }
  });

  // Issue 1705: one table holds the per-vault deploy and governance rule. A field that differs between the vaults names its reason and decision link.
  describe("vault rules", () => {
    const raw = JSON.parse(read("scripts/deploy/stage-table.json"));
    const rules = vaultRules(raw);
    test("every rule field is present on all four vaults", () => {
      expect(rules.map((v) => v.key)).toEqual(["USDC", "PROTO", "AGENT", "RWA"]);
      for (const v of rules) for (const f of VAULT_RULE_FIELDS) expect([v.key, f, f in v]).toEqual([v.key, f, true]);
    });
    test("a field that differs between vaults names a reason and a decision link, and a uniform field has no decision", () => {
      const decisions = raw.vaultRuleDecisions as Record<string, { reason: string; decision: string }>;
      for (const f of VAULT_RULE_FIELDS) {
        const values = new Set(rules.map((v) => JSON.stringify(f === "unpauseRow" ? (v[f] as string).replace(v.key, "<KEY>") : v[f])));
        if (values.size > 1) {
          expect([f, decisions[f]?.reason.length > 0]).toEqual([f, true]);
          expect([f, decisions[f]?.decision]).toEqual([f, expect.stringMatching(/^https:\/\/github\.com\/robotmoney\/robotmoney-(?:core|devops)\/issues\/\d+$/)]);
        } else expect([f, decisions[f]]).toEqual([f, undefined]);
      }
      // The recorded differences today: the seed, the eligibility source, the emergency levers and the registry name source.
      expect(Object.keys(decisions).sort()).toEqual(["eligibilitySource", "emergencyLevers", "registryNameSource", "seed"]);
    });
    test("the loader refuses a difference with no decision, a stale decision and a missing field", () => {
      const copy = () => JSON.parse(JSON.stringify(raw));
      const noDecision = copy(); delete noDecision.vaultRuleDecisions.seed;
      expect(() => vaultRules(noDecision)).toThrow(/vault rule seed differs between vaults/);
      const stale = copy(); stale.vaultRuleDecisions.deployPaused = { reason: "r", decision: "https://github.com/robotmoney/robotmoney-core/issues/1" };
      expect(() => vaultRules(stale)).toThrow(/vaultRuleDecisions.deployPaused is stale/);
      const split = copy(); split.vaults[0].deployPaused = false; split.vaults[0].unpauseInStage13 = false;
      expect(() => vaultRules(split)).toThrow(/vault rule deployPaused differs between vaults/);
      const missing = copy(); delete missing.vaults[2].emergencyLevers;
      expect(() => vaultRules(missing)).toThrow(/vault AGENT has no emergencyLevers/);
    });
    test("all four vaults deploy paused and stage 13 unpauses all four, each by its own row (issue 1705 Q1)", () => {
      for (const v of rules) expect([v.key, v.deployPaused, v.unpauseInStage13, v.unpauseRow]).toEqual([v.key, true, true, `unpause-${v.key}`]);
      const g = (table as unknown as { govern: { mainnetRows: string[] } }).govern;
      expect(g.mainnetRows).toEqual(rules.filter((v) => v.unpauseInStage13).map((v) => v.unpauseRow));
    });
    test("the seed sheet name is the vault stage's required env, and only the seeded vault's stage reads one", () => {
      for (const v of rules) {
        const env = table.stages.find((s) => s.name === v.stage)!.requiredEnv;
        if (v.seed) expect(env).toContain(v.seed);
        else expect(env.filter((n) => n.startsWith("SEED_"))).toEqual([]);
      }
    });
    test("eligibility: the router-stage vault is the one the router stage makes eligible, every other vault stage reads ROUTER_DEFAULT_BPS", () => {
      const router = read("contracts/script/DeployPortfolioRouter.s.sol");
      expect(router).toContain("setRouterEligible(vault_, true)");
      for (const v of rules) {
        const env = table.stages.find((s) => s.name === v.stage)!.requiredEnv;
        if (v.eligibilitySource === "router-stage") expect([v.key, env.includes("ROUTER_DEFAULT_BPS")]).toEqual([v.key, false]);
        else expect([v.key, env.includes("ROUTER_DEFAULT_BPS")]).toEqual([v.key, true]);
      }
      expect(rules.filter((v) => v.eligibilitySource === "router-stage").map((v) => v.key)).toEqual(["USDC"]);
    });
    test("emergencyLevers is every EMERGENCY_ROLE function of the vault contract, so a lever cannot be added unnamed", () => {
      const src = (artifact: string) => read(artifact === "RobotMoneyVault" ? "contracts/RobotMoneyVault.sol" : "contracts/vaults/BasketVault.sol");
      for (const v of rules) {
        const levers = [...src(v.artifact).matchAll(/function (\w+)\([^)]*\)[^{;]*onlyRole\(EMERGENCY_ROLE\)/g)].map((m) => m[1]);
        expect([v.key, [...levers].sort()]).toEqual([v.key, [...v.emergencyLevers].sort()]);
      }
    });
    test("registry name: the sheet name is the registry stage's required env, a script constant is the vault script's VAULT_NAME", () => {
      for (const v of rules) {
        if (v.registryNameSource.startsWith("sheet:")) expect(table.stages.find((s) => s.name === "registry")!.requiredEnv).toContain(v.registryNameSource.slice("sheet:".length));
        else expect(read(table.stages.find((s) => s.name === v.stage)!.script.split(":")[0]!)).toMatch(/string public constant VAULT_NAME = "[^"]+";/);
      }
    });
  });

  test("the one driver (publish-contracts CLI) reads the same table from the repo root", () => {
    const cli = cliLoadStageTable(ROOT);
    expect(cli.stages.map((s) => s.name)).toEqual(EXPECTED);
    expect(cli.stages.map((s) => s.script)).toEqual(table.stages.map((s) => s.script));
  });
});
