/**
 * wagmi/viem client setup. The dapp uses the browser-injected EIP-1193
 * provider (MetaMask, hardware bridges, etc.) as its only wallet
 * connector. Test harnesses inject `window.ethereum` themselves before
 * the page loads — no test-only branches in this file.
 */
import { http, createConfig } from "wagmi";
import { foundry, mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export function makeConfig(env: Record<string, string | undefined>) {
  const rpcUrl = env.VITE_FORK_RPC_URL ?? "http://127.0.0.1:8545";
  return createConfig({
    chains: [foundry, sepolia, mainnet],
    connectors: [injected()],
    transports: {
      [foundry.id]: http(rpcUrl),
      [sepolia.id]: http(),
      [mainnet.id]: http(),
    },
  });
}
