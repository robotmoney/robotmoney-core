/**
 * Entry point. Reads runtime config from `import.meta.env` and bootstraps
 * the wagmi provider + AdminFlow. Vite injects `VITE_*` env vars at
 * build time so feature-flag and RPC URL knobs are reproducible per
 * deployment artefact.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { Address } from "viem";
import { AdminFlow } from "./components/AdminFlow";
import { makeConfig } from "./lib/wagmi";

const env = import.meta.env as Record<string, string | undefined>;
const wagmiConfig = makeConfig(env);
const queryClient = new QueryClient();

const gateway = (env.VITE_GATEWAY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;
const vault = (env.VITE_VAULT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;
const codeHashVerified = env.VITE_GATEWAY_CODE_HASH_VERIFIED !== "false";
const envClass = (env.VITE_ENV_CLASS as "fork" | "devnet" | "testnet" | "mainnet") ?? "fork";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AdminFlow
          gatewayAddress={gateway}
          vaultAddress={vault}
          gatewayCodeHashVerified={codeHashVerified}
          envClass={envClass}
          flagEnv={env}
        />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
