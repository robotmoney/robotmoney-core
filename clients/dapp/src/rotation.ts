/**
 * Canonical: docs/implementation-plan.md §12 — Phase 6 Human Dapp Controls
 * Canonical: docs/technical/dapp-credential-decisions.md §6
 *
 * Agent rotation workflow.
 *
 * A rotation replaces an old authorized agent address with a new one. The
 * dapp must present a two-step preview — revokeAgent(old) followed by
 * authorizeAgent(new, policy) — before the wallet signing prompt is enabled.
 *
 * Both steps are presented together so the operator can verify the full
 * effect: the old address loses AGENT_ROLE and the new address gains it with
 * the specified policy. The operator must explicitly confirm before any wallet
 * interaction occurs.
 *
 * Rotation does NOT have to be atomic at the contract level. The dapp presents
 * the revoke and authorize as sequential transactions. The operator confirms
 * both before either is submitted.
 *
 * See docs/technical/dapp-credential-decisions.md §6 for the credential
 * revocation flow specification.
 */

import {
  AgentPolicy,
  composeRegisterPreview,
  validateEthereumAddress,
  RegisterPreview,
} from "./credentialWorkflow";

/**
 * Preview of a single `revokeAgent` call.
 * Shown as the first step of the rotation preview.
 */
export interface RevokePreview {
  /** The agent address being revoked. */
  agentAddress: string;
  /** Decoded preview of the `revokeAgent(address)` call. */
  preview: {
    target: "gateway";
    functionName: "revokeAgent";
    parameters: {
      agent: string;
    };
    /**
     * Risk annotation — revokeAgent removes AGENT_ROLE immediately.
     * Any in-flight deposits from the old address will fail after this tx.
     */
    riskAnnotation: string;
  };
}

/**
 * Combined preview for an agent rotation: revoke old then authorize new.
 *
 * Presented to the operator before wallet signing is enabled for either
 * transaction. The operator must confirm that:
 *   1. The old address is the one to be replaced.
 *   2. The new address and policy are correct.
 * before either transaction is submitted.
 */
export interface RotationPreview {
  /** Step 1: revoke old agent. Must be confirmed and submitted first. */
  revokeStep: RevokePreview;
  /** Step 2: authorize new agent with policy. Submitted after step 1 confirms. */
  authorizeStep: RegisterPreview;
  /**
   * Combined risk annotation for the rotation.
   * Shown above both step previews in the UI.
   */
  combinedRiskAnnotation: string;
}

/**
 * Compose the combined revoke + authorize preview for an agent rotation.
 *
 * This is a pure function. No wallet interaction or on-chain read occurs.
 * The caller must verify on-chain that `oldAgentAddress` is currently
 * authorized before presenting this preview.
 *
 * @param oldAgentAddress - The currently authorized agent address to revoke.
 * @param newAgentAddress - The new agent address to authorize (externally created).
 * @param newPolicy - Policy parameters for the new agent.
 * @returns A `RotationPreview` ready for display in the transaction-preview step.
 * @throws {Error} if any address is malformed or old and new addresses are identical.
 */
export function composeRotationPreview(
  oldAgentAddress: string,
  newAgentAddress: string,
  newPolicy: AgentPolicy,
): RotationPreview {
  validateEthereumAddress(oldAgentAddress);
  validateEthereumAddress(newAgentAddress);

  if (oldAgentAddress.toLowerCase() === newAgentAddress.toLowerCase()) {
    throw new Error(
      `Rotation requires distinct addresses. ` +
        `Old and new agent addresses are both: ${oldAgentAddress}`,
    );
  }

  const revokeStep: RevokePreview = {
    agentAddress: oldAgentAddress,
    preview: {
      target: "gateway",
      functionName: "revokeAgent",
      parameters: {
        agent: oldAgentAddress,
      },
      riskAnnotation:
        "revokeAgent removes AGENT_ROLE from the gateway immediately. " +
        "Any in-flight deposit calls from the old address will fail after this transaction confirms.",
    },
  };

  const authorizeStep = composeRegisterPreview(newAgentAddress, newPolicy);

  return {
    revokeStep,
    authorizeStep,
    combinedRiskAnnotation:
      "This rotation submits TWO on-chain transactions in sequence: " +
      "(1) revokeAgent removes the old agent address, " +
      "(2) authorizeAgent grants AGENT_ROLE to the new address with the specified policy. " +
      "Both previews must be reviewed and confirmed before wallet signing begins. " +
      "Do not close this dialog between transactions.",
  };
}

export type { AgentPolicy };
