/**
 * Playwright E2E — admin Faucet tab (issue #261).
 *
 *   AC: "On the smoke-test full-stack devnet, the admin panel renders a
 *        'Faucet' tab containing a wallet dropdown populated from the
 *        user's wallet list and a single drip button; clicking the
 *        button with a wallet selected mines a transaction that
 *        increases that wallet's USDC.balanceOf by exactly 100 USDC."
 *
 * Boots devnet via the existing globalSetup, opens the dapp as the
 * admin role, navigates to the Faucet tab, drips into the connected
 * EOA, and polls `USDC.balanceOf(admin)` until it has increased by
 * exactly `FAUCET_DRIP_AMOUNT_USDC`.
 *
 * Canonical: issue #261, docs/testing/smoke-test-design.md.
 */

import { test, expect } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

const FAUCET_DRIP_AMOUNT_USDC = 100_000_000n;
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

async function usdcBalanceOf(rpc: string, usdc: string, account: string): Promise<bigint> {
  // balanceOf(address) selector = 0x70a08231
  const padded = account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = `0x70a08231${padded}`;
  const result = await ethCall(rpc, usdc, data);
  if (!result || result === "0x") return 0n;
  return BigInt(result);
}

async function waitForBalanceDelta(
  rpc: string,
  usdc: string,
  account: string,
  baseline: bigint,
  expectedDelta: bigint,
): Promise<bigint> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = baseline;
  while (Date.now() < deadline) {
    last = await usdcBalanceOf(rpc, usdc, account);
    if (last - baseline === expectedDelta) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `faucet-admin-tab: timed out waiting for USDC.balanceOf(${account}) to increase by ` +
      `${expectedDelta}; baseline=${baseline}, last=${last}`,
  );
}

test.describe("admin Faucet tab — testnet/devnet drip", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("Faucet tab drips exactly 100 USDC into the selected wallet", async ({ page }) => {
    await openDapp(page, endpoints, { role: "admin" });
    await openTab(page, "faucet");

    // Wallet dropdown is populated; default selection is the connected EOA.
    const select = page.getByTestId("faucet-wallet-select");
    await expect(select).toBeVisible();
    const selectedValue = await select.inputValue();
    expect(selectedValue.toLowerCase()).toBe(endpoints.admin_addr.toLowerCase());

    const baseline = await usdcBalanceOf(
      endpoints.rpc_url,
      endpoints.usdc_addr,
      endpoints.admin_addr,
    );

    // Drip button enables once the harness `balanceOf` preflight returns.
    const drip = page.getByTestId("faucet-drip-submit");
    await expect(drip).toBeEnabled({ timeout: 30_000 });
    await drip.click();

    const after = await waitForBalanceDelta(
      endpoints.rpc_url,
      endpoints.usdc_addr,
      endpoints.admin_addr,
      baseline,
      FAUCET_DRIP_AMOUNT_USDC,
    );
    expect(after - baseline).toBe(FAUCET_DRIP_AMOUNT_USDC);

    // Success surface visible.
    await expect(page.getByTestId("faucet-drip-success")).toBeVisible({ timeout: 30_000 });
  });
});
