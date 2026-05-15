import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useAccount, useSimulateContract, useWriteContract } from "wagmi";
import { isAddress, type Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { markRegistered } from "../lib/useVaultRegistration";
import { TxPreview } from "./TxPreview";
import { PolicyFields } from "./PolicyFields";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  agent: string;
  setAgent: Dispatch<SetStateAction<string>>;
  shareReceiver: string;
  setShareReceiver: Dispatch<SetStateAction<string>>;
  now: number;
}>;

export function AuthorizeTab(props: Props) {
  const { address, isConnected } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(props.now / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");

  // strict: false — accept lowercase addresses (rmpc + some wallets omit
  // EIP-55 checksum casing).
  const validAgent = isAddress(props.agent, { strict: false });
  const validReceiver = isAddress(props.shareReceiver, { strict: false });

  const action: AdminAction | null =
    validAgent && validReceiver
      ? {
          kind: "authorizeAgent",
          agent: props.agent as Address,
          policy: {
            active: true,
            validUntil: BigInt(validUntil),
            maxPerPayment: BigInt(maxPerPayment),
            maxPerWindow: BigInt(maxPerWindow),
            shareReceiver: props.shareReceiver as Address,
            allowedDestinations: [],
            assetRecipient: "0x0000000000000000000000000000000000000000" as Address,
            maxWithdrawPerPayment: 0n,
            maxWithdrawPerWindow: 0n,
            allowedSourceVaults: [],
          },
        }
      : null;

  const preview = action ? buildPreview(action, props.ctx) : null;

  const { data: sim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "authorizeAgent",
    args: action ? [action.agent, action.policy] : undefined,
    query: { enabled: isConnected && preview?.ok === true },
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!sim) return;
    writeContract(sim.request);
    if (address) markRegistered(address);
  };

  return (
    <form data-testid="authorize-form" onSubmit={onSubmit}>
      <h2>Authorize agent</h2>
      <label>
        Agent address
        <input
          data-testid="agent-input"
          value={props.agent}
          onChange={(e) => props.setAgent(e.target.value)}
          placeholder="0x..."
        />
      </label>
      <PolicyFields
        validUntil={validUntil}
        setValidUntil={setValidUntil}
        maxPerPayment={maxPerPayment}
        setMaxPerPayment={setMaxPerPayment}
        maxPerWindow={maxPerWindow}
        setMaxPerWindow={setMaxPerWindow}
        shareReceiver={props.shareReceiver}
        setShareReceiver={props.setShareReceiver}
      />
      {preview && <TxPreview preview={preview} />}
      <button
        type="submit"
        data-testid="authorize-submit"
        disabled={!isConnected || !sim || isPending}
      >
        Sign authorizeAgent with wallet
      </button>
    </form>
  );
}
