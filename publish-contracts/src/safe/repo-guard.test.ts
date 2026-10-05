// Tree check: the replaced shell Safe tool is gone, nothing calls it, and nothing talks to the Safe Transaction Service.
// (Issue 57 asks for the same assertion in a CI job; this is the bun test it pairs with.)
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoGrep } from "../../tests/guard-allowlist.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const grep = (pattern: string): string[] => repoGrep(ROOT, pattern);

test("scripts/mainnet-safe-tx.sh and its selftest no longer exist", () => {
  expect(existsSync(join(ROOT, "scripts/mainnet-safe-tx.sh"))).toBe(false);
  expect(existsSync(join(ROOT, "scripts/mainnet-safe-tx-selftest.sh"))).toBe(false);
});
test("no file references the removed shell Safe tool", () => expect(grep("mainnet-safe-tx")).toEqual([]));
test("no file references a Safe Transaction Service URL", () => expect(grep("safe-transaction-[a-z0-9-]+\\.safe\\.global|transaction\\.safe\\.global|/api/v1/safes/")).toEqual([]));
