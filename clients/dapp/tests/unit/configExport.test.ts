/**
 * Unit tests for the rmpc TOML export. Asserts the §3.4 schema:
 * pinned schema_version="1", `unsafe_for_production` mirrors the signer
 * kind, and the policy block emits string-typed uint256 caps.
 */
import { describe, it, expect } from "vitest";
import { parse } from "smol-toml";
import { exportRmpcConfig } from "../../src/lib/configExport";

const baseConfig = {
  chain: { chain_id: 31337, name: "fork", rpc_url: "http://127.0.0.1:8545" },
  contracts: {
    gateway: "0x1111111111111111111111111111111111111111",
    vault: "0x2222222222222222222222222222222222222222",
    gateway_code_hash: "0x" + "ab".repeat(32),
  },
  agent: { address: "0x3333333333333333333333333333333333333333" },
  policy: {
    active: true,
    validUntil: 1893456000n,
    maxPerPayment: 100_000_000n,
    maxPerWindow: 1_000_000_000n,
    shareReceiver: "0x4444444444444444444444444444444444444444" as const,
  },
} as const;

describe("exportRmpcConfig", () => {
  it("hardware signer => unsafe_for_production=false", () => {
    const toml = exportRmpcConfig({
      config: {
        ...baseConfig,
        signer: { kind: "hardware", device: "ledger", derivation_path: "m/44'/60'/0'/0/0" },
      },
    });
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.schema_version).toBe("1");
    expect(parsed.unsafe_for_production).toBe(false);
    const signer = parsed.signer as Record<string, unknown>;
    expect(signer.kind).toBe("hardware");
    const policy = parsed.policy as Record<string, unknown>;
    expect(policy.per_deposit_cap).toBe("100000000");
    expect(policy.per_window_cap).toBe("1000000000");
  });

  it("encrypted_keystore signer => unsafe_for_production=true", () => {
    const toml = exportRmpcConfig({
      config: {
        ...baseConfig,
        signer: {
          kind: "encrypted_keystore",
          keystore_path: "./agent.keystore.json",
          keystore_format: "geth-v3",
        },
      },
    });
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.unsafe_for_production).toBe(true);
  });

  it("kms signer roundtrips required fields", () => {
    const toml = exportRmpcConfig({
      config: {
        ...baseConfig,
        signer: { kind: "kms", provider: "aws", key_id: "abcd", region: "us-east-1" },
      },
    });
    const parsed = parse(toml) as Record<string, unknown>;
    const signer = parsed.signer as Record<string, unknown>;
    expect(signer.provider).toBe("aws");
    expect(signer.key_id).toBe("abcd");
    expect(signer.region).toBe("us-east-1");
  });
});
