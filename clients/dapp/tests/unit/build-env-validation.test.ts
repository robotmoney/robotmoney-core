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
import {
  validateEnvClassForChain,
  validateFaucetKeyForBuild,
} from "../../src/lib/buildEnvValidation";

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

  /**
   * HARN-2 (off-chain scan remediation, issue #1026) — AC3.
   *
   * The faucet private key must never reach a PUBLIC (production-like) dapp
   * bundle nor be accepted as a public Vite build arg. The devnet/testnet/fork
   * classes intentionally inline the key for the local faucet UX (that key
   * existing in a devnet bundle is by-design and explicitly out of scope), but
   * any build that is NOT an explicit local-devnet class — i.e. mainnet, or a
   * production build with no/invalid env class — must FAIL CLOSED so the
   * key-bearing build arg can never produce a publicly-served bundle.
   *
   * This is the guard test the issue's AC3 calls for: it proves the build
   * pipeline rejects the faucet key on every public/production surface.
   */
  describe("HARN-2 AC3: faucet key cannot reach a public bundle / build arg", () => {
    // Surfaces that publish a bundle to untrusted parties (or are ambiguous and
    // must fail closed). None may accept the key as a build arg.
    const PUBLIC_OR_FAIL_CLOSED_ENVS: ReadonlyArray<string | undefined> = [
      "mainnet", // real-money chain — bundle is publicly served
      undefined, // no env class declared during a production build
      "production", // not one of the four recognized classes
      "staging", // not one of the four recognized classes
    ];

    for (const envClass of PUBLIC_OR_FAIL_CLOSED_ENVS) {
      it(`refuses the faucet key as a build arg for env class ${JSON.stringify(
        envClass ?? null,
      )}`, () => {
        const env: Record<string, string | undefined> = {
          VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY,
        };
        if (envClass !== undefined) env.VITE_ENV_CLASS = envClass;

        const result = validateFaucetKeyForBuild({
          env,
          command: "build",
          mode: "production",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // The rejection names the offending build arg so an operator sees
          // exactly which variable poisons the public bundle.
          expect(result.reason).toMatch(/VITE_FAUCET_HARNESS_PRIVATE_KEY|VITE_ENV_CLASS/);
        }
      });
    }

    it("a clean mainnet build (no faucet key) carries no key in its build env", () => {
      // The positive direction: a publicly-served bundle is permitted precisely
      // because the faucet key is absent from the build env — so it cannot be
      // inlined into the emitted JavaScript.
      const env = { VITE_ENV_CLASS: "mainnet" } as const;
      expect(env).not.toHaveProperty("VITE_FAUCET_HARNESS_PRIVATE_KEY");
      const result = validateFaucetKeyForBuild({ env, command: "build", mode: "production" });
      expect(result.ok).toBe(true);
    });
  });
});

describe("validateEnvClassForChain (issue 1729)", () => {
  const ok = (env: Record<string, string>, command: "build" | "serve" = "build") =>
    validateEnvClassForChain({ env, command }).ok;

  it("refuses a real-money chain with any class but mainnet", () => {
    for (const cls of ["fork", "devnet", "testnet"]) {
      expect(ok({ VITE_CHAIN_ID: "8453", VITE_ENV_CLASS: cls })).toBe(false);
      expect(ok({ VITE_CHAIN_ID: "1", VITE_ENV_CLASS: cls })).toBe(false);
    }
    expect(ok({ VITE_CHAIN_ID: "8453" })).toBe(false);
    expect(ok({ VITE_CHAIN_ID: "8453", VITE_ENV_CLASS: "mainnet" })).toBe(true);
  });

  it("refuses the mainnet class with another chain or a devnet RPC", () => {
    expect(ok({ VITE_CHAIN_ID: "918453", VITE_ENV_CLASS: "mainnet" })).toBe(false);
    expect(ok({ VITE_ENV_CLASS: "mainnet", VITE_DEVNET_RPC_URL: "https://x" })).toBe(false);
    expect(ok({ VITE_ENV_CLASS: "mainnet" })).toBe(true);
  });

  it("rejects a malformed VITE_CHAIN_ID and leaves non-mainnet builds and serve alone", () => {
    expect(ok({ VITE_CHAIN_ID: "0x2105", VITE_ENV_CLASS: "mainnet" })).toBe(false);
    expect(ok({ VITE_CHAIN_ID: "918453", VITE_ENV_CLASS: "devnet" })).toBe(true);
    expect(ok({ VITE_ENV_CLASS: "fork" })).toBe(true);
    expect(ok({ VITE_CHAIN_ID: "8453", VITE_ENV_CLASS: "fork" }, "serve")).toBe(true);
  });
});
