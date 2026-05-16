/**
 * Vitest unit tests for clients/dapp/src/feature-flags.ts.
 * Verifies that the TypeScript constants and registry match
 * config/feature-flags.json exactly.
 * Implements: issue #389 AC — TypeScript surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MULTI_VAULT_ENABLED,
  PORTFOLIO_ROUTER_ENABLED,
  INDEXER_MULTI_VAULT_EVENTS,
  FLAG_REGISTRY,
  isEnabled,
  parseFlagBitmap,
} from "../../src/feature-flags";

// ---------------------------------------------------------------------------
// Load the canonical JSON registry to cross-check IDs.
// ---------------------------------------------------------------------------
const registryPath = resolve(__dirname, "../../../../config/feature-flags.json");
const registryJson = JSON.parse(readFileSync(registryPath, "utf8")) as {
  flags: Array<{ id: number; name: string; description: string }>;
};

// ---------------------------------------------------------------------------
// ID constants match the JSON registry
// ---------------------------------------------------------------------------
describe("flag ID constants match config/feature-flags.json", () => {
  it("MULTI_VAULT_ENABLED === 0", () => {
    expect(MULTI_VAULT_ENABLED).toBe(0);
    const entry = registryJson.flags.find((f) => f.name === "MULTI_VAULT_ENABLED");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(MULTI_VAULT_ENABLED);
  });

  it("PORTFOLIO_ROUTER_ENABLED === 1", () => {
    expect(PORTFOLIO_ROUTER_ENABLED).toBe(1);
    const entry = registryJson.flags.find((f) => f.name === "PORTFOLIO_ROUTER_ENABLED");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(PORTFOLIO_ROUTER_ENABLED);
  });

  it("INDEXER_MULTI_VAULT_EVENTS === 2", () => {
    expect(INDEXER_MULTI_VAULT_EVENTS).toBe(2);
    const entry = registryJson.flags.find((f) => f.name === "INDEXER_MULTI_VAULT_EVENTS");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(INDEXER_MULTI_VAULT_EVENTS);
  });
});

// ---------------------------------------------------------------------------
// FLAG_REGISTRY is consistent with the JSON
// ---------------------------------------------------------------------------
describe("FLAG_REGISTRY matches config/feature-flags.json", () => {
  it("has the same number of entries as the JSON registry", () => {
    expect(FLAG_REGISTRY.length).toBe(registryJson.flags.length);
  });

  it("every entry ID matches the JSON registry by name", () => {
    for (const entry of FLAG_REGISTRY) {
      const jsonEntry = registryJson.flags.find((f) => f.name === entry.name);
      expect(jsonEntry, `Flag ${entry.name} missing from JSON registry`).toBeDefined();
      expect(jsonEntry!.id).toBe(entry.id);
    }
  });
});

// ---------------------------------------------------------------------------
// isEnabled bitmap helper
// ---------------------------------------------------------------------------
describe("isEnabled", () => {
  it("returns true when the flag bit is set", () => {
    expect(isEnabled(MULTI_VAULT_ENABLED, 0b001)).toBe(true);
    expect(isEnabled(PORTFOLIO_ROUTER_ENABLED, 0b010)).toBe(true);
    expect(isEnabled(INDEXER_MULTI_VAULT_EVENTS, 0b100)).toBe(true);
  });

  it("returns false when the flag bit is clear", () => {
    expect(isEnabled(MULTI_VAULT_ENABLED, 0b110)).toBe(false);
    expect(isEnabled(PORTFOLIO_ROUTER_ENABLED, 0b101)).toBe(false);
    expect(isEnabled(INDEXER_MULTI_VAULT_EVENTS, 0b011)).toBe(false);
  });

  it("returns false for bitmap 0", () => {
    expect(isEnabled(MULTI_VAULT_ENABLED, 0)).toBe(false);
    expect(isEnabled(PORTFOLIO_ROUTER_ENABLED, 0)).toBe(false);
    expect(isEnabled(INDEXER_MULTI_VAULT_EVENTS, 0)).toBe(false);
  });

  it("all flags on when bitmap = 7 (0b111)", () => {
    expect(isEnabled(MULTI_VAULT_ENABLED, 7)).toBe(true);
    expect(isEnabled(PORTFOLIO_ROUTER_ENABLED, 7)).toBe(true);
    expect(isEnabled(INDEXER_MULTI_VAULT_EVENTS, 7)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFlagBitmap
// ---------------------------------------------------------------------------
describe("parseFlagBitmap", () => {
  it("returns 0 when env is empty", () => {
    expect(parseFlagBitmap({})).toBe(0);
  });

  it("returns 0 when VITE_FEATURE_FLAGS is absent", () => {
    expect(parseFlagBitmap({ VITE_FEATURE_FLAGS: undefined })).toBe(0);
  });

  it("parses decimal integer correctly", () => {
    expect(parseFlagBitmap({ VITE_FEATURE_FLAGS: "3" })).toBe(3);
    expect(parseFlagBitmap({ VITE_FEATURE_FLAGS: "7" })).toBe(7);
  });

  it("returns 0 for non-numeric value", () => {
    expect(parseFlagBitmap({ VITE_FEATURE_FLAGS: "true" })).toBe(0);
    expect(parseFlagBitmap({ VITE_FEATURE_FLAGS: "" })).toBe(0);
  });

  it("enables MULTI_VAULT_ENABLED when bitmap bit 0 is set", () => {
    const bitmap = parseFlagBitmap({ VITE_FEATURE_FLAGS: "1" });
    expect(isEnabled(MULTI_VAULT_ENABLED, bitmap)).toBe(true);
    expect(isEnabled(PORTFOLIO_ROUTER_ENABLED, bitmap)).toBe(false);
  });
});
