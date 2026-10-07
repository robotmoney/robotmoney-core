/**
 * Playwright E2E — ADMIN_ROLE / DEPOSIT_PAUSER_ROLE grant + revoke (issue #83).
 *
 * Covers the four flows named in the acceptance criteria:
 *   ADMIN-grant, ADMIN-revoke, DEPOSIT_PAUSER-grant, DEPOSIT_PAUSER-revoke.
 *
 * Per the existing dapp E2E pattern (see authorize.spec.ts) this runs
 * against the mock-wallet connector and asserts the UI invariants:
 *   - structured tx-preview renders for the requested call,
 *   - the rendered calldata equals the encoder output for the intended
 *     (function, role, account) triple,
 *   - raw calldata is never visible in the DOM (it is only reachable
 *     by expanding the operator-opt-in <details> block),
 *   - the browser wallet cannot sign: after the timelock handover no EOA
 *     holds DEFAULT_ADMIN_ROLE (the admin of ADMIN_ROLE and DEPOSIT_PAUSER_ROLE) on
 *     any chain, so the submit button is disabled and the tab states why.
 *     The real grant/revoke through the Safe -> Timelock is covered by the
 *     Twin governance tests, not here.
 *     (docs/technical/dapp-credential-decisions.md §3.2, 2026-10-06 amendment)
 *
 * The optional on-chain writeContract round-trip is gated by FORK_E2E=1
 * and ships in a sibling spec; we keep this file focused on the UI
 * invariants the acceptance criteria explicitly enumerate.
 */
import { test, expect } from "./helpers/fixtures";
import type { Page } from "@playwright/test";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab, type AdminTabId } from "./helpers/wallet";
import { DEFAULT_ADMIN_ROLE, gatewayHasRole } from "./helpers/depositor";

let endpoints: DevnetEndpoints;
let ADMIN_ACCOUNT: `0x${string}`;
let PAUSER_ACCOUNT: `0x${string}`;
test.beforeAll(() => {
  endpoints = loadEndpoints();
  // ADMIN_ACCOUNT is an address with no existing role on the gateway:
  // AccessRoles._grantRole is mutex with AGENT_ROLE/DEPOSIT_PAUSER_ROLE, so the
  // previewed grantRole(ADMIN_ROLE, account) is one an admin could execute.
  ADMIN_ACCOUNT = "0x1111111111111111111111111111111111111111";
  PAUSER_ACCOUNT = endpoints.share_receiver_addr as `0x${string}`;
});

const ABI = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
] as const;

const ADMIN_ROLE = keccak256(toBytes("ADMIN_ROLE"));
const DEPOSIT_PAUSER_ROLE = keccak256(toBytes("DEPOSIT_PAUSER_ROLE"));

async function connect(page: Page) {
  // The connected wallet (`admin_*`, the harness USDC holder) is a plain EOA.
  // Prove the precondition on-chain so the refusal below is not vacuous.
  expect(
    await gatewayHasRole(endpoints, DEFAULT_ADMIN_ROLE, endpoints.admin_addr as `0x${string}`),
    "test wallet must not hold DEFAULT_ADMIN_ROLE after the timelock handover",
  ).toBe(false);
  await openDapp(page, endpoints);
}

/**
 * Production behavior for a wallet without DEFAULT_ADMIN_ROLE: the submit
 * button is refused and the tab shows the visible reason.
 */
async function expectRefusedForNonAdminWallet(page: Page, c: RoleCase, btnId: string) {
  await expect(page.getByTestId(btnId)).toBeDisabled();
  const reason = page.getByTestId(`${c.slug}-role-wallet-refusal`);
  await expect(reason).toBeVisible();
  await expect(reason).toContainText("lacks DEFAULT_ADMIN_ROLE");
  await expect(reason).toContainText(c.roleName);
  await expect(reason).toContainText("Safe -> Timelock");
}

/**
 * Asserts no raw calldata strings appear in the rendered DOM outside
 * the operator-opt-in <details data-testid="tx-preview-calldata-details">
 * block — i.e. the user cannot land on a screen that surfaces signing-grade
 * calldata without an explicit expand action.
 */
async function expectNoRawCalldataExposed(page: Page, expectedCalldata: string) {
  // The encoder output should only be present inside the collapsed
  // <details> block. Locate every node containing the hex string and
  // assert each one is a descendant of a closed <details>.
  const matches = page.locator(`text="${expectedCalldata}"`);
  const count = await matches.count();
  for (let i = 0; i < count; i++) {
    const detailsAncestorOpen = await matches.nth(i).evaluate((node) => {
      const parent = (node as HTMLElement).closest?.("details");
      return parent ? (parent as HTMLDetailsElement).open : false;
    });
    expect(detailsAncestorOpen, "raw calldata leaked outside collapsed <details>").toBe(false);
  }
}

