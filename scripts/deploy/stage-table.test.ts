// Canonical: core issue 1499, core stage table.
// Offline test: stage-table.json agrees with the real scripts. Run: bun test scripts/deploy/stage-table.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadStageTable } from "../stage/stage-table";
import { loadStageTable as cliLoadStageTable, VAULT_RULE_FIELDS, differingRuleFields, parseStageTable } from "../../publish-contracts/src/stage-table";

const ROOT = join(import.meta.dir, "..", "..");
const table = loadStageTable();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Source of a script plus the shared bases it inherits env readers and manifest names from: the basket base, the proxy base (issue 1809: UPGRADE_AUTHORITY and
 * UPGRADE_MODE are read in GovernedProxyDeploy) and the handover script the authority stage inherits (DeployUpgradeAuthority is DeployTimelock).
 */
function scriptSource(path: string): string {
  const own = read(path);
  const base = path.replace(/[^/]+$/, "");
  const basket = /BasketVaultDeployBase/.test(own) ? read(`${base}BasketVaultDeployBase.sol`) : "";
  const proxy = /GovernedProxyDeploy/.test(own + basket) ? read(`${base}GovernedProxyDeploy.sol`) : "";
  const handover = /\bis DeployTimelock\b/.test(own) ? read(`${base}DeployTimelock.s.sol`) : "";
  return own + basket + proxy + handover + read(`${base}ExpectedChainGuard.sol`);
}

const EXPECTED = ["libs", "recorder", "authority", "vault", "registry", "router", "gateway", "governance", "ic-policy", "proto", "agent", "rwa", "timelock"];

