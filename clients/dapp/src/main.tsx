// Canonical: docs/architecture.md §5.3 — Human Dapp (Vite entry point)

/**
 * Entry point. Reads runtime config from `import.meta.env` and bootstraps
 * the wagmi provider. Renders the brand nav, the public landing header,
 * the protocol-layer (no wallet required), the per-user Agents panel,
 * the account-layer inspector, and either the main app or the /debug
 * full-page developer view depending on the current URL path.
 *
 * An About modal is accessible from the NavBar About button and provides
 * version, commit SHA, environment, and a link to /debug.
 *
 * The global error capture module is installed before React renders so that
 * all errors and warnings are captured from startup.
 *
 * VaultRegistryContext (issue #417) is mounted here as a shared
 * data-fetching seam so all downstream components receive vault metadata
 * from a single batched registry read rather than N independent chain
 * reads. See docs/technical/multi-vault-dapp-decisions.md §4.1. (The
 * router side of that seam, RouterContext, was removed in issue #1281:
 * it had zero consumers and issued a reverting read for a selector no
 * Solidity source defines; RouterDepositTab reads the router directly.)
 *
 * ExplorerProvider (ExplorerContext) is mounted here as the single polling
 * loop for the explorer API (/v1/vaults and /v1/stats). All components that
 * display TVL, stats, or block freshness consume useExplorer() instead of
 * issuing independent fetches — ensuring they always reflect the same
 * indexed block_number with no mixed-block state across components.
 */
import "./styles.css";
import React, { useEffect, useState } from "react";
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
import { AboutModal } from "./components/AboutModal";
import { DebugPage } from "./components/DebugPage";
import { VaultCards } from "./components/VaultCards";
import { LandingPriceStrip } from "./components/LandingPriceStrip";
import { BalancesPanel } from "./components/BalancesPanel";
import { Tabs } from "./components/Tabs";
import { GovernancePanel } from "./components/GovernancePanel";
import { ConsensusReceiptPanel } from "./components/ConsensusReceiptPanel";
import { parseVaultAddressMap } from "./lib/consensusReceiptApi";
import { makeConfig } from "./lib/wagmi";
import { useGatewayVerifier } from "./lib/useGatewayVerifier";
import { resolveExplorerApiUrl } from "./lib/explorerApi";
import { initErrorCapture } from "./lib/error-capture";
import { VaultRegistryProvider } from "./lib/VaultRegistryContext";
import { ExplorerProvider } from "./lib/ExplorerContext";

// Install global error capture before React renders so startup errors are
// included in the /debug feed.
initErrorCapture();

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
// Issue #647: TimelockController address for the Timelock admin tab (architecture §4.5).
const timelock = env.VITE_TIMELOCK_ADDRESS ? (env.VITE_TIMELOCK_ADDRESS as Address) : undefined;
// Issue #365: RM token address for the Faucet tab drip button. Zero address
// default means the button is hidden in standalone builds without the smoke-test harness.
const rmToken = env.VITE_RM_TOKEN_ADDRESS ? (env.VITE_RM_TOKEN_ADDRESS as Address) : undefined;
const expectedCodeHash = env.VITE_GATEWAY_EXPECTED_CODE_HASH;
const envClass = (env.VITE_ENV_CLASS as "fork" | "devnet" | "testnet" | "mainnet") ?? "fork";
const explorerApiUrl = resolveExplorerApiUrl(env);
// Issue #1247 task 4.14: the per-deployment vault-symbol map that
// tests/fixtures/consensus-receipt.bucket-vault-map.json requires in order to
// say whether a recommendation was applied. When it is absent or incomplete the
// deployment is not receipt-capable for that comparison, and the surface says
// "cannot determine" rather than substituting a global or zero address.
const vaultAddressBySymbol = parseVaultAddressMap(env.VITE_VAULT_ADDRESSES);

function App() {
  const { state: verificationState, refresh: verificationRefresh } = useGatewayVerifier(
    gateway,
    expectedCodeHash,
  );
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState("my-account");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const { address: connectedAddress } = useAccount();

  // Listen for navigation so the /debug route works with browser back/forward.
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const isDebugRoute = currentPath === "/debug";

  if (isDebugRoute) {
    return (
      <>
        <TestnetBanner
          envClass={envClass}
          forkTimestamp={env.VITE_FORK_BLOCK_TIMESTAMP}
          forkBlock={env.VITE_FORK_BLOCK_NUMBER}
        />
        <NavBar aboutOpen={aboutOpen} onToggleAbout={() => setAboutOpen((open) => !open)} />
        <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} envClass={envClass} />
        <DebugPage
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
      </>
    );
  }

  return (
    <>
      <TestnetBanner
        envClass={envClass}
        forkTimestamp={env.VITE_FORK_BLOCK_TIMESTAMP}
        forkBlock={env.VITE_FORK_BLOCK_NUMBER}
      />
      <NavBar aboutOpen={aboutOpen} onToggleAbout={() => setAboutOpen((open) => !open)} />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} envClass={envClass} />
      <StatusHeader />
      <VerificationBanner state={verificationState} refresh={verificationRefresh} />
      <main className="dapp-shell">
        <div className="landing-overview">
          <ProtocolStats />
          <LandingPriceStrip />
          <VaultCards
            onSelectVault={setSelectedVault}
            onSwitchToExplorer={() => setActiveTabId("portfolio-explorer")}
          />
          <BalancesPanel gatewayAddress={gateway} rmTokenAddress={rmToken} />
        </div>

        <Tabs
          testId="dapp-surface-tabs"
          activeTabId={activeTabId}
          onTabChange={setActiveTabId}
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
                  rmTokenAddress={rmToken}
                  timelockAddress={timelock}
                />
              ),
            },
            {
              id: "router-governance",
              label: "Router Governance",
              content: (
                <div className="tab-section-stack">
                  <RouterView apiUrl={explorerApiUrl} />
                  {governance ? (
                    <GovernancePanel governanceAddress={governance} apiUrl={explorerApiUrl} />
                  ) : (
                    <section data-testid="governance-config-missing">
                      <h2>Governance — Weight Proposals</h2>
                      <p className="hint">
                        Router governance voting is unavailable until the governance contract
                        address is configured.
                      </p>
                    </section>
                  )}
                </div>
              ),
            },
            {
              id: "consensus-receipts",
              label: "Consensus Receipts",
              content: (
                <div className="tab-section-stack">
                  <ConsensusReceiptPanel
                    explorerApiUrl={explorerApiUrl}
                    vaultAddressBySymbol={vaultAddressBySymbol}
                  />
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
                    <VaultList onSelectVault={setSelectedVault} />
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

// Wrap App with ExplorerProvider (single polling loop for /v1/vaults and
// /v1/stats) and VaultRegistryProvider when the registry address is
// configured. VaultRegistryProvider is a no-op when its address is missing
// (e.g. single-vault deployments). docs/technical/multi-vault-dapp-decisions.md
// §4.1.
const appWithChainProviders = registry ? (
  <VaultRegistryProvider registryAddress={registry}>
    <App />
  </VaultRegistryProvider>
) : (
  <App />
);

const appWithProviders = (
  <ExplorerProvider apiUrl={explorerApiUrl}>{appWithChainProviders}</ExplorerProvider>
);

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{appWithProviders}</QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
