/**
 * AdminFlow — orchestrates the agent-management tabs. Each tab owns
 * its wallet hooks and preview pipeline; this component routes shared
 * state (agent address, share receiver) between tabs that reference
 * them and delegates tab assembly to `buildAdminTabs`.
 */
import { useState } from "react";
import { useAccount, useChainId, useReadContract } from "wagmi";
import type { Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import type { PreviewContext } from "../lib/preview";
import { Tabs } from "./Tabs";
import { resolveFlags } from "../lib/featureFlags";
import type { VerificationState } from "../lib/useGatewayVerifier";
import { buildAdminTabs } from "./buildAdminTabs";

type Props = Readonly<{
  gatewayAddress: Address;
  vaultAddress: Address;
  gatewayVerificationState: VerificationState;
  envClass: PreviewContext["envClass"];
  flagEnv: Record<string, string | undefined>;
  /** Wall-clock ms at mount, injected so render stays deterministic. */
  now: number;
  /** VaultRegistry address — forwarded to the Deposit & Withdraw tab (issue #320). */
  registryAddress?: Address;
  /** PortfolioRouter address — forwarded to the Deposit & Withdraw tab (issue #320). */
  routerAddress?: Address;
}>;

export function AdminFlow(props: Props) {
  const flags = resolveFlags(props.flagEnv);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const { data: usdcAddressData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "usdc",
    query: { enabled: isConnected },
  });
  const usdcAddress = (usdcAddressData as Address | undefined) ?? ("" as Address);

  // Shared between AuthorizeTab (input), RevokeTab (read-only), History,
  // and Export tabs — RevokeTab intentionally has no input of its own.
  const [agent, setAgent] = useState("");
  const [shareReceiver, setShareReceiver] = useState("");

  const { gatewayVerificationState } = props;
  const ctx: PreviewContext = {
    gateway: props.gatewayAddress,
    gatewayCodeHashVerified: gatewayVerificationState.status === "verified",
    envClass: props.envClass,
  };

  const tabs = buildAdminTabs({
    gatewayAddress: props.gatewayAddress,
    vaultAddress: props.vaultAddress,
    usdcAddress,
    chainId,
    ctx,
    gatewayVerificationState,
    flagEnv: props.flagEnv,
    historyPaneEnabled: flags.historyPane,
    agent,
    setAgent,
    shareReceiver,
    setShareReceiver,
    // Today the dapp only knows the single connected EOA; once
    // multi-wallet onboarding lands we widen this list. The Faucet tab
    // gracefully renders "(no wallets connected)" when empty.
    faucetWalletAddresses: address ? [address] : [],
    now: props.now,
    registryAddress: props.registryAddress,
    routerAddress: props.routerAddress,
  });

  return (
    <main className="admin-flow">
      <h1>Agents</h1>

      {gatewayVerificationState.status === "verified" && (
        <p data-testid="gateway-verification-ok" className="verification-ok">
          Gateway bytecode verified: <code>{gatewayVerificationState.computedHash}</code>
        </p>
      )}

      <Tabs tabs={tabs} />
    </main>
  );
}
