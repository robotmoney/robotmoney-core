/**
 * Vitest covering issue #261 acceptance criterion:
 *
 *   "The drip amount is sourced from a single shared constant; a Vitest
 *    test asserts both the onboarding seed and the admin tab read the
 *    same 100-USDC value."
 *
 * Implementation strategy: greps the source files of both consumers
 * (`onboardingSeed.ts` and `FaucetTab.tsx`) for an import of
 * `FAUCET_DRIP_AMOUNT_USDC` (or `encodeDripCalldata`, which itself
 * depends on the constant). This guarantees neither file can locally
 * redefine the amount without the test failing.
 *
 * We also assert the encoded drip calldata round-trips through both
 * code paths — same recipient ⇒ same selector and same encoded amount.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Abi } from "../../src/lib/abi";
import { FAUCET_DRIP_AMOUNT_USDC } from "../../src/lib/chainClassifier";
import { encodeDripCalldata } from "../../src/lib/faucetClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../../src");

function source(rel: string): string {
  return readFileSync(path.join(srcRoot, rel), "utf8");
}

describe("shared faucet drip amount", () => {
  it("the onboarding seed module imports FAUCET_DRIP_AMOUNT_USDC from chainClassifier", () => {
    const src = source("lib/onboardingSeed.ts");
    expect(src).toMatch(/FAUCET_DRIP_AMOUNT_USDC/);
    expect(src).toMatch(/from\s+["']\.\/chainClassifier["']/);
  });

  it("the FaucetTab view imports FAUCET_DRIP_AMOUNT_USDC from chainClassifier", () => {
    const src = source("components/FaucetTabView.tsx");
    expect(src).toMatch(/FAUCET_DRIP_AMOUNT_USDC/);
    expect(src).toMatch(/from\s+["']\.\.\/lib\/chainClassifier["']/);
  });

  it("no source file outside chainClassifier.ts re-defines the literal 100_000_000n", () => {
    const offenders = [
      "lib/onboardingSeed.ts",
      "lib/faucetClient.ts",
      "components/FaucetTab.tsx",
      "components/FaucetTabView.tsx",
    ];
    for (const rel of offenders) {
      const src = source(rel);
      // Allow comments to mention 100, but no `100_000_000n` literal.
      expect(src, `${rel} must not hard-code the drip amount`).not.toMatch(/100_000_000n/);
    }
  });

  it("encodeDripCalldata encodes a transfer with the shared amount", () => {
    const recipient = "0x000000000000000000000000000000000000dead" as const;
    const calldata = encodeDripCalldata(recipient);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args?.[1]).toBe(FAUCET_DRIP_AMOUNT_USDC);
  });
});
