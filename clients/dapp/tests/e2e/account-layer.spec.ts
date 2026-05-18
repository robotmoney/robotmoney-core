/**
 * Suite-10 — Playwright E2E: account layer (issue #319).
 *
 * Runs against the smoke-test full-stack devnet. Both account-layer API
 * endpoints are intercepted via `page.route` so the test does not depend on
 * whatever the explorer API returns for the smoke-test address.
 *
 * Covers the suite-10 acceptance criterion:
 *   "Enter watched address, verify portfolio position and history render."
 *
 * The WatchedAddressInput is embedded in the NavBar area of the dapp via the
 * AccountLayerView component. The test navigates to the dapp, enters the
 * smoke-test share-receiver address, and asserts that PortfolioPosition and
 * TransactionHistory render the stubbed fixture data.
 */
import { test, expect } from "@playwright/test";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";

let endpoints: DevnetEndpoints;
test.beforeAll(() => {
  endpoints = loadEndpoints();
});

test("watched address — portfolio position and transaction history render from stubbed API", async ({
  page,
}) => {
  const watchedAddress = endpoints.share_receiver_addr;

  const positionsStub = {
    address: watchedAddress,
    positions: [
      {
        vault_address: endpoints.vault_addr,
        vault_name: "Smoke Test Vault",
        risk_label: "stable-yield",
        shares: "1000000",
        block_number: 100,
      },
    ],
    block_number: 100,
    indexed_at: "2026-05-10T12:00:00Z",
  };

  const historyStub = {
    address: watchedAddress,
    events: [
      {
        event_type: "deposit",
        block_number: 100,
        tx_hash: "0x" + "ab".repeat(32),
        vault_address: endpoints.vault_addr,
        amount: "1000000",
        indexed_at: "2026-05-10T12:00:00Z",
      },
    ],
    block_number: 100,
    indexed_at: "2026-05-10T12:00:00Z",
  };

  // Stub the account positions endpoint.
  await page.route(/\/v1\/accounts\/0x[0-9a-fA-F]{40}\/positions$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(positionsStub),
    });
  });

  // Stub the account history endpoint.
  await page.route(/\/v1\/accounts\/0x[0-9a-fA-F]{40}\/history$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(historyStub),
    });
  });

  // Navigate to the dapp (no wallet injection — watched-address mode is
  // read-only and requires no wallet).
  await page.goto(endpoints.dapp_url);

  // The WatchedAddressInput lives in the "Portfolio Explorer" tab.
  await page.getByTestId("tab-portfolio-explorer").click();
  await page.getByTestId("tabpanel-portfolio-explorer").waitFor({ state: "visible" });

  // Enter the watched address and submit.
  await expect(page.getByTestId("watched-address-form")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("watched-address-input").fill(watchedAddress);
  await page.getByTestId("watched-address-submit").click();

  // PortfolioPosition renders with the stubbed vault row.
  await expect(page.getByTestId("portfolio-position")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("portfolio-position-table")).toBeVisible();
  const positionRows = page.getByTestId("portfolio-position-row");
  await expect(positionRows).toHaveCount(1);
  await expect(page.getByTestId("portfolio-position-row-vault")).toHaveText("Smoke Test Vault");
  await expect(page.getByTestId("portfolio-position-row-shares")).toHaveText("1000000");

  // Shared VaultPositionCard renders in the card grid below the table (issue #381).
  await expect(page.getByTestId("portfolio-position-cards")).toBeVisible();
  const vaultCards = page.getByTestId("vault-position-card");
  await expect(vaultCards).toHaveCount(1);
  await expect(page.getByTestId("vault-position-card-name")).toHaveText("Smoke Test Vault");
  await expect(page.getByTestId("vault-position-card-shares")).toHaveText("1000000");

  // TransactionHistory renders with the stubbed deposit event.
  await expect(page.getByTestId("transaction-history")).toBeVisible();
  await expect(page.getByTestId("transaction-history-table")).toBeVisible();
  const historyRows = page.getByTestId("transaction-history-row");
  await expect(historyRows).toHaveCount(1);
  await expect(page.getByTestId("transaction-history-row-type")).toHaveText("deposit");
  await expect(page.getByTestId("transaction-history-row-block")).toHaveText("100");
  await expect(page.getByTestId("transaction-history-row-tx")).toHaveText("0x" + "ab".repeat(32));
});
