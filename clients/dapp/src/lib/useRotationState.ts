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
 *                Step 2 previews the commit and step 3 previews the reveal,
 *                each built from the inputs its write uses (QA plan U4).
 *
 * After the timelock handover no EOA holds ADMIN_ROLE on any chain, so a
 * browser wallet always takes the depositor path. Step 1 (`revokeAgent`) is
 * the same for both: the gateway only lets the agent's recorded owner call it.
 *
 * On the depositor path the new agent must consent (issue 1791): its EIP-712
 * AgentConsent signature is collected before step 1, because a rotation that
 * revokes the old agent and then cannot reveal the new one leaves no agent.
 *
 * Each step has its own write hook and receipt (QA plan U5). A step advances
 * when the wallet accepts it; a step whose receipt says reverted stops the
 * flow, and "done" means the final transaction (authorizeAgent or the reveal)
 * is mined with status success, never that the wallet merely accepted it.
 */
import { useState } from "react";
import {
  useAccount,
  useBlockNumber,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useGuardedWriteContract } from "./useGuardedWriteContract";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { ADMIN_ROLE_HASH, gatewayAbi } from "./abi";
import { useAgentConsent } from "./useAgentConsent";
import { NO_AGENT_CONSENT } from "./agentConsent";
import { buildPreview, type AdminAction, type PreviewContext } from "./preview";
import { composeRotationPreview } from "./rotation";
import {
  commitAuthorizationCall,
  generateSalt,
  revealAuthorizationCall,
  type CommitInputs,
  type RevealInputs,
} from "./commitReveal";

/** Which transaction the wallet last accepted. "Done" is derived from the final receipt. */
type RotationStep = "idle" | "revoke-sent" | "commit-sent" | "final-sent";
export type RotationAuthorizePath = "admin" | "depositor";

