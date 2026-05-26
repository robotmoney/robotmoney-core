// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * useRotationState — owns the agent-rotation flow state machine.
 *
 * Encapsulates the rotation form fields, derives the two-step revoke +
 * authorize previews via `buildPreview`, validates the combined transition
 * via `composeRotationPreview`, and exposes the wagmi writeContract
 * handlers for each step. RotationTab is left as render-only.
 */
import { useState } from "react";
import { useSimulateContract, useWriteContract } from "wagmi";
import { isAddress, type Address } from "viem";
import { gatewayAbi } from "./abi";
import { buildPreview, type AdminAction, type PreviewContext } from "./preview";
import { composeRotationPreview } from "./rotation";

type RotationStep = "idle" | "revoke-sent" | "done";

export function useRotationState(gatewayAddress: Address, ctx: PreviewContext, now: number) {
  const { writeContract, isPending } = useWriteContract();

  const [oldAgentRaw, setOldAgentRaw] = useState("");
  const [newAgentRaw, setNewAgentRaw] = useState("");
  const [validUntil, setValidUntil] = useState(() => Math.floor(now / 1000 + 86400).toString());
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");
  const [shareReceiver, setShareReceiver] = useState("");
  const [step, setStep] = useState<RotationStep>("idle");

  const setOldAgent = (v: string) => {
    setOldAgentRaw(v);
    setStep("idle");
  };
  const setNewAgent = (v: string) => {
    setNewAgentRaw(v);
    setStep("idle");
  };

  // strict: false — accept lowercase addresses (rmpc + some wallets omit
  // EIP-55 checksum casing).
  const validOld = isAddress(oldAgentRaw, { strict: false });
  const validNew = isAddress(newAgentRaw, { strict: false });
  const validReceiver = isAddress(shareReceiver, { strict: false });

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
  const authorizeAction: AdminAction | null =
    validNew && validReceiver
      ? {
          kind: "authorizeAgent",
          agent: newAgentRaw as Address,
          policy: {
            active: true,
            validUntil: BigInt(validUntil),
            maxPerPayment: BigInt(maxPerPayment),
            maxPerWindow: BigInt(maxPerWindow),
            shareReceiver: shareReceiver as Address,
            allowedDestinations: [],
            assetRecipient: "0x0000000000000000000000000000000000000000" as Address,
            maxWithdrawPerPayment: 0n,
            maxWithdrawPerWindow: 0n,
            allowedSourceVaults: [],
          },
        }
      : null;

  const revokePreview = revokeAction ? buildPreview(revokeAction, ctx) : null;
  const authorizePreview = authorizeAction ? buildPreview(authorizeAction, ctx) : null;

  const { data: revokeSim } = useSimulateContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "revokeAgent",
    args: revokeAction ? [revokeAction.agent] : undefined,
    query: { enabled: combinedOk && revokePreview?.ok === true },
  });
  const { data: authorizeSim } = useSimulateContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "authorizeAgent",
    args: authorizeAction ? [authorizeAction.agent, authorizeAction.policy] : undefined,
    query: { enabled: combinedOk && authorizePreview?.ok === true },
  });
  const previewsOk = combinedOk && Boolean(revokeSim) && Boolean(authorizeSim);

  const onRevoke = () => {
    if (!revokeSim) return;
    writeContract(revokeSim.request);
    setStep("revoke-sent");
  };

  const onAuthorize = () => {
    if (!authorizeSim) return;
    writeContract(authorizeSim.request);
    setStep("done");
  };

  return {
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
    revokePreview,
    authorizePreview,
    combinedRiskAnnotation,
    combinedError,
    previewsOk,
    isPending,
    onRevoke,
    onAuthorize,
  };
}
