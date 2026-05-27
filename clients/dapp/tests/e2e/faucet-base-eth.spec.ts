/**
 * Playwright E2E — admin Faucet tab Get Base ETH drip (issue #466).
 *
 *   AC: "A new 'Get Base ETH' control drips a fixed amount of native ETH
 *        from the harness holder EOA to the selected recipient … After
 *        dripping Base ETH and RM, a fresh account can immediately
 *        submit a governance vote."
 *
 * This spec covers the Base ETH leg of the fresh-account provisioning
 * flow: boots the full-stack devnet via the existing globalSetup, opens
 * the dapp as the admin role, navigates to the Faucet tab, clicks
 * "Get Base ETH" for the connected EOA, and polls `eth_getBalance`
 * until it has increased by the FAUCET_DRIP_AMOUNT_ETH constant.
 *
 * The full drip-ETH-then-RM-then-vote round-trip against a freshly
 * generated EOA additionally requires the smoke-test global-setup to
 * surface `governance_addr` and `rm_token_addr` to Playwright. Tracking
 * that as a separate follow-up keeps this spec deterministic on the
 * existing devnet endpoint set.
 *
 * Canonical: issue #466, docs/architecture.md §5.3 — Human Dapp (faucet UX),
 * docs/testing/smoke-test-design.md.
 */

import { test, expect } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

// Mirrors FAUCET_DRIP_AMOUNT_ETH in clients/dapp/src/lib/chainClassifier.ts.
const FAUCET_DRIP_AMOUNT_ETH = 10_000_000_000_000_000n; // 0.01 ETH
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

async function ethGetBalance(rpc: string, account: string): Promise<bigint> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [account, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`eth_getBalance HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(`eth_getBalance error: ${j.error.message}`);
  return j.result ? BigInt(j.result) : 0n;
}

async function waitForBalanceGrowth(
  rpc: string,
  account: string,
  baseline: bigint,
  expectedDelta: bigint,
): Promise<bigint> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = baseline;
  while (Date.now() < deadline) {
    last = await ethGetBalance(rpc, account);
    // Recipient pays no gas (the harness signs), so the delta is exact.
    if (last - baseline >= expectedDelta) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `faucet-base-eth: timed out waiting for eth_getBalance(${account}) to grow by ` +
      `>= ${expectedDelta}; baseline=${baseline}, last=${last}`,
  );
}

test.describe("admin Faucet tab — Base ETH gas drip", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("Get Base ETH drips FAUCET_DRIP_AMOUNT_ETH into the selected wallet", async ({ page }) => {
    await openDapp(page, endpoints, { role: "admin" });
    await openTab(page, "faucet");

    const baseline = await ethGetBalance(endpoints.rpc_url, endpoints.admin_addr);

    // The Get Base ETH button enables once the harness ETH balance preflight
    // returns and the wallet dropdown has a valid recipient selected (the
    // connected EOA is selected by default).
    const dripEth = page.getByTestId("faucet-eth-drip-button");
    await expect(dripEth).toBeVisible({ timeout: 30_000 });
    await expect(dripEth).toBeEnabled({ timeout: 30_000 });
    await dripEth.click();

    const after = await waitForBalanceGrowth(
      endpoints.rpc_url,
      endpoints.admin_addr,
      baseline,
      FAUCET_DRIP_AMOUNT_ETH,
    );
    expect(after - baseline).toBeGreaterThanOrEqual(FAUCET_DRIP_AMOUNT_ETH);

    // Success surface visible.
    await expect(page.getByTestId("faucet-eth-drip-success")).toBeVisible({ timeout: 30_000 });
  });
});
