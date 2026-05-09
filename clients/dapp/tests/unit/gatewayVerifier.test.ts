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
import { computeVerificationState, ZERO_ADDRESS } from "../../src/lib/gatewayVerifier";

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

  it("returns refused when hash mismatches, naming both values", () => {
    const result = computeVerificationState(GATEWAY, WRONG_HASH, CODE);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain(WRONG_HASH);
      expect(result.reason).toContain(CODE_HASH);
    }
  });

  it("returns refused when expected hash is missing", () => {
    const result = computeVerificationState(GATEWAY, undefined, CODE);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toMatch(/VITE_GATEWAY_EXPECTED_CODE_HASH/);
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
      expect(result.reason).toMatch(/zero/i);
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
      expect(result.reason).toMatch(/empty/i);
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

  it("returns verified immediately when bypassForTest is true, ignoring hash and address", () => {
    // Zero address + no hash would normally refuse; bypass overrides all checks.
    const result = computeVerificationState(ZERO_ADDRESS, undefined, undefined, true);
    expect(result.status).toBe("verified");
  });
});
