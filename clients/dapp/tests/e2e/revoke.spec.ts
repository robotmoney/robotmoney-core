/**
 * Playwright E2E — revoke flow UI invariants.
 *
 * Runs against the smoke-test full-stack devnet. Mirrors authorize.spec.ts
 * for the revoke action. The on-chain follow-up (rmpc self-check after
 * revoke confirms) lives in fork-roundtrip.spec.ts.
 */
import { test, expect } from "@playwright/test";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

let endpoints: DevnetEndpoints;
test.beforeAll(() => {
  endpoints = loadEndpoints();
});

test("revoke preview renders structured fields", async ({ page }) => {
  await openDapp(page, endpoints);
  await page.getByTestId("agent-input").fill(endpoints.agent_addr);
  await page.getByTestId("shareReceiver-input").fill(endpoints.share_receiver_addr);

  const revokeForm = page.getByTestId("revoke-form");
  await expect(revokeForm.getByTestId("tx-preview-fn")).toHaveText("revokeAgent");
  await expect(revokeForm.getByTestId("tx-preview-effect")).toContainText("loses AGENT_ROLE");
});
