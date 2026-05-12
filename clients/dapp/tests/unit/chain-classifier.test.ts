/**
 * Vitest unit covering the chain-ID classifier and the shared faucet drip
 * constant (issue #261). The classifier is the single safety gate that
 * keeps the testnet/devnet USDC faucet code path off mainnet, so its
 * behaviour for the canonical mainnet IDs (1, 8453) must be locked in.
 */
import { describe, expect, it } from "vitest";
import {
  classifyChain,
  FAUCET_DRIP_AMOUNT_LABEL,
  FAUCET_DRIP_AMOUNT_USDC,
  MAINNET_CHAIN_IDS,
  ROBOT_MONEY_DEVNET_CHAIN_ID,
} from "../../src/lib/chainClassifier";

describe("classifyChain", () => {
  it("classifies canonical mainnet IDs as `mainnet`", () => {
    expect(classifyChain(1)).toBe("mainnet");
    expect(classifyChain(8453)).toBe("mainnet");
  });

  it("classifies the smoke-test devnet (918453) as `testnet`", () => {
    expect(classifyChain(ROBOT_MONEY_DEVNET_CHAIN_ID)).toBe("testnet");
    expect(ROBOT_MONEY_DEVNET_CHAIN_ID).toBe(918453);
  });

  it("classifies other known testnets as `testnet`", () => {
    expect(classifyChain(11155111)).toBe("testnet"); // Sepolia
    expect(classifyChain(84532)).toBe("testnet"); // Base Sepolia
    expect(classifyChain(31337)).toBe("testnet"); // foundry
  });

  it("classifies disconnected (chain id 0) as `mainnet` (fails closed)", () => {
    expect(classifyChain(0)).toBe("mainnet");
  });

  it("MAINNET_CHAIN_IDS contains exactly Ethereum and Base mainnet", () => {
    expect([...MAINNET_CHAIN_IDS]).toEqual([1, 8453]);
  });
});

describe("FAUCET_DRIP_AMOUNT_USDC", () => {
  it("is exactly 100 USDC in 6-decimal base units", () => {
    expect(FAUCET_DRIP_AMOUNT_USDC).toBe(100_000_000n);
  });

  it("human label matches the numeric constant", () => {
    expect(FAUCET_DRIP_AMOUNT_LABEL).toBe("100 USDC");
  });
});
