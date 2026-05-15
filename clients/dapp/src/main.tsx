/**
 * Entry point. Reads runtime config from `import.meta.env` and bootstraps
 * the wagmi provider. Renders the brand nav, a always-on status header,
 * the protocol-layer (no wallet required), and the per-user Agents panel.
 */
import "./styles.css";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { Address } from "viem";
import { AgentsPanel } from "./components/AgentsPanel";
import { NavBar } from "./components/NavBar";
import { StatusHeader } from "./components/StatusHeader";
import { TestnetBanner } from "./components/TestnetBanner";
import { VerificationBanner } from "./components/VerificationBanner";
import { VaultList } from "./components/VaultList";
import { VaultDetail } from "./components/VaultDetail";
import { RouterView } from "./components/RouterView";
import { ProtocolStats } from "./components/ProtocolStats";
import { makeConfig } from "./lib/wagmi";
import { useGatewayVerifier } from "./lib/useGatewayVerifier";
import { resolveExplorerApiUrl } from "./lib/explorerApi";

const env = import.meta.env as Record<string, string | undefined>;
const wagmiConfig = makeConfig(env);
const queryClient = new QueryClient();

const gateway = (env.VITE_GATEWAY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;
const vault = (env.VITE_VAULT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;
const expectedCodeHash = env.VITE_GATEWAY_EXPECTED_CODE_HASH;
const envClass = (env.VITE_ENV_CLASS as "fork" | "devnet" | "testnet" | "mainnet") ?? "fork";
const explorerApiUrl = resolveExplorerApiUrl(env);

function App() {
  const { state: verificationState, refresh: verificationRefresh } = useGatewayVerifier(
    gateway,
    expectedCodeHash,
  );
  const [selectedVault, setSelectedVault] = useState<string | null>(null);

  return (
    <>
      <TestnetBanner
        envClass={envClass}
        forkTimestamp={env.VITE_FORK_BLOCK_TIMESTAMP}
        forkBlock={env.VITE_FORK_BLOCK_NUMBER}
      />
      <NavBar />
      <VerificationBanner state={verificationState} refresh={verificationRefresh} />
      {/* Protocol layer — works without a connected wallet (issue #318). */}
      <ProtocolStats apiUrl={explorerApiUrl} />
      {selectedVault != null ? (
        <VaultDetail
          apiUrl={explorerApiUrl}
          address={selectedVault}
          onBack={() => setSelectedVault(null)}
        />
      ) : (
        <VaultList apiUrl={explorerApiUrl} onSelectVault={setSelectedVault} />
      )}
      <RouterView apiUrl={explorerApiUrl} />
      {/* Account / action layer — requires a connected wallet. */}
      <StatusHeader gatewayAddress={gateway} vaultAddress={vault} envClass={envClass} />
      <AgentsPanel
        gatewayAddress={gateway}
        vaultAddress={vault}
        gatewayVerificationState={verificationState}
        envClass={envClass}
        flagEnv={env}
        // eslint-disable-next-line no-restricted-syntax -- boundary: real clock injected here.
        now={Date.now()}
      />
    </>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing from index.html");
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
