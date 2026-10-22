/**
 * Unit tests for the calldata-preview pipeline. Covers the happy path
 * (register, revoke, pauseDeposits), the hard refusal on unverified bytecode,
 * and the risk classifier matrix from ADR §3.3.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import {
  buildPreview,
  classifyRisk,
  policyViolations,
  type PreviewContext,
} from "../../src/lib/preview";
import { gatewayAbi, ROLE_HASH } from "../../src/lib/abi";

const gateway = "0x1111111111111111111111111111111111111111" as const;
const agent = "0x2222222222222222222222222222222222222222" as const;
const receiver = "0x3333333333333333333333333333333333333333" as const;

const baseCtx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const salt = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

const policy = {
  active: true,
  validUntil: 1893456000n, // 2030-01-01
  maxPerPayment: 100_000_000n,
  maxPerWindow: 500_000_000n,
  shareReceiver: receiver,
  allowedDestinations: ["0x4444444444444444444444444444444444444444"] as `0x${string}`[],
  assetRecipient: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  maxWithdrawPerPayment: 0n,
  maxWithdrawPerWindow: 0n,
  allowedSourceVaults: [] as `0x${string}`[],
};

describe("buildPreview", () => {
  it("renders registration reveal preview with all required fields", () => {
    const p = buildPreview({ kind: "revealAuthorization", agent, salt, policy }, baseCtx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.functionName).toBe("revealAuthorization");
    expect(p.target).toBe(gateway);
    expect(p.targetCodeHashKnown).toBe(true);
    expect(p.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(p.calldata).toMatch(/^0x[0-9a-f]+$/);
    expect(p.args.find((a) => a.name === "agent")?.raw).toBe(agent);
    expect(p.effect).toMatch(/AGENT_ROLE/);
    expect(p.risk).toBe("medium");
  });

  it("renders revoke preview", () => {
    const p = buildPreview({ kind: "revokeAgent", agent }, baseCtx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.functionName).toBe("revokeAgent");
    expect(p.risk).toBe("low");
    expect(p.effect).toMatch(/loses AGENT_ROLE/);
  });

  it("hard-refuses when bytecode hash is unverified", () => {
    const p = buildPreview(
      { kind: "revealAuthorization", agent, salt, policy },
      { ...baseCtx, gatewayCodeHashVerified: false },
    );
    expect(p.ok).toBe(false);
    if (p.ok) return;
    // reason is now a typed ProductReasonCode — unverified bytecode maps to "unknown_revert"
    expect(p.reason).toBe("unknown_revert");
  });

  it("flags pauseDeposits on non-fork env as unsafe", () => {
    expect(classifyRisk({ kind: "pauseDeposits" }, baseCtx)).toBe("low");
    expect(classifyRisk({ kind: "pauseDeposits" }, { ...baseCtx, envClass: "mainnet" })).toBe(
      "unsafe",
    );
  });

  it("pauseDeposits preview says it stops deposits only and withdrawals stay open", () => {
    const p = buildPreview({ kind: "pauseDeposits" }, baseCtx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.functionName).toBe("pauseDeposits");
    expect(p.effect).toContain("DepositsArePaused");
    expect(p.effect).toContain("Withdrawals stay open");
    expect(p.effect).not.toMatch(/withdraw\(\) reverts/i);
  });

  it("DEPOSIT_PAUSER_ROLE hash is keccak256 of the new role string", () => {
    expect(ROLE_HASH.DEPOSIT_PAUSER_ROLE).toBe(keccak256(toBytes("DEPOSIT_PAUSER_ROLE")));
    expect(ROLE_HASH.ADMIN_ROLE).toBe(keccak256(toBytes("ADMIN_ROLE")));
  });

  it("flags high-cap authorize as high risk", () => {
    const big = { ...policy, maxPerWindow: 10_000_000_000n };
    expect(classifyRisk({ kind: "revealAuthorization", agent, salt, policy: big }, baseCtx)).toBe(
      "high",
    );
  });

  // Issue #83: ADMIN_ROLE / DEPOSIT_PAUSER_ROLE grant + revoke previews.
  describe("role grant / revoke (issue #83)", () => {
    const account = agent;
    for (const role of ["ADMIN_ROLE", "DEPOSIT_PAUSER_ROLE"] as const) {
      it(`grant ${role} encodes the AccessControl.grantRole(role, account) calldata`, () => {
        const p = buildPreview({ kind: "grantRole", role, account }, baseCtx);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        const expected = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "grantRole",
          args: [ROLE_HASH[role], account],
        });
        expect(p.calldata).toBe(expected);
        expect(p.functionName).toBe("grantRole");
        expect(p.risk).toBe("high");
        expect(p.effect).toContain(role);
      });

      it(`revoke ${role} encodes the AccessControl.revokeRole(role, account) calldata`, () => {
        const p = buildPreview({ kind: "revokeRole", role, account }, baseCtx);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        const expected = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "revokeRole",
          args: [ROLE_HASH[role], account],
        });
        expect(p.calldata).toBe(expected);
        expect(p.functionName).toBe("revokeRole");
        expect(p.risk).toBe("low");
        expect(p.effect).toContain(role);
      });
    }
  });

  // Issue 1889: deposit-only policy. The gateway reverts an empty destination list and any
  // non-zero retired withdraw member, so the preview must name the destinations and flag both.
  describe("deposit-only policy surfacing (issue 1889)", () => {
    const retiredRecipient = "0x5555555555555555555555555555555555555555" as `0x${string}`;
    const withdrawPolicy = {
      ...policy,
      assetRecipient: retiredRecipient,
      maxWithdrawPerPayment: 1_000n,
      maxWithdrawPerWindow: 10_000n,
    };

    it("policyViolations is empty for a selected-destination deposit-only policy", () => {
      expect(policyViolations(policy)).toEqual([]);
    });

    it("policyViolations flags an empty list, a zero entry and each retired member", () => {
      expect(policyViolations({ ...policy, allowedDestinations: [] })).toHaveLength(1);
      expect(
        policyViolations({
          ...policy,
          allowedDestinations: ["0x0000000000000000000000000000000000000000"],
        }),
      ).toHaveLength(1);
      expect(policyViolations({ ...policy, assetRecipient: retiredRecipient })).toHaveLength(1);
      expect(policyViolations({ ...policy, maxWithdrawPerPayment: 1n })).toHaveLength(1);
      expect(policyViolations({ ...policy, maxWithdrawPerWindow: 1n })).toHaveLength(1);
      expect(policyViolations({ ...policy, allowedSourceVaults: [agent] })).toHaveLength(1);
    });

    it("the preview lists the allowed destinations and has no withdraw rows", () => {
      const p = buildPreview({ kind: "revealAuthorization", agent, salt, policy }, baseCtx);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const d = p.args.find((a) => a.name === "policy.allowedDestinations");
      expect(d?.raw).toBe(policy.allowedDestinations.join(","));
      expect(d?.gloss).toMatch(/deposit only into/i);
      expect(p.args.some((a) => /Withdraw|assetRecipient/.test(a.name))).toBe(false);
      expect(p.effect).toMatch(/depositTo/);
      expect(p.effect).toMatch(/no withdrawal path/i);
      expect(p.effect).not.toMatch(/WARNING/);
      expect(p.risk).toBe("medium");
    });

    it("a policy the gateway would revert carries a WARNING and high risk", () => {
      for (const bad of [{ ...policy, allowedDestinations: [] }, withdrawPolicy]) {
        const p = buildPreview({ kind: "revealAuthorization", agent, salt, policy: bad }, baseCtx);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.effect).toMatch(/WARNING: the gateway reverts this policy/);
        expect(p.risk).toBe("high");
        expect(
          classifyRisk({ kind: "revealAuthorization", agent, salt, policy: bad }, baseCtx),
        ).toBe("high");
      }
    });
  });
});