export function useRotationState(gatewayAddress: Address, ctx: PreviewContext, now: number) {
  const { address, isConnected } = useAccount();
  // One hook per step, so each step shows its own refusal and receipt (QA plan U5).
  const revokeWrite = useGuardedWriteContract();
  const authorizeWrite = useGuardedWriteContract();
  const revealWrite = useGuardedWriteContract();
  const isPending = revokeWrite.isPending || authorizeWrite.isPending || revealWrite.isPending;

  const [oldAgentRaw, setOldAgentRaw] = useState("");
  const [newAgentRaw, setNewAgentRaw] = useState("");
  const [validUntil, setValidUntil] = useState(() => Math.floor(now / 1000 + 86400).toString());
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");
  const [shareReceiver, setShareReceiver] = useState("");
  const [step, setStep] = useState<RotationStep>("idle");
  // The salt of the next commit. It exists before the commit so the step-2
  // preview shows the exact commitHash, and it holds until the reveal.
  const [salt, setSalt] = useState<Hex>(generateSalt);
  const [revokeTxHash, setRevokeTxHash] = useState<Hex | null>(null);
  const [commitTxHash, setCommitTxHash] = useState<Hex | null>(null);
  /** authorizeAgent (admin path) or the reveal (depositor path). */
  const [finalTxHash, setFinalTxHash] = useState<Hex | null>(null);

  const resetSteps = () => {
    setStep("idle");
    setSalt(generateSalt());
    setRevokeTxHash(null);
    setCommitTxHash(null);
    setFinalTxHash(null);
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

  // Depositor path: the new agent's consent (issue 1791). The admin path's
  // authorizeAgent takes none.
  const agentConsent = useAgentConsent({
    gateway: gatewayAddress,
    agent: authorizePath === "depositor" ? newAgentRaw : "",
    revealer: address,
    shareReceiver,
  });

  // Depositor path: step 2 signs the commit and step 3 the reveal, so those are
  // what it previews (QA plan U4, DR-4). A new-agent edit resets the steps and
  // the salt, so the agent and salt cannot drift between commit and reveal.
  const commitInputs: CommitInputs | null =
    authorizeAction && address ? { agent: authorizeAction.agent, committer: address, salt } : null;
  const revealInputs: RevealInputs | null = authorizeAction
    ? {
        agent: authorizeAction.agent,
        salt,
        policy: authorizeAction.policy,
        agentConsent: agentConsent.consent ?? NO_AGENT_CONSENT,
      }
    : null;

  const revokePreview = revokeAction ? buildPreview(revokeAction, ctx) : null;
  const adminAuthorizePreview = authorizeAction ? buildPreview(authorizeAction, ctx) : null;
  const commitPreview = commitInputs
    ? buildPreview({ kind: "commitAuthorization", ...commitInputs }, ctx)
    : null;
  const revealPreview =
    authorizePath === "depositor" && revealInputs
      ? buildPreview({ kind: "revealAuthorization", ...revealInputs }, ctx)
      : null;
  // The step-2 preview: the call the step-2 button signs on this wallet's path.
  const authorizePreview = authorizePath === "admin" ? adminAuthorizePreview : commitPreview;

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
      enabled: authorizePath === "admin" && combinedOk && adminAuthorizePreview?.ok === true,
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
      : newAgentFree &&
        receiverIsSelf &&
        agentConsent.consent !== null &&
        commitPreview?.ok === true &&
        revealPreview?.ok === true;
  // Step 2 needs its own preview; step 1 needs BOTH so the operator sees the
  // whole rotation before signing anything.
  const authorizeOk = combinedOk && authorizeReady;
  const previewsOk = authorizeOk && Boolean(revokeSim);

  // Each step's receipt. A reverted revoke or commit stops the flow; the
  // rotation is complete only when the final transaction is mined with success.
  const revokeReceipt = useWaitForTransactionReceipt({
    hash: revokeTxHash ?? undefined,
    query: { enabled: revokeTxHash !== null },
  });
  // Depositor reveal gating: the reveal must land in a later block than the
  // commit (CommitmentTooRecent), so wait for the commit receipt and a newer head.
  const commitReceipt = useWaitForTransactionReceipt({
    hash: commitTxHash ?? undefined,
    query: { enabled: commitTxHash !== null },
  });
  const finalReceipt = useWaitForTransactionReceipt({
    hash: finalTxHash ?? undefined,
    query: { enabled: finalTxHash !== null },
  });
  const revokeReverted = revokeReceipt.data?.status === "reverted";
  const commitReverted = commitReceipt.data?.status === "reverted";
  const done = finalReceipt.data?.status === "success";
  const commitBlockNumber = commitReverted ? null : (commitReceipt.data?.blockNumber ?? null);
  const { data: currentBlock } = useBlockNumber({
    watch: step === "commit-sent",
    query: { enabled: step === "commit-sent" },
  });
  // The reveal also needs every step-2 precondition still true: the policy
  // fields stay editable after the commit and the reveal preview follows them.
  const revealReady =
    step === "commit-sent" &&
    authorizeOk &&
    commitBlockNumber !== null &&
    currentBlock !== undefined &&
    currentBlock > commitBlockNumber;

  // Step 2 opens once the wallet accepted the revoke, and closes again if the
  // revoke's receipt says it reverted (the old agent is still bound).
  const authorizeOpen = step === "revoke-sent" && !revokeReverted;

  const onRevoke = () => {
    if (!revokeSim) return;
    revokeWrite.writeContract(revokeSim.request, {
      onSuccess: (txHash) => {
        setRevokeTxHash(txHash);
        setStep("revoke-sent");
      },
    });
  };

  const onAuthorize = () => {
    if (!authorizeOpen) return;
    if (authorizePath === "admin") {
      if (!authorizeSim) return;
      authorizeWrite.writeContract(authorizeSim.request, {
        onSuccess: (txHash) => {
          setFinalTxHash(txHash);
          setStep("final-sent");
        },
      });
      return;
    }
    if (!commitInputs || commitPreview?.ok !== true) return;
    authorizeWrite.writeContract(
      {
        address: gatewayAddress,
        abi: gatewayAbi,
        ...commitAuthorizationCall(commitInputs),
      },
      {
        onSuccess: (txHash) => {
          setCommitTxHash(txHash);
          setStep("commit-sent");
        },
      },
    );
  };

  const onReveal = () => {
    if (!revealReady || !revealInputs) return;
    revealWrite.writeContract(
      {
        address: gatewayAddress,
        abi: gatewayAbi,
        ...revealAuthorizationCall(revealInputs),
      },
      {
        onSuccess: (txHash) => {
          setFinalTxHash(txHash);
          setStep("final-sent");
        },
      },
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
    /** True only when the final transaction is mined with status success. */
    done,
    authorizeOpen,
    authorizePath,
    agentConsent,
    revokePreview,
    authorizePreview,
    revealPreview,
    combinedRiskAnnotation,
    combinedError,
    depositorError,
    previewsOk,
    authorizeOk,
    revealReady,
    isPending,
    /**
     * Each step's write and receipt, shown by the tab (QA plan U5, finding DR-9):
     * the refusal or wallet error, then sent, mined or reverted.
     */
    revokeStatus: {
      write: {
        error: revokeWrite.error,
        isPending: revokeWrite.isPending,
        data: revokeTxHash ?? undefined,
      },
      receipt: revokeReceipt,
    },
    authorizeStatus: {
      write: {
        error: authorizeWrite.error,
        isPending: authorizeWrite.isPending,
        data: (authorizePath === "admin" ? finalTxHash : commitTxHash) ?? undefined,
      },
      receipt: authorizePath === "admin" ? finalReceipt : commitReceipt,
    },
    revealStatus: {
      write: {
        error: revealWrite.error,
        isPending: revealWrite.isPending,
        data: authorizePath === "depositor" ? (finalTxHash ?? undefined) : undefined,
      },
      receipt: finalReceipt,
    },
    onRevoke,
    onAuthorize,
    onReveal,
  };
}
