// Issue 1912, ADR-0017: rmAGENT is retired, so no sheet of the three-vault deployment carries a VAULT_AGENT_ name any more. The pool-depth guard VAULT_AGENT_MIN_POOL_LIQUIDITY was 1e15 in every sheet
// (issue 1903, ADR-0015, ADR-0016) and nothing here lowers it: the guard is not removed, the vault it guarded is. The floor stays 1e15 for any agent-token vault the parked scripts deploy again, and
// for the retired rmAGENT if it is reactivated. This file keeps that promise checkable: the sheets name no AGENT vault, no sheet sets another value, and the ADR records the 1e15.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSheet } from "../src/sheet.ts";

const ROOT = join(import.meta.dir, "..", "..");
const NAME = "VAULT_AGENT_MIN_POOL_LIQUIDITY";
const FLOOR = 10n ** 15n;
const SHEETS = [
  "deployments/twin-918453/stage-sheet.env",
  "deployments/base-8453-rehearsal/stage-sheet.example.env",
  "deployments/base-8453-rehearsal/deploy-3.env",
  "publish-contracts/tests/fixtures/frozen-sheet.env.example",
];
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const valueIn = (rel: string): bigint | undefined => {
  const m = new RegExp(`^${NAME}=([0-9]+)`, "m").exec(read(rel));
  return m ? BigInt(m[1]!) : undefined;
};

describe("VAULT_AGENT_MIN_POOL_LIQUIDITY stays 1e15 (ADR-0017, issue 1903)", () => {
  for (const rel of SHEETS) {
    test(`${rel} sets no value below 1e15 (it sets none or exactly 1e15)`, () => {
      const v = valueIn(rel);
      expect(v === undefined || v === FLOOR).toBe(true);
    });
  }
  test("the three-vault sheets name no AGENT vault: the parser refuses the retired vault's names", () => {
    for (const rel of ["deployments/twin-918453/stage-sheet.env", "deployments/base-8453-rehearsal/stage-sheet.example.env", "publish-contracts/tests/fixtures/frozen-sheet.env.example"]) {
      expect(read(rel), rel).not.toMatch(/^VAULT_AGENT_/m);
      expect(read(rel), rel).not.toMatch(/AGENT/);
    }
    const text = read("publish-contracts/tests/fixtures/frozen-sheet.env.example");
    expect(() => parseSheet(`${text}\n${NAME}=${FLOOR}\n`)).toThrow();
  });
  test("ADR-0017 records the floor: VAULT_AGENT_MIN_POOL_LIQUIDITY stays 1e15 for a reactivated or redeployed agent-token vault, and nothing is lowered", () => {
    const adr = read("docs/adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md");
    expect(adr).toContain(`${NAME}\` stays 1e15`);
    expect(adr).toContain("No guard, bound or executed-test floor is lowered");
  });
  test("the parked basket deploy base still reads the floor from the sheet's MIN_POOL_LIQUIDITY, so a redeploy takes it from a sheet and not from a constant", () => {
    const base = read("contracts/script/BasketVaultDeployBase.sol");
    expect(base).toContain('"MIN_POOL_LIQUIDITY"');
  });
});
