// Canonical: docs/architecture.md §5.3 — Human Dapp (faucet UX)

/**
 * Onboarding seed — drip a fixed `FAUCET_DRIP_AMOUNT_USDC` (100 USDC)
 * into a newly-onboarded account on testnet/devnet builds only. Issue
 * #261 acceptance criterion:
 *
 *   "On the smoke-test full-stack devnet (chain-id 918453), creating a
 *    new account during onboarding results in that account's USDC
 *    balance increasing by exactly 100 USDC."
 *
 * This module exposes a pure async handler that the OnboardingWizard
 * invokes once per successful `authorizeAgent`. The handler:
 *
 *   1. Classifies the active chain. If `mainnet`, returns
 *      `{ status: "skipped-mainnet" }` and does NOT touch the network.
 *   2. Looks up the build-time harness key. If absent, returns
 *      `{ status: "skipped-no-harness" }` (e.g. local dev build without
 *      VITE_FAUCET_HARNESS_PRIVATE_KEY).
 *   3. Otherwise signs and broadcasts a USDC `transfer(recipient, 100e6)`
 *      via `dripUsdc()` (lib/faucetClient.ts), the same canonical funding
 *      path the Faucet tab uses.
 *
 * Returning a discriminated union (rather than a boolean) lets the
 * caller render exactly-once feedback and lets Vitest assert the gating
 * decision without mocking the network.
 *
 * Canonical: docs/prd.md, issue #261, lib/faucetClient.ts.
 */

import type { Address } from "viem";
import { classifyChain, FAUCET_DRIP_AMOUNT_USDC } from "./chainClassifier";
import {
  dripUsdc,
  readHarnessPrivateKey,
  type DripUsdcArgs,
  type Eip1193Like,
} from "./faucetClient";

export type SeedResult =
  | { status: "skipped-mainnet" }
  | { status: "skipped-no-harness" }
  | { status: "skipped-no-provider" }
  | { status: "seeded"; hash: `0x${string}`; amount: bigint }
  | { status: "failed"; message: string };

export interface SeedArgs {
  readonly chainId: number;
  readonly recipient: Address;
  readonly usdcAddress: Address;
  readonly env: Record<string, string | undefined>;
  readonly provider: Eip1193Like | undefined;
  /** Injected for tests; production passes `dripUsdc` from faucetClient. */
  readonly drip?: (args: DripUsdcArgs) => Promise<`0x${string}`>;
}

export async function seedOnboardingUsdc(args: SeedArgs): Promise<SeedResult> {
  if (classifyChain(args.chainId) === "mainnet") {
    return { status: "skipped-mainnet" };
  }
  const harnessPrivateKey = readHarnessPrivateKey(args.env);
  if (!harnessPrivateKey) {
    return { status: "skipped-no-harness" };
  }
  if (!args.provider) {
    return { status: "skipped-no-provider" };
  }
  const drip = args.drip ?? dripUsdc;
  try {
    const hash = await drip({
      usdcAddress: args.usdcAddress,
      recipient: args.recipient,
      provider: args.provider,
      harnessPrivateKey,
      chainId: args.chainId,
    });
    return { status: "seeded", hash, amount: FAUCET_DRIP_AMOUNT_USDC };
  } catch (err) {
    const message =
      typeof err === "object" && err !== null && "shortMessage" in err
        ? String((err as { shortMessage: unknown }).shortMessage)
        : err instanceof Error
          ? err.message
          : String(err);
    return { status: "failed", message };
  }
}
