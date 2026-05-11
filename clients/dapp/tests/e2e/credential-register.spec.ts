/**
 * Playwright E2E — register-existing-address credential flow.
 *
 * Runs against the smoke-test full-stack devnet. Acceptance criterion
 * source: issue #150 AC §1–§4.
 *
 * Invariants verified here:
 *   1. The browser-keygen banner is NOT visible by default.
 *   2. Filling a valid externally-supplied agent address plus a
 *      share-receiver surfaces a structured authorizeAgent preview.
 *   3. The wallet signing button is only enabled after the structured
 *      preview renders.
 *   4. The config-export panel appears (register flow emits a config
 *      the real rmpc loader accepts; the TOML round-trip is covered
 *      by `clients/rust-payment-client/tests/dapp_toml_roundtrip.rs`).
 */
import { test, expect } from "@playwright/test";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

let endpoints: DevnetEndpoints;
let AGENT_ADDRESS: string;
let SHARE_RECEIVER: string;

test.beforeAll(() => {
  endpoints = loadEndpoints();
  AGENT_ADDRESS = endpoints.agent_addr;
  SHARE_RECEIVER = endpoints.share_receiver_addr;
});

test.describe("register-existing-address flow — UI invariants", () => {
  test("browser-keygen banner is hidden in default production build", async ({ page }) => {
    await openDapp(page, endpoints, { connect: false });
    const keygenBanner = page.getByTestId("browser-keygen");
    await expect(keygenBanner).not.toBeVisible();
    const disabledMarker = page.getByTestId("browser-keygen-disabled");
    await expect(disabledMarker).toBeAttached();
    await expect(disabledMarker).toBeHidden();
  });

  test("structured authorizeAgent preview renders for a valid externally-supplied address", async ({
    page,
  }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    const preview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(preview).toBeVisible();

    await expect(page.getByTestId("tx-preview-fn").first()).toContainText("authorizeAgent");
    await expect(page.getByTestId("tx-preview-effect").first()).toContainText("AGENT_ROLE");

    const refusals = await page.locator('[data-testid="refusal-reason"]').count();
    expect(refusals).toBe(0);
  });

  test("authorize signing button is disabled until structured preview is valid", async ({
    page,
  }) => {
    await openDapp(page, endpoints);

    const button = page.getByTestId("authorize-submit");
    await expect(button).toBeDisabled();

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await expect(button).toBeDisabled();

    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);
    await expect(button).toBeEnabled();
  });

  test("config-export panel appears after valid register inputs are supplied", async ({ page }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    const exportPanel = page.getByTestId("config-export");
    await expect(exportPanel).toBeVisible();
  });
});
