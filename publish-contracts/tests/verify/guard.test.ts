// CI guard (devops 57): the superseded verifier scripts are gone and nothing calls them. No Safe Transaction Service URL appears either.
// Files that must quote the old names are listed once in tests/guard-allowlist.ts.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoGrep } from "../guard-allowlist.ts";

const root = join(import.meta.dir, "..", "..", "..");
const OLD = ["mainnet-verify.sh", "mainnet-verify-sources.sh", "mainnet-verify-selftest.sh"];

const grep = (pattern: string): string[] => repoGrep(root, pattern);

describe("superseded verifier scripts", () => {
  test("the files no longer exist", () => {
    for (const f of OLD) expect(existsSync(join(root, "scripts", f))).toBe(false);
  });
  test("nothing references them", () => {
    expect(grep(OLD.map((f) => f.replace(/\./g, "\\.")).join("|"))).toEqual([]);
  });
  test("no Safe Transaction Service URL is referenced", () => {
    expect(grep("safe-transaction-[a-z0-9-]+\\.safe\\.global|/api/v1/safes/")).toEqual([]);
  });
});
