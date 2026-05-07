/**
 * Playwright E2E — revoke flow.
 *
 * Mirrors the authorize spec for the revoke action. The full
 * revoke + `rmpc self-check` follow-up that the acceptance criterion
 * names is gated by FORK_E2E=1; see .github/workflows/dapp.yml for the
 * CI sidecar wiring.
 */
import { test, expect } from "@playwright/test";

test("revoke preview renders structured fields", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("connect-mock").click();
  await page.getByTestId("agent-input").fill("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  await page.getByTestId("shareReceiver-input").fill("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");

  // After issue #82 the page also renders a PauseFlow (pause + unpause
  // previews), so scope to the revoke-form to avoid coupling to the
  // total preview count on the page.
  const revokeForm = page.getByTestId("revoke-form");
  await expect(revokeForm.getByTestId("tx-preview-fn")).toHaveText("revokeAgent");
  await expect(revokeForm.getByTestId("tx-preview-effect")).toContainText("loses AGENT_ROLE");
});
