/**
 * Unit tests — safeProposalChain (core 1544): the pre-sign refusals and the
 * on-chain digest check, against a fake chain reader.
 */
import { describe, expect, it } from "vitest";
import { getAddress, keccak256, type Abi, type Address, type Hex } from "viem";
import {
  EXECUTOR_ROLE,
  PROPOSER_ROLE,
  SAFE_L2_141,
  SafeProposalError,
  ZERO_ADDRESS,
  buildSafeTx,
  encodeSchedule,
} from "../../src/lib/safeProposal";
import {
  assessSafeContext,
  isCanonicalSafe,
  loadSafeContext,
  verifyDigestOnChain,
  type SafeChainReader,
  type SafeContext,
} from "../../src/lib/safeProposalChain";

const SAFE = "0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE" as Address;
const TIMELOCK = "0x7172717271727172717271727172717271727172" as Address;
const OWNER_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OWNER_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const STRANGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

function ctx(over: Partial<SafeContext> = {}): SafeContext {
  return {
    chainId: 918453,
    safe: SAFE,
    timelock: TIMELOCK,
    version: "1.4.1",
    owners: [OWNER_A, OWNER_B],
    threshold: 2,
    nonce: 3n,
    codehash: SAFE_L2_141.proxyCodehash,
    singleton: SAFE_L2_141.singletonL2,
    canonical: true,
    minDelay: 172800n,
    hasProposerRole: true,
    hasExecutorRole: true,
    ...over,
  };
}

