// Canonical: docs/architecture.md §5.3 — Human Dapp

/** Factory for the My Account tab list. Not a component — returns TabDef[]. */
import type { Dispatch, SetStateAction } from "react";
import type { Address } from "viem";
import type { TabDef } from "./Tabs";
import { Tabs } from "./Tabs";
import type { PreviewContext } from "../lib/preview";
import { AuthorizeTab } from "./AuthorizeTab";
import { RevokeTab } from "./RevokeTab";
import { RotationTab } from "./RotationTab";
import { RoleTab } from "./RoleTab";
import { DepositWithdrawTab } from "./DepositWithdrawTab";
import { FaucetTab } from "./FaucetTab";
import { PauseFlow } from "./PauseFlow";
import { HistoryPane } from "./HistoryPane";
import { ConfigExportPanel } from "./ConfigExportPanel";
import { classifyChain } from "../lib/chainClassifier";
import { readHarnessPrivateKey } from "../lib/faucetClient";

export type BuildAdminTabsArgs = Readonly<{
  gatewayAddress: Address;
  vaultAddress: Address;
  usdcAddress: Address;
  chainId: number;
  ctx: PreviewContext;
  flagEnv: Record<string, string | undefined>;
  agent: string;
  setAgent: Dispatch<SetStateAction<string>>;
  shareReceiver: string;
  setShareReceiver: Dispatch<SetStateAction<string>>;
  /**
   * Wallets shown in the testnet/devnet Faucet tab dropdown. Caller
   * passes the connected EOA list; empty on mainnet builds, which is
   * fine because the FaucetTab is never inserted there.
   */
  faucetWalletAddresses: ReadonlyArray<Address>;
  now: number;
  /** VaultRegistry address for the DestinationSelector (issue #320). Optional. */
  registryAddress?: Address;
  /** PortfolioRouter address for multi-vault deposits (issue #320). Optional. */
  routerAddress?: Address;
  /**
   * Explorer API base URL for the PositionSelector in the Deposit &
   * Withdraw tab (issue #321). When provided, the withdraw section lists
   * the user's non-zero vault positions via GET /v1/accounts/:addr/positions.
   */
  explorerApiUrl?: string;
  /**
   * RM token contract address (issue #365). When provided, the Faucet tab
   * renders a 'Get RM tokens' button so testnet users can self-serve
   * governance voting power.
   */
  rmTokenAddress?: Address;
  /**
   * keccak256(eth_getCode(gateway)) pinned at deploy time. Passed through to
   * ConfigExportPanel so the exported TOML carries the verified hash.
   * Defaults to an empty string when not yet verified.
   */
  gatewayRuntimeHash?: string;
}>;

export function buildAdminTabs(a: BuildAdminTabsArgs): TabDef[] {
  const tabs: TabDef[] = [
    {
      id: "agent-permissions",
      label: "Agent Permissions",
      content: (
        <Tabs
          testId="agent-permission-tabs"
          tabs={[
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
                      <code> AccessRoles._grantRole</code>. Only DEFAULT_ADMIN_ROLE holders may
                      grant.
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
                      PAUSER may call <code>pause()</code> only; <code>unpause()</code> requires
                      ADMIN_ROLE. Mutually exclusive with AGENT_ROLE and ADMIN_ROLE on the same
                      account.
                    </p>
                  }
                />
              ),
            },
          ]}
        />
      ),
    },
  ];

  tabs.push({
    id: "pause",
    label: "Pause / Unpause",
    content: (
      <PauseFlow
        gatewayAddress={a.gatewayAddress}
        gatewayCodeHashVerified={a.ctx.gatewayCodeHashVerified}
        envClass={a.ctx.envClass}
      />
    ),
  });

  // History tab — only when an explorer API URL and a plausible agent
  // address are provided. The agent address is user-supplied state so it
  // may be an empty string before the user types anything.
  if (a.explorerApiUrl && a.agent && a.agent.startsWith("0x")) {
    tabs.push({
      id: "history",
      label: "Deposit History",
      content: <HistoryPane agent={a.agent as Address} apiUrl={a.explorerApiUrl} />,
    });
  }

  // Export tab — renders the rmpc TOML config once the agent address is
  // known. Conditionally inserted so the tab is absent when the field is
  // empty (avoids a type-cast to an empty address).
  if (a.agent && a.agent.startsWith("0x")) {
    tabs.push({
      id: "export",
      label: "Export Config",
      content: (
        <ConfigExportPanel
          gateway={a.gatewayAddress}
          vault={a.vaultAddress}
          usdcAddress={a.usdcAddress}
          gatewayRuntimeHash={a.gatewayRuntimeHash ?? ""}
          chainId={a.chainId}
          agent={a.agent as Address}
        />
      ),
    });
  }

  tabs.push({
    id: "deposit-withdraw",
    label: "Deposit & Withdraw",
    content: (
      <DepositWithdrawTab
        vaultAddress={a.vaultAddress}
        usdcAddress={a.usdcAddress}
        ctx={{ ...a.ctx, vault: a.vaultAddress }}
        registryAddress={a.registryAddress}
        routerAddress={a.routerAddress}
        explorerApiUrl={a.explorerApiUrl}
      />
    ),
  });

  // Faucet tab — testnet/devnet only. Hard gate at insertion time so the
  // tab is absent from the DOM entirely on mainnet (issue #261 AC: "no
  // faucet UI component … reachable when the chain-ID classifier returns
  // `mainnet`"). Defence in depth: FaucetTab itself also fails closed when
  // the build-time harness key is missing.
  if (classifyChain(a.chainId) === "testnet") {
    tabs.push({
      id: "faucet",
      label: "Faucet",
      content: (
        <FaucetTab
          usdcAddress={a.usdcAddress}
          chainId={a.chainId}
          walletAddresses={a.faucetWalletAddresses}
          harnessPrivateKey={readHarnessPrivateKey(a.flagEnv)}
          rmTokenAddress={a.rmTokenAddress}
        />
      ),
    });
  }

  return tabs;
}
