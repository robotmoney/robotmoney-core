/**
 * Entry point. Reads runtime config from `import.meta.env` and bootstraps
 * the wagmi provider. Renders the brand nav, the public landing header,
 * the protocol-layer (no wallet required), the per-user Agents panel,
 * the account-layer inspector (issue #319), and the debug observability
 * drawer for engineering diagnostics.
 */
import "./styles.css";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount } from "wagmi";
import type { Address } from "viem";
import { AgentsPanel } from "./components/AgentsPanel";
import { AccountLayerView } from "./components/AccountLayerView";
import { NavBar } from "./components/NavBar";
import { StatusHeader } from "./components/StatusHeader";
import { TestnetBanner } from "./components/TestnetBanner";
import { VerificationBanner } from "./components/VerificationBanner";
import { VaultList } from "./components/VaultList";
import { VaultDetail } from "./components/VaultDetail";
import { RouterView } from "./components/RouterView";
import { ProtocolStats } from "./components/ProtocolStats";
import { DebugPanel } from "./components/DebugPanel";
import { VaultCards } from "./components/VaultCards";
import { Tabs } from "./components/Tabs";
import { GovernancePanel } from "./components/GovernancePanel";
import { makeConfig } from "./lib/wagmi";
import { useGatewayVerifier } from "./lib/useGatewayVerifier";
import { resolveExplorerApiUrl } from "./lib/explorerApi";

const env = import.meta.env as Record<string, string | undefined>;
const wagmiConfig = makeConfig(env);
const queryClient = new QueryClient();

const gateway = (env.VITE_GATEWAY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;
const vault = (env.VITE_VAULT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;
const registry = env.VITE_REGISTRY_ADDRESS ? (env.VITE_REGISTRY_ADDRESS as Address) : undefined;
const router = env.VITE_ROUTER_ADDRESS ? (env.VITE_ROUTER_ADDRESS as Address) : undefined;
const governance = env.VITE_GOVERNANCE_ADDRESS
  ? (env.VITE_GOVERNANCE_ADDRESS as Address)
  : undefined;
const rmToken = env.VITE_RM_TOKEN_ADDRESS ? (env.VITE_RM_TOKEN_ADDRESS as Address) : undefined;
const expectedCodeHash = env.VITE_GATEWAY_EXPECTED_CODE_HASH;
const envClass = (env.VITE_ENV_CLASS as "fork" | "devnet" | "testnet" | "mainnet") ?? "fork";
const explorerApiUrl = resolveExplorerApiUrl(env);

function App() {
  const { state: verificationState, refresh: verificationRefresh } = useGatewayVerifier(
    gateway,
    expectedCodeHash,
  );
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const { address: connectedAddress } = useAccount();

  return (
    <>
      <TestnetBanner
        envClass={envClass}
        forkTimestamp={env.VITE_FORK_BLOCK_TIMESTAMP}
        forkBlock={env.VITE_FORK_BLOCK_NUMBER}
      />
      <NavBar debugOpen={debugOpen} onToggleDebug={() => setDebugOpen((open) => !open)} />
      <DebugPanel
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        gatewayAddress={gateway}
        vaultAddress={vault}
        registryAddress={registry}
        routerAddress={router}
        envClass={envClass}
        explorerApiUrl={explorerApiUrl}
        expectedCodeHash={expectedCodeHash}
        forkTimestamp={env.VITE_FORK_BLOCK_TIMESTAMP}
        forkBlock={env.VITE_FORK_BLOCK_NUMBER}
        verificationState={verificationState}
      />
      <StatusHeader />
      <VerificationBanner state={verificationState} refresh={verificationRefresh} />
      <main className="dapp-shell">
        <div className="landing-overview">
          <ProtocolStats apiUrl={explorerApiUrl} />
          <VaultCards apiUrl={explorerApiUrl} />
        </div>

        <Tabs
          testId="dapp-surface-tabs"
          defaultTabId="my-account"
          tabs={[
            {
              id: "my-account",
              label: "My Account",
              content: (
                <AgentsPanel
                  gatewayAddress={gateway}
                  vaultAddress={vault}
                  gatewayVerificationState={verificationState}
                  envClass={envClass}
                  flagEnv={env}
                  // eslint-disable-next-line no-restricted-syntax -- boundary: real clock injected here.
                  now={Date.now()}
                  registryAddress={registry}
                  routerAddress={router}
                />
              ),
            },
            {
              id: "router-governance",
              label: "Router Governance",
              content: (
                <div className="tab-section-stack">
                  <RouterView apiUrl={explorerApiUrl} />
                  {governance && rmToken ? (
                    <GovernancePanel
                      governanceAddress={governance}
                      rmTokenAddress={rmToken}
                      apiUrl={explorerApiUrl}
                    />
                  ) : (
                    <section data-testid="governance-config-missing">
                      <h2>Governance — Weight Proposals</h2>
                      <p className="hint">
                        Router governance voting is unavailable until governance and RM-token
                        contract addresses are configured.
                      </p>
                    </section>
                  )}
                </div>
              ),
            },
            {
              id: "portfolio-explorer",
              label: "Portfolio Explorer",
              content: (
                <div className="tab-section-stack">
                  {selectedVault != null ? (
                    <VaultDetail
                      apiUrl={explorerApiUrl}
                      address={selectedVault}
                      onBack={() => setSelectedVault(null)}
                    />
                  ) : (
                    <VaultList apiUrl={explorerApiUrl} onSelectVault={setSelectedVault} />
                  )}
                  <AccountLayerView
                    apiUrl={explorerApiUrl}
                    connectedAddress={connectedAddress as Address | undefined}
                  />
                </div>
              ),
            },
          ]}
        />
      </main>
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
