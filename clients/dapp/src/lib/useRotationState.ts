// Canonical: docs/architecture.md §5.3 — Human Dapp
// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (2026-10-06 amendment, 2026-10-20 amendment)

/**
 * useRotationState — owns the agent-rotation flow state machine.
 *
 * Encapsulates the rotation form fields, derives the revoke preview via
 * `buildPreview`, validates the combined transition via `composeRotationPreview`,
 * and exposes the wagmi writeContract handler for the revoke step. The new agent
 * is registered by `useConsentedRegistration`, the same hook the Authorize tab and
 * the onboarding wizard use.
 *
 * Every wallet takes one path (issue 1890). The gateway has no `authorizeAgent`
 * and no role registers an agent, so an ADMIN_ROLE holder and a plain depositor run
 * the same sequence:
 *
 *   1. `revokeAgent(old)` - signed by the old agent's owner (or by the old agent itself);
 *   2. the new agent's consent, read from the gateway, then this wallet's
 *      `commitAuthorization`;
 *   3. `revealAuthorization(new, salt, policy)` one block later, inside both expiry windows.
 *
 * This wallet becomes the new agent's owner and share receiver. "Done" means the
 * reveal is mined with status success, never that the wallet merely accepted it.
 * A reverted revoke stops the flow before the registration opens.
 */
import { useState } from "react";
import { useReadContract, useSimulateContract, useWaitForTransactionReceipt } from "wagmi";
import { useGuardedWriteContract } from "./useGuardedWriteContract";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { gatewayAbi } from "./abi";
import { buildPreview, type AdminAction, type AgentPolicy, type PreviewContext } from "./preview";
import { composeRotationPreview } from "./rotation";
import { useConsentedRegistration } from "./useConsentedRegistration";

/** Which transaction the wallet last accepted. */
type RotationStep = "idle" | "revoke-sent";

export function useRotationState(gatewayAddress: Address, ctx: PreviewContext, now: number) {
  // One hook for the revoke step, so it shows its own refusal and receipt (QA plan U5).
  const revokeWrite = useGuardedWriteContract();

  const [oldAgentRaw, setOldAgentRaw] = useState("");
  const [newAgentRaw, setNewAgentRaw] = useState("");
  const [validUntil, setValidUntil] = useState(() => Math.floor(now / 1000 + 86400).toString());
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");
  const [shareReceiver, setShareReceiver] = useState("");
  const [step, setStep] = useState<RotationStep>("idle");
  const [revokeTxHash, setRevokeTxHash] = useState<Hex | null>(null);

  // strict: false — accept lowercase addresses (rmpc + some wallets omit
  // EIP-55 checksum casing).
  const validOld = isAddress(oldAgentRaw, { strict: false });
  const validNew = isAddress(newAgentRaw, { strict: false });
  const validReceiver = isAddress(shareReceiver, { strict: false });

  const policy: AgentPolicy | null =
    validNew && validReceiver && isUint(validUntil) && isUint(maxPerPayment) && isUint(maxPerWindow)
      ? {
          active: true,
          validUntil: BigInt(validUntil),
          maxPerPayment: BigInt(maxPerPayment),
          maxPerWindow: BigInt(maxPerWindow),
          shareReceiver: shareReceiver as Address,
          allowedDestinations: [],
          assetRecipient: zeroAddress,
          maxWithdrawPerPayment: 0n,
          maxWithdrawPerWindow: 0n,
          allowedSourceVaults: [],
        }
      : null;

  const registration = useConsentedRegistration({
    gatewayAddress,
    ctx,
    agent: newAgentRaw,
    policy,
  });

  const resetSteps = () => {
    setStep("idle");
    setRevokeTxHash(null);
    registration.reset();
  };
  const setOldAgent = (v: string) => {
    setOldAgentRaw(v);
    resetSteps();
  };
  const setNewAgent = (v: string) => {
    setNewAgentRaw(v);
    resetSteps();
  };

  let combinedRiskAnnotation: string | null = null;
  let combinedError: string | null = null;
  let combinedOk = false;
  if (validOld && validNew && validReceiver) {
    try {
      const r = composeRotationPreview(oldAgentRaw, newAgentRaw, {
        shareReceiver,
        validUntil: Number(validUntil),
        maxPerDeposit: BigInt(maxPerPayment),
        maxPerWindow: BigInt(maxPerWindow),
      });
      combinedRiskAnnotation = r.combinedRiskAnnotation;
      combinedOk = true;
    } catch (err) {
      combinedError = (err as Error).message;
    }
  }

  const revokeAction: AdminAction | null = validOld
    ? { kind: "revokeAgent", agent: oldAgentRaw as Address }
    : null;
  const revokePreview = revokeAction ? buildPreview(revokeAction, ctx) : null;

  const { data: revokeSim } = useSimulateContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "revokeAgent",
    args: revokeAction ? [revokeAction.agent] : undefined,
    query: { enabled: combinedOk && revokePreview?.ok === true },
  });

  // A reveal cannot be simulated before its commitments exist. Warn up front when the new
  // agent already has an owner: the reveal reverts AgentAlreadyOwned unless that
  // registration's policy has expired.
  const { data: newAgentOwner } = useReadContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "agentOwner",
    args: validNew ? [newAgentRaw as Address] : undefined,
    query: { enabled: validNew },
  });
  const newAgentOwned =
    typeof newAgentOwner === "string" && newAgentOwner.toLowerCase() !== zeroAddress;
  const newAgentOwnedWarning = newAgentOwned
    ? "The new agent address already has an owner. The reveal reverts (AgentAlreadyOwned) unless that registration's policy has expired."
    : null;

  // Step 1 needs the whole rotation to be previewable so the operator sees it before signing.
  const previewsOk = combinedOk && Boolean(revokeSim);

  const revokeReceipt = useWaitForTransactionReceipt({
    hash: revokeTxHash ?? undefined,
    query: { enabled: revokeTxHash !== null },
  });
  const revokeReverted = revokeReceipt.data?.status === "reverted";

  // The registration opens once the wallet accepted the revoke, and closes again if the
  // revoke's receipt says it reverted (the old agent is still bound).
  const registrationOpen = step === "revoke-sent" && !revokeReverted;

  const onRevoke = () => {
    if (!revokeSim) return;
    revokeWrite.writeContract(revokeSim.request, {
      onSuccess: (txHash) => {
        setRevokeTxHash(txHash);
        setStep("revoke-sent");
      },
    });
  };

  return {
    registration,
    oldAgent: oldAgentRaw,
    setOldAgent,
    newAgent: newAgentRaw,
    setNewAgent,
    validUntil,
    setValidUntil,
    maxPerPayment,
    setMaxPerPayment,
    maxPerWindow,
    setMaxPerWindow,
    shareReceiver,
    setShareReceiver,
    step,
    /** True only when the reveal is mined with status success. */
    done: registration.revealMined,
    registrationOpen,
    revokePreview,
    combinedRiskAnnotation,
    combinedError,
    newAgentOwnedWarning,
    previewsOk,
    isPending: revokeWrite.isPending || registration.isPending,
    /** The revoke step's write and receipt (QA plan U5, finding DR-9). */
    revokeStatus: {
      write: {
        error: revokeWrite.error,
        isPending: revokeWrite.isPending,
        data: revokeTxHash ?? undefined,
      },
      receipt: revokeReceipt,
    },
    onRevoke,
  };
}

function isUint(v: string): boolean {
  return /^\d+$/.test(v.trim());
}
