// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

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
 * Optional top-level fields (issue 1810), emitted only for a proxied gateway:
 *   gateway_implementation, gateway_implementation_runtime_hash
 *   rmpc refuses every write on a proxied gateway without them.
 *
 * Required [signer] sub-table fields (encrypted_keystore path):
 *   allow_software_fallback = true
 *   keystore_path
 *
 * Binding pins (QA plan D2/U6): `share_receiver` and `agent_owner`. The
 * dapp knows both at authorize time: the connected wallet reveals, so it is
 * the agent's owner, and a wallet without ADMIN_ROLE must name itself as
 * share receiver. With both set, every `rmpc` deposit and withdraw preflight
 * refuses (`ErrAgentBindingMismatch`) when the gateway shows another owner or
 * receiver for the agent, so a binding someone else made first never
 * receives the agent's shares unnoticed. The panel always passes them once a
 * wallet is connected.
 *
 * Gateway implementation pin (issue 1810): the panel passes the
 * implementation and its code hash only after the dapp verified them against
 * the build's pin (`VITE_GATEWAY_EXPECTED_IMPLEMENTATION` + `_HASH`), so the
 * export never pins whatever is live at export time. A direct gateway gets no
 * such lines.
 *
 * The vaults and the router are proxies too, and rmpc checks every one a write
 * reaches against `proxy_implementation_hashes` (a deposit the vault, a
 * withdraw the router and the vault, a router deposit the router and every
 * leg). The panel passes the reviewed vault and router implementation hashes
 * this build pins (`VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH`,
 * `VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH`, from the release manifests), and
 * the export writes them as values. A build without those pins writes the key
 * commented out with the release-record fields to copy, never a command that
 * hashes whatever implementation is live (that would approve the very code
 * the check exists to refuse).
 *
 * Encrypted-keystore exports sign on every chain. `rmpc deposit` signs with the software keystore on Base mainnet too,
 * after a production warning (owner decision 2026-10-06, issue #1545). A
 * hardware wallet, HSM or KMS is optional, never required (owner decision
 * 2026-10-14). The exported comment block says so: see
 * `SOFTWARE_KEYSTORE_COMMENT`.
 */

import { destinationsExportLines } from "./agentDestinations";

export type SignerKind = "encrypted_keystore" | "hardware" | "kms";

/**
 * Comment lines emitted above `allow_software_fallback = true` in an
 * encrypted-keystore export. They state the signer decisions of 2026-10-06
 * and 2026-10-14 (QA plan U7, finding DR-12); the old lines said a software
 * keystore was "devnet/test use only" and that Base mainnet required an
 * HSM/KMS/device-bound signer, which rmpc has not enforced for depositor
 * writes since 2026-10-06.
 *
 * `clients/rust-payment-client/tests/dapp_toml_roundtrip.rs` reads this array
 * from this file and checks that its fixture carries every line verbatim and
 * still loads through rmpc's `Config::from_str`. Keep one string per line.
 */
export const SOFTWARE_KEYSTORE_COMMENT: readonly string[] = [
  "# Software keystore: rmpc deposit signs with it on every",
  "# chain, Base mainnet included, after a production warning (owner decision 2026-10-06).",
  "# A hardware wallet, HSM or KMS is optional, never required (owner decision 2026-10-14).",
  "# rmpc decrypts the key in memory: keep the keystore 0600 and the passphrase out of argv.",
];

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
  /**
   * The verified ERC-1967 implementation behind a proxied gateway and its
   * code hash (issue 1810). Omit both for a direct gateway.
   */
  gateway_implementation?: string;
  gateway_implementation_runtime_hash?: string;
  /**
   * The vault is an ERC-1967 proxy: rmpc needs `proxy_implementation_hashes`. Without reviewed
   * hashes below, the export writes the key commented out with where to copy them from.
   */
  vault_is_proxy?: boolean;
  /**
   * Reviewed implementation code hashes of the vaults and the router, from this build's pins
   * (never read live). Non-empty: written as `proxy_implementation_hashes`.
   */
  proxy_implementation_hashes?: readonly string[];
  /** The share receiver the depositor authorized: rmpc refuses a binding with another (QA plan D2). */
  share_receiver?: string;
  /** The wallet that revealed the authorization: rmpc refuses a binding owned by another. */
  agent_owner?: string;
  /**
   * The vaults the depositor's policy allows (`allowedDestinations`). Written as a comment:
   * rmpc's `Config` has `deny_unknown_fields` and no such key, so a live key would not load.
   */
  allowed_destinations?: readonly string[];
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
    ...(inputs.gateway_implementation && inputs.gateway_implementation_runtime_hash
      ? [
          `gateway_implementation = ${tomlStr(inputs.gateway_implementation)}`,
          `gateway_implementation_runtime_hash = ${tomlStr(inputs.gateway_implementation_runtime_hash)}`,
        ]
      : []),
    ...(inputs.proxy_implementation_hashes !== undefined &&
    inputs.proxy_implementation_hashes.length > 0
      ? [
          `# The reviewed vault and router implementations this dapp build pins (release manifests).`,
          `# rmpc refuses to sign when a vault or the router runs any other: approve a reviewed`,
          `# upgrade by adding its hash from the release record.`,
          `proxy_implementation_hashes = [${inputs.proxy_implementation_hashes
            .map(tomlStr)
            .join(", ")}]`,
        ]
      : inputs.vault_is_proxy === true
        ? [
            `# The vault and the router are upgradeable proxies. rmpc refuses to deposit or withdraw`,
            `# until the reviewed implementation code hash of each is listed here. Copy them from the`,
            `# release record (timelock.json vault_handover.vault_<i>.implementation_code_hash and`,
            `# code_hashes.router_implementation), never from the live chain.`,
            `# proxy_implementation_hashes = ["0x<reviewed vault implementation code hash>", "0x<reviewed router implementation code hash>"]`,
          ]
        : []),
    ...(inputs.share_receiver !== undefined
      ? [`share_receiver       = ${tomlStr(inputs.share_receiver)}`]
      : []),
    ...(inputs.agent_owner !== undefined
      ? [`agent_owner          = ${tomlStr(inputs.agent_owner)}`]
      : []),
    ...destinationsExportLines(inputs.allowed_destinations ?? []),
    ``,
    `[signer]`,
    ...buildSignerLines(inputs.signer),
  ];

  return lines.join("\n") + "\n";
}

function buildSignerLines(signer: SignerSpec): string[] {
  if (signer.kind === "encrypted_keystore") {
    const lines = [...SOFTWARE_KEYSTORE_COMMENT, `allow_software_fallback = true`];
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
