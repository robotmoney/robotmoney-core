// Source guard for issue 1767: share-count formatting never takes a hardcoded rm* unit literal anywhere
// under src/components.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../src/components/", import.meta.url));
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f));

describe("no hardcoded share-unit literal in share-count formatting", () => {
  it("scans a non-empty component set", () => {
    expect(files.length).toBeGreaterThan(5);
  });
  for (const f of files) {
    it(`${f} passes no quoted rm* symbol to formatShares/formatSharesString`, () => {
      const src = readFileSync(`${DIR}${f}`, "utf8");
      expect(src).not.toMatch(/formatShares(String)?\([^)]*["']rm[A-Za-z]+["']/);
    });
  }
});
