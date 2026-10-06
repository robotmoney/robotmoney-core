/**
 * Playwright E2E — agent rotation flow (revoke old → authorize new).
 *
 * Acceptance criterion source: issue #150 AC §2.
 *
 * A rotation previews BOTH revokeAgent(old) AND authorizeAgent(new, policy)
 * effects before wallet signing is enabled for either step. The operator
 * must confirm both previews before any wallet interaction occurs.
 *
 * The rotation runs as a DEPOSITOR. After the timelock handover no EOA holds
 * ADMIN_ROLE on any chain, so a browser wallet authorizes and rotates only
 * its own agents: revokeAgent is gated on agentOwner == msg.sender, and the
 * new agent is authorized through commitAuthorization + revealAuthorization
 * (docs/architecture.md §6, docs/technical/dapp-credential-decisions.md §3.2
 * 2026-10-06 amendment). `beforeAll` makes a fresh depositor and has it
 * authorize OLD_AGENT through the dapp's Authorize tab, so OLD_AGENT is
 * depositor-owned before any rotation test runs.
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
 *      (revoke old) has been submitted. Completing the rotation leaves
 *      OLD_AGENT unowned without AGENT_ROLE, and NEW_AGENT owned by the
 *      depositor with AGENT_ROLE and the previewed policy.
 */
import { test, expect } from "./helpers/fixtures";
import { zeroAddress, type Address } from "viem";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";
import {
  ADMIN_ROLE,
  agentPolicyOf,
  authorizeOwnAgentViaUi,
  freshAccount,
  freshDepositor,
  gatewayHasRole,
  waitForAgentState,
  type TestAccount,
} from "./helpers/depositor";

let endpoints: DevnetEndpoints;
let DEPOSITOR: TestAccount;
let OLD_AGENT: Address;
let NEW_AGENT: Address;
let SHARE_RECEIVER: Address;

test.beforeAll(async ({ browser }) => {
  endpoints = loadEndpoints();
  DEPOSITOR = await freshDepositor(endpoints);
  // The depositor holds no admin role: this is the production wallet shape.
  expect(await gatewayHasRole(endpoints, ADMIN_ROLE, DEPOSITOR.address)).toBe(false);
  // OLD_AGENT and NEW_AGENT are fresh addresses with no role and no owner.
  // AccessRoles._grantRole is mutex with ADMIN/PAUSER, and authorization
  // reverts with AgentAlreadyOwned on an owned agent, so neither may be a
  // harness key.
  OLD_AGENT = freshAccount().address;
  NEW_AGENT = freshAccount().address;
  // A caller without ADMIN_ROLE must name itself as shareReceiver.
  SHARE_RECEIVER = DEPOSITOR.address;

  const setupPage = await browser.newPage();
  try {
    await authorizeOwnAgentViaUi(setupPage, endpoints, DEPOSITOR, OLD_AGENT);
  } finally {
    await setupPage.close();
  }
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
    await openDapp(page, endpoints, { privateKey: DEPOSITOR.privateKey });
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

    // The wallet lacks ADMIN_ROLE, so the dapp takes the depositor path.
    await expect(page.getByTestId("rotation-depositor-path")).toBeVisible();
    await expect(page.getByTestId("rotation-depositor-error")).toHaveCount(0);

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

    // The revoke mined: OLD_AGENT has no owner and no AGENT_ROLE.
    await waitForAgentState(endpoints, OLD_AGENT, zeroAddress);

    // Step 2 (commit) then step 3 (reveal, one block later) authorize NEW_AGENT.
    const reveal = page.getByTestId("rotation-reveal-submit");
    await expect(reveal).toBeDisabled();
    await page.getByTestId("rotation-authorize-submit").click();
    await expect(reveal).toBeEnabled({ timeout: 60_000 });
    await reveal.click();
    await expect(page.getByTestId("rotation-complete")).toBeVisible();

    // NEW_AGENT is owned by the depositor, holds AGENT_ROLE, and stores the
    // previewed policy (form defaults: 100 / 1000 USDC caps).
    await waitForAgentState(endpoints, NEW_AGENT, DEPOSITOR.address);
    const policy = await agentPolicyOf(endpoints, NEW_AGENT);
    expect(policy.active).toBe(true);
    expect(policy.shareReceiver.toLowerCase()).toBe(DEPOSITOR.address.toLowerCase());
    expect(policy.maxPerPayment).toBe(100_000_000n);
    expect(policy.maxPerWindow).toBe(1_000_000_000n);
    // The revoked agent's policy is cleared.
    expect((await agentPolicyOf(endpoints, OLD_AGENT)).active).toBe(false);
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
