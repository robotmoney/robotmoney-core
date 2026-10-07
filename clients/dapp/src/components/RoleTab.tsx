// Canonical: docs/architecture.md §6.2 — Custody (see also §6.3 Role Separation)
// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (2026-10-06 amendment)

/**
 * RoleTab — ADMIN_ROLE / DEPOSIT_PAUSER_ROLE grant + revoke preview.
 *
 * Both roles are administered by DEFAULT_ADMIN_ROLE. After the timelock
 * handover only the TimelockController holds it, on every chain, so a
 * browser wallet cannot sign these calls: the gateway would revert. The tab
 * still renders the full structured preview, keeps the submit buttons
 * disabled, and states why (`${slug}-role-wallet-refusal`). The real change
 * goes through the Safe -> Timelock.
 */
import { useState, type FormEvent } from "react";
import { useAccount, useReadContract, useSimulateContract, useWriteContract } from "wagmi";
import { isAddress, type Address } from "viem";
import { DEFAULT_ADMIN_ROLE_HASH, gatewayAbi, ROLE_HASH, type RoleName } from "../lib/abi";
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
  DEPOSIT_PAUSER_ROLE: "pauser",
};

export function RoleTab(props: Props) {
  const { address, isConnected } = useAccount();
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

  // DEFAULT_ADMIN_ROLE is the admin role of both ADMIN_ROLE and DEPOSIT_PAUSER_ROLE
  // on the gateway. Only a settled `false` shows the refusal, so a pending
  // read never flashes it.
  const { data: hasRoleAdmin } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "hasRole",
    args: address ? [DEFAULT_ADMIN_ROLE_HASH, address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });
  const walletLacksRoleAdmin = isConnected && hasRoleAdmin === false;

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
      {walletLacksRoleAdmin && (
        <p data-testid={`${slug}-role-wallet-refusal`} className="error">
          Connected wallet lacks DEFAULT_ADMIN_ROLE, the admin of {props.role}, so the gateway would
          revert this call. After the timelock handover admin actions go through the Safe
          {" -> "}Timelock, not a browser wallet.
        </p>
      )}
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
          disabled={!isConnected || walletLacksRoleAdmin || !grantSim || isPending}
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
          disabled={!isConnected || walletLacksRoleAdmin || !revokeSim || isPending}
        >
          Sign revokeRole({props.role}) with wallet
        </button>
      </form>
    </section>
  );
}
