/**
 * Vitest unit covering feature-flag defaults. The dapp does NOT expose a
 * browser-keygen flag — per docs/technical/dapp-credential-decisions.md
 * §3.1 the dapp never holds private keys, so there is nothing to gate.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_FLAGS, resolveFlags } from "../../src/lib/featureFlags";

describe("featureFlags", () => {
  it("defaults historyPane to false", () => {
    expect(DEFAULT_FLAGS.historyPane).toBe(false);
  });

  it("only enables historyPane when VITE_HISTORY_PANE='true'", () => {
    expect(resolveFlags({}).historyPane).toBe(false);
    expect(resolveFlags({ VITE_HISTORY_PANE: "" }).historyPane).toBe(false);
    expect(resolveFlags({ VITE_HISTORY_PANE: "false" }).historyPane).toBe(false);
    expect(resolveFlags({ VITE_HISTORY_PANE: "true" }).historyPane).toBe(true);
  });

  it("does not expose a browserGeneratedCredential field", () => {
    expect(
      (DEFAULT_FLAGS as unknown as Record<string, unknown>).browserGeneratedCredential,
    ).toBeUndefined();
    expect(
      (resolveFlags({}) as unknown as Record<string, unknown>).browserGeneratedCredential,
    ).toBeUndefined();
  });
});
