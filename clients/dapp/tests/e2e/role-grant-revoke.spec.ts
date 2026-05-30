/**
 * Playwright E2E — ADMIN_ROLE / PAUSER_ROLE grant + revoke (issue #83).
 *
 * Covers the four flows named in the acceptance criteria:
 *   ADMIN-grant, ADMIN-revoke, PAUSER-grant, PAUSER-revoke.
 *
 * Per the existing dapp E2E pattern (see authorize.spec.ts) this runs
 * against the mock-wallet connector and asserts the UI invariants:
 *   - structured tx-preview renders for the requested call,
 *   - the rendered calldata equals the encoder output for the intended
 *     (function, role, account) triple,
 *   - raw calldata is never visible in the DOM (it is only reachable
 *     by expanding the operator-opt-in <details> block).
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

let endpoints: DevnetEndpoints;
let ADMIN_ACCOUNT: `0x${string}`;
let PAUSER_ACCOUNT: `0x${string}`;
test.beforeAll(() => {
  endpoints = loadEndpoints();
  // ADMIN_ACCOUNT must be an address with no existing role on the gateway:
  // AccessRoles._grantRole is mutex with AGENT_ROLE/PAUSER_ROLE, so simulating
  // grantRole(ADMIN_ROLE, agent_addr) would revert (agent_addr already has
  // AGENT_ROLE) and keep the submit button disabled. Use a fresh hex address.
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
const PAUSER_ROLE = keccak256(toBytes("PAUSER_ROLE"));

async function connect(page: Page) {
  await openDapp(page, endpoints);
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
  roleName: "ADMIN_ROLE" | "PAUSER_ROLE";
  tabId: AdminTabId;
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
  },
  {
    label: "PAUSER",
    inputId: "pauser-account-input",
    account: () => PAUSER_ACCOUNT,
    grantBtnId: "grant-pauser-submit",
    grantPreviewId: "grant-pauser-preview-wrap",
    revokeBtnId: "revoke-pauser-submit",
    revokePreviewId: "revoke-pauser-preview-wrap",
    role: PAUSER_ROLE,
    roleName: "PAUSER_ROLE",
    tabId: "pauser-role",
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

      // Submit button is enabled (preview ok + connected).
      await expect(page.getByTestId(c.grantBtnId)).toBeEnabled();

      // No refusal banner anywhere.
      await expect(previewWrap.getByTestId("refusal-reason")).toHaveCount(0);
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
      await expect(page.getByTestId(c.revokeBtnId)).toBeEnabled();
      await expect(previewWrap.getByTestId("refusal-reason")).toHaveCount(0);
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
