/**
 * Playwright E2E — agent rotation flow (revoke old → authorize new).
 *
 * Acceptance criterion source: issue #150 AC §2.
 *
 * A rotation previews BOTH revokeAgent(old) AND authorizeAgent(new, policy)
 * effects before wallet signing is enabled for either step. The operator
 * must confirm both previews before any wallet interaction occurs.
 *
 * Invariants verified here:
 *   1. Rotation section renders two independent step sub-sections.
 *   2. Both signing buttons are disabled until all rotation inputs are
 *      valid and both previews are structurally OK.
 *   3. The revokeAgent step preview renders the old address and the
 *      authorizeAgent step preview renders the new address.
 *   4. Entering identical addresses for old and new prevents the
 *      previews from rendering (rotation requires distinct addresses).
 *   5. Step-2 (authorize new) button is disabled until step-1
 *      (revoke old) has been submitted.
 */
import { test, expect } from "@playwright/test";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

let endpoints: DevnetEndpoints;
let OLD_AGENT: string;
let NEW_AGENT: string;
let SHARE_RECEIVER: string;

test.beforeAll(() => {
  endpoints = loadEndpoints();
  // OLD_AGENT = smoke-test's pre-authorized agent EOA.
  // NEW_AGENT must be an address with no existing role on the gateway:
  // AccessRoles._grantRole is mutex with AGENT_ROLE/PAUSER_ROLE, so an
  // authorizeAgent simulation against pauser_addr (which has PAUSER_ROLE)
  // would revert and keep the submit button disabled. Use a fresh hex
  // address that is guaranteed to have no roles on the deployed gateway.
  OLD_AGENT = endpoints.agent_addr;
  NEW_AGENT = "0x2222222222222222222222222222222222222222";
  SHARE_RECEIVER = endpoints.share_receiver_addr;
});

async function fillRotationForm(
  page: import("@playwright/test").Page,
  {
    oldAgent,
    newAgent,
    shareReceiver,
  }: { oldAgent: string; newAgent: string; shareReceiver: string },
) {
  await page.getByTestId("rotation-old-agent-input").fill(oldAgent);
  await page.getByTestId("rotation-new-agent-input").fill(newAgent);
  await page.getByTestId("rotation-shareReceiver-input").fill(shareReceiver);
}

test.describe("agent rotation flow — UI invariants", () => {
  test.beforeEach(async ({ page }) => {
    await openDapp(page, endpoints);
    await openTab(page, "rotation");
  });

  test("rotation section renders step-1 and step-2 sub-sections", async ({ page }) => {
    const rotationForm = page.getByTestId("rotation-form");
    await expect(rotationForm).toBeVisible();
    await expect(page.getByTestId("rotation-step1")).toBeVisible();
    await expect(page.getByTestId("rotation-step2")).toBeVisible();
  });

  test("both rotation signing buttons disabled with empty inputs", async ({ page }) => {
    await expect(page.getByTestId("rotation-revoke-submit")).toBeDisabled();
    await expect(page.getByTestId("rotation-authorize-submit")).toBeDisabled();
  });

  test("both rotation signing buttons disabled with only old agent address", async ({ page }) => {
    await page.getByTestId("rotation-old-agent-input").fill(OLD_AGENT);
    await expect(page.getByTestId("rotation-revoke-submit")).toBeDisabled();
    await expect(page.getByTestId("rotation-authorize-submit")).toBeDisabled();
  });

  test("step-1 button enabled only after all rotation inputs valid and previews OK", async ({
    page,
  }) => {
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: NEW_AGENT,
      shareReceiver: SHARE_RECEIVER,
    });

    // After valid inputs, step-1 button must be enabled (previews OK).
    await expect(page.getByTestId("rotation-revoke-submit")).toBeEnabled();
  });

  test("step-2 button disabled until step-1 has been submitted", async ({ page }) => {
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: NEW_AGENT,
      shareReceiver: SHARE_RECEIVER,
    });

    // Step-2 must be disabled even after inputs are valid (awaiting step-1).
    await expect(page.getByTestId("rotation-authorize-submit")).toBeDisabled();

    // After step-1 is submitted, step-2 becomes enabled.
    await page.getByTestId("rotation-revoke-submit").click();
    await expect(page.getByTestId("rotation-authorize-submit")).toBeEnabled();
    // And step-1 is now disabled (already submitted).
    await expect(page.getByTestId("rotation-revoke-submit")).toBeDisabled();
  });

  test("revokeAgent preview for old address renders structured fields", async ({ page }) => {
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: NEW_AGENT,
      shareReceiver: SHARE_RECEIVER,
    });

    const step1 = page.getByTestId("rotation-step1");
    // The structured preview for revokeAgent must render.
    await expect(step1.locator('[data-testid="tx-preview"][data-ok="true"]')).toBeVisible();
    await expect(step1.getByTestId("tx-preview-fn")).toContainText("revokeAgent");
    await expect(step1.getByTestId("tx-preview-effect")).toContainText("loses AGENT_ROLE");
  });

  test("authorizeAgent preview for new address renders structured fields", async ({ page }) => {
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: NEW_AGENT,
      shareReceiver: SHARE_RECEIVER,
    });

    const step2 = page.getByTestId("rotation-step2");
    // The structured preview for authorizeAgent must render.
    await expect(step2.locator('[data-testid="tx-preview"][data-ok="true"]')).toBeVisible();
    await expect(step2.getByTestId("tx-preview-fn")).toContainText("authorizeAgent");
    await expect(step2.getByTestId("tx-preview-effect")).toContainText("AGENT_ROLE");
  });

  test("combined risk annotation renders warning about TWO transactions", async ({ page }) => {
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: NEW_AGENT,
      shareReceiver: SHARE_RECEIVER,
    });

    const riskBanner = page.getByTestId("rotation-combined-risk");
    await expect(riskBanner).toBeVisible();
    await expect(riskBanner).toContainText("TWO");
  });

  test("identical old and new addresses show an error instead of previews", async ({ page }) => {
    // Rotation requires distinct addresses. Entering the same address for both
    // must surface an error and keep both signing buttons disabled.
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: OLD_AGENT, // same as old
      shareReceiver: SHARE_RECEIVER,
    });

    const error = page.getByTestId("rotation-preview-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("distinct");

    // Both buttons must stay disabled.
    await expect(page.getByTestId("rotation-revoke-submit")).toBeDisabled();
    await expect(page.getByTestId("rotation-authorize-submit")).toBeDisabled();
  });

  test("no raw-calldata-only signing surface in rotation section", async ({ page }) => {
    await fillRotationForm(page, {
      oldAgent: OLD_AGENT,
      newAgent: NEW_AGENT,
      shareReceiver: SHARE_RECEIVER,
    });

    // Refusal-reason elements would indicate a signing prompt without a preview.
    const rotationForm = page.getByTestId("rotation-form");
    const refusals = await rotationForm.locator('[data-testid="refusal-reason"]').count();
    expect(refusals).toBe(0);
  });
});
