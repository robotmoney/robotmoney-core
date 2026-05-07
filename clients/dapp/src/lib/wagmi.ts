/**
 * wagmi/viem client setup. The dapp targets fork-anvil for E2E tests
 * and a real wallet (browser EIP-1193) for register-only flows. The
 * mock connector is wired up unconditionally so Playwright tests run
 * deterministically without prompting an extension.
 */
import { http, createConfig } from "wagmi";
import { foundry, mainnet, sepolia } from "wagmi/chains";
import { mock } from "wagmi/connectors";

// Single canonical fork-anvil test EOA (anvil's account[0]). Used only
// when VITE_USE_MOCK_WALLET=true.
const MOCK_PRIVATE_KEY_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

export function makeConfig(env: Record<string, string | undefined>) {
  const useMock = env.VITE_USE_MOCK_WALLET === "true";
  const rpcUrl = env.VITE_FORK_RPC_URL ?? "http://127.0.0.1:8545";
  return createConfig({
    chains: [foundry, sepolia, mainnet],
    connectors: useMock ? [mock({ accounts: [MOCK_PRIVATE_KEY_ACCOUNT] })] : [],
    transports: {
      [foundry.id]: http(rpcUrl),
      [sepolia.id]: http(),
      [mainnet.id]: http(),
    },
  });
}
