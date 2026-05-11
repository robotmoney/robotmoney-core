/**
 * Playwright E2E — HistoryPane (issue #88).
 *
 * Runs against the smoke-test full-stack devnet. The smoke-test dapp
 * container is always built with `VITE_HISTORY_PANE=true`, so the
 * flag-on path is the only mode tested here. (The flag-off invariant
 * is covered by `tests/unit/historyPane.test.tsx`.)
 *
 * Stubs `/v1/agents/:address/deposits` via `page.route` so the test
 * does not depend on whatever the explorer API returns for the
 * smoke-test agent.
 */
import { test, expect } from "@playwright/test";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

let endpoints: DevnetEndpoints;
test.beforeAll(() => {
  endpoints = loadEndpoints();
});

test("history pane renders rows from the stubbed explorer API", async ({ page }) => {
  const stubBody = {
    deposits: [
      {
        chain_id: endpoints.chain_id,
        block_number: 1234,
        log_index: 0,
        tx_hash: "0x" + "ab".repeat(32),
        payment_id: "0x" + "cd".repeat(32),
        agent: endpoints.agent_addr,
        share_receiver: endpoints.share_receiver_addr,
        amount: "1000000",
        indexed_at: "2026-05-07T12:34:56Z",
      },
    ],
    freshness: {
      block_number: 1234,
      indexed_at: "2026-05-07T12:34:56Z",
    },
  };

  await page.route(/\/v1\/agents\/0x[0-9a-fA-F]{40}\/deposits$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stubBody),
    });
  });

  await openDapp(page, endpoints);
  await openTab(page, "authorize");
  await page.getByTestId("agent-input").fill(endpoints.agent_addr);
  await openTab(page, "history");

  await expect(page.getByTestId("history-pane")).toBeVisible();
  await expect(page.getByTestId("history-pane-table")).toBeVisible();
  const rows = page.getByTestId("history-pane-row");
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("history-pane-row-block")).toHaveText("1234");
  await expect(page.getByTestId("history-pane-row-tx")).toHaveText("0x" + "ab".repeat(32));
});
