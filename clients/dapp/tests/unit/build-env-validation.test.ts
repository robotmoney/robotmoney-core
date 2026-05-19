/**
 * Build-time faucet-key guard tests (issue #431).
 *
 * Covers the acceptance criteria:
 *   - A production-like build fails when VITE_FAUCET_HARNESS_PRIVATE_KEY is set.
 *   - Devnet/testnet builds can still include the faucet key intentionally.
 *
 * The validator is pure, so we exercise it directly without spinning up
 * Vite. The same function is invoked from `vite.config.ts` during
 * `vite build`.
 */
import { describe, expect, it } from "vitest";
import { validateFaucetKeyForBuild } from "../../src/lib/buildEnvValidation";

const KEY = "0x" + "11".repeat(32);

describe("validateFaucetKeyForBuild", () => {
  describe("permitted cases", () => {
    it("permits dev server invocations regardless of key/env class", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY, VITE_ENV_CLASS: "mainnet" },
        command: "serve",
        mode: "development",
      });
      expect(result.ok).toBe(true);
    });

    it("permits a mainnet build when the faucet key is absent", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_ENV_CLASS: "mainnet" },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(true);
    });

    it("permits a mainnet build when the faucet key is an empty string", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_ENV_CLASS: "mainnet", VITE_FAUCET_HARNESS_PRIVATE_KEY: "" },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(true);
    });

    it("permits a devnet build that includes the faucet key", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_ENV_CLASS: "devnet", VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(true);
    });

    it("permits a testnet build that includes the faucet key", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_ENV_CLASS: "testnet", VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(true);
    });

    it("permits a fork build that includes the faucet key", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_ENV_CLASS: "fork", VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("refused cases", () => {
    it("refuses a mainnet build that includes the faucet key", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_ENV_CLASS: "mainnet", VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/mainnet/i);
        expect(result.reason).toMatch(/VITE_FAUCET_HARNESS_PRIVATE_KEY/);
      }
    });

    it("refuses a build with a key but no VITE_ENV_CLASS declared (fail closed)", () => {
      const result = validateFaucetKeyForBuild({
        env: { VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/VITE_ENV_CLASS/);
      }
    });

    it("refuses a build with a key and an unrecognized VITE_ENV_CLASS value", () => {
      const result = validateFaucetKeyForBuild({
        env: {
          VITE_ENV_CLASS: "staging-prod",
          VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY,
        },
        command: "build",
        mode: "production",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/VITE_ENV_CLASS/);
      }
    });
  });
});
