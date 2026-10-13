// Core issue 1778: a dust USDC redeem that reverts "Too little received" points to redeemInKind.
import { describe, expect, it } from "vitest";
import { redeemFailureHint, TOO_LITTLE_RECEIVED_HINT } from "../../src/lib/redeemFailureHint";

describe("redeemFailureHint", () => {
  it("points a Too little received revert to redeemInKind", () => {
    const hint = redeemFailureHint(
      'The contract function "redeem" reverted with the following reason:\nToo little received',
    );
    expect(hint).toBe(TOO_LITTLE_RECEIVED_HINT);
    expect(hint).toContain("redeemInKind(shares, receiver, owner)");
  });
  it("adds nothing for other failures", () => {
    expect(redeemFailureHint("InsufficientGas()")).toBeNull();
    expect(redeemFailureHint(undefined)).toBeNull();
  });
});
