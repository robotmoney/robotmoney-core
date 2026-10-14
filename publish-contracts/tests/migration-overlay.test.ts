import { expect, test } from "bun:test";
import { buildMigrationOverlay, currentGeneration } from "../src/migration-overlay.ts";
import type { RedeployRecord } from "../src/redeploy-vault.ts";
const old = `0x${"11".repeat(20)}`, next = `0x${"22".repeat(20)}`, hash = `0x${"33".repeat(32)}`;
const record = { status: "governed", vault: "rmPROTO", old_vault: old, new_vault: next, execute_tx: hash, operation_id: hash } as RedeployRecord;
test("only an executed migration with both raw hashes selects the current address", () => {
  const overlay = buildMigrationOverlay(8453, 100n, [record], { [old]: hash, [next]: hash });
  expect(currentGeneration(overlay, 8453, "rmPROTO", old)).toBe(next);
  expect(currentGeneration(overlay, 8453, "rmUSDC", old)).toBe(old);
  expect(() => currentGeneration(overlay, 918453, "rmPROTO", old)).toThrow();
  expect(() => currentGeneration(overlay, 8453, "rmPROTO", next)).toThrow();
  expect(() => buildMigrationOverlay(8453, 100n, [{ ...record, status: "deployed" }], { [old]: hash, [next]: hash })).toThrow();
  expect(() => buildMigrationOverlay(8453, 100n, [record], { [old]: hash })).toThrow();
});
