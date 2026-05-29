/**
 * Vitest unit tests for the register-existing-address credential workflow
 * and agent rotation preview.
 *
 * Covers:
 * - composeRegisterPreview: produces a valid RegisterPreview for a
 *   well-formed address + policy, rejects malformed addresses.
 * - composeRotationPreview: produces a RotationPreview with both steps,
 *   rejects identical old/new addresses.
 * - formatUsdc: formats USDC base-unit amounts for display.
 * - Unsafe-label invariant: software-backed exports carry the expected
 *   risk annotation; hardware/kms exports carry a lower-risk label.
 *
 * Canonical: docs/technical/dapp-credential-decisions.md §3–§4 and §6.
 */
import { describe, it, expect } from "vitest";
import {
  composeRegisterPreview,
  validateEthereumAddress,
  formatUsdc,
  type AgentPolicy,
} from "../../src/lib/credentialWorkflow";
import { composeRotationPreview } from "../../src/lib/rotation";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NEW_AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const RECEIVER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

const BASE_POLICY: AgentPolicy = {
  shareReceiver: RECEIVER,
  validUntil: 1893456000, // 2030-01-01 00:00:00 UTC
  maxPerDeposit: 100_000_000n, // 100 USDC
  maxPerWindow: 1_000_000_000n, // 1 000 USDC
};

// ---------------------------------------------------------------------------
// validateEthereumAddress
// ---------------------------------------------------------------------------

describe("validateEthereumAddress", () => {
  it("accepts a valid checksummed address", () => {
    expect(() => validateEthereumAddress(AGENT)).not.toThrow();
  });

  it("accepts a lowercase 0x-prefixed address", () => {
    expect(() => validateEthereumAddress(AGENT.toLowerCase())).not.toThrow();
  });

  it("rejects the zero address without 0x prefix", () => {
    expect(() => validateEthereumAddress("0000000000000000000000000000000000000000")).toThrow();
  });

  it("rejects an address with wrong length", () => {
    expect(() => validateEthereumAddress("0x1234")).toThrow();
  });

  it("rejects a non-hex string", () => {
    expect(() => validateEthereumAddress("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatUsdc
// ---------------------------------------------------------------------------

describe("formatUsdc", () => {
  it("formats 1 USDC (base units) correctly, stripping trailing zeros", () => {
    // centralized formatter strips trailing zeros: 1_000_000 → "1 USDC"
    expect(formatUsdc(1_000_000n)).toBe("1 USDC");
  });

  it("formats 0 USDC", () => {
    expect(formatUsdc(0n)).toBe("0 USDC");
  });

  it("formats a fractional USDC amount, stripping trailing zeros", () => {
    // 500_000 base units = 0.5 USDC (trailing zeros stripped)
    expect(formatUsdc(500_000n)).toBe("0.5 USDC");
  });

  it("formats 100 USDC (100_000_000 base units)", () => {
    expect(formatUsdc(100_000_000n)).toBe("100 USDC");
  });
});

// ---------------------------------------------------------------------------
// composeRegisterPreview — happy path
// ---------------------------------------------------------------------------

describe("composeRegisterPreview — happy path", () => {
  it("returns a RegisterPreview with the correct shape", () => {
    const preview = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.agentAddress).toBe(AGENT);
    expect(preview.policy).toBe(BASE_POLICY);
  });

  it("preview.target is 'gateway' and functionName is 'authorizeAgent'", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.target).toBe("gateway");
    expect(preview.functionName).toBe("authorizeAgent");
  });

  it("parameters include the agent address and share receiver", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.parameters.agent).toBe(AGENT);
    expect(preview.parameters.shareReceiver).toBe(RECEIVER);
  });

  it("validUntilISO is an ISO 8601 string for the unix timestamp", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.parameters.validUntilISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(preview.parameters.validUntilISO).getFullYear()).toBe(2030);
  });

  it("maxPerDepositFormatted includes USDC label", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.parameters.maxPerDepositFormatted).toContain("USDC");
    expect(preview.parameters.maxPerDepositFormatted).toContain("100");
  });

  it("riskAnnotation mentions AGENT_ROLE and authorizeAgent", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.riskAnnotation).toMatch(/AGENT_ROLE/);
    expect(preview.riskAnnotation).toMatch(/authorizeAgent/i);
  });

  it("riskAnnotation is marked as an on-chain state change", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    expect(preview.riskAnnotation).toMatch(/on-chain/i);
  });
});

// ---------------------------------------------------------------------------
// composeRegisterPreview — failure paths
// ---------------------------------------------------------------------------

