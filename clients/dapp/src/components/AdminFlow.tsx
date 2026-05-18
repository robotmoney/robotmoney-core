/**
 * AdminFlow — orchestrates the wallet-scoped My Account tabs.
 */
import { useState } from "react";
import { useAccount, useChainId, useDisconnect, useReadContract } from "wagmi";
import type { Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import type { PreviewContext } from "../lib/preview";
import { Tabs } from "./Tabs";
import type { VerificationState } from "../lib/useGatewayVerifier";
import { buildAdminTabs } from "./buildAdminTabs";
import { resolveExplorerApiUrl } from "../lib/explorerApi";

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
  /** RM token address — forwarded to the Faucet tab (issue #365). */
  rmTokenAddress?: Address;
}>;

export function AdminFlow(props: Props) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
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
    flagEnv: props.flagEnv,
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
    // PositionSelector in the Deposit & Withdraw tab fetches positions
    // from the explorer API (issue #321).
    explorerApiUrl: resolveExplorerApiUrl(props.flagEnv),
    rmTokenAddress: props.rmTokenAddress,
    gatewayRuntimeHash:
      gatewayVerificationState.status === "verified"
        ? gatewayVerificationState.computedHash
        : undefined,
  });

  return (
    <main className="admin-flow" data-testid="my-account-panel">
      <div className="account-panel-header">
        <div>
          <h2>My Account</h2>
          <p className="hint">
            Manage wallet-scoped permissions, deposits, withdrawals, and faucet access.
          </p>
        </div>
        {isConnected && (
          <div className="account-wallet-controls" data-testid="account-wallet-controls">
            <code className="wallet-address" data-testid="my-account-address">
              {address}
            </code>
            <button type="button" data-testid="my-account-disconnect" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {gatewayVerificationState.status === "verified" && (
        <p data-testid="gateway-verification-ok" className="verification-ok">
          Gateway bytecode verified:{" "}
          <code>{`0x${props.gatewayAddress.slice(2, 6)}…${props.gatewayAddress.slice(-4)}`}</code>{" "}
          <code>{gatewayVerificationState.computedHash}</code>
        </p>
      )}

      <Tabs tabs={tabs} defaultTabId="agent-permissions" />
    </main>
  );
}
