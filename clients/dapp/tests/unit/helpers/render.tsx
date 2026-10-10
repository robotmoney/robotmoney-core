/**
 * Custom RTL render that wraps the component under test in the providers
 * needed for wagmi hooks.
 *
 * In Vitest browser mode, vi.mock("wagmi", ...) only intercepts wagmi imports
 * inside the test file itself; component source files served by Vite's dev
 * server use the pre-bundled wagmi and receive real hook implementations.
 * Without a real WagmiProvider in the React tree those hooks throw
 * WagmiProviderNotFoundError.
 *
 * vi.importActual is used here to ensure this file always receives the
 * pre-bundled wagmi instance (same as what Vite serves to component source
 * files), even when the importing test file has vi.mock("wagmi", ...) active.
 * Module-level equality ensures WagmiContext identity matches.
 *
 * Usage — replace the RTL render import in component tests:
 *
 *   // Before:
 *   import { render, screen } from "@testing-library/react";
 *   // After:
 *   import { render, screen } from "../helpers/render";
 *
 * All other RTL exports are re-exported unchanged.
 */

import React from "react";
import { render as rtlRender, type RenderOptions, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export * from "@testing-library/react";

// vi.importActual bypasses any vi.mock("wagmi") registered in the test file so
// render.tsx always loads the same pre-bundled module instance that component
// source files use — same WagmiContext object, same React context identity.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
const { WagmiProvider, createConfig, http } = (await vi.importActual(
  "wagmi",
)) as typeof import("wagmi");
const { mock } = (await vi.importActual("wagmi/connectors")) as typeof import("wagmi/connectors");
const { defineChain } = (await vi.importActual("viem")) as typeof import("viem");
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

// The wagmi instance the COMPONENT SOURCE gets (a plain import). It is the same module as the one above in
// some runs and a second instance in others (Vitest browser mode serves the source its own optimized copy),
// and a provider from one instance is invisible to hooks of the other: `useAccount` throws
// WagmiProviderNotFoundError. Components that read real wagmi hooks (issue 1731: the write guard and the
// `depositsPaused()` reads) need the provider of THEIR instance, so it is nested inside the first when the two
// differ. A test file that vi.mock("wagmi") has no such provider (access throws) and gets only the first.
let SourceWagmiProvider: typeof WagmiProvider | undefined;
try {
  SourceWagmiProvider = ((await import("wagmi")) as typeof import("wagmi")).WagmiProvider;
} catch {
  SourceWagmiProvider = undefined;
}

const testChain = defineChain({
  id: 918453,
  name: "Test Devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:8545"] } },
});

const wagmiConfig = createConfig({
  chains: [testChain],
  connectors: [mock({ accounts: ["0x1111111111111111111111111111111111111111"] as const })],
  transports: { [testChain.id]: http() },
});

function TestProviders({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const inner =
    SourceWagmiProvider && SourceWagmiProvider !== WagmiProvider ? (
      <SourceWagmiProvider config={wagmiConfig}>{children}</SourceWagmiProvider>
    ) : (
      children
    );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>
    </WagmiProvider>
  );
}

export function render(ui: React.ReactElement, options?: RenderOptions): RenderResult {
  return rtlRender(ui, { wrapper: TestProviders, ...options });
}
