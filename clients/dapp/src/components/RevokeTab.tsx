// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

import { useAccount, useSimulateContract, useWaitForTransactionReceipt } from "wagmi";
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

export function RevokeTab(props: Props) {
  const { isConnected } = useAccount();
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
      {preview && <TxPreview preview={preview} />}
      <button
        type="button"
        data-testid="revoke-submit"
        disabled={!isConnected || !sim || isPending}
        onClick={onSubmit}
      >
        Sign revokeAgent with wallet
      </button>
      {/* Refusal, wallet error and receipt status (QA plan U5, finding DR-9). */}
      <WriteStatus testId="revoke" label="Revoke" write={write} receipt={receipt} />
    </section>
  );
}
