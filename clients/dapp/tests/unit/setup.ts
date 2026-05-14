import "@testing-library/jest-dom/vitest";
import { mock } from "wagmi";

// Seed the Vitest environment with wagmi's mock connector so any RTL
// helper that mounts the app can connect without a browser wallet.
mock({
  accounts: ["0x1111111111111111111111111111111111111111"] as const,
});
