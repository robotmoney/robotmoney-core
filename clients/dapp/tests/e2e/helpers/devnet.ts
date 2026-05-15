/**
 * Devnet endpoint reader. Loads the JSON file written by
 * devnet-global-setup.ts and exposes the smoke-test fixture's URLs,
 * deployed contract addresses, and test-EOA private keys.
 *
 * The endpoint file path is propagated to the Playwright workers via
 * the DEVNET_ENDPOINTS_FILE env var, which globalSetup sets.
 */
import * as fs from "node:fs";

export interface DevnetEndpoints {
  rpc_url: string;
  dapp_url: string;
  explorer_api_url: string;
  chain_id: number;
  gateway_addr: string;
  vault_addr: string;
  usdc_addr: string;
  agent_addr: string;
  admin_addr: string;
  pauser_addr: string;
  share_receiver_addr: string;
  admin_private_key: string;
  pauser_private_key: string;
  agent_private_key: string;
  gateway_runtime_hash: string;
  harness_usdc_holder_addr: string;
  harness_usdc_holder_private_key: string;
  /** VaultRegistry contract address (issue #320). */
  registry_addr: string;
  /** PortfolioRouter contract address (issue #320). */
  router_addr: string;
}

export function loadEndpoints(): DevnetEndpoints {
  const file = process.env.DEVNET_ENDPOINTS_FILE;
  if (!file) {
    throw new Error(
      "DEVNET_ENDPOINTS_FILE is not set. The Playwright globalSetup (devnet-global-setup.ts) " +
        "must have run successfully before any spec executes.",
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DevnetEndpoints;
}
