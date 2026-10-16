/**
 * Unit tests for the pure gateway bytecode verifier (issue #207).
 *
 * Covers all fail-closed paths:
 *   - matching hash       → verified
 *   - mismatched hash     → refused (with mismatch detail)
 *   - missing expected hash → refused
 *   - zero gateway address  → refused
 *   - empty bytecode        → refused
 *   - undefined code (in-flight) → pending
 */
import { describe, it, expect } from "vitest";
import { keccak256 } from "viem";
import {
  computeGatewayVerification,
  computeVerificationState,
  describeVerificationCause,
  ZERO_ADDRESS,
  type VerificationCause,
} from "../../src/lib/gatewayVerifier";
import { buildVaultPreview } from "../../src/lib/vaultPreview";
import { buildRouterPreview } from "../../src/lib/routerPreview";

const GATEWAY = "0x1111111111111111111111111111111111111111";
// Minimal non-empty bytecode fixture.
const CODE = "0xdeadbeef" as const;
const CODE_HASH = keccak256(CODE);
const WRONG_HASH = "0x" + "ab".repeat(32);

describe("computeVerificationState", () => {
  it("returns verified when hash matches", () => {
    const result = computeVerificationState(GATEWAY, CODE_HASH, CODE);
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.computedHash.toLowerCase()).toBe(CODE_HASH.toLowerCase());
    }
  });

  it("returns refused when hash mismatches", () => {
    const result = computeVerificationState(GATEWAY, WRONG_HASH, CODE);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      // reason is now a typed ProductReasonCode — mismatch maps to "unknown_revert"
      expect(result.reason).toBe("unknown_revert");
    }
  });

  it("returns refused when expected hash is missing", () => {
    const result = computeVerificationState(GATEWAY, undefined, CODE);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      // reason is now a typed ProductReasonCode
      expect(result.reason).toBe("unknown_revert");
    }
  });

  it("returns refused when expected hash is empty string", () => {
    const result = computeVerificationState(GATEWAY, "", CODE);
    expect(result.status).toBe("refused");
  });

  it("returns refused when gateway address is zero", () => {
    const result = computeVerificationState(ZERO_ADDRESS, CODE_HASH, CODE);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      // reason is now a typed ProductReasonCode
      expect(result.reason).toBe("unknown_revert");
    }
  });

  it("returns refused when gateway address is missing", () => {
    const result = computeVerificationState("", CODE_HASH, CODE);
    expect(result.status).toBe("refused");
  });

  it("returns refused when bytecode is null (not deployed)", () => {
    const result = computeVerificationState(GATEWAY, CODE_HASH, null);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      // reason is now a typed ProductReasonCode
      expect(result.reason).toBe("unknown_revert");
    }
  });

  it("returns refused when bytecode is '0x' (empty code)", () => {
    const result = computeVerificationState(GATEWAY, CODE_HASH, "0x");
    expect(result.status).toBe("refused");
  });

  it("returns pending when code is undefined (fetch in-flight)", () => {
    const result = computeVerificationState(GATEWAY, CODE_HASH, undefined);
    expect(result.status).toBe("pending");
  });

  it("returns refused (not pending) when expectedHash is missing even with undefined code", () => {
    const result = computeVerificationState(GATEWAY, undefined, undefined);
    expect(result.status).toBe("refused");
  });
});

// QA plan U5, finding DR-9: every refusal names its own cause, and the banner prints one
// distinct sentence per cause instead of the same "unknown_revert" for all of them.
describe("one refusal cause per failure", () => {
  const causeOf = (r: ReturnType<typeof computeVerificationState>) =>
    r.status === "refused" ? r.cause : `not refused: ${r.status}`;

  it("names pin-missing, address-missing, no-code and hash-mismatch", () => {
    expect(causeOf(computeVerificationState(GATEWAY, undefined, CODE))).toBe("pin-missing");
    expect(causeOf(computeVerificationState(GATEWAY, " ", CODE))).toBe("pin-missing");
    expect(causeOf(computeVerificationState(ZERO_ADDRESS, CODE_HASH, CODE))).toBe(
      "address-missing",
    );
    expect(causeOf(computeVerificationState("", CODE_HASH, CODE))).toBe("address-missing");
    expect(causeOf(computeVerificationState(GATEWAY, CODE_HASH, null))).toBe("no-code");
    expect(causeOf(computeVerificationState(GATEWAY, CODE_HASH, "0x"))).toBe("no-code");
    expect(causeOf(computeVerificationState(GATEWAY, WRONG_HASH, CODE))).toBe("hash-mismatch");
  });

  it("keeps the stable product reason code on every refusal", () => {
    const r = computeVerificationState(GATEWAY, WRONG_HASH, CODE);
    expect(r).toEqual({ status: "refused", reason: "unknown_revert", cause: "hash-mismatch" });
  });

  it("describes each cause with its own sentence", () => {
    const causes: VerificationCause[] = [
      "pin-missing",
      "address-missing",
      "no-code",
      "hash-mismatch",
      "wrong-chain",
      "no-wallet",
      "rpc-failed",
      "implementation-unreadable",
      "implementation-pin-missing",
      "implementation-mismatch",
      "implementation-unexpected",
    ];
    const sentences = causes.map(describeVerificationCause);
    expect(new Set(sentences).size).toBe(causes.length);
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(20);
      expect(s).not.toContain("unknown_revert");
    }
    expect(describeVerificationCause("wrong-chain")).toMatch(/different chain/);
    expect(describeVerificationCause("hash-mismatch")).toMatch(/does not match the pinned/);
  });
});

