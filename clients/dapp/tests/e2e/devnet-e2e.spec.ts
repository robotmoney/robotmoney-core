/**
 * Playwright E2E — full-stack Geth+Lighthouse devnet smoke.
 *
 * devnet-global-setup.ts has already booted `cargo run -p smoke-test --
 * --full-stack` and written the endpoint summary (URLs, contract
 * addresses, test-EOA private keys) to DEVNET_ENDPOINTS_FILE.
 *
 * Asserts:
 *   (A) The dapp, built with the deployed gateway's runtime hash pinned,
 *       renders the gateway address in the DOM once the admin wallet
 *       connects. Verifies that the prod-bit-identical bundle reaches
 *       the verified state against a real chain.
 *   (B) Calling authorizeAgent through the dapp's prod injected()
 *       connector mines on real Geth and sets AGENT_ROLE on-chain.
 *
 * Canonical: docs/testing/smoke-test-design.md, issue #245.
 */

import { test, expect } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hex } from "viem";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { injectWallet, connectInjectedWallet } from "./helpers/wallet";

// keccak256("AGENT_ROLE") — matches contracts/gateway/AccessRoles.sol.
const AGENT_ROLE = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

// Polling params tuned for real Geth block times (~12s per block).
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(`eth_call error: ${j.error.message}`);
  return j.result ?? "0x";
}

async function hasRole(
  rpc: string,
  gateway: string,
  role: string,
  account: string,
): Promise<boolean> {
  // hasRole(bytes32,address) selector = 0x91d14854
  const accountPadded = account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const rolePadded = role.toLowerCase().replace(/^0x/, "");
  const data = `0x91d14854${rolePadded}${accountPadded}`;
  const result = await ethCall(rpc, gateway, data);
  return /1$/.test(result.trim());
}

async function waitForRole(
  rpc: string,
  gateway: string,
  role: string,
  account: string,
  expectValue: boolean,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: boolean | null = null;
  while (Date.now() < deadline) {
    last = await hasRole(rpc, gateway, role, account);
    if (last === expectValue) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `devnet-e2e: timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for ` +
      `hasRole(${role.slice(0, 10)}…, ${account}) === ${expectValue}; ` +
      `last observed: ${last}`,
  );
}

test.describe("devnet E2E — full-stack Geth+Lighthouse", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("(A) dapp renders the deployed gateway address in the DOM", async ({ page }) => {
    await injectWallet(page, {
      privateKey: endpoints.admin_private_key as Hex,
      rpcUrl: endpoints.rpc_url,
      chainId: endpoints.chain_id,
    });
    await page.goto(endpoints.dapp_url);
    await connectInjectedWallet(page);

    // Verification must pass — the dapp container was built with the
    // real runtime hash. ConfigExportPanel then renders the gateway
    // address inside its TOML output (case-insensitive: smoke-test
    // emits lowercase, dapp may render EIP-55 checksummed form).
    await expect(page.getByTestId("gateway-verification-ok")).toBeVisible({ timeout: 30_000 });
    const escaped = endpoints.gateway_addr.replace(/^0x/, "");
    const re = new RegExp(`0x${escaped}`, "i");
    await expect(page.getByText(re).first()).toBeVisible({ timeout: 30_000 });
  });

  test("(B) authorizeAgent mines on Geth and AGENT_ROLE is confirmed on-chain", async ({
    page,
  }) => {
    await injectWallet(page, {
      privateKey: endpoints.admin_private_key as Hex,
      rpcUrl: endpoints.rpc_url,
      chainId: endpoints.chain_id,
    });
    await page.goto(endpoints.dapp_url);
    await connectInjectedWallet(page);

    await page.getByTestId("agent-input").fill(endpoints.agent_addr);
    await page.getByTestId("shareReceiver-input").fill(endpoints.share_receiver_addr);

    const authorizePreview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(authorizePreview).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("authorize-submit").click();

    console.log(
      `devnet-e2e: polling for AGENT_ROLE on ${endpoints.rpc_url}, ` +
        `gateway=${endpoints.gateway_addr}, agent=${endpoints.agent_addr}`,
    );
    await waitForRole(
      endpoints.rpc_url,
      endpoints.gateway_addr,
      AGENT_ROLE,
      endpoints.agent_addr,
      true,
    );
    console.log("devnet-e2e: AGENT_ROLE confirmed on-chain.");
  });
});
