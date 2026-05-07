/**
 * Config export panel — renders the TOML and offers a download link.
 * Per ADR §3.4 the dapp never auto-generates a passphrase and never
 * persists keys; this MVP component covers the public-info-only export
 * (signer.kind = hardware/kms). Software-backed-keystore exports are
 * deferred to the follow-up that lifts the feature flag.
 */
import { useState } from "react";
import type { Address } from "viem";
import { exportRmpcConfig, type SignerKind } from "../lib/configExport";
import type { AgentPolicy } from "../lib/preview";

interface Props {
  gateway: Address;
  vault: Address;
  gatewayCodeHash: string;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  agent: Address;
  policy: AgentPolicy;
}

export function ConfigExportPanel(props: Props) {
  const [signerKind, setSignerKind] = useState<SignerKind>("hardware");
  const [device, setDevice] = useState("ledger");
  const [derivationPath, setDerivationPath] = useState("m/44'/60'/0'/0/0");
  const [provider, setProvider] = useState("aws");
  const [keyId, setKeyId] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [keystorePath, setKeystorePath] = useState("./agent.keystore.json");

  const toml = exportRmpcConfig({
    config: {
      chain: { chain_id: props.chainId, name: props.chainName, rpc_url: props.rpcUrl },
      contracts: {
        gateway: props.gateway,
        vault: props.vault,
        gateway_code_hash: props.gatewayCodeHash,
      },
      agent: { address: props.agent },
      signer:
        signerKind === "hardware"
          ? { kind: "hardware", device, derivation_path: derivationPath }
          : signerKind === "kms"
            ? { kind: "kms", provider, key_id: keyId, region }
            : {
                kind: "encrypted_keystore",
                keystore_path: keystorePath,
                keystore_format: "geth-v3",
              },
      policy: props.policy,
    },
  });

  return (
    <section data-testid="config-export">
      <h2>Export rmpc config</h2>
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
