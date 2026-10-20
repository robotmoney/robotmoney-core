// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway
// Canonical: docs/technical/smart-contract-invariants.md ACL-9
// Canonical: docs/technical/dapp-credential-decisions.md (amendment 2026-10-20)

/**
 * useConsentedRegistration — the one state machine behind every way the dapp registers an
 * agent (Authorize tab, onboarding wizard, rotation tab). Issue 1890.
 *
 * The gateway has one registration path: `commitAuthorization` then `revealAuthorization`.
 * There is no admin shortcut, so every wallet, an ADMIN_ROLE holder included, runs this.
 * For an agent key other than the signing wallet the order is fixed:
 *
 *   1. freeze the inputs (agent, policy, salt, wallet, chain);
 *   2. the agent commits its consent hash from its own key; the hook reads that commitment
 *      from the gateway;
 *   3. only after the consent is seen live is the owner commit enabled;
 *   4. one block after the owner commit mines, and while both commitments are within
 *      COMMIT_EXPIRY_BLOCKS, the reveal is enabled.
 *
 * Any edit to a bound input, the wallet or the chain after the freeze unbinds the
 * registration, which disables every step until the inputs are frozen again. A reverted
 * commit never opens the reveal, and a reverted reveal never completes the registration.
 */
import { useState } from "react";
import {
  useAccount,
  useBlockNumber,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { useGuardedWriteContract } from "./useGuardedWriteContract";
import { gatewayAbi } from "./abi";
import { buildPreview, type AgentPolicy, type PreviewContext } from "./preview";
import {
  commitAuthorizationCall,
  computeConsentHash,
  generateSalt,
  policyTuple,
  revealAuthorizationCall,
} from "./commitReveal";
import {
  bindingKey,
  commitLive,
  commitmentStorageKey,
  consentStatus,
  type CommitmentRead,
  type ConsentStatus,
} from "./consent";

/** What the freeze captured. The commit and the reveal are built from this, never from live inputs. */
interface Frozen {
  key: string;
  owner: Address;
  agent: Address;
  policy: AgentPolicy;
  salt: Hex;
}

export type RegistrationExpiry = "ok" | "commit-expired" | "consent-expired";

export interface ConsentedRegistrationInput {
  gatewayAddress: Address;
  ctx: PreviewContext;
  /** The raw agent field. */
  agent: string;
  /** Null until the form holds a valid policy. */
  policy: AgentPolicy | null;
}

export function useConsentedRegistration(input: ConsentedRegistrationInput) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  // One hook per step, so each step shows its own refusal and receipt (QA plan U5).
  const commitWrite = useGuardedWriteContract();
  const revealWrite = useGuardedWriteContract();
  const isPending = commitWrite.isPending || revealWrite.isPending;

  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [commitTxHash, setCommitTxHash] = useState<Hex | null>(null);
  const [revealTxHash, setRevealTxHash] = useState<Hex | null>(null);

  const validAgent = isAddress(input.agent, { strict: false });
  const agentAddress = validAgent ? getAddress(input.agent) : null;
  const owner = address ? getAddress(address) : null;

  // The share receiver is always the owner (ACL-9): the policy must name the signing wallet.
  const receiverIsOwner =
    input.policy !== null &&
    owner !== null &&
    input.policy.shareReceiver.toLowerCase() === owner.toLowerCase();
  const canFreeze =
    isConnected &&
    agentAddress !== null &&
    owner !== null &&
    input.policy !== null &&
    receiverIsOwner;

  const liveKey =
    agentAddress && owner && input.policy
      ? bindingKey({
          gateway: input.gatewayAddress,
          chainId,
          owner,
          agent: agentAddress,
          policy: input.policy,
        })
      : null;
  const bound = frozen !== null && liveKey !== null && frozen.key === liveKey;
  const stale = frozen !== null && !bound;

  const freeze = () => {
    if (!canFreeze || !agentAddress || !owner || !input.policy || !liveKey) return;
    setFrozen({
      key: liveKey,
      owner,
      agent: agentAddress,
      policy: input.policy,
      salt: generateSalt(),
    });
    setCommitTxHash(null);
    setRevealTxHash(null);
  };
  const reset = () => {
    setFrozen(null);
    setCommitTxHash(null);
    setRevealTxHash(null);
  };

  const self = frozen !== null && frozen.agent.toLowerCase() === frozen.owner.toLowerCase();
  const consentHash =
    frozen && !self
      ? computeConsentHash(frozen.owner, frozen.agent, frozen.salt, policyTuple(frozen.policy))
      : null;

  // The head block. The earliest block a transaction sent now can land in is head + 1.
  const { data: currentBlock } = useBlockNumber({ watch: bound, query: { enabled: bound } });
  const nextBlock = currentBlock !== undefined ? currentBlock + 1n : undefined;

  const consentRead = useReadContract({
    address: input.gatewayAddress,
    abi: gatewayAbi,
    functionName: "commitments",
    args: consentHash && frozen ? [commitmentStorageKey(consentHash, frozen.agent)] : undefined,
    query: { enabled: bound && consentHash !== null, refetchInterval: 4000 },
  });
  const consent: ConsentStatus = frozen
    ? consentStatus({
        self,
        agent: frozen.agent,
        commitment: consentRead.data as CommitmentRead,
        nextBlock,
      })
    : "unknown";

  const commitInputs = frozen
    ? { agent: frozen.agent, committer: frozen.owner, salt: frozen.salt }
    : null;
  const revealInputs = frozen
    ? { agent: frozen.agent, salt: frozen.salt, policy: frozen.policy }
    : null;
  const commitPreview = commitInputs
    ? buildPreview({ kind: "commitAuthorization", ...commitInputs }, input.ctx)
    : null;
  const revealPreview = revealInputs
    ? buildPreview({ kind: "revealAuthorization", ...revealInputs }, input.ctx)
    : null;
  const previewsOk = commitPreview?.ok === true && revealPreview?.ok === true;

  const commitReceipt = useWaitForTransactionReceipt({
    hash: commitTxHash ?? undefined,
    query: { enabled: commitTxHash !== null },
  });
  const revealReceipt = useWaitForTransactionReceipt({
    hash: revealTxHash ?? undefined,
    query: { enabled: revealTxHash !== null },
  });
  const commitReverted = commitReceipt.data?.status === "reverted";
  const revealReverted = revealReceipt.data?.status === "reverted";
  const revealMined = revealReceipt.data?.status === "success";
  // The block the owner commit mined in. A reverted commit recorded nothing, so it never opens the reveal.
  const commitBlock = commitReverted ? null : (commitReceipt.data?.blockNumber ?? null);

  // The owner commit waits for the agent's consent to be seen on chain and live.
  const consentOk = consent === "self" || consent === "live";
  const commitReady =
    bound && isConnected && commitTxHash === null && consentOk && previewsOk && !isPending;

  let expiry: RegistrationExpiry = "ok";
  if (commitBlock !== null && nextBlock !== undefined && !commitLive(commitBlock, nextBlock)) {
    expiry = "commit-expired";
  } else if (consent === "expired") {
    expiry = "consent-expired";
  }
  const revealReady =
    bound &&
    isConnected &&
    commitBlock !== null &&
    currentBlock !== undefined &&
    currentBlock > commitBlock &&
    expiry === "ok" &&
    consentOk &&
    previewsOk &&
    revealTxHash === null &&
    !isPending;

  const onCommit = () => {
    if (!commitReady || !commitInputs) return;
    commitWrite.writeContract(
      { address: input.gatewayAddress, abi: gatewayAbi, ...commitAuthorizationCall(commitInputs) },
      { onSuccess: (txHash) => setCommitTxHash(txHash) },
    );
  };
  const onReveal = () => {
    if (!revealReady || !revealInputs) return;
    revealWrite.writeContract(
      { address: input.gatewayAddress, abi: gatewayAbi, ...revealAuthorizationCall(revealInputs) },
      { onSuccess: (txHash) => setRevealTxHash(txHash) },
    );
  };

  return {
    frozen,
    bound,
    stale,
    self,
    canFreeze,
    receiverIsOwner,
    freeze,
    reset,
    consent,
    consentHash,
    commitPreview,
    revealPreview,
    commitReady,
    revealReady,
    expiry,
    commitTxHash,
    revealTxHash,
    commitBlock,
    commitReverted,
    revealReverted,
    /** True only when the reveal is mined with status success. */
    revealMined,
    isPending,
    commitStatus: {
      write: {
        error: commitWrite.error,
        isPending: commitWrite.isPending,
        data: commitTxHash ?? undefined,
      },
      receipt: commitReceipt,
    },
    revealStatus: {
      write: {
        error: revealWrite.error,
        isPending: revealWrite.isPending,
        data: revealTxHash ?? undefined,
      },
      receipt: revealReceipt,
    },
    onCommit,
    onReveal,
  };
}

export type ConsentedRegistration = ReturnType<typeof useConsentedRegistration>;
