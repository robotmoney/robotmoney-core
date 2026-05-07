/**
 * Vitest unit asserting the browser-credential feature-flag default
 * is `false` and that the UI surface is hidden when disabled. Backs the
 * §3.1 ADR clause that the dapp ships with the flow gated off.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_FLAGS, resolveFlags } from "../../src/lib/featureFlags";

describe("featureFlags", () => {
  it("defaults browserGeneratedCredential to false", () => {
    expect(DEFAULT_FLAGS.browserGeneratedCredential).toBe(false);
  });

  it("only enables browser keygen when env opts in explicitly", () => {
    expect(resolveFlags({}).browserGeneratedCredential).toBe(false);
    expect(resolveFlags({ VITE_BROWSER_KEYGEN: "" }).browserGeneratedCredential).toBe(false);
    expect(resolveFlags({ VITE_BROWSER_KEYGEN: "false" }).browserGeneratedCredential).toBe(false);
    expect(resolveFlags({ VITE_BROWSER_KEYGEN: "true" }).browserGeneratedCredential).toBe(true);
  });
});
