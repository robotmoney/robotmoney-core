/**
 * Canonical: docs/implementation-plan.md §12 — Phase 6 Human Dapp Controls
 * Canonical: docs/technical/dapp-credential-decisions.md §3–§4
 *
 * Register-existing-address credential workflow.
 *
 * The operator supplies a public address generated externally (hardware
 * wallet, `cast wallet new`, encrypted keystore). The dapp never sees the
 * private key. Browser-side keypair generation is not a supported path —
 * see docs/technical/dapp-credential-decisions.md §3.1.
 */

import { formatUsdc } from "./format";

/**
 * Policy parameters the operator sets when registering an agent address.
 * Mirrors the `AgentPolicy` struct in the gateway contract.
 */
export interface AgentPolicy {
  /** Address that receives rmUSDC shares from the gateway deposit. */
  shareReceiver: string;
  /** Unix timestamp after which the agent authorization expires. */
  validUntil: number;
  /** Maximum USDC amount per individual deposit call (in token base units). */
  maxPerDeposit: bigint;
  /** Maximum USDC amount per rolling window (in token base units). */
  maxPerWindow: bigint;
}

/**
 * Result of composing a register-existing-address flow step.
 * Contains a human-readable preview of the on-chain effect before the wallet
 * signing prompt is shown.
 */
export interface RegisterPreview {
  /** The agent address being registered (externally supplied, 0x-prefixed). */
  agentAddress: string;
  /** The policy parameters as a display-ready record. */
  policy: AgentPolicy;
  /**
   * Decoded preview of the `authorizeAgent(address, AgentPolicy)` call.
   * Shown to the operator before wallet signing is triggered.
   */
  preview: {
    target: "gateway";
    functionName: "authorizeAgent";
    /** Human-readable parameter breakdown for display. */
    parameters: {
      agent: string;
      shareReceiver: string;
      validUntilISO: string;
      maxPerDepositFormatted: string;
      maxPerWindowFormatted: string;
    };
    /**
     * Risk annotation shown in the UI before signing.
     * authorizeAgent grants AGENT_ROLE — an irreversible on-chain state
     * change until revokeAgent is called. Operator must confirm intent.
     */
    riskAnnotation: string;
  };
}

/**
 * Validate that a string is a well-formed Ethereum address.
 *
 * Accepts checksummed or lowercase 0x-prefixed 40-hex-char addresses.
 * Does NOT perform EIP-55 checksum validation — that is the wallet's
 * responsibility at signing time.
 *
 * @throws {Error} if the address is not a valid Ethereum address format.
 */
export function validateEthereumAddress(addr: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(
      `Invalid Ethereum address: "${addr}". Expected 0x-prefixed 40-hex-char string.`,
    );
  }
}

/**
 * Compose the `authorizeAgent` preview for a register-existing-address flow.
 *
 * This is a pure function that constructs the display model for the
 * transaction preview step. No wallet interaction or on-chain read occurs here.
 *
 * The caller (UI component or test) must validate that the agent is not already
 * authorized before presenting this preview.
 *
 * @param agentAddress - 0x-prefixed Ethereum address of the agent (externally created).
 * @param policy - The policy parameters the operator wants to set.
 * @returns A `RegisterPreview` ready for display in the transaction-preview step.
 * @throws {Error} if either address is malformed.
 */
export function composeRegisterPreview(agentAddress: string, policy: AgentPolicy): RegisterPreview {
  validateEthereumAddress(agentAddress);
  validateEthereumAddress(policy.shareReceiver);

  const validUntilISO = new Date(policy.validUntil * 1000).toISOString();
  const maxPerDepositFormatted = formatUsdc(policy.maxPerDeposit);
  const maxPerWindowFormatted = formatUsdc(policy.maxPerWindow);

  return {
    agentAddress,
    policy,
    preview: {
      target: "gateway",
      functionName: "authorizeAgent",
      parameters: {
        agent: agentAddress,
        shareReceiver: policy.shareReceiver,
        validUntilISO,
        maxPerDepositFormatted,
        maxPerWindowFormatted,
      },
      riskAnnotation:
        "authorizeAgent grants AGENT_ROLE on the gateway. " +
        "The authorized address can call gateway.deposit() within the specified policy caps. " +
        "This is an on-chain state change. Use revokeAgent to undo it.",
    },
  };
}

/**
 * Re-export formatUsdc from the shared module so callers that historically
 * imported it from credentialWorkflow continue to work without changes.
 */
export { formatUsdc } from "./format";
