import { describe, expect, test } from "bun:test";
import { scanText } from "./check-stale-snapshot-docs.ts";

describe("stale snapshot docs gate", () => {
  test("flags a live claim", () => {
    expect(scanText("docs/x.md", "Boots anvil --load-state from the fixture.").length).toBe(1);
    expect(scanText("docs/x.md", "Geth + Lighthouse devnet").length).toBe(1);
    expect(scanText("docs/x.md", "see CURRENT.anvil-state").length).toBe(1);
  });
  test("passes a retirement note", () => {
    expect(scanText("docs/x.md", "There is no warm list.")).toEqual([]);
  });
  test("passes a Historical banner file", () => {
    expect(scanText("docs/h.md", "# T\n\n> **Historical.** old\n\nanvil_dumpState\n")).toEqual([]);
  });
  test("passes an allowlisted file", () => {
    expect(scanText("scripts/devnet/README.md", "warm list")).toEqual([]);
  });
});
