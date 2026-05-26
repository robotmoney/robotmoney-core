// Canonical: docs/architecture.md §6.2 — Custody (see also §6.3 Role Separation)

import { useState, type FormEvent } from "react";
import { useAccount, useSimulateContract, useWriteContract } from "wagmi";
import { isAddress, type Address } from "viem";
import { gatewayAbi, ROLE_HASH, type RoleName } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { TxPreview } from "./TxPreview";

type Props = Readonly<{
  role: RoleName;
  gatewayAddress: Address;
  ctx: PreviewContext;
  /** Inline note shown under the heading. */
  description: React.ReactNode;
}>;

const SLUG: Record<RoleName, string> = {
  ADMIN_ROLE: "admin",
  PAUSER_ROLE: "pauser",
};

export function RoleTab(props: Props) {
  const { isConnected } = useAccount();
  const { writeContract, isPending } = useWriteContract();
  const [account, setAccount] = useState("");

  const slug = SLUG[props.role];
  const valid = isAddress(account);
  const roleHash = ROLE_HASH[props.role];
  const accountAddr = valid ? (account as Address) : undefined;

  const grantAction: AdminAction | null = valid
    ? { kind: "grantRole", role: props.role, account: account as Address }
    : null;
  const revokeAction: AdminAction | null = valid
    ? { kind: "revokeRole", role: props.role, account: account as Address }
    : null;

  const grantPreview = grantAction ? buildPreview(grantAction, props.ctx) : null;
  const revokePreview = revokeAction ? buildPreview(revokeAction, props.ctx) : null;

  const { data: grantSim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "grantRole",
    args: accountAddr ? [roleHash, accountAddr] : undefined,
    query: { enabled: isConnected && grantPreview?.ok === true },
  });
  const { data: revokeSim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "revokeRole",
    args: accountAddr ? [roleHash, accountAddr] : undefined,
    query: { enabled: isConnected && revokePreview?.ok === true },
  });

  return (
    <section data-testid={`${slug}-role-form`}>
      <h2>{props.role} grant / revoke</h2>
      {props.description}
      <label>
        {props.role.replace("_ROLE", "")} account address
        <input
          data-testid={`${slug}-account-input`}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="0x..."
        />
      </label>
      <form
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (grantSim) writeContract(grantSim.request);
        }}
      >
        {grantPreview && (
          <div data-testid={`grant-${slug}-preview-wrap`}>
            <TxPreview preview={grantPreview} />
          </div>
        )}
        <button
          type="submit"
          data-testid={`grant-${slug}-submit`}
          disabled={!isConnected || !grantSim || isPending}
        >
          Sign grantRole({props.role}) with wallet
        </button>
      </form>
      <form
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (revokeSim) writeContract(revokeSim.request);
        }}
      >
        {revokePreview && (
          <div data-testid={`revoke-${slug}-preview-wrap`}>
            <TxPreview preview={revokePreview} />
          </div>
        )}
        <button
          type="submit"
          data-testid={`revoke-${slug}-submit`}
          disabled={!isConnected || !revokeSim || isPending}
        >
          Sign revokeRole({props.role}) with wallet
        </button>
      </form>
    </section>
  );
}
