// Canonical: docs/architecture.md §5.3 — Human Dapp
// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (2026-10-06 amendment)

/**
 * useRotationState — owns the agent-rotation flow state machine.
 *
 * Encapsulates the rotation form fields, derives the two-step revoke +
 * authorize previews via `buildPreview`, validates the combined transition
 * via `composeRotationPreview`, and exposes the wagmi writeContract
 * handlers for each step. RotationTab is left as render-only.
 *
 * Two authorize paths, chosen by the connected wallet's ADMIN_ROLE:
 *
 *   - admin:     step 2 signs `authorizeAgent(new, policy)` (ADMIN_ROLE-gated).
 *   - depositor: step 2 signs `commitAuthorization(hash)` and step 3 signs
 *                `revealAuthorization(new, salt, policy)` one block later.
 *                No role needed; the depositor becomes the new agent's owner.
 *
 * After the timelock handover no EOA holds ADMIN_ROLE on any chain, so a
 * browser wallet always takes the depositor path. Step 1 (`revokeAgent`) is
 * the same for both: the gateway only lets the agent's recorded owner call it.
 */
import { useState } from "react";
import {
  useAccount,
  useBlockNumber,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { ADMIN_ROLE_HASH, gatewayAbi } from "./abi";
import { buildPreview, type AdminAction, type PreviewContext } from "./preview";
import { composeRotationPreview } from "./rotation";
import { computeCommitHash, generateSalt } from "./commitReveal";

type RotationStep = "idle" | "revoke-sent" | "commit-sent" | "done";
export type RotationAuthorizePath = "admin" | "depositor";

export function useRotationState(gatewayAddress: Address, ctx: PreviewContext, now: number) {
  const { address, isConnected } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const [oldAgentRaw, setOldAgentRaw] = useState("");
  const [newAgentRaw, setNewAgentRaw] = useState("");
  const [validUntil, setValidUntil] = useState(() => Math.floor(now / 1000 + 86400).toString());
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");
  const [shareReceiver, setShareReceiver] = useState("");
  const [step, setStep] = useState<RotationStep>("idle");
  const [salt, setSalt] = useState<Hex | null>(null);
  const [commitTxHash, setCommitTxHash] = useState<Hex | null>(null);

  const resetSteps = () => {
    setStep("idle");
    setSalt(null);
    setCommitTxHash(null);
  };
  const setOldAgent = (v: string) => {
    setOldAgentRaw(v);
    resetSteps();
  };
  const setNewAgent = (v: string) => {
    setNewAgentRaw(v);
    resetSteps();
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

  const { data: hasAdminData } = useReadContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "hasRole",
    args: address ? [ADMIN_ROLE_HASH, address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });
  const authorizePath: RotationAuthorizePath = hasAdminData === true ? "admin" : "depositor";

  const revokeAction: AdminAction | null = validOld
    ? { kind: "revokeAgent", agent: oldAgentRaw as Address }
    : null;
  const authorizeAction =
    validNew && validReceiver
      ? ({
          kind: "authorizeAgent",
          agent: newAgentRaw as Address,
          policy: {
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
          },
        } satisfies AdminAction)
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

  // Admin path: simulate authorizeAgent (reverts for a wallet without ADMIN_ROLE).
  const { data: authorizeSim } = useSimulateContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "authorizeAgent",
    args: authorizeAction ? [authorizeAction.agent, authorizeAction.policy] : undefined,
    query: {
      enabled: authorizePath === "admin" && combinedOk && authorizePreview?.ok === true,
    },
  });

  // Depositor path: a reveal cannot be simulated before its commit exists, so
  // check the two conditions the gateway enforces on it up front: the new
  // agent has no owner yet (AgentAlreadyOwned), and a caller without
  // ADMIN_ROLE names itself as shareReceiver (ShareReceiverNotAuthorized).
  const { data: newAgentOwner } = useReadContract({
    address: gatewayAddress,
    abi: gatewayAbi,
    functionName: "agentOwner",
    args: authorizeAction ? [authorizeAction.agent] : undefined,
    query: { enabled: authorizePath === "depositor" && authorizeAction !== null },
  });
  const newAgentFree =
    typeof newAgentOwner === "string" && newAgentOwner.toLowerCase() === zeroAddress;
  const receiverIsSelf =
    Boolean(address) && validReceiver && shareReceiver.toLowerCase() === address?.toLowerCase();

  let depositorError: string | null = null;
  if (authorizePath === "depositor" && combinedOk) {
    if (address && !receiverIsSelf) {
      depositorError =
        "This wallet lacks ADMIN_ROLE, so it must name itself as shareReceiver. " +
        "The gateway reverts any other receiver.";
    } else if (typeof newAgentOwner === "string" && !newAgentFree) {
      depositorError = "The new agent address already has an owner (AgentAlreadyOwned).";
    }
  }

  const authorizeReady =
    authorizePath === "admin"
      ? Boolean(authorizeSim)
      : newAgentFree && receiverIsSelf && authorizePreview?.ok === true;
  // Step 2 needs its own preview; step 1 needs BOTH so the operator sees the
  // whole rotation before signing anything.
  const authorizeOk = combinedOk && authorizeReady;
  const previewsOk = authorizeOk && Boolean(revokeSim);

  // Depositor reveal gating: the reveal must land in a later block than the
  // commit (CommitmentTooRecent), so wait for the commit receipt and a newer head.
  const { data: commitReceipt } = useWaitForTransactionReceipt({
    hash: commitTxHash ?? undefined,
    query: { enabled: commitTxHash !== null },
  });
  const commitBlockNumber = commitReceipt?.blockNumber ?? null;
  const { data: currentBlock } = useBlockNumber({
    watch: step === "commit-sent",
    query: { enabled: step === "commit-sent" },
  });
  const revealReady =
    step === "commit-sent" &&
    salt !== null &&
    commitBlockNumber !== null &&
    currentBlock !== undefined &&
    currentBlock > commitBlockNumber;

  const onRevoke = () => {
    if (!revokeSim) return;
    writeContract(revokeSim.request);
    setStep("revoke-sent");
  };

  const onAuthorize = () => {
    if (authorizePath === "admin") {
      if (!authorizeSim) return;
      writeContract(authorizeSim.request);
      setStep("done");
      return;
    }
    if (!address || !authorizeAction) return;
    const newSalt = generateSalt();
    writeContract(
      {
        address: gatewayAddress,
        abi: gatewayAbi,
        functionName: "commitAuthorization",
        args: [computeCommitHash(authorizeAction.agent, address, newSalt)],
      },
      {
        onSuccess: (txHash) => {
          setSalt(newSalt);
          setCommitTxHash(txHash);
          setStep("commit-sent");
        },
      },
    );
  };

  const onReveal = () => {
    if (!revealReady || !salt || !authorizeAction) return;
    writeContract(
      {
        address: gatewayAddress,
        abi: gatewayAbi,
        functionName: "revealAuthorization",
        args: [authorizeAction.agent, salt, authorizeAction.policy],
      },
      { onSuccess: () => setStep("done") },
    );
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
    authorizePath,
    revokePreview,
    authorizePreview,
    combinedRiskAnnotation,
    combinedError,
    depositorError,
    previewsOk,
    authorizeOk,
    revealReady,
    isPending,
    onRevoke,
    onAuthorize,
    onReveal,
  };
}
