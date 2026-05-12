/**
 * Integration test — `seedOnboardingUsdc` gating logic. Covers issue
 * #261 acceptance criteria:
 *
 *   - "Integration test for the onboarding seed step: given a stubbed
 *     account-creation event on a testnet chain, the seed handler is
 *     invoked exactly once per new account with amount = 100 USDC; on
 *     a mainnet chain, the handler is never invoked."
 *
 * The drip bridge is injected, so the network is never touched. The
 * test asserts the gating decision purely from the public
 * `seedOnboardingUsdc` API: classifier output, env-var presence, and
 * provider availability.
 */
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { seedOnboardingUsdc } from "../../src/lib/onboardingSeed";
import type { DripUsdcArgs } from "../../src/lib/faucetClient";
import { FAUCET_DRIP_AMOUNT_USDC } from "../../src/lib/chainClassifier";

const USDC = "0x4444444444444444444444444444444444444444" as const;
const RECIPIENT = "0x5555555555555555555555555555555555555555" as const;
const KEY = "0x" + "22".repeat(32);
const FAKE_HASH = "0xabc123" as Hex;

function makeArgs(overrides: Partial<Parameters<typeof seedOnboardingUsdc>[0]> = {}) {
  return {
    chainId: 918453,
    recipient: RECIPIENT,
    usdcAddress: USDC,
    env: { VITE_FAUCET_HARNESS_PRIVATE_KEY: KEY },
    provider: { request: vi.fn() },
    ...overrides,
  };
}

describe("seedOnboardingUsdc", () => {
  it("skips on mainnet (chainId 1) and never invokes the drip handler", async () => {
    const drip = vi.fn();
    const result = await seedOnboardingUsdc(
      makeArgs({ chainId: 1, drip: drip as unknown as (a: DripUsdcArgs) => Promise<Hex> }),
    );
    expect(result).toEqual({ status: "skipped-mainnet" });
    expect(drip).not.toHaveBeenCalled();
  });

  it("skips on Base mainnet (chainId 8453)", async () => {
    const drip = vi.fn();
    const result = await seedOnboardingUsdc(
      makeArgs({ chainId: 8453, drip: drip as unknown as (a: DripUsdcArgs) => Promise<Hex> }),
    );
    expect(result.status).toBe("skipped-mainnet");
    expect(drip).not.toHaveBeenCalled();
  });

  it("skips when the harness key is absent (mainnet operator build)", async () => {
    const drip = vi.fn();
    const result = await seedOnboardingUsdc(
      makeArgs({
        env: {},
        drip: drip as unknown as (a: DripUsdcArgs) => Promise<Hex>,
      }),
    );
    expect(result.status).toBe("skipped-no-harness");
    expect(drip).not.toHaveBeenCalled();
  });

  it("skips when no injected provider is available", async () => {
    const drip = vi.fn();
    const result = await seedOnboardingUsdc(
      makeArgs({
        provider: undefined,
        drip: drip as unknown as (a: DripUsdcArgs) => Promise<Hex>,
      }),
    );
    expect(result.status).toBe("skipped-no-provider");
    expect(drip).not.toHaveBeenCalled();
  });

  it("invokes drip exactly once on a testnet chain and returns the amount", async () => {
    const drip = vi.fn().mockResolvedValue(FAKE_HASH);
    const result = await seedOnboardingUsdc(
      makeArgs({ drip: drip as unknown as (a: DripUsdcArgs) => Promise<Hex> }),
    );
    expect(drip).toHaveBeenCalledTimes(1);
    const callArg = drip.mock.calls[0][0] as DripUsdcArgs;
    expect(callArg.recipient).toBe(RECIPIENT);
    expect(callArg.usdcAddress).toBe(USDC);
    expect(callArg.chainId).toBe(918453);
    expect(result).toEqual({
      status: "seeded",
      hash: FAKE_HASH,
      amount: FAUCET_DRIP_AMOUNT_USDC,
    });
  });

  it("returns a `failed` result if drip rejects", async () => {
    const drip = vi.fn().mockRejectedValue(new Error("revert: insufficient harness balance"));
    const result = await seedOnboardingUsdc(
      makeArgs({ drip: drip as unknown as (a: DripUsdcArgs) => Promise<Hex> }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toMatch(/insufficient harness balance/);
    }
  });
});
