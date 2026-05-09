/**
 * Playwright E2E — register-existing-address credential flow.
 *
 * Acceptance criterion source: issue #150 AC §1–§4.
 *
 * The default (production) build supports register-existing-address
 * (supply an externally-created agent public address) without any
 * browser-key-generation UI being visible.
 *
 * Invariants verified here:
 *   1. The browser-keygen banner is NOT visible by default.
 *   2. Filling a valid externally-supplied agent address plus a
 *      share-receiver surfaces a structured authorizeAgent preview
 *      (not a raw calldata-only signing prompt).
 *   3. The wallet signing button is only enabled after the structured
 *      preview renders (i.e., mock-wallet signing is disabled until
 *      the preview is valid).
 *   4. The config-export panel appears (register flow emits a config
 *      the real rmpc loader accepts — panel presence is the UI signal
 *      that the export is available; the TOML round-trip is covered by
 *      clients/rust-payment-client/tests/dapp_toml_roundtrip.rs).
 */
import { test, expect } from "@playwright/test";

// Anvil pre-funded accounts used as safe test addresses.
const AGENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SHARE_RECEIVER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test.describe("register-existing-address flow — UI invariants", () => {
  test("browser-keygen banner is hidden in default production build", async ({ page }) => {
    await page.goto("/");
    // The element is in the DOM (hidden attribute) but must not be visible.
    const keygenBanner = page.getByTestId("browser-keygen");
    await expect(keygenBanner).not.toBeVisible();
    // The disabled marker element should exist in the DOM but be hidden.
    const disabledMarker = page.getByTestId("browser-keygen-disabled");
    await expect(disabledMarker).toBeAttached();
    await expect(disabledMarker).toBeHidden();
  });

  test("structured authorizeAgent preview renders for a valid externally-supplied address", async ({
    page,
  }) => {
    await page.goto("/");

    // Connect mock wallet.
    const connect = page.getByTestId("connect-mock");
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    // Fill the register-existing-address form with a valid agent address
    // generated externally (any valid Ethereum address — no private key needed).
    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    // Structured preview must render (not a refusal).
    const preview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(preview).toBeVisible();

    // Preview shows the function name and AGENT_ROLE effect.
    await expect(page.getByTestId("tx-preview-fn").first()).toContainText("authorizeAgent");
    await expect(page.getByTestId("tx-preview-effect").first()).toContainText("AGENT_ROLE");

    // No raw-calldata-only refusal surface.
    const refusals = await page.locator('[data-testid="refusal-reason"]').count();
    expect(refusals).toBe(0);
  });

  test("authorize signing button is disabled until structured preview is valid", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("connect-mock").click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    // Button disabled with no address.
    const button = page.getByTestId("authorize-submit");
    await expect(button).toBeDisabled();

    // Fill only the agent — still disabled (no shareReceiver yet).
    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await expect(button).toBeDisabled();

    // Fill the share receiver — now the preview should be valid and the button enabled.
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);
    await expect(button).toBeEnabled();
  });

  test("config-export panel appears after valid register inputs are supplied", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("connect-mock").click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    // Fill valid register inputs.
    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    // ConfigExportPanel should render, signalling the config is available.
    const exportPanel = page.getByTestId("config-export");
    await expect(exportPanel).toBeVisible();
  });
});
