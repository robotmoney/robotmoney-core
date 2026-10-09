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
  /** RouterGovernance contract address (issue #477). */
  governance_addr: string;
  /** InvestmentCommitteePolicy contract address (issue #1247/#1294). */
  ic_policy_addr: string;
  /** ConsensusRebalanceReceipt contract address (issue #1247/#1294). */
  consensus_receipt_addr: string;
  /** The real 2-of-3 SafeL2 v1.4.1 that proposes to the timelock (core 1544). */
  safe_addr: string;
  /** TimelockController holding ADMIN_ROLE after the handover (core 1544). */
  timelock_addr: string;
  /** Directory of the encrypted rehearsal keystores: SAFE_OWNER_A, SAFE_OWNER_B, SAFE_OWNER_C. Path only. */
  key_dir: string;
  /** 0600 file holding the keystore passphrase. Path only. */
  password_file: string;
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