describe("isCanonicalSafe", () => {
  const good = {
    version: "1.4.1",
    codehash: SAFE_L2_141.proxyCodehash,
    singleton: SAFE_L2_141.singletonL2,
  };
  it("accepts SafeL2 v1.4.1 behind the canonical proxy", () => {
    expect(isCanonicalSafe(good)).toBe(true);
  });
  it("refuses a wrong version, proxy codehash or singleton", () => {
    expect(isCanonicalSafe({ ...good, version: "1.3.0" })).toBe(false);
    expect(isCanonicalSafe({ ...good, codehash: `0x${"11".repeat(32)}` })).toBe(false);
    expect(
      isCanonicalSafe({ ...good, singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a" }),
    ).toBe(false);
  });
});

describe("assessSafeContext — refusals before any signature request", () => {
  it("passes an owner of a canonical Safe that can propose", () => {
    expect(assessSafeContext(ctx(), { account: OWNER_A, kind: "schedule" })).toEqual({ ok: true });
  });
  it("matches the owner case-insensitively", () => {
    expect(
      assessSafeContext(ctx(), { account: OWNER_A.toLowerCase() as Address, kind: "schedule" }),
    ).toEqual({ ok: true });
  });
  it("refuses a non-canonical Safe first", () => {
    const v = assessSafeContext(ctx({ canonical: false }), { account: STRANGER, kind: "schedule" });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain("not canonical SafeL2");
  });
  it("refuses a non-owner wallet", () => {
    const v = assessSafeContext(ctx(), { account: STRANGER, kind: "schedule" });
    expect(v.ok === false && v.reason).toContain("not an owner of the Safe");
  });
  it("asks for a wallet when none is connected", () => {
    expect(assessSafeContext(ctx(), { account: undefined, kind: "schedule" }).ok).toBe(false);
  });
  it("refuses a Safe without PROPOSER_ROLE for schedule, but not for execute", () => {
    const c = ctx({ hasProposerRole: false });
    const sched = assessSafeContext(c, { account: OWNER_A, kind: "schedule" });
    expect(sched.ok === false && sched.reason).toContain("PROPOSER_ROLE");
    expect(assessSafeContext(c, { account: OWNER_A, kind: "execute" })).toEqual({ ok: true });
  });
  it("refuses execute when neither the Safe nor address(0) holds EXECUTOR_ROLE", () => {
    const v = assessSafeContext(ctx({ hasExecutorRole: false }), {
      account: OWNER_A,
      kind: "execute",
    });
    expect(v.ok === false && v.reason).toContain("EXECUTOR_ROLE");
  });
});

describe("loadSafeContext", () => {
  const proxyCode = "0x6080" as Hex;
  function reader(over: { roles?: Record<string, boolean>; code?: Hex | undefined } = {}) {
    const calls: string[] = [];
    const r: SafeChainReader = {
      chainId: async () => 918453,
      getCode: async (a) => {
        calls.push(`code:${a}`);
        return "code" in over ? over.code : proxyCode;
      },
      getStorageAt: async () => `0x${"00".repeat(12)}${SAFE_L2_141.singletonL2.slice(2)}` as Hex,
      read: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: readonly unknown[];
        address: Address;
        abi: Abi;
      }) => {
        switch (functionName) {
          case "VERSION":
            return "1.4.1";
          case "getOwners":
            return [OWNER_B.toLowerCase(), OWNER_A];
          case "getThreshold":
            return 2n;
          case "nonce":
            return 5n;
          case "getMinDelay":
            return 172800n;
          case "hasRole": {
            const [role, who] = args ?? [];
            const key = `${role === PROPOSER_ROLE ? "proposer" : role === EXECUTOR_ROLE ? "executor" : "?"}:${String(who).toLowerCase() === SAFE.toLowerCase() ? "safe" : String(who).toLowerCase() === ZERO_ADDRESS ? "zero" : "?"}`;
            return over.roles?.[key] ?? false;
          }
          default:
            throw new Error(`unmocked ${functionName}`);
        }
      },
    };
    return { r, calls };
  }

  it("reads owners, threshold, nonce, delay and roles; the unforgeable bytecode check fails on fake code", async () => {
    const { r } = reader({ roles: { "proposer:safe": true, "executor:zero": true } });
    const c = await loadSafeContext(r, { safe: SAFE, timelock: TIMELOCK });
    expect(c.owners).toEqual([getAddress(OWNER_B), OWNER_A]);
    expect(c.threshold).toBe(2);
    expect(c.nonce).toBe(5n);
    expect(c.minDelay).toBe(172800n);
    expect(c.singleton).toBe(SAFE_L2_141.singletonL2);
    expect(c.codehash).toBe(keccak256(proxyCode));
    expect(c.hasProposerRole).toBe(true);
    // An open executor (address(0)) counts.
    expect(c.hasExecutorRole).toBe(true);
    // Fake code does not hash to the canonical proxy codehash.
    expect(c.canonical).toBe(false);
  });

  it("throws when there is no contract at the Safe address", async () => {
    const { r } = reader({ code: undefined });
    await expect(loadSafeContext(r, { safe: SAFE, timelock: TIMELOCK })).rejects.toBeInstanceOf(
      SafeProposalError,
    );
  });
});

describe("verifyDigestOnChain", () => {
  const data = encodeSchedule(
    {
      target: "0x1111111111111111111111111111111111111111",
      data: "0x63d8882a",
      predecessor: `0x${"00".repeat(32)}`,
      salt: `0x${"22".repeat(32)}`,
    },
    172800n,
  );
  const build = buildSafeTx({
    chainId: 918453,
    safe: SAFE,
    timelock: TIMELOCK,
    to: TIMELOCK,
    data,
    nonce: 3n,
  });

  function readerReturning(hash: string): SafeChainReader {
    return {
      chainId: async () => 918453,
      getCode: async () => "0x",
      getStorageAt: async () => "0x",
      read: async () => hash,
    };
  }

  it("passes when Safe.getTransactionHash equals the local digest", async () => {
    await expect(
      verifyDigestOnChain(readerReturning(build.safeTxHash), ctx(), build),
    ).resolves.toBeUndefined();
  });

  it("throws DIGEST_MISMATCH when the Safe computes another hash", async () => {
    await expect(
      verifyDigestOnChain(readerReturning(`0x${"ab".repeat(32)}`), ctx(), build),
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
  });
});
