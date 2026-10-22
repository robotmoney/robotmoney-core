/**
 * Issue 1889: the owner's explicit, non-empty vault selection reaches the reveal calldata, the
 * policy edit and the rmpc export unchanged. The retired withdraw members stay zero.
 */
import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress } from "viem";
import { parse } from "smol-toml";
import {
  depositOnlyPolicy,
  destinationsExportLines,
  editPolicy,
  normalizeDestinations,
  tryDepositOnlyPolicy,
} from "../../src/lib/agentDestinations";
import {
  computeConsentHash,
  policyTuple,
  revealAuthorizationCall,
} from "../../src/lib/commitReveal";
import { gatewayAbi } from "../../src/lib/abi";
import { gatewayAbiGenerated } from "../../src/lib/abi.generated";
import { exportRmpcConfig } from "../../src/lib/configExport";
import { buildPreview, policyViolations } from "../../src/lib/preview";

const VAULT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROUTER = "0xcccccccccccccccccccccccccccccccccccccccc";
const RECEIVER = "0x3333333333333333333333333333333333333333" as const;
const AGENT = "0x2222222222222222222222222222222222222222" as const;
const SALT = ("0x" + "11".repeat(32)) as `0x${string}`;
const base = {
  validUntil: 1893456000n,
  maxPerPayment: 100_000_000n,
  maxPerWindow: 500_000_000n,
  shareReceiver: RECEIVER,
};

describe("depositOnlyPolicy", () => {
  it("keeps exactly the selected vaults and zeroes every retired member", () => {
    const p = depositOnlyPolicy({ ...base, destinations: [VAULT_A, VAULT_B] });
    expect(p.allowedDestinations).toEqual([getAddress(VAULT_A), getAddress(VAULT_B)]);
    expect(p.assetRecipient).toBe(zeroAddress);
    expect(p.maxWithdrawPerPayment).toBe(0n);
    expect(p.maxWithdrawPerWindow).toBe(0n);
    expect(p.allowedSourceVaults).toEqual([]);
    expect(policyViolations(p)).toEqual([]);
  });

  it("refuses an empty selection instead of substituting vaults", () => {
    expect(() => depositOnlyPolicy({ ...base, destinations: [] })).toThrow(/at least one vault/);
    expect(tryDepositOnlyPolicy({ ...base, destinations: [] })).toBeNull();
    expect(tryDepositOnlyPolicy({ ...base, destinations: ["not-an-address"] })).toBeNull();
  });

  it("never lets the router or the zero address be a destination", () => {
    expect(normalizeDestinations([ROUTER, zeroAddress, VAULT_A], [ROUTER])).toEqual([
      getAddress(VAULT_A),
    ]);
    expect(tryDepositOnlyPolicy({ ...base, destinations: [ROUTER] }, ROUTER)).toBeNull();
  });

  it("drops duplicates and keeps the owner's order", () => {
    expect(
      normalizeDestinations([VAULT_B, VAULT_A, VAULT_B.toUpperCase().replace("0X", "0x")]),
    ).toEqual([getAddress(VAULT_B), getAddress(VAULT_A)]);
  });
});

describe("policy edit (setPolicy)", () => {
  it("preserves the destinations exactly and re-zeroes the retired members", () => {
    const old = {
      ...depositOnlyPolicy({ ...base, destinations: [VAULT_B, VAULT_A] }),
      // a legacy policy read back from chain may carry retired values
      maxWithdrawPerPayment: 5n,
      assetRecipient: AGENT,
    };
    const edited = editPolicy(old, { maxPerWindow: 900_000_000n });
    expect(edited.allowedDestinations).toEqual(old.allowedDestinations);
    expect(edited.maxPerWindow).toBe(900_000_000n);
    expect(edited.maxWithdrawPerPayment).toBe(0n);
    expect(edited.assetRecipient).toBe(zeroAddress);
    expect(policyViolations(edited)).toEqual([]);
  });

  it("encodes a reveal preview whose tuple carries the destinations", () => {
    const edited = editPolicy(depositOnlyPolicy({ ...base, destinations: [VAULT_A] }), {});
    const p = buildPreview(
      {
        kind: "revealAuthorization",
        agent: AGENT,
        salt: "0x1111111111111111111111111111111111111111111111111111111111111111",
        policy: edited,
      },
      { gateway: RECEIVER, gatewayCodeHashVerified: true, envClass: "fork" },
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.args.find((a) => a.name === "policy.allowedDestinations")?.raw).toBe(
      getAddress(VAULT_A),
    );
  });
});

