/**
 * Build-time validation that prevents the dapp from bundling the testnet
 * faucet private key into a production-like build (issue #431).
 *
 * Threat model:
 *   `VITE_FAUCET_HARNESS_PRIVATE_KEY` is intentionally inlined into the
 *   bundle so the testnet faucet UX works without a server. Anything in
 *   the bundle is public — anyone with the dapp HTML can extract the
 *   key. If that key is *funded* on a mainnet (or any real-money chain),
 *   the faucet account is publicly drainable.
 *
 * The defence in depth strategy:
 *   1. Runtime: `chainClassifier.ts` hides faucet UI on mainnet chain IDs
 *      and `seedOnboardingUsdc` refuses to drip on mainnet. (Already
 *      shipped, kept in place.)
 *   2. Build time (this module): refuse to even *produce* a bundle that
 *      contains the key when `VITE_ENV_CLASS=mainnet` or when the Vite
 *      build mode signals production-like intent without an explicit
 *      devnet/testnet env class. Operators cannot ship a poisoned bundle
 *      by accident.
 *   3. Docs: `.env.example` carries a prominent warning that bundled
 *      faucet keys are public secrets and must be throwaway-funded only.
 *
 * This module is invoked from `vite.config.ts` during build and is also
 * exercised directly by unit tests so the rules are independently
 * verifiable without spinning up a Vite build.
 *
 * Canonical:
 *   - docs/code-reviews/review-codex-20260518-234945.md §7
 *   - docs/security/dapp-topology.md
 *   - docs/testing/smoke-test-design.md (faucet harness origin)
 */

/** Environment-class tag accepted by the dapp. Mirrors `VITE_ENV_CLASS`. */
export type DappEnvClass = "fork" | "devnet" | "testnet" | "mainnet";

/** Vite invocation mode — only `build` is policed; `serve` (dev server) is unaffected. */
export type ViteCommand = "build" | "serve";

export interface FaucetKeyValidationInput {
  /**
   * The build-time env map. In Vite plugins this is `loadEnv(...)`; in
   * tests it is a plain object. Only `VITE_ENV_CLASS` and
   * `VITE_FAUCET_HARNESS_PRIVATE_KEY` are read.
   */
  readonly env: Record<string, string | undefined>;
  /** `build` (production-like) or `serve` (dev server). */
  readonly command: ViteCommand;
  /**
   * Vite's `--mode` value. Treated as a hint only — when `command` is
   * `build` and `mode` is `production` (the default) we require an
   * explicit non-mainnet `VITE_ENV_CLASS` before we will permit the key.
   */
  readonly mode: string;
}

export type FaucetKeyValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether a build invocation is allowed to include the faucet
 * private key.
 *
 * Rules:
 *   - Dev server (`command === "serve"`) is always permitted — never
 *     produces a distributable artefact.
 *   - If the key is not set, the build is always permitted.
 *   - If `VITE_ENV_CLASS=mainnet`, the build is refused. Mainnet bundles
 *     must never contain a private key.
 *   - If `VITE_ENV_CLASS` is missing or not one of the four recognized
 *     values during a production build, refuse — fail closed.
 *   - For `fork`, `devnet`, `testnet`, the key is permitted (intentional
 *     bundling for the faucet UX).
 */
export function validateFaucetKeyForBuild(
  input: FaucetKeyValidationInput,
): FaucetKeyValidationResult {
  const { env, command } = input;
  if (command !== "build") return { ok: true };

  const rawKey = env.VITE_FAUCET_HARNESS_PRIVATE_KEY;
  const keyPresent = typeof rawKey === "string" && rawKey.trim().length > 0;
  if (!keyPresent) return { ok: true };

  const rawClass = env.VITE_ENV_CLASS;
  const envClass = isDappEnvClass(rawClass) ? rawClass : undefined;

  if (envClass === "mainnet") {
    return {
      ok: false,
      reason:
        "VITE_FAUCET_HARNESS_PRIVATE_KEY must not be set when VITE_ENV_CLASS=mainnet. " +
        "Bundled keys are public secrets — anyone with the dapp HTML can extract them. " +
        "Unset VITE_FAUCET_HARNESS_PRIVATE_KEY for mainnet/production-like builds. " +
        "See docs/code-reviews/review-codex-20260518-234945.md §7.",
    };
  }

  if (envClass === undefined) {
    return {
      ok: false,
      reason:
        "VITE_FAUCET_HARNESS_PRIVATE_KEY is set but VITE_ENV_CLASS is missing or invalid " +
        `(got ${JSON.stringify(rawClass ?? null)}). Production builds must declare an explicit ` +
        "non-mainnet env class (fork|devnet|testnet) before a faucet key is permitted in the bundle. " +
        "See docs/code-reviews/review-codex-20260518-234945.md §7.",
    };
  }

  // envClass is one of fork|devnet|testnet — explicitly devnet/testnet — allowed.
  return { ok: true };
}

function isDappEnvClass(value: unknown): value is DappEnvClass {
  return value === "fork" || value === "devnet" || value === "testnet" || value === "mainnet";
}
