// Canonical: docs/architecture.md §6.2 — Custody (see also §6.3 Role Separation)
// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (2026-10-07 amendment)

/**
 * RoleTab — ADMIN_ROLE / DEPOSIT_PAUSER_ROLE grant + revoke proposals.
 *
 * Both roles are administered by DEFAULT_ADMIN_ROLE. After the timelock
 * handover only the TimelockController holds it, on every chain, so a browser
 * wallet cannot call these functions on the gateway. The tab renders the full
 * structured preview and the button reads "Create Safe proposal": the dapp
 * builds `timelock.schedule(gateway, 0, grantRole|revokeRole(...), ...)` as a
 * SafeTx and asks the connected Safe owner to sign its typed data
 * (`SafeProposalPanel`). No direct wallet transaction is offered.
 */
import { useState } from "react";
import { isAddress, type Address } from "viem";
import type { RoleName } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { SafeProposalPanel } from "./SafeProposalPanel";
import { TxPreview } from "./TxPreview";

type Props = Readonly<{
  role: RoleName;
  gatewayAddress: Address;
  ctx: PreviewContext;
  /** Safe that proposes to the timelock. Absent: the proposal is blocked, no button. */
  safeAddress?: Address;
  timelockAddress?: Address;
  /** Inline note shown under the heading. */
  description: React.ReactNode;
}>;

const SLUG: Record<RoleName, string> = {
  ADMIN_ROLE: "admin",
  DEPOSIT_PAUSER_ROLE: "pauser",
};

export function RoleTab(props: Props) {
  const [account, setAccount] = useState("");

  const slug = SLUG[props.role];
  const valid = isAddress(account);

  const grantAction: AdminAction | null = valid
    ? { kind: "grantRole", role: props.role, account: account as Address }
    : null;
  const revokeAction: AdminAction | null = valid
    ? { kind: "revokeRole", role: props.role, account: account as Address }
    : null;

  const grantPreview = grantAction ? buildPreview(grantAction, props.ctx) : null;
  const revokePreview = revokeAction ? buildPreview(revokeAction, props.ctx) : null;

  return (
    <section data-testid={`${slug}-role-form`}>
      <h2>{props.role} grant / revoke</h2>
      {props.description}
      <p className="hint" data-testid={`${slug}-role-safe-note`}>
        After the timelock handover these changes go through the Safe {" -> "} Timelock. The button
        below builds the proposal for a Safe owner to sign. It does not send a transaction.
      </p>
      <label>
        {props.role.replace("_ROLE", "")} account address
        <input
          data-testid={`${slug}-account-input`}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="0x..."
        />
      </label>
      <div>
        {grantPreview && (
          <div data-testid={`grant-${slug}-preview-wrap`}>
            <TxPreview preview={grantPreview} />
          </div>
        )}
        {grantPreview?.ok && (
          <SafeProposalPanel
            testId={`grant-${slug}`}
            safeAddress={props.safeAddress}
            timelockAddress={props.timelockAddress}
            request={{
              kind: "schedule",
              target: props.gatewayAddress,
              data: grantPreview.calldata,
              action: "schedule",
              description: `grantRole(${props.role}, ${account}) on ${props.gatewayAddress}`,
            }}
          />
        )}
      </div>
      <div>
        {revokePreview && (
          <div data-testid={`revoke-${slug}-preview-wrap`}>
            <TxPreview preview={revokePreview} />
          </div>
        )}
        {revokePreview?.ok && (
          <SafeProposalPanel
            testId={`revoke-${slug}`}
            safeAddress={props.safeAddress}
            timelockAddress={props.timelockAddress}
            request={{
              kind: "schedule",
              target: props.gatewayAddress,
              data: revokePreview.calldata,
              action: "schedule",
              description: `revokeRole(${props.role}, ${account}) on ${props.gatewayAddress}`,
            }}
          />
        )}
      </div>
    </section>
  );
}