// QA plan U5, finding DR-9: a vault preview refused because the gateway is unverified used to say only
// "Gateway bytecode hash does not match" whatever the real cause. It now carries the cause's sentence.
describe("a vault or router preview refused on the gateway names the cause", () => {
  const vault = "0x2222222222222222222222222222222222222222" as const;
  const user = "0x3333333333333333333333333333333333333333" as const;
  const ctx = {
    gateway: GATEWAY as `0x${string}`,
    gatewayCodeHashVerified: false,
    envClass: "mainnet" as const,
    gatewayRefusalDetail: describeVerificationCause("wrong-chain"),
  };

  it("vault deposit", () => {
    const p = buildVaultPreview(
      { kind: "vaultDeposit", assets: 1n, receiver: user },
      { ...ctx, vault },
    );
    expect(p.ok).toBe(false);
    expect(!p.ok && p.detail).toBe(describeVerificationCause("wrong-chain"));
  });

  // An exit never depends on the gateway (core 1494): the redeem is built, UNVERIFIED, and the
  // gateway's cause rides along as a warning instead of a refusal.
  it("vault redeem is built, not refused, and carries the cause as a warning", () => {
    const p = buildVaultPreview(
      { kind: "vaultRedeem", shares: 1n, receiver: user, owner: user },
      { ...ctx, vault },
    );
    expect(p.ok).toBe(true);
    expect(p.ok && p.targetCodeHashKnown).toBe(false);
    expect(p.ok && p.warning).toContain(describeVerificationCause("wrong-chain"));
  });

  it("router deposit", () => {
    const p = buildRouterPreview(1n, [], { ...ctx, router: vault });
    expect(!p.ok && p.detail).toBe(describeVerificationCause("wrong-chain"));
  });

  it("no detail is invented when the caller gives none", () => {
    const { gatewayRefusalDetail: _unused, ...bare } = ctx;
    void _unused;
    const p = buildVaultPreview(
      { kind: "vaultDeposit", assets: 1n, receiver: user },
      { ...bare, vault },
    );
    expect(!p.ok && p.detail).toBeUndefined();
  });
});

// Issue 1810: behind a proxy the gateway's own code never changes across an upgrade, so
// computeGatewayVerification also checks the live implementation against the build's pin
// (VITE_GATEWAY_EXPECTED_IMPLEMENTATION + _HASH). gateway-implementation.test.tsx covers the
// rules; this block pins the U5 cause each implementation refusal carries for the banner.
describe("computeGatewayVerification names an implementation cause", () => {
  const IMPL = "0x00000000000000000000000000000000000001a1";
  const OTHER = "0x00000000000000000000000000000000000001b2";
  const SLOT = `0x${"00".repeat(12)}${IMPL.slice(2)}` as `0x${string}`;
  const ZERO_SLOT = `0x${"00".repeat(32)}` as `0x${string}`;
  const IMPL_CODE = "0x6001600055" as const;
  const IMPL_HASH = keccak256(IMPL_CODE);
  const pin = { address: IMPL, hash: IMPL_HASH };
  const causeOf = (r: ReturnType<typeof computeGatewayVerification>) =>
    r.status === "refused" ? r.cause : `not refused: ${r.status}`;
  const run = (
    p: { address?: string; hash?: string },
    slot: `0x${string}` | null | undefined,
    implCode: `0x${string}` | null | undefined,
  ) => computeGatewayVerification(GATEWAY, CODE_HASH, CODE, p, slot, implCode);

  it("verifies the pinned implementation", () => {
    expect(run(pin, SLOT, IMPL_CODE).status).toBe("verified");
  });

  it("refuses a swapped implementation while the proxy's own code still matches", () => {
    expect(causeOf(run({ address: IMPL, hash: WRONG_HASH }, SLOT, IMPL_CODE))).toBe(
      "implementation-mismatch",
    );
    expect(causeOf(run({ address: OTHER, hash: IMPL_HASH }, SLOT, IMPL_CODE))).toBe(
      "implementation-mismatch",
    );
    expect(causeOf(run(pin, SLOT, null))).toBe("implementation-mismatch");
  });

  it("refuses a proxy with no or half a pin, and a pin for a gateway that is not a proxy", () => {
    expect(causeOf(run({}, SLOT, IMPL_CODE))).toBe("implementation-pin-missing");
    expect(causeOf(run({ address: IMPL }, SLOT, IMPL_CODE))).toBe("implementation-pin-missing");
    expect(causeOf(run(pin, ZERO_SLOT, undefined))).toBe("implementation-unexpected");
  });

  it("refuses an unreadable slot, and never overrides an earlier code-pin refusal", () => {
    expect(causeOf(run(pin, null, undefined))).toBe("implementation-unreadable");
    expect(
      causeOf(computeGatewayVerification(GATEWAY, WRONG_HASH, CODE, pin, SLOT, IMPL_CODE)),
    ).toBe("hash-mismatch");
  });

  it("describes the four implementation causes with their own sentences", () => {
    const s = (
      [
        "implementation-unreadable",
        "implementation-pin-missing",
        "implementation-mismatch",
        "implementation-unexpected",
      ] as const
    ).map(describeVerificationCause);
    expect(new Set(s).size).toBe(4);
    expect(s[2]).toMatch(/not the reviewed one/);
    expect(s[1]).toContain("VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH");
  });
});
