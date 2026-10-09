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
 *   - the browser wallet cannot grant or revoke directly: after the timelock
 *     handover no EOA holds DEFAULT_ADMIN_ROLE (the admin of ADMIN_ROLE and
 *     DEPOSIT_PAUSER_ROLE) on any chain. The button reads "Create Safe proposal"
 *     and is disabled for a wallet that is not a Safe owner, with the refusal
 *     visible. The real grant through the Safe -> Timelock, signed by Safe
 *     owners, is covered by safe-proposal-role-grant.spec.ts.
 *     (docs/technical/dapp-credential-decisions.md §3.2, 2026-10-07 amendment)
 *
 * The optional on-chain writeContract round-trip is gated by FORK_E2E=1
 * and ships in a sibling spec; we keep this file focused on the UI
 * invariants the acceptance criteria explicitly enumerate.
 */
import { test, expect } from "./helpers/fixtures";
import type { Page } from "@playwright/test";
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toBytes } from "viem";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab, type AdminTabId, type RpcRequest } from "./helpers/wallet";
import { DEFAULT_ADMIN_ROLE, gatewayHasRole } from "./helpers/depositor";
import { loadOwnerKeys } from "./helpers/safeGovernance";

const scheduleAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
]);

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
 * Production behavior for a wallet that is not a Safe owner: the "Create Safe
 * proposal" button is disabled and the panel shows the visible reason.
 */
async function expectRefusedForNonOwnerWallet(page: Page, btnId: string) {
  const prefix = btnId.replace(/-submit$/, "");
  await expect(page.getByTestId(btnId)).toBeDisabled();
  await expect(page.getByTestId(btnId)).toHaveText("Create Safe proposal");
  const reason = page.getByTestId(`${prefix}-safe-refusal`);
  await expect(reason).toBeVisible({ timeout: 60_000 });
  await expect(reason).toContainText("not an owner of the Safe");
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

      // The wallet is not a Safe owner: the proposal button is refused, reason visible.
      await expectRefusedForNonOwnerWallet(page, c.grantBtnId);
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
      await expectRefusedForNonOwnerWallet(page, c.revokeBtnId);
    });

    // Issue 1647: the proposal is a Safe -> Timelock proposal signed by a Safe OWNER, never a wallet
    // transaction from an EOA. The spec asserts that the timelock is the Safe transaction's target,
    // that the timelock call schedules the gateway's grantRole/revokeRole, that the Safe signs typed
    // data (one request, eth_signTypedData_v4) and that no eth_sendTransaction ever reaches the wallet.
    for (const fn of ["grant", "revoke"] as const) {
      test(`${fn} ${c.label}_ROLE by a Safe owner is a Safe -> Timelock proposal, not an EOA transaction`, async ({
        page,
      }) => {
        const owner = loadOwnerKeys(endpoints)[0];
        if (!owner) throw new Error("the harness minted no Safe owner keystore");
        const signRequests: RpcRequest[] = [];
        await openDapp(page, endpoints, { privateKey: owner.privateKey, signRequests });
        await openTab(page, c.tabId);
        await page.getByTestId(c.inputId).fill(c.account());
        const btnId = fn === "grant" ? c.grantBtnId : c.revokeBtnId;
        const prefix = btnId.replace(/-submit$/, "");

        // The panel names the REAL Safe and timelock of the devnet topology.
        await expect(page.getByTestId(`${prefix}-safe-address`)).toHaveText(
          new RegExp(`^${endpoints.safe_addr}$`, "i"),
          { timeout: 90_000 },
        );
        await expect(page.getByTestId(`${prefix}-timelock-address`)).toHaveText(
          new RegExp(`^${endpoints.timelock_addr}$`, "i"),
        );
        await expect(page.getByTestId(btnId)).toHaveText("Create Safe proposal");

        // The Safe transaction calls the timelock, and the timelock schedules the role call on the gateway.
        const typed = JSON.parse(
          (await page.getByTestId(`${prefix}-typed-data`).textContent()) ?? "{}",
        ) as { message: { to: string; data: `0x${string}` } };
        expect(typed.message.to.toLowerCase()).toBe(endpoints.timelock_addr.toLowerCase());
        const scheduled = decodeFunctionData({ abi: scheduleAbi, data: typed.message.data });
        const [target, , inner] = scheduled.args;
        expect(target.toLowerCase()).toBe(endpoints.gateway_addr.toLowerCase());
        expect(inner).toBe(
          encodeFunctionData({
            abi: ABI,
            functionName: fn === "grant" ? "grantRole" : "revokeRole",
            args: [c.role, c.account()],
          }),
        );
        // Rendering the proposal asks the wallet for nothing.
        expect(signRequests).toHaveLength(0);

        if (fn === "grant") {
          const button = page.getByTestId(btnId);
          await expect(button).toBeEnabled({ timeout: 90_000 });
          await button.click();
          await expect(page.getByTestId(`${prefix}-signature-count`)).toContainText("1 of 2", {
            timeout: 60_000,
          });
          // One typed-data signature for the Safe; never a transaction from the wallet.
          expect(signRequests.map((r) => r.method)).toEqual(["eth_signTypedData_v4"]);
        }
      });
    }

    test(`${c.label}_ROLE offers no proposal button until an address is entered`, async ({
      page,
    }) => {
      await connect(page);
      await openTab(page, c.tabId);
      // Inputs are empty: no preview, so no proposal and no button.
      await expect(page.getByTestId(c.grantBtnId)).toHaveCount(0);
      await expect(page.getByTestId(c.revokeBtnId)).toHaveCount(0);
    });
  });
}
