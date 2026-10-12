// Source guard for issue 1767: share-count formatting never takes a hardcoded rm* unit literal.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("no hardcoded share-unit literal in share-count formatting", () => {
  for (const f of ["VaultDetail.tsx", "AgentPoliciesPanel.tsx"]) {
    it(`${f} passes no quoted rm* symbol to formatSharesString`, () => {
      const src = readFileSync(
        fileURLToPath(new URL(`../../src/components/${f}`, import.meta.url)),
        "utf8",
      );
      expect(src).not.toMatch(/formatShares(String)?\([^)]*"rm[A-Za-z]+"/);
    });
  }
});