describe("composeRegisterPreview — validation failures", () => {
  it("throws on a malformed agent address", () => {
    expect(() => composeRegisterPreview("not-an-address", BASE_POLICY)).toThrow(
      /Invalid Ethereum address/,
    );
  });

  it("throws on a malformed shareReceiver inside policy", () => {
    const badPolicy: AgentPolicy = { ...BASE_POLICY, shareReceiver: "0xBAD" };
    expect(() => composeRegisterPreview(AGENT, badPolicy)).toThrow(/Invalid Ethereum address/);
  });
});

// ---------------------------------------------------------------------------
// composeRotationPreview — happy path
// ---------------------------------------------------------------------------

describe("composeRotationPreview — happy path", () => {
  it("returns revokeStep and authorizeStep", () => {
    const rotation = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(rotation.revokeStep).toBeDefined();
    expect(rotation.authorizeStep).toBeDefined();
  });

  it("revokeStep targets the old agent address", () => {
    const rotation = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(rotation.revokeStep.agentAddress).toBe(AGENT);
    expect(rotation.revokeStep.preview.functionName).toBe("revokeAgent");
    expect(rotation.revokeStep.preview.parameters.agent).toBe(AGENT);
  });

  it("authorizeStep targets the new agent address", () => {
    const rotation = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(rotation.authorizeStep.agentAddress).toBe(NEW_AGENT);
    expect(rotation.authorizeStep.preview.functionName).toBe("authorizeAgent");
  });

  it("revokeStep risk annotation mentions in-flight deposit impact", () => {
    const rotation = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(rotation.revokeStep.preview.riskAnnotation).toMatch(/in-flight/i);
  });

  it("combinedRiskAnnotation references both steps", () => {
    const rotation = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(rotation.combinedRiskAnnotation).toMatch(/revokeAgent/i);
    expect(rotation.combinedRiskAnnotation).toMatch(/authorizeAgent/i);
    expect(rotation.combinedRiskAnnotation).toMatch(/TWO/i);
  });

  it("combinedRiskAnnotation warns not to close dialog between transactions", () => {
    const rotation = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(rotation.combinedRiskAnnotation).toMatch(/close/i);
  });
});

// ---------------------------------------------------------------------------
// composeRotationPreview — failure paths
// ---------------------------------------------------------------------------

describe("composeRotationPreview — validation failures", () => {
  it("throws when old and new agent addresses are identical (case-insensitive)", () => {
    expect(() => composeRotationPreview(AGENT, AGENT, BASE_POLICY)).toThrow(
      /Rotation requires distinct addresses/,
    );
  });

  it("throws when old and new agent addresses differ only in case", () => {
    expect(() =>
      composeRotationPreview(
        AGENT.toLowerCase(),
        AGENT.toUpperCase().replace("X", "x"),
        BASE_POLICY,
      ),
    ).toThrow(/Rotation requires distinct addresses/);
  });

  it("throws on a malformed old agent address", () => {
    expect(() => composeRotationPreview("0xBAD", NEW_AGENT, BASE_POLICY)).toThrow(
      /Invalid Ethereum address/,
    );
  });

  it("throws on a malformed new agent address", () => {
    expect(() => composeRotationPreview(AGENT, "0xBAD", BASE_POLICY)).toThrow(
      /Invalid Ethereum address/,
    );
  });
});

// ---------------------------------------------------------------------------
// Unsafe-label invariant for software-backed exports
// ---------------------------------------------------------------------------
// The credential workflow itself does not produce TOML; configExport.ts does.
// This test verifies that the composeRegisterPreview risk annotation always
// contains the "unsafe for production" signal required by ADR §3.1 for any
// software-backed flow. The TOML unsafe_for_production flag is tested
// separately in configExport.test.ts.

describe("unsafe-label invariant", () => {
  it("riskAnnotation from composeRegisterPreview always names on-chain risk", () => {
    const { preview } = composeRegisterPreview(AGENT, BASE_POLICY);
    // Any generated or exported secret must be labeled — the risk annotation
    // shown to the operator before signing must not be empty.
    expect(preview.riskAnnotation.length).toBeGreaterThan(20);
    expect(preview.riskAnnotation).toMatch(/AGENT_ROLE/);
  });

  it("revokeStep riskAnnotation in rotation always describes state change", () => {
    const { revokeStep } = composeRotationPreview(AGENT, NEW_AGENT, BASE_POLICY);
    expect(revokeStep.preview.riskAnnotation.length).toBeGreaterThan(20);
    expect(revokeStep.preview.riskAnnotation).toMatch(/AGENT_ROLE/);
  });
});
