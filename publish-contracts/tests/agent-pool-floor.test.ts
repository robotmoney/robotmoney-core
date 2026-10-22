// Issue 1903, acceptance criterion 4: the production pool-depth guard VAULT_AGENT_MIN_POOL_LIQUIDITY is 1e15 in every sheet. Nothing here lowers it.
// The guard is raw liquidity L (a different dollar depth at every price), so the BNKR test asset passes it (L 3.9e16) without any change (ADR-0016).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const NAME = "VAULT_AGENT_MIN_POOL_LIQUIDITY";
const FLOOR = 10n ** 15n;

const valueIn = (rel: string): bigint | undefined => {
  const m = new RegExp(`^${NAME}=([0-9]+)`, "m").exec(readFileSync(join(ROOT, rel), "utf8"));
  return m ? BigInt(m[1]!) : undefined;
};

describe("VAULT_AGENT_MIN_POOL_LIQUIDITY is 1e15 in every sheet", () => {
  for (const rel of [
    "deployments/twin-918453/stage-sheet.env",
    "deployments/base-8453-rehearsal/stage-sheet.example.env",
    "publish-contracts/tests/fixtures/frozen-sheet.env.example",
  ]) {
    test(`${rel} sets exactly 1e15`, () => {
      expect(valueIn(rel)).toBe(FLOOR);
    });
  }
  test("deploy-3.env sets 1e15 or inherits the 1e15 of the example sheet it overlays, never another value", () => {
    const own = valueIn("deployments/base-8453-rehearsal/deploy-3.env");
    const inherited = valueIn("deployments/base-8453-rehearsal/stage-sheet.example.env");
    expect(own ?? inherited).toBe(FLOOR);
  });
});
