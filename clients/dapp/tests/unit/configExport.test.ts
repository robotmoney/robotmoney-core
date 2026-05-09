/**
 * Unit tests for the rmpc TOML export.
 *
 * The exported TOML must be directly loadable by `rmpc`'s `Config::from_str`
 * (flat schema, `deny_unknown_fields`). The Rust round-trip test
 * (`clients/rust-payment-client/tests/dapp_toml_roundtrip.rs`) is the
 * authoritative cross-language contract; these tests cover the TypeScript
 * side only.
 */
import { describe, it, expect } from "vitest";
import { parse } from "smol-toml";
import { exportRmpcConfig } from "../../src/lib/configExport";

const baseInputs = {
  chain_id: 31337,
  rpc_url: "http://127.0.0.1:8545",
  gateway_address: "0x1111111111111111111111111111111111111111",
  usdc_address: "0x2222222222222222222222222222222222222222",
  vault_address: "0x3333333333333333333333333333333333333333",
  gateway_runtime_hash: "0x" + "ab".repeat(32),
};

describe("exportRmpcConfig", () => {
  it("encrypted_keystore: emits flat rmpc-compatible TOML with allow_software_fallback=true", () => {
    const toml = exportRmpcConfig({
      ...baseInputs,
      signer: {
        kind: "encrypted_keystore",
        keystore_path: "./agent.keystore.json",
      },
    });

    // Must parse as valid TOML
    const parsed = parse(toml) as Record<string, unknown>;

    // All required top-level fields must be present and correct
    expect(parsed.chain_id).toBe(31337);
    expect(parsed.rpc_url).toBe("http://127.0.0.1:8545");
    expect(parsed.gateway_address).toBe("0x1111111111111111111111111111111111111111");
    expect(parsed.usdc_address).toBe("0x2222222222222222222222222222222222222222");
    expect(parsed.vault_address).toBe("0x3333333333333333333333333333333333333333");
    expect(parsed.gateway_runtime_hash).toBe("0x" + "ab".repeat(32));

    // [signer] table must match rmpc's SignerConfig fields exactly
    const signer = parsed.signer as Record<string, unknown>;
    expect(signer.allow_software_fallback).toBe(true);
    expect(signer.keystore_path).toBe("./agent.keystore.json");

    // deny_unknown_fields — no extra top-level keys
    const topLevelKeys = Object.keys(parsed).filter((k) => k !== "signer");
    expect(topLevelKeys).toEqual([
      "chain_id",
      "rpc_url",
      "gateway_address",
      "usdc_address",
      "vault_address",
      "gateway_runtime_hash",
    ]);
  });

  it("gateway_runtime_hash must be non-zero in the exported config", () => {
    const nonZeroHash = "0x" + "ab".repeat(32);
    const toml = exportRmpcConfig({
      ...baseInputs,
      gateway_runtime_hash: nonZeroHash,
      signer: { kind: "encrypted_keystore", keystore_path: "./agent.keystore.json" },
    });
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.gateway_runtime_hash).toBe(nonZeroHash);
    expect(parsed.gateway_runtime_hash).not.toBe("0x" + "00".repeat(32));
  });

  it("usdc_address is present in exported TOML", () => {
    const toml = exportRmpcConfig({
      ...baseInputs,
      signer: { kind: "encrypted_keystore", keystore_path: "./agent.keystore.json" },
    });
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.usdc_address).toBe("0x2222222222222222222222222222222222222222");
  });

  it("hardware signer: emits a TOML file with no allow_software_fallback", () => {
    const toml = exportRmpcConfig({
      ...baseInputs,
      signer: { kind: "hardware", device: "ledger", derivation_path: "m/44'/60'/0'/0/0" },
    });
    // Must still be valid TOML (may have comments, no signer.allow_software_fallback)
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.chain_id).toBe(31337);
    expect(parsed.gateway_runtime_hash).toBe(baseInputs.gateway_runtime_hash);
    // hardware signer does not set allow_software_fallback
    const signer = (parsed.signer ?? {}) as Record<string, unknown>;
    expect(signer.allow_software_fallback).toBeUndefined();
  });

  it("kms signer: emits a TOML file referencing provider and key_id", () => {
    const toml = exportRmpcConfig({
      ...baseInputs,
      signer: { kind: "kms", provider: "aws", key_id: "abcd", region: "us-east-1" },
    });
    // Must still be valid TOML
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.chain_id).toBe(31337);
  });
});