describe("stage-table.json", () => {
  test("version 1 with every stage, in deploy order", () => {
    expect(table.version).toBe(1);
    expect(table.stages.map((s) => s.name)).toEqual(EXPECTED);
  });

  test("every non-script deploy script in contracts/script has a stage", () => {
    const listed = new Set(table.stages.map((s) => s.script.split(":")[0].split("/").pop()));
    // the single-vault redeploy (issue 1796), a verb of its own with a `redeploys` row (the stale basket eligibility script is deleted, issue 1705)
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
    // issue 1698: router weights change through the one applyReceipt call (release and weights together), never a vote and never a two-call batch
    expect(g.description).toContain("one RouterGovernance.applyReceipt call through the timelock");
    expect(g.description).toContain("no voting surface");
    for (const old of ["setDefaultWeights", "releaseReceipt", "scheduleBatch", "propose", "quorum"]) expect(g.description).not.toContain(old);
    // no 13-row list survives: none of the old matrix rows is named
    for (const old of ["voting-power-quorum", "other-setters", "migrate-eligibility", "router-weights"]) expect(JSON.stringify(g)).not.toContain(old);
    // the deploy-time configuration is read by the stages that set it
    const env = (n: string) => table.stages.find((s) => s.name === n)!.requiredEnv;
    // issue 1698: the governance stage deploys the weight setter with no voting surface, so no voter or quorum input exists
    expect(env("governance")).toEqual(["ADMIN_ADDRESS", "ROUTER_ADDRESS", "DEPLOYMENT_OUT"]);
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
        // issue 1809: the redeployed vault's upgrade authority is TIMELOCK_ADDRESS itself, so the redeploy reads no UPGRADE_AUTHORITY (it reads UPGRADE_MODE like the launch stage)
        const launch = stage.requiredEnv.filter((n) => n !== "ROUTER_DEFAULT_BPS" && n !== "UPGRADE_AUTHORITY");
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

  // Issue 1705 (QA plan v1 E9 a): one table holds the per-vault rule for every dimension the four vaults are governed by. Every field is present on every
  // vault, a field on which the vaults differ names its decision, and each rule is what the scripts and contracts do.
  describe("vault rules (issue 1705)", () => {
    const vaultSource = (artifact: string): string =>
      artifact === "RobotMoneyVault" ? read("contracts/RobotMoneyVault.sol") : read("contracts/vaults/BasketVault.sol") + read(`contracts/vaults/${artifact}.sol`);
    const stageOf = (key: string) => table.stages.find((s) => s.vault === key)!;
    const govern = (table as unknown as { govern: { mainnetRows: string[] } }).govern;

    test("vault rules: every rule field is present on all four vaults, and the parser refuses a row without one", () => {
      expect(table.vaults.map((v) => v.key)).toEqual(["USDC", "PROTO", "AGENT", "RWA"]);
      for (const v of table.vaults) for (const f of VAULT_RULE_FIELDS) expect([v.key, f, (v as unknown as Record<string, unknown>)[f] !== undefined]).toEqual([v.key, f, true]);
      const raw = JSON.parse(read("scripts/deploy/stage-table.json"));
      for (const f of VAULT_RULE_FIELDS) {
        const t = JSON.parse(JSON.stringify(raw));
        delete t.vaults[2][f];
        expect(() => parseStageTable(t), f).toThrow(`vault AGENT: ${f}`);
      }
    });

    test("vault rules: a field that differs between vaults names a decision link, and the parser refuses a difference without one", () => {
      const decisions = table.vaultRuleDecisions as Record<string, string>;
      const differing = differingRuleFields(table.vaults);
      expect(differing.length).toBeGreaterThan(0);
      for (const f of differing) expect([f, decisions[f] ?? ""]).toEqual([f, expect.stringMatching(/\b(?:issue|core) \d{3,5}\b|owner decision/i)]);
      for (const f of Object.keys(decisions)) expect(VAULT_RULE_FIELDS as readonly string[]).toContain(f);
      const t = JSON.parse(read("scripts/deploy/stage-table.json"));
      delete t.vaultRuleDecisions[differing[0]!];
      expect(() => parseStageTable(t)).toThrow(`the vaults differ on ${differing[0]}`);
      const u = JSON.parse(read("scripts/deploy/stage-table.json"));
      u.vaults[1].deployPaused = false; u.vaults[1].unpauseInStage13 = false; // rmPROTO open at deploy, with no decision for the difference
      delete u.vaultRuleDecisions.deployPaused; delete u.vaultRuleDecisions.unpauseInStage13;
      expect(() => parseStageTable(u)).toThrow("the vaults differ on deployPaused");
    });

    test("vault rules: deployPaused is what each vault stage script does (pauseDeposits in the stage)", () => {
      for (const v of table.vaults) expect([v.key, /\.pauseDeposits\(\)/.test(scriptSource(stageOf(v.key).script.split(":")[0]!))]).toEqual([v.key, v.deployPaused]);
    });

    test("vault rules: the unpause rows are unpause-<KEY>, and stage 13 (govern.mainnetRows) is exactly the rows the table puts in stage 13", () => {
      for (const v of table.vaults) expect(v.unpauseRow).toBe(`unpause-${v.key}`);
      expect(govern.mainnetRows).toEqual(table.vaults.filter((v) => v.unpauseInStage13).map((v) => v.unpauseRow));
    });

    test("vault rules: the seed is the env name the vault stage requires, and a vault with no seed requires none", () => {
      for (const v of table.vaults) {
        const env = stageOf(v.key).requiredEnv;
        if (v.seed === "none") expect([v.key, env.filter((e) => e.startsWith("SEED_"))]).toEqual([v.key, []]);
        else expect([v.key, env]).toEqual([v.key, expect.arrayContaining([v.seed.slice("sheet:".length), "SEED_SHARE_RECEIVER"])]);
      }
    });

    test("vault rules: router eligibility comes from the router stage (setRouterEligible on the vault stage's address) or from the vault's own stage (ROUTER_DEFAULT_BPS, migrateEligibility)", () => {
      const router = table.stages.find((s) => s.name === "router")!;
      for (const v of table.vaults) {
        if (v.eligibilitySource === "router-stage") {
          // the router stage reads VAULT_ADDRESS, the vault stage manifest's address, and marks it eligible
          expect([v.key, v.stage, router.requiredEnv.includes("VAULT_ADDRESS"), /setRouterEligible\(vault_, true\)/.test(read(router.script.split(":")[0]!))]).toEqual([v.key, "vault", true, true]);
          expect(stageOf(v.key).requiredEnv).not.toContain("ROUTER_DEFAULT_BPS");
        } else {
          expect([v.key, stageOf(v.key).requiredEnv.includes("ROUTER_DEFAULT_BPS"), /migrateEligibility/.test(scriptSource(stageOf(v.key).script.split(":")[0]!))]).toEqual([v.key, true, true]);
        }
      }
    });

    test("vault rules: emergencyLevers is exactly the vault contract's EMERGENCY_ROLE functions", () => {
      for (const v of table.vaults) {
        const src = vaultSource(v.artifact);
        const levers = [...src.matchAll(/function\s+(\w+)\s*\([^)]*\)([^{;]*)\{/g)].filter((m) => /onlyRole\(EMERGENCY_ROLE\)/.test(m[2]!)).map((m) => m[1]!);
        expect([v.key, [...new Set(levers)].sort()]).toEqual([v.key, [...v.emergencyLevers].sort()]);
      }
    });

    test("vault rules: registryNameSource is where the registered name comes from (a sheet env a stage reads, or the vault script's constant)", () => {
      for (const v of table.vaults) {
        const [where, name] = v.registryNameSource.split(":") as [string, string];
        if (where === "sheet") {
          const reg = table.stages.find((s) => s.requiredEnv.includes(name) && /registerVault/.test(read(s.script.split(":")[0]!)));
          expect([v.key, reg?.name]).toEqual([v.key, "registry"]);
        } else {
          const own = read(stageOf(v.key).script.split(":")[0]!);
          expect([v.key, new RegExp(`string public constant ${name} = "`).test(own), new RegExp(`_registryName\\(\\)[^{]*\\{\\s*return ${name};`).test(own)]).toEqual([v.key, true, true]);
        }
      }
    });
  });

  test("the one driver (publish-contracts CLI) reads the same table from the repo root", () => {
    const cli = cliLoadStageTable(ROOT);
    expect(cli.stages.map((s) => s.name)).toEqual(EXPECTED);
    expect(cli.stages.map((s) => s.script)).toEqual(table.stages.map((s) => s.script));
  });
  // Issue 1809 (ADR-0014): the stage table deploys the timelock before every proxy, each proxy stage states the authority and the release mode it deploys with, and the
  // proxies the deploy tooling verifies are exactly the contracts the storage-layout gate snapshots.
  describe("proxies (issue 1809)", () => {
    const t = table as unknown as { proxies?: { name: string; stage: string; field: string; implementationField: string; artifact: string }[]; proxyArtifact?: string };
    const proxies = t.proxies ?? [];
    const names = table.stages.map((s) => s.name);

    test("the nine proxied contracts are the layout gate's proxied.txt, with ERC1967Proxy as the proxy build", () => {
      const listed = read("contracts/test/fixtures/storage-layout/proxied.txt").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      expect(proxies.map((p) => p.artifact).sort()).toEqual([...listed].sort());
      expect(proxies.map((p) => p.name)).toEqual(["rmUSDC", "registry", "router", "gateway", "icpolicy", "receipt", "rmPROTO", "rmAGENT", "rmRWA"]);
      expect(t.proxyArtifact).toBe("ERC1967Proxy");
      for (const v of table.vaults) expect(proxies.find((p) => p.stage === v.stage)?.artifact).toBe(v.artifact);
    });

    test("the authority stage deploys the upgrade-authority timelock before every proxy stage, and the handover reuses it", () => {
      const auth = table.stages.find((s) => s.name === "authority")!;
      expect(auth.script).toBe("contracts/script/DeployUpgradeAuthority.s.sol:DeployUpgradeAuthority");
      expect(auth.manifest).toBe("deployments/<chain>/upgrade-authority.json");
      for (const p of proxies) expect([p.name, names.indexOf(auth.name) < names.indexOf(p.stage)]).toEqual([p.name, true]);
      expect(read("contracts/script/DeployUpgradeAuthority.s.sol")).toMatch(/_runAuthorityFrom\(""\)/);
      expect(scriptSource("contracts/script/DeployUpgradeAuthority.s.sol")).toContain('vm.serializeAddress(obj, "timelock"');
      expect(table.stages.find((s) => s.name === "timelock")!.requiredEnv).toContain("TIMELOCK_ADDRESS");
    });

    test("every proxy stage requires UPGRADE_AUTHORITY and UPGRADE_MODE, and its script writes the proxy, the implementation, the authority and the mode", () => {
      for (const p of proxies) {
        const st = table.stages.find((s) => s.name === p.stage)!;
        expect([p.name, st.requiredEnv.includes("UPGRADE_AUTHORITY"), st.requiredEnv.includes("UPGRADE_MODE")]).toEqual([p.name, true, true]);
        const src = scriptSource(st.script.split(":")[0]!);
        for (const f of [p.field, p.implementationField, "upgrade_authority", "upgrade_mode"]) expect([p.name, f, src.includes(`"${f}"`)]).toEqual([p.name, f, true]);
      }
      expect(table.stages.find((s) => s.name === "vault")!.requiredEnv).toContain("EXCLUSION_LEDGER_FACTORY");
      expect(read("contracts/script/DeployLibs.s.sol")).toContain('"exclusion_ledger_factory"');
    });

    test("the parser refuses a proxy whose stage could deploy it with an undeclared mode or authority", () => {
      for (const env of ["UPGRADE_MODE", "UPGRADE_AUTHORITY"]) {
        const raw = JSON.parse(read("scripts/deploy/stage-table.json"));
        const st = raw.stages.find((s: { name: string }) => s.name === "gateway");
        st.requiredEnv = st.requiredEnv.filter((e: string) => e !== env);
        expect(() => parseStageTable(raw)).toThrow(`proxy gateway: stage gateway must require ${env}`);
      }
      const noArtifact = JSON.parse(read("scripts/deploy/stage-table.json"));
      delete noArtifact.proxyArtifact;
      expect(() => parseStageTable(noArtifact)).toThrow("proxies need proxyArtifact");
      const twice = JSON.parse(read("scripts/deploy/stage-table.json"));
      twice.proxies.push({ ...twice.proxies[0] });
      expect(() => parseStageTable(twice)).toThrow("is listed twice");
    });
  });
});
