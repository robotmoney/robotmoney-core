/**
 * Unit tests for the calldata-preview pipeline. Covers the happy path
 * (authorize, revoke, pause), the hard refusal on unverified bytecode,
 * and the risk classifier matrix from ADR §3.3.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import {
  buildPreview,
  classifyRisk,
  isWithdrawalEnabled,
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

const policy = {
  active: true,
  validUntil: 1893456000n, // 2030-01-01
  maxPerPayment: 100_000_000n,
  maxPerWindow: 500_000_000n,
  shareReceiver: receiver,
  allowedDestinations: [] as `0x${string}`[],
  assetRecipient: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  maxWithdrawPerPayment: 0n,
  maxWithdrawPerWindow: 0n,
  allowedSourceVaults: [] as `0x${string}`[],
};

describe("buildPreview", () => {
  it("renders authorize preview with all required fields", () => {
    const p = buildPreview({ kind: "authorizeAgent", agent, policy }, baseCtx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.functionName).toBe("authorizeAgent");
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
      { kind: "authorizeAgent", agent, policy },
      { ...baseCtx, gatewayCodeHashVerified: false },
    );
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/bytecode hash/i);
  });

  it("flags pause on non-fork env as unsafe", () => {
    expect(classifyRisk({ kind: "pause" }, baseCtx)).toBe("low");
    expect(classifyRisk({ kind: "pause" }, { ...baseCtx, envClass: "mainnet" })).toBe("unsafe");
  });

  it("flags high-cap authorize as high risk", () => {
    const big = { ...policy, maxPerWindow: 10_000_000_000n };
    expect(classifyRisk({ kind: "authorizeAgent", agent, policy: big }, baseCtx)).toBe("high");
  });

  // Issue #83: ADMIN_ROLE / PAUSER_ROLE grant + revoke previews.
  describe("role grant / revoke (issue #83)", () => {
    const account = agent;
    for (const role of ["ADMIN_ROLE", "PAUSER_ROLE"] as const) {
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

  // Issue #429: withdrawal-enabled agent policy surfacing. These tests
  // drive both the dapp test_plan bullet ("withdrawal-enabled policy
  // preview includes assetRecipient, caps, expiry, and risk copy") and
  // the regression bullet ("deposit-only policies do not show
  // withdrawal exposure as enabled").
  describe("withdrawal-enabled policy surfacing (issue #429)", () => {
    const assetRecipient = "0x4444444444444444444444444444444444444444" as `0x${string}`;
    const withdrawPolicy = {
      ...policy,
      assetRecipient,
      maxWithdrawPerPayment: 1_000n,
      maxWithdrawPerWindow: 10_000n,
    };

    it("isWithdrawalEnabled mirrors the on-chain WithdrawalNotEnabled guard", () => {
      expect(isWithdrawalEnabled(policy)).toBe(false);
      expect(isWithdrawalEnabled(withdrawPolicy)).toBe(true);
      // Defense-in-depth: maxWithdrawPerWindow alone does NOT enable
      // withdrawals — the gateway checks maxWithdrawPerPayment.
      expect(isWithdrawalEnabled({ ...policy, maxWithdrawPerWindow: 10_000n })).toBe(false);
    });

    it("authorize preview surfaces assetRecipient, caps, expiry, and explicit WARNING copy", () => {
      const p = buildPreview({ kind: "authorizeAgent", agent, policy: withdrawPolicy }, baseCtx);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      // assetRecipient is decoded into a labelled arg, not an
      // anonymous trailing field — the user must see *who* will
      // receive USDC on agent withdrawal.
      const ar = p.args.find((a) => a.name === "policy.assetRecipient");
      expect(ar?.raw).toBe(assetRecipient);
      expect(ar?.gloss).toMatch(/WARNING/i);
      // Per-payment and per-window caps appear as decoded args with
      // their actual numeric values rendered in the gloss.
      const perPay = p.args.find((a) => a.name === "policy.maxWithdrawPerPayment");
      expect(perPay?.raw).toBe("1000");
      const perWin = p.args.find((a) => a.name === "policy.maxWithdrawPerWindow");
      expect(perWin?.raw).toBe("10000");
      expect(perWin?.gloss).toMatch(/per window/i);
      // Effect carries the canonical WARNING + expiry + revoke
      // guidance copy.
      expect(p.effect).toMatch(/WARNING/);
      expect(p.effect).toMatch(/withdrawals enabled/i);
      expect(p.effect).toMatch(/revoke gateway share allowance/i);
      expect(p.effect).toContain(new Date(Number(withdrawPolicy.validUntil) * 1000).toISOString());
      // Issue #429: withdrawal-enabled policies are HIGH risk, even
      // when the deposit caps are below threshold.
      expect(p.risk).toBe("high");
    });

    it("deposit-only policy does not advertise withdrawal exposure as enabled", () => {
      const p = buildPreview({ kind: "authorizeAgent", agent, policy }, baseCtx);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      // The withdrawal-policy args are always present (shape is
      // stable) but the gloss must say DISABLED for each.
      const ar = p.args.find((a) => a.name === "policy.assetRecipient");
      expect(ar?.gloss).toMatch(/DISABLED/i);
      expect(ar?.gloss).not.toMatch(/WARNING/i);
      const perPay = p.args.find((a) => a.name === "policy.maxWithdrawPerPayment");
      expect(perPay?.gloss).toMatch(/DISABLED/i);
      // The effect copy must not mention withdrawals being enabled,
      // and must NOT carry the WARNING string.
      expect(p.effect).toMatch(/Withdrawals DISABLED/);
      expect(p.effect).not.toMatch(/WARNING/);
      // Deposit-only at the default cap stays "medium".
      expect(p.risk).toBe("medium");
    });

    it("classifyRisk upgrades withdrawal-enabled policies to high", () => {
      expect(classifyRisk({ kind: "authorizeAgent", agent, policy: withdrawPolicy }, baseCtx)).toBe(
        "high",
      );
    });
  });
});
