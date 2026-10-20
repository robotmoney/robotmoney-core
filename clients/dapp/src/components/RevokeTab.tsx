// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

import {
  useAccount,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";
import { isAddress, type Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { TxPreview } from "./TxPreview";
import { WriteStatus } from "./WriteStatus";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  agent: string;
}>;

/**
 * Revoke an agent. Two accounts can sign it (ACL-9, issue 1890): the agent's recorded owner, and
 * the agent itself (self-revoke), so an agent can always leave a registration it no longer wants.
 * No other account can, an ADMIN_ROLE holder included. Revoking clears the policy, the owner
 * record and the role, and resets the agent's rolling deposit budget.
 */
export function RevokeTab(props: Props) {
  const { address, isConnected } = useAccount();
  const write = useGuardedWriteContract();
  const { writeContract, isPending } = write;
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: Boolean(write.data) },
  });

  const action: AdminAction | null = isAddress(props.agent)
    ? { kind: "revokeAgent", agent: props.agent as Address }
    : null;
  const preview = action ? buildPreview(action, props.ctx) : null;

  // Who may sign: the recorded owner, or the agent itself.
  const { data: ownerData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "agentOwner",
    args: action ? [action.agent] : undefined,
    query: { enabled: action !== null },
  });
  const owner = typeof ownerData === "string" ? ownerData.toLowerCase() : null;
  const wallet = address?.toLowerCase() ?? null;
  const selfRevoke = wallet !== null && action !== null && wallet === action.agent.toLowerCase();
  const isOwner = wallet !== null && owner !== null && wallet === owner;
  const unregistered = owner === "0x0000000000000000000000000000000000000000";
  const mayRevoke = selfRevoke || isOwner;

  const { data: sim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "revokeAgent",
    args: action ? [action.agent] : undefined,
    query: { enabled: isConnected && preview?.ok === true },
  });

  const onSubmit = () => {
    if (!sim) return;
    writeContract(sim.request);
  };

  return (
    <section data-testid="revoke-form">
      <h2>Revoke agent</h2>
      {selfRevoke && (
        <p data-testid="revoke-self-note" className="hint">
          This wallet is the agent. It can revoke its own registration; its owner is not asked.
        </p>
      )}
      {action && isConnected && !mayRevoke && !unregistered && owner !== null && (
        <p data-testid="revoke-not-allowed" className="error">
          Only the agent&apos;s owner or the agent itself can revoke it. This wallet is neither.
        </p>
      )}
      {unregistered && (
        <p data-testid="revoke-unregistered" className="hint">
          This address has no registration.
        </p>
      )}
      {preview && <TxPreview preview={preview} />}
      <button
        type="button"
        data-testid="revoke-submit"
        disabled={!isConnected || !sim || isPending}
        onClick={onSubmit}
      >
        {selfRevoke ? "Sign revokeAgent (self-revoke) with wallet" : "Sign revokeAgent with wallet"}
      </button>
      {/* Refusal, wallet error and receipt status (QA plan U5, finding DR-9). */}
      <WriteStatus testId="revoke" label="Revoke" write={write} receipt={receipt} />
    </section>
  );
}
