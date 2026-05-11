/**
 * `rmpc` config export — flat TOML that `Config::from_str` loads directly.
 *
 * The schema is locked by `clients/rust-payment-client/src/config.rs`.
 * `Config` uses `deny_unknown_fields`, so the exported TOML must contain
 * only the fields rmpc knows about. The round-trip Rust test
 * (`tests/dapp_toml_roundtrip.rs`) enforces this contract — if either side
 * renames or adds a required field without updating the other, the test
 * fails loudly.
 *
 * Required top-level fields:
 *   chain_id, rpc_url, gateway_address, usdc_address, vault_address,
 *   gateway_runtime_hash
 *
 * Required [signer] sub-table fields (encrypted_keystore path):
 *   allow_software_fallback = true
 *   keystore_path
 */

export type SignerKind = "encrypted_keystore" | "hardware" | "kms";

interface SignerSpec {
  kind: SignerKind;
  /** kind=encrypted_keystore: path to the encrypted keystore file */
  keystore_path?: string;
  /** kind=hardware */
  device?: string;
  derivation_path?: string;
  /** kind=kms */
  provider?: string;
  key_id?: string;
  region?: string;
}

interface RmpcExportInputs {
  chain_id: number;
  rpc_url: string;
  gateway_address: string;
  usdc_address: string;
  vault_address: string;
  /** keccak256(eth_getCode(gateway_address)) — must be non-zero */
  gateway_runtime_hash: string;
  signer: SignerSpec;
}

/**
 * Produce the rmpc TOML string. Pure — no I/O, no clipboard, no file write.
 *
 * For `encrypted_keystore` signers the output is directly loadable by
 * `Config::from_str`. For `hardware` and `kms` signers rmpc does not yet
 * implement those backends; the exported file serves as an operator
 * reference template (out of scope per issue #208).
 */
export function exportRmpcConfig(inputs: RmpcExportInputs): string {
  const lines: string[] = [
    `chain_id             = ${inputs.chain_id}`,
    `rpc_url              = ${tomlStr(inputs.rpc_url)}`,
    `gateway_address      = ${tomlStr(inputs.gateway_address)}`,
    `usdc_address         = ${tomlStr(inputs.usdc_address)}`,
    `vault_address        = ${tomlStr(inputs.vault_address)}`,
    `gateway_runtime_hash = ${tomlStr(inputs.gateway_runtime_hash)}`,
    ``,
    `[signer]`,
    ...buildSignerLines(inputs.signer),
  ];

  return lines.join("\n") + "\n";
}

function buildSignerLines(signer: SignerSpec): string[] {
  if (signer.kind === "encrypted_keystore") {
    const lines = [`allow_software_fallback = true`];
    if (signer.keystore_path !== undefined) {
      lines.push(`keystore_path = ${tomlStr(signer.keystore_path)}`);
    }
    return lines;
  }

  // hardware / kms — rmpc signer backends are future work (issue #208 out of
  // scope). Emit a template the operator can fill in once rmpc supports these.
  if (signer.kind === "hardware") {
    const lines: string[] = [];
    if (signer.device !== undefined) lines.push(`# device = ${tomlStr(signer.device)}`);
    if (signer.derivation_path !== undefined)
      lines.push(`# derivation_path = ${tomlStr(signer.derivation_path)}`);
    lines.push(
      `# TODO: hardware signer backend not yet supported by rmpc; fill in signer fields manually.`,
    );
    return lines;
  }

  // kms
  const lines: string[] = [];
  if (signer.provider !== undefined) lines.push(`# provider = ${tomlStr(signer.provider)}`);
  if (signer.key_id !== undefined) lines.push(`# key_id = ${tomlStr(signer.key_id)}`);
  if (signer.region !== undefined) lines.push(`# region = ${tomlStr(signer.region)}`);
  lines.push(
    `# TODO: KMS signer backend not yet supported by rmpc; fill in signer fields manually.`,
  );
  return lines;
}

/** Minimal TOML string literal — JSON.stringify produces valid TOML strings. */
function tomlStr(s: string): string {
  return JSON.stringify(s);
}
