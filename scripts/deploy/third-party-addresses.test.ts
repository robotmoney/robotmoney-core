// Canonical: core issue 1490 (clean room rule, core 1498).
// The third-party address list matches the Rust harness constants and the vault deploy script, and
// holds no Robot Money production address.
// Run: bun test scripts/deploy/third-party-addresses.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCTION_ADDRESSES } from "../ci/check-no-production-addresses.ts";

const repo = join(import.meta.dir, "..", "..");
const list = JSON.parse(readFileSync(join(import.meta.dir, "third-party-addresses.json"), "utf8")) as {
  addresses: Record<string, string>;
};
const rust = readFileSync(join(repo, "testing/fork-e2e-rust/src/addresses.rs"), "utf8").toLowerCase();
const deploy = readFileSync(join(repo, "contracts/script/DeployVault.s.sol"), "utf8").toLowerCase();

describe("third-party addresses", () => {
  test("every entry is a 20 byte address", () => {
    for (const [k, v] of Object.entries(list.addresses)) expect(v, k).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("every entry appears in the Rust harness constants", () => {
    for (const [k, v] of Object.entries(list.addresses)) expect(rust, k).toContain(v.slice(2).toLowerCase());
  });

  test("the venue entries match DeployVault.s.sol", () => {
    for (const k of ["usdc", "aave_v3_pool", "aave_v3_a_token", "compound_v3_comet", "moonwell_flagship_usdc"]) {
      expect(deploy, k).toContain(list.addresses[k]!.slice(2).toLowerCase());
    }
  });

  test("no Robot Money production address is listed or constant in the harness", () => {
    const text = JSON.stringify(list).toLowerCase();
    for (const p of PRODUCTION_ADDRESSES) {
      expect(text).not.toContain(p.address);
      expect(rust).not.toContain(p.address);
    }
  });
});
