/**
 * Entry point. Reads runtime config from `import.meta.env` and bootstraps
 * the wagmi provider + AdminFlow. Vite injects `VITE_*` env vars at
 * build time so feature-flag and RPC URL knobs are reproducible per
 * deployment artefact.
 *
 * Gateway bytecode hash verification (issue #207):
 *   VITE_GATEWAY_EXPECTED_CODE_HASH must be set to the keccak256 of
 *   the expected runtime bytecode. Missing or mismatched values render
 *   refusal previews and disable every admin write button.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { Address } from "viem";
import { AdminFlow } from "./components/AdminFlow";
import { makeConfig } from "./lib/wagmi";
import { useGatewayVerifier } from "./lib/useGatewayVerifier";

const env = import.meta.env as Record<string, string | undefined>;
const wagmiConfig = makeConfig(env);
const queryClient = new QueryClient();

const gateway = (env.VITE_GATEWAY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;
const vault = (env.VITE_VAULT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;
const expectedCodeHash = env.VITE_GATEWAY_EXPECTED_CODE_HASH;
const envClass = (env.VITE_ENV_CLASS as "fork" | "devnet" | "testnet" | "mainnet") ?? "fork";
// Test-only bypass: set VITE_GATEWAY_VERIFY_BYPASS_FOR_TEST=true in
// Playwright E2E builds to skip bytecode fetch and return verified state.
// Must never be set in production deployments.
const verifyBypassForTest = env.VITE_GATEWAY_VERIFY_BYPASS_FOR_TEST === "true";

/**
 * Inner bootstrap component that runs inside WagmiProvider so the
 * useGatewayVerifier hook has access to the wagmi context.
 */
function App() {
  const verificationState = useGatewayVerifier(gateway, expectedCodeHash, verifyBypassForTest);
  const gatewayCodeHashVerified = verificationState.status === "verified";

  return (
    <AdminFlow
      gatewayAddress={gateway}
      vaultAddress={vault}
      gatewayCodeHashVerified={gatewayCodeHashVerified}
      gatewayVerificationState={verificationState}
      envClass={envClass}
      flagEnv={env}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
