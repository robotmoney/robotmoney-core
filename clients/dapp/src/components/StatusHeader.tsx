/**
 * StatusHeader — protocol context shown above the Agents panel.
 * Always visible regardless of registration state. Live reads from
 * the gateway: paused state + USDC token address. Other addresses
 * come from build-time env (VITE_GATEWAY_ADDRESS, VITE_VAULT_ADDRESS).
 */
import { useState } from "react";
import { useAccount, useChainId, useDisconnect, useReadContract } from "wagmi";
import type { Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import { targetChainId } from "../lib/wagmi";
import { getInjectedProvider, syncDevnetChain } from "../lib/syncDevnetChain";

interface StatusHeaderProps {
  gatewayAddress: Address;
  vaultAddress: Address;
  envClass: "fork" | "devnet" | "testnet" | "mainnet";
}

export function StatusHeader(props: StatusHeaderProps) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();

  const { data: pausedData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "paused",
    query: { enabled: isConnected },
  });
  const paused = Boolean(pausedData);

  const { data: usdcAddressData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "usdc",
    query: { enabled: isConnected },
  });
  const usdcAddress = (usdcAddressData as Address | undefined) ?? "";

  const [networkSyncError, setNetworkSyncError] = useState<string | undefined>(undefined);
  const handleSwitchChain = () => {
    const provider = getInjectedProvider();
    if (!provider) {
      setNetworkSyncError("No injected wallet provider (window.ethereum is undefined).");
      return;
    }
    void syncDevnetChain(provider).then(setNetworkSyncError);
  };

  return (
    <section className="status-header" data-testid="status-header">
      <div className="hero">
        <h1>One USDC transfer. Diversified exposure.</h1>
        <p className="hero-sub">
          Authorize an agent to allocate USDC across the bucket portfolio on your behalf. One
          integration, not twenty.
        </p>
        {isConnected && (
          <div className="wallet-row" data-testid="wallet-row">
            <code data-testid="connected-address" className="wallet-address">
              {address}
            </code>
            {targetChainId !== undefined && chainId !== targetChainId && (
              <button type="button" data-testid="switch-chain" onClick={handleSwitchChain}>
                Switch to Robot Money devnet
              </button>
            )}
            <button type="button" data-testid="disconnect" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
        {networkSyncError && (
          <p data-testid="network-sync-error" className="unsafe-banner">
            <strong>Network setup error:</strong> {networkSyncError}
          </p>
        )}
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Chain</p>
          <p className="stat-value">{isConnected ? chainId : "—"}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Gateway</p>
          <p className="stat-value font-mono">{shortAddr(props.gatewayAddress)}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Vault</p>
          <p className="stat-value font-mono">{shortAddr(props.vaultAddress)}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">USDC</p>
          <p className="stat-value font-mono">{usdcAddress ? shortAddr(usdcAddress) : "—"}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Status</p>
          <p
            className="stat-value"
            data-testid="public-paused"
            style={{ color: paused ? "var(--color-warn)" : "var(--color-accent)" }}
          >
            {isConnected ? (paused ? "PAUSED" : "ACTIVE") : "—"}
          </p>
        </div>
      </div>
    </section>
  );
}

function shortAddr(a: string): string {
  if (!a || a === "0x0000000000000000000000000000000000000000") return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
