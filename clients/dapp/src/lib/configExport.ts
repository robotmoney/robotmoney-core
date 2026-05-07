/**
 * `rmpc` config export — TOML bundle as locked by
 * docs/technical/dapp-credential-decisions.md §3.4.
 *
 * The dapp emits a single `rmpc-config.toml`. The schema is fixed:
 *
 *   schema_version       — pinned literal "1"
 *   unsafe_for_production — true iff signer.kind = "encrypted_keystore"
 *   [chain] / [contracts] / [agent] / [signer] / [policy]
 *
 * `rmpc`'s loader is the consumer of record; a Rust integration test
 * (clients/rust-payment-client/tests/rmpc_config_roundtrip.rs) asserts
 * round-trip parsing.
 */
import { stringify } from "smol-toml";
import type { AgentPolicy } from "./preview";

export type SignerKind = "encrypted_keystore" | "hardware" | "kms";

export interface SignerSpec {
  kind: SignerKind;
  /** kind=encrypted_keystore */
  keystore_path?: string;
  keystore_format?: "geth-v3";
  /** kind=hardware */
  device?: string;
  derivation_path?: string;
  /** kind=kms */
  provider?: string;
  key_id?: string;
  region?: string;
}

export interface RmpcConfig {
  chain: { chain_id: number; name: string; rpc_url: string };
  contracts: { gateway: string; vault: string; gateway_code_hash: string };
  agent: { address: string };
  signer: SignerSpec;
  policy: AgentPolicy;
}

export interface ExportInputs {
  config: RmpcConfig;
}

/** Produce the TOML string. Pure — no I/O, no clipboard, no file write. */
export function exportRmpcConfig({ config }: ExportInputs): string {
  const unsafe = config.signer.kind === "encrypted_keystore";
  // smol-toml requires plain objects; bigints are serialized as strings
  // because the §3.4 schema mandates `uint256` policy fields land as
  // string-typed TOML values.
  const doc: Record<string, unknown> = {
    schema_version: "1",
    unsafe_for_production: unsafe,
    chain: { ...config.chain },
    contracts: { ...config.contracts },
    agent: { ...config.agent },
    signer: stripUndefined({ ...config.signer }),
    policy: {
      active: config.policy.active,
      valid_until: new Date(Number(config.policy.validUntil) * 1000).toISOString(),
      per_deposit_cap: config.policy.maxPerPayment.toString(),
      per_window_cap: config.policy.maxPerWindow.toString(),
      window_seconds: 86400,
      share_receiver: config.policy.shareReceiver,
    },
  };
  return stringify(doc);
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