interface RoleCase {
  label: string;
  inputId: string;
  /** Lazy — beforeAll populates the addresses. */
  account: () => `0x${string}`;
  grantBtnId: string;
  grantPreviewId: string;
  revokeBtnId: string;
  revokePreviewId: string;
  role: `0x${string}`;
  roleName: "ADMIN_ROLE" | "DEPOSIT_PAUSER_ROLE";
  tabId: AdminTabId;
  slug: "admin" | "pauser";
}

const cases: RoleCase[] = [
  {
    label: "ADMIN",
    inputId: "admin-account-input",
    account: () => ADMIN_ACCOUNT,
    grantBtnId: "grant-admin-submit",
    grantPreviewId: "grant-admin-preview-wrap",
    revokeBtnId: "revoke-admin-submit",
    revokePreviewId: "revoke-admin-preview-wrap",
    role: ADMIN_ROLE,
    roleName: "ADMIN_ROLE",
    tabId: "admin-role",
    slug: "admin",
  },
  {
    label: "PAUSER",
    inputId: "pauser-account-input",
    account: () => PAUSER_ACCOUNT,
    grantBtnId: "grant-pauser-submit",
    grantPreviewId: "grant-pauser-preview-wrap",
    revokeBtnId: "revoke-pauser-submit",
    revokePreviewId: "revoke-pauser-preview-wrap",
    role: DEPOSIT_PAUSER_ROLE,
    roleName: "DEPOSIT_PAUSER_ROLE",
    tabId: "pauser-role",
    slug: "pauser",
  },
];

for (const c of cases) {
  test.describe(`${c.label}_ROLE grant + revoke UI (issue #83)`, () => {
    test(`grant ${c.label}_ROLE: preview matches encoder, no raw calldata exposed`, async ({
      page,
    }) => {
      await connect(page);
      await openTab(page, c.tabId);
      await page.getByTestId(c.inputId).fill(c.account());

      const previewWrap = page.getByTestId(c.grantPreviewId);
      await expect(previewWrap).toBeVisible();

      // Function name + effect mention the role.
      await expect(previewWrap.getByTestId("tx-preview-fn")).toHaveText("grantRole");
      await expect(previewWrap.getByTestId("tx-preview-effect")).toContainText(c.roleName);

      // Calldata equals encoder output for grantRole(role, account).
      const expected = encodeFunctionData({
        abi: ABI,
        functionName: "grantRole",
        args: [c.role, c.account()],
      });
      const calldata = await previewWrap.getByTestId("tx-preview-calldata").textContent();
      expect(calldata?.trim()).toBe(expected);

      // Raw calldata is hidden in collapsed <details>; not freely in DOM.
      await expectNoRawCalldataExposed(page, expected);

      // The preview itself is OK: no preview refusal banner.
      await expect(previewWrap.getByTestId("refusal-reason")).toHaveCount(0);

      // The wallet cannot sign it: submit refused, reason visible.
      await expectRefusedForNonAdminWallet(page, c, c.grantBtnId);
    });

    test(`revoke ${c.label}_ROLE: preview matches encoder, no raw calldata exposed`, async ({
      page,
    }) => {
      await connect(page);
      await openTab(page, c.tabId);
      await page.getByTestId(c.inputId).fill(c.account());

      const previewWrap = page.getByTestId(c.revokePreviewId);
      await expect(previewWrap).toBeVisible();

      await expect(previewWrap.getByTestId("tx-preview-fn")).toHaveText("revokeRole");
      await expect(previewWrap.getByTestId("tx-preview-effect")).toContainText(c.roleName);

      const expected = encodeFunctionData({
        abi: ABI,
        functionName: "revokeRole",
        args: [c.role, c.account()],
      });
      const calldata = await previewWrap.getByTestId("tx-preview-calldata").textContent();
      expect(calldata?.trim()).toBe(expected);

      await expectNoRawCalldataExposed(page, expected);
      await expect(previewWrap.getByTestId("refusal-reason")).toHaveCount(0);
      await expectRefusedForNonAdminWallet(page, c, c.revokeBtnId);
    });

    test(`${c.label}_ROLE submit buttons stay disabled with no address`, async ({ page }) => {
      await connect(page);
      await openTab(page, c.tabId);
      // Inputs are empty.
      await expect(page.getByTestId(c.grantBtnId)).toBeDisabled();
      await expect(page.getByTestId(c.revokeBtnId)).toBeDisabled();
    });
  });
}
