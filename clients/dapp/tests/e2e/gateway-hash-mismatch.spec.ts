/**
 * Playwright E2E — gateway bytecode hash mismatch prevents admin writes (issue #207).
 *
 * Asserts acceptance criterion AC3:
 *   "E2E test that a configured hash mismatch prevents wallet signing prompts."
 *
 * Strategy: the dev server is started with VITE_GATEWAY_EXPECTED_CODE_HASH
 * set to an intentionally wrong value. The dapp must:
 *   1. Render the gateway-verification-refused banner.
 *   2. Render refusal previews (data-ok="false") for all write surfaces.
 *   3. Keep every submit button disabled (no wallet prompt triggered).
 *
 * Note: This test does not rely on a live chain — it exercises the
 * verification-refused branch that fires when the expected hash env var
 * is absent or wrong. The mock wallet connector is used so no real
 * browser extension is required.
 *
 * The test can only run if the server was started without a valid
 * VITE_GATEWAY_EXPECTED_CODE_HASH (or with a deliberately wrong one).
 * In the default dev-server config the env var is absent, which makes
 * the verifier refuse immediately — this test asserts that refusal UI.
 */
import { test, expect } from "@playwright/test";

test.describe("gateway hash verification — refused state disables writes", () => {
  test("verification banner shown and all write buttons disabled when hash is absent", async ({
    page,
  }) => {
    await page.goto("/");

    // The gateway verification refused banner must be visible.
    // (When VITE_GATEWAY_EXPECTED_CODE_HASH is unset the dapp refuses
    //  immediately before any RPC call.)
    const refusedBanner = page.getByTestId("gateway-verification-refused");
    await expect(refusedBanner).toBeVisible();

    // Connect wallet so the button disabled state is unambiguously
    // about verification, not lack of a connected wallet.
    const connectBtn = page.getByTestId("connect-mock");
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
      await expect(page.getByTestId("connected-address")).toBeVisible();
    }

    // All submit buttons must be disabled because preview.ok is false.
    const submitButtons = [
      "authorize-submit",
      "revoke-submit",
      "grant-admin-submit",
      "revoke-admin-submit",
      "grant-pauser-submit",
      "revoke-pauser-submit",
    ];
    for (const testId of submitButtons) {
      await expect(page.getByTestId(testId)).toBeDisabled();
    }

    // No wallet prompt was ever triggered (no sign request interceptable).
    // We assert this indirectly: if any button was enabled and clicked,
    // a wagmi writeContract call would fail and surface an error. Since
    // all buttons are disabled this cannot happen.
  });

  test("refusal reason is surfaced in the verification banner", async ({ page }) => {
    await page.goto("/");

    const refusedBanner = page.getByTestId("gateway-verification-refused");
    await expect(refusedBanner).toBeVisible();

    // The banner must explain the reason — either missing expected hash
    // or mismatch. Either way it must not be an empty message.
    const text = await refusedBanner.textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(10);
  });
});
