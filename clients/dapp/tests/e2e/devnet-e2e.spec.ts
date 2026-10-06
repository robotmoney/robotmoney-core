/**
 * Playwright E2E — full-stack Twin chain smoke.
 *
 * devnet-global-setup.ts has already booted `cargo run -p smoke-test --
 * --full-stack` and written the endpoint summary (URLs, contract
 * addresses, test-EOA private keys) to DEVNET_ENDPOINTS_FILE.
 *
 * Asserts:
 *   (A) The dapp, built with the deployed gateway's runtime hash pinned,
 *       renders the gateway address in the DOM once the admin wallet
 *       connects. Verifies that the prod-bit-identical bundle reaches
 *       the verified state against a real chain.
 *   (B) A depositor authorizing its own agent through the dapp's prod
 *       injected() connector (commitAuthorization + revealAuthorization,
 *       no ADMIN_ROLE) mines on the Twin chain, sets AGENT_ROLE on-chain
 *       and records the depositor as agentOwner. After the timelock
 *       handover no EOA holds ADMIN_ROLE on any chain, so this is the
 *       production registration path (docs/architecture.md §6).
 *
 * Canonical: docs/development/smoke-test-design.md, issue #245.
 */

import { test, expect } from "./helpers/fixtures";
import { setTimeout as sleep } from "node:timers/promises";
import type { Address, Hex } from "viem";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { agentOwnerOf, freshDepositor } from "./helpers/depositor";
import { injectWallet, connectInjectedWallet, dismissOnboardingIfPresent } from "./helpers/wallet";

// keccak256("AGENT_ROLE") — matches contracts/gateway/AccessRoles.sol.
const AGENT_ROLE = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

// Polling params tuned for real Geth block times (~12s per block).
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(`eth_call error: ${j.error.message}`);
  return j.result ?? "0x";
}

async function hasRole(
  rpc: string,
  gateway: string,
  role: string,
  account: string,
): Promise<boolean> {
  // hasRole(bytes32,address) selector = 0x91d14854
  const accountPadded = account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const rolePadded = role.toLowerCase().replace(/^0x/, "");
  const data = `0x91d14854${rolePadded}${accountPadded}`;
  const result = await ethCall(rpc, gateway, data);
  return /1$/.test(result.trim());
}

async function waitForRole(
  rpc: string,
  gateway: string,
  role: string,
  account: string,
  expectValue: boolean,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: boolean | null = null;
  while (Date.now() < deadline) {
    last = await hasRole(rpc, gateway, role, account);
    if (last === expectValue) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `devnet-e2e: timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for ` +
      `hasRole(${role.slice(0, 10)}…, ${account}) === ${expectValue}; ` +
      `last observed: ${last}`,
  );
}