describe("reveal encoding", () => {
  const policy = depositOnlyPolicy({ ...base, destinations: [VAULT_A, VAULT_B] });

  it("the reveal calldata carries the selected destinations and zero retired members", () => {
    const call = revealAuthorizationCall({ agent: AGENT, salt: SALT, policy });
    const data = encodeFunctionData({ abi: gatewayAbi, ...call });
    const decoded = decodeFunctionData({ abi: gatewayAbi, data });
    expect(decoded.functionName).toBe("revealAuthorization");
    const tuple = (decoded.args as unknown as unknown[])[2] as typeof policy;
    expect(tuple.allowedDestinations).toEqual([getAddress(VAULT_A), getAddress(VAULT_B)]);
    expect(tuple.assetRecipient).toBe(zeroAddress);
    expect(tuple.maxWithdrawPerPayment).toBe(0n);
    expect(tuple.maxWithdrawPerWindow).toBe(0n);
    expect(tuple.allowedSourceVaults).toEqual([]);
  });

  it("the consent hash changes when the destination list changes", () => {
    const other = depositOnlyPolicy({ ...base, destinations: [VAULT_A] });
    expect(computeConsentHash(RECEIVER, AGENT, SALT, policyTuple(policy))).not.toBe(
      computeConsentHash(RECEIVER, AGENT, SALT, policyTuple(other)),
    );
  });

  it("the generated gateway ABI no longer has the removed agent entrypoints", () => {
    const names = new Set(
      gatewayAbiGenerated
        .filter((e) => e.type === "function")
        .map((e) => (e as { name: string }).name),
    );
    for (const gone of ["deposit", "withdraw", "withdrawFromRouter", "vault", "router"]) {
      expect(names.has(gone)).toBe(false);
    }
    expect(names.has("depositTo")).toBe(true);
  });
});

describe("config export", () => {
  const inputs = {
    chain_id: 31337,
    rpc_url: "http://127.0.0.1:8545",
    gateway_address: "0x1111111111111111111111111111111111111111",
    usdc_address: "0x2222222222222222222222222222222222222222",
    vault_address: VAULT_A,
    gateway_runtime_hash: "0x" + "ab".repeat(32),
    signer: { kind: "encrypted_keystore" as const, keystore_path: "./k.json" },
  };

  it("lists the selected destinations as a live key and still loads as flat rmpc TOML", () => {
    const toml = exportRmpcConfig({ ...inputs, allowed_destinations: [VAULT_A, VAULT_B] });
    expect(toml).toContain(
      `allowed_destinations = ["${getAddress(VAULT_A)}", "${getAddress(VAULT_B)}"]`,
    );
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.allowed_destinations).toEqual([getAddress(VAULT_A), getAddress(VAULT_B)]);
    expect(parsed.vault_address).toBe(VAULT_A);
  });

  it("names no withdraw or router command", () => {
    const toml = exportRmpcConfig({ ...inputs, allowed_destinations: [VAULT_A] });
    expect(toml).not.toMatch(/withdraw-router|rmpc withdraw|withdraw and/i);
  });

  it("writes nothing when no destination is selected", () => {
    expect(destinationsExportLines([])).toEqual([]);
    expect(exportRmpcConfig(inputs)).not.toContain("allowed_destinations");
  });
});
