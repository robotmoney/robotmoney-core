// Pure decision table for the wrong-chain write guard (issue 1729).
import { describe, expect, it } from "vitest";
import {
  evaluateWriteGuard,
  isWriteBlocked,
  resolveWriteTargetChainId,
} from "../../src/lib/writeChainGuard";

const MAINNET = { VITE_ENV_CLASS: "mainnet" };

describe("write chain guard decision", () => {
  it("targets 8453 on the mainnet class only", () => {
    expect(resolveWriteTargetChainId(MAINNET)).toBe(8453);
    for (const cls of ["fork", "devnet", "testnet", undefined]) {
      expect(resolveWriteTargetChainId({ VITE_ENV_CLASS: cls })).toBeUndefined();
    }
  });

  it("allows only an exact match with 8453 on the mainnet class", () => {
    expect(isWriteBlocked(evaluateWriteGuard(MAINNET, 8453))).toBe(false);
    for (const wrong of [1, 918453, 84532, 31337, 0, 8454]) {
      const g = evaluateWriteGuard(MAINNET, wrong);
      expect(g.kind).toBe("wrong-chain");
      expect(isWriteBlocked(g)).toBe(true);
    }
  });

  it("blocks when no wallet is connected on the mainnet class", () => {
    expect(isWriteBlocked(evaluateWriteGuard(MAINNET, undefined))).toBe(true);
  });

  it("does not apply to other classes", () => {
    expect(evaluateWriteGuard({ VITE_ENV_CLASS: "devnet" }, 1).kind).toBe("not-applicable");
    expect(isWriteBlocked(evaluateWriteGuard({ VITE_ENV_CLASS: "fork" }, 1))).toBe(false);
  });
});
