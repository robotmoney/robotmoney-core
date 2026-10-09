// Canonical: core issue 1499, core stage table.
// Offline test: stage-table.json agrees with the real scripts. Run: bun test scripts/deploy/stage-table.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadStageTable } from "../stage/stage-table";
import { loadStageTable as cliLoadStageTable } from "../../publish-contracts/src/stage-table";

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

const EXPECTED = ["libs", "recorder", "vault", "registry", "router", "gateway", "governance", "ic-policy", "proto", "agent", "rwa", "timelock"];

describe("stage-table.json", () => {
  test("version 1 with every stage, in deploy order", () => {
    expect(table.version).toBe(1);
    expect(table.stages.map((s) => s.name)).toEqual(EXPECTED);
  });

  test("every non-script deploy script in contracts/script has a stage", () => {
    const listed = new Set(table.stages.map((s) => s.script.split(":")[0].split("/").pop()));
    const skip = new Set(["ActivateBasketVaultEligibility.s.sol"]); // a govern action, not a stage
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

  test("stage 13 is the basket unpauses only, with the deploy-time configuration set in stages 4 to 10 (issue 1520)", () => {
    const g = (table as unknown as { govern: { stage: number; description: string; mainnetRows: string[]; twinOnlyRows: string[] } }).govern;
    expect(g.stage).toBe(13);
    expect(g.mainnetRows).toEqual(["unpause-PROTO", "unpause-AGENT", "unpause-RWA"]);
    expect(g.twinOnlyRows).toEqual(["update-delay", "batch", "cancel"]);
    expect(g.description).toContain("only mainnet operation is the unpause of each basket vault");
    expect(g.description).toContain("deploy-time configuration set by the deployer in stages 4 to 10");
    expect(g.description).toContain("Twin-only");
    // no 13-row list survives: none of the old matrix rows is named
    for (const old of ["voting-power-quorum", "other-setters", "migrate-eligibility", "router-weights"]) expect(JSON.stringify(g)).not.toContain(old);
    // the deploy-time configuration is read by the stages that set it
    const env = (n: string) => table.stages.find((s) => s.name === n)!.requiredEnv;
    expect(env("governance")).toEqual(expect.arrayContaining(["VOTER_ADDRESSES", "VOTER_POWER", "QUORUM_THRESHOLD", "VOTING_PERIOD", "EXECUTION_DELAY"]));
    for (const n of ["proto", "agent", "rwa"]) expect(env(n)).toContain("ROUTER_DEFAULT_BPS");
  });

  test("the one driver (publish-contracts CLI) reads the same table from the repo root", () => {
    const cli = cliLoadStageTable(ROOT);
    expect(cli.stages.map((s) => s.name)).toEqual(EXPECTED);
    expect(cli.stages.map((s) => s.script)).toEqual(table.stages.map((s) => s.script));
  });
});
