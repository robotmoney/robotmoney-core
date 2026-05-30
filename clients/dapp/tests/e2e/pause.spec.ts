/**
 * Playwright E2E — pause flow UI invariants (issue #82).
 *
 * Runs against the smoke-test full-stack devnet. Asserts the structured
 * preview shape (selector + fn + effect + calldata) is rendered, no
 * raw-calldata leak, and the calldata equals the encoder output for
 * pause() (selector 0x8456cb59).
 *
 * Connects as the pauser EOA so PAUSER_ROLE is set; the submit button
 * is therefore enabled but we don't click it — this spec only asserts
 * UI invariants, not on-chain state changes.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

// keccak256("pause()")[0..4]
const PAUSE_SELECTOR = "0x8456cb59";

let endpoints: DevnetEndpoints;
test.beforeAll(() => {
  endpoints = loadEndpoints();
});

test.describe("pause flow — UI invariants", () => {
  test("renders structured preview, signs intended calldata, no raw-calldata leak", async ({
    page,
  }) => {
    await openDapp(page, endpoints, { role: "pauser" });
    await openTab(page, "pause");

    const pauseFlow = page.getByTestId("pause-flow");
    await expect(pauseFlow).toBeVisible();

    const pauseForm = page.getByTestId("pause-form");
    await expect(pauseForm).toBeVisible();

    const previewFn = pauseForm.getByTestId("tx-preview-fn");
    await expect(previewFn).toHaveText("pause");
    await expect(pauseForm.getByTestId("tx-preview-effect")).toContainText("paused state");
    await expect(pauseForm.locator('[data-testid="refusal-reason"]')).toHaveCount(0);

    await expect(pauseForm.getByTestId("tx-preview-selector")).toHaveText(PAUSE_SELECTOR);

    const calldataElement = pauseForm.getByTestId("tx-preview-calldata");
    const calldataText = await calldataElement.textContent();
    expect(calldataText).toBe(PAUSE_SELECTOR);

    const calldataDetails = pauseForm.getByTestId("tx-preview-calldata-details");
    await expect(calldataDetails).toBeAttached();
    const isOpen = await calldataDetails.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);
    await expect(calldataElement).toBeHidden();
  });
});
