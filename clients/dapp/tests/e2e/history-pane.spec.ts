/**
 * Playwright E2E — HistoryPane (issue #88).
 *
 * Acceptance criterion:
 *   "Playwright E2E asserts history loads from an API mock with the flag
 *    on and is absent from the DOM with the flag off."
 *
 * The flag is read from `import.meta.env` at build time. Locally the dev
 * server picks up `VITE_HISTORY_PANE` from the shell, so the suite forks
 * one of two paths via the env var the test runner already sets:
 *
 *   - Default (flag unset): asserts `data-testid="history-pane"` is
 *     never in the DOM, even after the agent input is filled in.
 *   - Flag-on (VITE_HISTORY_PANE=true + VITE_EXPLORER_API_URL): the
 *     suite stubs `/v1/agents/:address/deposits` with `page.route` and
 *     asserts the table renders the stubbed rows.
 *
 * Both modes use the mock-wallet connector
 * (`VITE_USE_MOCK_WALLET=true`, set by the workflow) so we do not depend
 * on a browser wallet extension.
 */
import { test, expect } from "@playwright/test";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RECEIVER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const stubBody = {
  deposits: [
    {
      chain_id: 31337,
      block_number: 1234,
      log_index: 0,
      tx_hash: "0x" + "ab".repeat(32),
      payment_id: "0x" + "cd".repeat(32),
      agent: AGENT,
      share_receiver: RECEIVER,
      amount: "1000000",
      indexed_at: "2026-05-07T12:34:56Z",
    },
  ],
  freshness: {
    block_number: 1234,
    indexed_at: "2026-05-07T12:34:56Z",
  },
};

const flagOn = process.env.VITE_HISTORY_PANE === "true";

test.describe("HistoryPane — flag off", () => {
  test.skip(flagOn, "flag-on suite covers this path");

  test("history pane is absent from the DOM when the flag is off", async ({ page }) => {
    await page.goto("/");
    const connect = page.getByTestId("connect-mock");
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    // Even with a valid agent address (which would otherwise mount the
    // pane behind the flag) the section must stay hidden.
    await page.getByTestId("agent-input").fill(AGENT);
    await page.getByTestId("shareReceiver-input").fill(RECEIVER);

    await expect(page.getByTestId("history-pane")).toHaveCount(0);
  });
});

test.describe("HistoryPane — flag on with stubbed API", () => {
  test.skip(!flagOn, "flag must be enabled at build time for this suite");

  test("history pane renders rows from the stubbed explorer API", async ({ page }) => {
    // Intercept any request to the deposits endpoint and return the
    // stub. This works because the dapp issues a real network call to
    // the URL configured in VITE_EXPLORER_API_URL.
    await page.route(/\/v1\/agents\/0x[0-9a-fA-F]{40}\/deposits$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stubBody),
      });
    });

    await page.goto("/");
    const connect = page.getByTestId("connect-mock");
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    await page.getByTestId("agent-input").fill(AGENT);

    await expect(page.getByTestId("history-pane")).toBeVisible();
    await expect(page.getByTestId("history-pane-table")).toBeVisible();
    const rows = page.getByTestId("history-pane-row");
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("history-pane-row-block")).toHaveText("1234");
    await expect(page.getByTestId("history-pane-row-tx")).toHaveText("0x" + "ab".repeat(32));
  });
});