test.describe("devnet E2E — full-stack Twin chain", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("(A) dapp renders the deployed gateway address in the DOM", async ({ page }) => {
    await injectWallet(page, {
      privateKey: endpoints.admin_private_key as Hex,
      rpcUrl: endpoints.rpc_url,
      chainId: endpoints.chain_id,
    });
    await page.goto(endpoints.dapp_url);
    await connectInjectedWallet(page);
    await dismissOnboardingIfPresent(page);

    // Verification must pass — the dapp container was built with the
    // real runtime hash. StatusHeader then renders the gateway address
    // (always-visible). It is shown in abbreviated form `0xABCD…WXYZ`
    // (case-insensitive: smoke-test emits lowercase, dapp may render
    // EIP-55 checksummed form). Either form satisfies the assertion.
    await expect(page.getByTestId("gateway-verification-ok")).toBeVisible({ timeout: 30_000 });
    const escaped = endpoints.gateway_addr.replace(/^0x/, "");
    const head = escaped.slice(0, 4);
    const tail = escaped.slice(-4);
    const re = new RegExp(`0x${head}…${tail}|0x${escaped}`, "i");
    await expect(page.getByText(re).first()).toBeVisible({ timeout: 30_000 });
  });

  test("(B) authorizeAgent mines on Geth and AGENT_ROLE is confirmed on-chain", async ({
    page,
  }) => {
    // A fresh depositor wallet (gas funded through the Twin "fund gas" step,
    // no role) authorizes its own agent. The gateway requires a caller
    // without ADMIN_ROLE to name itself as shareReceiver, so it does.
    const depositor = await freshDepositor(endpoints);
    await injectWallet(page, {
      privateKey: depositor.privateKey,
      rpcUrl: endpoints.rpc_url,
      chainId: endpoints.chain_id,
    });
    await page.goto(endpoints.dapp_url);
    await connectInjectedWallet(page);
    await dismissOnboardingIfPresent(page);

    // Per issue #269, authorization reverts with `AgentAlreadyOwned` if the
    // agent address already has an owner. The publish run authorized
    // `endpoints.agent_addr` at deploy time. Use a fresh, deterministic-but-
    // unused address instead so the reveal transaction does not revert.
    const FRESH_AGENT_ADDR = "0x000000000000000000000000000000000000BB01" as Address;
    await page.getByTestId("agent-input").fill(FRESH_AGENT_ADDR);
    await page.getByTestId("shareReceiver-input").fill(depositor.address);

    const authorizePreview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(authorizePreview).toBeVisible({ timeout: 30_000 });

    // Step 1 of 2: commit — signs commitAuthorization(keccak256(agent,caller,salt)).
    await page.getByTestId("authorize-submit").click();

    // Step 2 of 2: reveal — enabled once currentBlock > commitBlockNumber.
    const revealSubmit = page.getByTestId("authorize-reveal-submit");
    await expect(revealSubmit).toBeEnabled({ timeout: 60_000 });
    await revealSubmit.click();

    console.log(
      `devnet-e2e: polling for AGENT_ROLE on ${endpoints.rpc_url}, ` +
        `gateway=${endpoints.gateway_addr}, agent=${FRESH_AGENT_ADDR}, depositor=${depositor.address}`,
    );
    await waitForRole(
      endpoints.rpc_url,
      endpoints.gateway_addr,
      AGENT_ROLE,
      FRESH_AGENT_ADDR,
      true,
    );
    // The depositor, not any admin, is the recorded owner: only it can
    // setPolicy / revokeAgent this agent from now on.
    expect((await agentOwnerOf(endpoints, FRESH_AGENT_ADDR)).toLowerCase()).toBe(
      depositor.address.toLowerCase(),
    );
    console.log("devnet-e2e: AGENT_ROLE confirmed on-chain, agentOwner is the depositor.");
  });

  // Issue #463 — the main-page balances panel must be visible after wallet
  // connect on devnet and surface USDC, ETH, and RM rows. The smoke-test
  // fixture seeds the admin EOA with USDC and RM, so non-zero balances are
  // expected; however the AC only requires that the panel renders with the
  // correct symbols, so we assert presence and symbols rather than exact
  // values (devnet seed amounts are not stable across runs).
  test("(C) main-page balances panel shows USDC/ETH/RM rows after wallet connect", async ({
    page,
  }) => {
    await injectWallet(page, {
      privateKey: endpoints.admin_private_key as Hex,
      rpcUrl: endpoints.rpc_url,
      chainId: endpoints.chain_id,
    });
    await page.goto(endpoints.dapp_url);
    await connectInjectedWallet(page);
    await dismissOnboardingIfPresent(page);

    await expect(page.getByTestId("balances-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("balances-panel-row-usdc")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("balances-panel-row-eth")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("balances-panel-row-usdc-symbol")).toHaveText("USDC", {
      timeout: 30_000,
    });
    // The dapp build under test is the devnet build which exports
    // VITE_RM_TOKEN_ADDRESS, so the RM row is expected to render.
    await expect(page.getByTestId("balances-panel-row-rm")).toBeVisible({ timeout: 30_000 });
  });
});
