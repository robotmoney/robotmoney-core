// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * Config export panel — renders the TOML and offers a download link.
 *
 * The exported TOML is directly loadable by `rmpc` via `Config::from_str`
 * (flat schema, no translation helper required). See
 * `clients/dapp/src/lib/configExport.ts` and
 * `clients/rust-payment-client/src/config.rs`.
 *
 * For encrypted_keystore signers `allow_software_fallback = true` is emitted
 * automatically. Hardware and KMS backends emit commented-out template fields
 * until rmpc implements those backends.
 */
import { useState } from "react";
import type { Address } from "viem";
import { exportRmpcConfig, type SignerKind } from "../lib/configExport";

interface Props {
  gateway: Address;
  vault: Address;
  usdcAddress: Address;
  /** keccak256(eth_getCode(gateway)) — non-zero for production deployments */
  gatewayRuntimeHash: string;
  chainId: number;
  agent: Address;
}

export function ConfigExportPanel(props: Props) {
  const [signerKind, setSignerKind] = useState<SignerKind>("hardware");
  const [device, setDevice] = useState("ledger");
  const [derivationPath, setDerivationPath] = useState("m/44'/60'/0'/0/0");
  const [provider, setProvider] = useState("aws");
  const [keyId, setKeyId] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [keystorePath, setKeystorePath] = useState("./agent.keystore.json");
  // rmpc RPC URL is operator-chosen and lives in their TOML, not in the
  // dapp bundle. Defaults to localhost so the user replaces it knowingly.
  const [rpcUrl, setRpcUrl] = useState("http://127.0.0.1:8545");

  const signer =
    signerKind === "hardware"
      ? { kind: "hardware" as const, device, derivation_path: derivationPath }
      : signerKind === "kms"
        ? { kind: "kms" as const, provider, key_id: keyId, region }
        : {
            kind: "encrypted_keystore" as const,
            keystore_path: keystorePath,
          };

  const toml = exportRmpcConfig({
    chain_id: props.chainId,
    rpc_url: rpcUrl,
    gateway_address: props.gateway,
    usdc_address: props.usdcAddress,
    vault_address: props.vault,
    gateway_runtime_hash: props.gatewayRuntimeHash,
    signer,
  });

  return (
    <section data-testid="config-export">
      <h2>Export rmpc config</h2>
      <label>
        rmpc RPC URL
        <input data-testid="rpc-url" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} />
      </label>
      <label>
        Signer kind
        <select
          data-testid="signer-kind"
          value={signerKind}
          onChange={(e) => setSignerKind(e.target.value as SignerKind)}
        >
          <option value="hardware">hardware</option>
          <option value="kms">kms</option>
          <option value="encrypted_keystore">encrypted_keystore (UNSAFE)</option>
        </select>
      </label>
      {signerKind === "hardware" && (
        <>
          <input
            data-testid="hw-device"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          />
          <input
            data-testid="hw-path"
            value={derivationPath}
            onChange={(e) => setDerivationPath(e.target.value)}
          />
        </>
      )}
      {signerKind === "kms" && (
        <>
          <input
            data-testid="kms-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <input data-testid="kms-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
          <input
            data-testid="kms-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          />
        </>
      )}
      {signerKind === "encrypted_keystore" && (
        <input
          data-testid="ks-path"
          value={keystorePath}
          onChange={(e) => setKeystorePath(e.target.value)}
        />
      )}
      <pre data-testid="exported-toml">{toml}</pre>
    </section>
  );
}
