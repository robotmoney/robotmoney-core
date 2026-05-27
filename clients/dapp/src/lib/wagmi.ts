// Canonical: docs/architecture.md §3 — Technology Stack

/**
 * wagmi/viem client setup. The dapp uses the browser-injected EIP-1193
 * provider (MetaMask, hardware bridges, etc.) as its only wallet
 * connector AND as its read transport for the foundry/devnet chain —
 * see `docs/technical/dapp-topology.md` §2 ("No dapp-owned RPC"). All
 * traffic for the chain the user is interacting with traverses an
 * endpoint the user chose, not one this bundle was built with.
 * Test harnesses inject `window.ethereum` themselves before the page
 * loads — no test-only branches in this file.
 */
import { unstable_connector, http, createConfig } from "wagmi";
import { foundry, mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

// Robot Money devnet (Geth+Lighthouse fork). Real prod-shaped chain id;
// not the same as foundry/anvil (31337). The dapp never makes its own
// HTTP requests to this URL — reads dispatch through the wallet
// provider per §2 of docs/technical/dapp-topology.md. The URL only
// exists so `wallet_addEthereumChain` (triggered by Connect Wallet)
// can prefill the network entry in the user's wallet. The user can
// always override before accepting.
const devnetRpcUrl = (import.meta.env.VITE_DEVNET_RPC_URL ?? "") as string;
const devnet = defineChain({
  id: 918453,
  name: "Robot Money devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: devnetRpcUrl ? [devnetRpcUrl] : [] } },
});

/**
 * Chain ID the dapp will ask the user's wallet to switch to after
 * Connect. `undefined` in builds where no `VITE_DEVNET_RPC_URL` was
 * baked in (i.e. mainnet / Base operator builds) — in those, the user
 * is expected to already be on the right chain and Connect does no
 * automatic switching.
 */
export const targetChainId: number | undefined = devnetRpcUrl ? devnet.id : undefined;

/**
 * RPC URL the dapp asks the user's wallet to associate with
 * `targetChainId`. Used by the Connect Wallet flow to call
 * `wallet_addEthereumChain` every time, which is the only way to keep
 * the wallet's stored RPC URL in sync with ephemeral tunnel URLs that
 * rotate across smoke-test sessions. The dapp never fetches from this
 * URL itself — the wallet does, after the user accepts the prompt.
 */
export const targetRpcUrl: string | undefined = devnetRpcUrl || undefined;

export function makeConfig(_env: Record<string, string | undefined>) {
  return createConfig({
    chains: [devnet, foundry, sepolia, mainnet],
    connectors: [injected()],
    transports: {
      [devnet.id]: unstable_connector(injected),
      [foundry.id]: unstable_connector(injected),
      [sepolia.id]: http(),
      [mainnet.id]: http(),
    },
  });
}
