// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (agent consent, issue #1791)

/**
 * The agent's EIP-712 consent to a depositor binding (issue #1791, QA plan D2).
 *
 * `RobotMoneyGateway.revealAuthorization(agent, salt, policy, agentConsent)`
 * binds an agent other than the revealer only with the agent's signature over
 *
 *   domain  EIP712Domain("RobotMoneyGateway", "1", chainId, gateway)
 *   message AgentConsent(agent, owner, shareReceiver, nonce)
 *
 * where `owner` is the revealing wallet and `nonce` is
 * `agentConsentNonce(agent)`. A wallet that reveals for itself passes empty
 * bytes. Without this the old 3-argument reveal hits an unknown selector.
 *
 * The dapp never holds an agent key. The agent signs with
 * `rmpc agent-consent --owner <wallet>` and the depositor pastes the
 * signature. Before the commit is enabled the dapp recovers the signer from
 * the pasted bytes against the live nonce, so a wrong, stale or malformed
 * consent is refused here instead of reverting `InvalidAgentConsent` on chain.
 *
 * `clients/rust-payment-client/src/signer/consent.rs` builds the same digest;
 * both pin the golden vector in `tests/unit/agent-consent.test.ts`.
 */
import {
  getAddress,
  hashTypedData,
  hexToBigInt,
  recoverTypedDataAddress,
  slice,
  type Address,
  type Hex,
} from "viem";

export const AGENT_CONSENT_DOMAIN_NAME = "RobotMoneyGateway";
export const AGENT_CONSENT_DOMAIN_VERSION = "1";

/** The EIP-712 type. Its type hash is the gateway's `AGENT_CONSENT_TYPEHASH`. */
export const AGENT_CONSENT_TYPES = {
  AgentConsent: [
    { name: "agent", type: "address" },
    { name: "owner", type: "address" },
    { name: "shareReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** What a reveal sends when the revealer is the agent: consent by the call. */
export const NO_AGENT_CONSENT: Hex = "0x";

/** secp256k1 order / 2. The gateway refuses a high-s signature (EIP-2). */
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Every field the consent digest binds. */
export interface AgentConsentFields {
  agent: Address;
  /** The wallet that will call revealAuthorization (msg.sender). */
  owner: Address;
  shareReceiver: Address;
  /** `agentConsentNonce(agent)` on the gateway. */
  nonce: bigint;
  chainId: number;
  gateway: Address;
}

/** The typed data the agent signs, in viem's `signTypedData` shape. */
export function agentConsentTypedData(f: AgentConsentFields) {
  return {
    domain: {
      name: AGENT_CONSENT_DOMAIN_NAME,
      version: AGENT_CONSENT_DOMAIN_VERSION,
      chainId: f.chainId,
      verifyingContract: getAddress(f.gateway),
    },
    types: AGENT_CONSENT_TYPES,
    primaryType: "AgentConsent" as const,
    message: {
      agent: getAddress(f.agent),
      owner: getAddress(f.owner),
      shareReceiver: getAddress(f.shareReceiver),
      nonce: f.nonce,
    },
  };
}

/** The EIP-712 digest `_requireAgentConsent` recovers the agent from. */
export function agentConsentDigest(f: AgentConsentFields): Hex {
  return hashTypedData(agentConsentTypedData(f));
}

/** A revealer binds an agent other than itself only with the agent's consent. */
export function agentConsentRequired(agent: Address, revealer: Address): boolean {
  return agent.toLowerCase() !== revealer.toLowerCase();
}

/** The command an rmpc agent runs to produce the consent for `owner`. */
export function rmpcAgentConsentCommand(owner: Address): string {
  return `rmpc agent-consent --config <CONFIG> --owner ${getAddress(owner)}`;
}

/** The outcome of checking a pasted consent. Only `ok` and `not-required` let a reveal go. */
export type AgentConsentCheck =
  | { status: "not-required" }
  | { status: "missing" }
  | { status: "malformed"; reason: string }
  | { status: "nonce-unknown" }
  | { status: "checking" }
  | { status: "wrong-signer"; recovered: Address }
  | { status: "ok"; signature: Hex };

/**
 * Parse a pasted consent into the 65-byte `r ‖ s ‖ v` the gateway reads, or
 * say why it is not one: wrong length, a `v` other than 27/28, or a high `s`.
 */
export function parseAgentConsent(raw: string): { signature: Hex } | { reason: string } {
  const text = raw.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(text)) return { reason: "not 0x-prefixed hex" };
  if (text.length !== 2 + 130) {
    return { reason: `${(text.length - 2) / 2} bytes, expected 65 (r ‖ s ‖ v)` };
  }
  const signature = text.toLowerCase() as Hex;
  const v = Number(hexToBigInt(slice(signature, 64, 65)));
  if (v !== 27 && v !== 28) return { reason: `v is ${v}, expected 27 or 28` };
  if (hexToBigInt(slice(signature, 32, 64)) > SECP256K1_HALF_ORDER) {
    return { reason: "high-s signature; the gateway accepts only the low-s form" };
  }
  return { signature };
}

/**
 * Check a pasted consent against the fields the reveal will bind. `fields`
 * is null while the nonce has not been read. Resolves `ok` only when the
 * bytes recover to `fields.agent`.
 */
export async function checkAgentConsent(
  raw: string,
  fields: AgentConsentFields | null,
): Promise<AgentConsentCheck> {
  if (raw.trim() === "") return { status: "missing" };
  const parsed = parseAgentConsent(raw);
  if ("reason" in parsed) return { status: "malformed", reason: parsed.reason };
  if (fields === null) return { status: "nonce-unknown" };
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      ...agentConsentTypedData(fields),
      signature: parsed.signature,
    });
  } catch (err) {
    return { status: "malformed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (recovered.toLowerCase() !== fields.agent.toLowerCase()) {
    return { status: "wrong-signer", recovered };
  }
  return { status: "ok", signature: parsed.signature };
}

/** The `agentConsent` bytes a reveal sends, or null while it cannot be sent. */
export function consentBytes(check: AgentConsentCheck): Hex | null {
  if (check.status === "not-required") return NO_AGENT_CONSENT;
  if (check.status === "ok") return check.signature;
  return null;
}
