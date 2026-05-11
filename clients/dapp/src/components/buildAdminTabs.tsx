/** Factory for the AdminFlow tab list. Not a component — returns TabDef[]. */
import type { Dispatch, SetStateAction } from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import { ConfigExportPanel } from "./ConfigExportPanel";
import { HistoryPane } from "./HistoryPane";
import { PauseFlow } from "./PauseFlow";
import type { TabDef } from "./Tabs";
import type { PreviewContext } from "../lib/preview";
import { resolveExplorerApiUrl } from "../lib/explorerApi";
import type { VerificationState } from "../lib/useGatewayVerifier";
import { AuthorizeTab } from "./AuthorizeTab";
import { RevokeTab } from "./RevokeTab";
import { RotationTab } from "./RotationTab";
import { RoleTab } from "./RoleTab";
import { DepositWithdrawTab } from "./DepositWithdrawTab";

export type BuildAdminTabsArgs = Readonly<{
  gatewayAddress: Address;
  vaultAddress: Address;
  usdcAddress: Address;
  chainId: number;
  ctx: PreviewContext;
  gatewayVerificationState: VerificationState;
  flagEnv: Record<string, string | undefined>;
  historyPaneEnabled: boolean;
  agent: string;
  setAgent: Dispatch<SetStateAction<string>>;
  shareReceiver: string;
  setShareReceiver: Dispatch<SetStateAction<string>>;
  now: number;
}>;

export function buildAdminTabs(a: BuildAdminTabsArgs): TabDef[] {
  const validAgent = isAddress(a.agent);
  const validReceiver = isAddress(a.shareReceiver);

  const tabs: TabDef[] = [
    {
      id: "authorize",
      label: "Authorize",
      content: (
        <AuthorizeTab
          gatewayAddress={a.gatewayAddress}
          ctx={a.ctx}
          agent={a.agent}
          setAgent={a.setAgent}
          shareReceiver={a.shareReceiver}
          setShareReceiver={a.setShareReceiver}
          now={a.now}
        />
      ),
    },
  ];

  tabs.push(
    { id: "deposit-withdraw", label: "Deposit & Withdraw", content: <DepositWithdrawTab /> },
    {
      id: "pause",
      label: "Pause",
      content: (
        <PauseFlow
          gatewayAddress={a.gatewayAddress}
          gatewayCodeHashVerified={a.ctx.gatewayCodeHashVerified}
          envClass={a.ctx.envClass}
        />
      ),
    },
    {
      id: "revoke",
      label: "Revoke",
      content: <RevokeTab gatewayAddress={a.gatewayAddress} ctx={a.ctx} agent={a.agent} />,
    },
    {
      id: "rotation",
      label: "Rotation",
      content: <RotationTab gatewayAddress={a.gatewayAddress} ctx={a.ctx} now={a.now} />,
    },
    {
      id: "admin-role",
      label: "Admin Role",
      content: (
        <RoleTab
          role="ADMIN_ROLE"
          gatewayAddress={a.gatewayAddress}
          ctx={a.ctx}
          description={
            <p>
              Mutually exclusive with AGENT_ROLE and PAUSER_ROLE per
              <code> AccessRoles._grantRole</code>. Only DEFAULT_ADMIN_ROLE holders may grant.
            </p>
          }
        />
      ),
    },
    {
      id: "pauser-role",
      label: "Pauser Role",
      content: (
        <RoleTab
          role="PAUSER_ROLE"
          gatewayAddress={a.gatewayAddress}
          ctx={a.ctx}
          description={
            <p>
              PAUSER may call <code>pause()</code> only; <code>unpause()</code> requires ADMIN_ROLE.
              Mutually exclusive with AGENT_ROLE and ADMIN_ROLE on the same account.
            </p>
          }
        />
      ),
    },
  );

  if (a.historyPaneEnabled && validAgent) {
    tabs.push({
      id: "history",
      label: "History",
      content: <HistoryPane agent={a.agent as Address} apiUrl={resolveExplorerApiUrl(a.flagEnv)} />,
    });
  }

  if (validAgent && validReceiver) {
    const runtimeHash =
      a.gatewayVerificationState.status === "verified"
        ? a.gatewayVerificationState.computedHash
        : "";
    tabs.push({
      id: "export",
      label: "Export Config",
      content: (
        <ConfigExportPanel
          gateway={a.gatewayAddress}
          vault={a.vaultAddress}
          usdcAddress={a.usdcAddress}
          gatewayRuntimeHash={runtimeHash}
          chainId={a.chainId}
          agent={a.agent as Address}
        />
      ),
    });
  }

  return tabs;
}
