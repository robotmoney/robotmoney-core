// Canonical: docs/architecture.md §6.2 — Custody (see also §6.3 Role Separation)

/**
 * AdminFlow — orchestrates the wallet-scoped My Account tabs.
 */
import { useMemo, useState } from "react";
import { useAccount, useChainId, useDisconnect, useReadContract } from "wagmi";
import type { Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import type { PreviewContext } from "../lib/preview";
import { Tabs } from "./Tabs";
import type { VerificationState } from "../lib/useGatewayVerifier";
import { buildAdminTabs } from "./buildAdminTabs";
import { resolveExplorerApiUrl } from "../lib/explorerApi";
import { useCodeTargetVerification } from "../lib/useVerifiedCodeTargets";
import { describeVerificationCause } from "../lib/gatewayVerifier";
import { useUpgradeState } from "../lib/useUpgradeState";
import { useRuntimeConfig } from "../lib/RuntimeConfigContext";
import { parseImplementationPinMap } from "../lib/codePins";

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
  /**
   * TimelockController address (issue #647 / architecture §4.5).
   * Forwarded to buildAdminTabs → TimelockPanel. When absent the panel
   * renders its config-missing state rather than being hidden.
   */
  timelockAddress?: Address;
  /** The Safe that proposes to the timelock (core 1544). Forwarded to the admin tabs. */
  safeAddress?: Address;
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
  // Vaults and the router whose code and implementation matched their build-time pins (QA plan
  // U5, ADR-0014). Their previews badge the target "[bytecode verified]" only when they are in
  // `verified`; a router in `refused` is not offered a share approval.
  const { verified: verifiedTargets, refused: refusedTargets } = useCodeTargetVerification();
  const ctx: PreviewContext = {
    gateway: props.gatewayAddress,
    gatewayCodeHashVerified: gatewayVerificationState.status === "verified",
    envClass: props.envClass,
    verifiedTargets,
    refusedTargets,
    // A vault or router preview refused on the gateway names the gateway's actual cause.
    gatewayRefusalDetail:
      gatewayVerificationState.status === "refused"
        ? describeVerificationCause(gatewayVerificationState.cause)
        : gatewayVerificationState.status === "verified"
          ? undefined
          : "The gateway's code has not been verified yet.",
  };

  // QA plan P3, issue 1810: the implementation behind a proxied gateway, for the rmpc export's
  // pin. The verifier sets it only when the live implementation is one of this build's reviewed
  // pins (VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH), so the export never pins whatever happens to
  // be live (no trust on first use).
  const gatewayImplementationHash =
    gatewayVerificationState.status === "verified"
      ? gatewayVerificationState.implementationHash
      : undefined;
  // The vaults and the router are proxies too: rmpc then needs `proxy_implementation_hashes`. The
  // export takes the reviewed implementation hashes this build pins for them (ADR-0014), never the
  // live ones. Without such pins it names the key and the release-record fields to copy.
  const vaultUpgrade = useUpgradeState(props.vaultAddress);
  const runtimeEnv = useRuntimeConfig();
  const proxyImplementationHashes = useMemo(() => {
    const gateway = props.gatewayAddress.toLowerCase();
    const hashes = new Set<string>();
    for (const [address, list] of parseImplementationPinMap(runtimeEnv)) {
      if (address !== gateway) list.forEach((h) => hashes.add(h));
    }
    return [...hashes];
  }, [runtimeEnv, props.gatewayAddress]);

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
    walletAddress: address,
    now: props.now,
    registryAddress: props.registryAddress,
    routerAddress: props.routerAddress,
    // PositionSelector in the Deposit & Withdraw tab fetches positions
    // from the explorer API (issue #321).
    explorerApiUrl: resolveExplorerApiUrl(props.flagEnv),
    timelockAddress: props.timelockAddress,
    safeAddress: props.safeAddress,
    gatewayRuntimeHash:
      gatewayVerificationState.status === "verified"
        ? gatewayVerificationState.computedHash
        : undefined,
    gatewayImplementationHash,
    vaultIsProxy: vaultUpgrade.kind === "proxy" || vaultUpgrade.kind === "indexed",
    proxyImplementationHashes,
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
