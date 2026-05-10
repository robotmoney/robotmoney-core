/**
 * Playwright E2E — full-stack Geth+Lighthouse devnet.
 *
 * Gated by DEVNET_E2E_ENABLED=1. Without that flag the entire describe
 * block is skipped so `pnpm test:e2e` stays green with no extra deps.
 *
 * When enabled, devnet-global-setup.ts has already:
 *   1. Booted `cargo run --bin smoke-test -- --full-stack`.
 *   2. Parsed the endpoint summary and written it to a JSON file whose
 *      path is in DEVNET_ENDPOINTS_FILE.
 *   3. Set baseURL in the Playwright config to the dapp_url from the
 *      summary (done via playwright.config.ts conditional logic).
 *
 * This spec asserts:
 *   (A) The dapp renders the correct gateway address injected at build time.
 *   (B) The mock-wallet connector submits an authorizeAgent transaction that
 *       mines on real Geth (12s block time). We poll eth_call with a 120s
 *       timeout and 3s interval until AGENT_ROLE is confirmed on-chain.
 *
 * Canonical: docs/implementation-plan.md §10.5, issue #230.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { DevnetEndpoints } from "./devnet-global-setup";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const ENABLED = process.env.DEVNET_E2E_ENABLED === "1";

// keccak256("AGENT_ROLE") — matches contracts/gateway/AccessRoles.sol.
// Hard-coded constant to avoid a round-trip; the fork-roundtrip spec
// validates this at runtime against the deployed contract.
const AGENT_ROLE = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

// Polling params tuned for real Geth block times (~12s per block).
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Endpoint loading
// ---------------------------------------------------------------------------

function loadEndpoints(): DevnetEndpoints {
  const file = process.env.DEVNET_ENDPOINTS_FILE;
  if (!file) {
    throw new Error(
      "devnet-e2e: DEVNET_ENDPOINTS_FILE is not set. " +
        "Make sure devnet-global-setup ran successfully.",
    );
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as DevnetEndpoints;
  } catch (err) {
    throw new Error(`devnet-e2e: failed to read endpoints file ${file}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// eth_call helpers (same pattern as fork-roundtrip.spec.ts)
// ---------------------------------------------------------------------------

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

/**
 * Poll hasRole until it returns `expectValue` or POLL_TIMEOUT_MS elapses.
 * Uses POLL_INTERVAL_MS between checks to be kind to real Geth (~12s blocks).
 */
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

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe("devnet E2E — full-stack Geth+Lighthouse", () => {
  test.skip(!ENABLED, "DEVNET_E2E_ENABLED=1 not set; full-stack devnet not booted.");

  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("(A) dapp renders the deployed gateway address in the DOM", async ({ page }) => {
    // Navigate to the dapp (baseURL is set to dapp_url by playwright.config.ts
    // when DEVNET_E2E_ENABLED=1).
    await page.goto("/");

    // The gateway address is baked into the dapp at build time via
    // VITE_GATEWAY_ADDRESS and rendered inside the AdminFlow as part of the
    // verification status section or elsewhere in the DOM.
    // We assert the checksummed address text appears anywhere on the page.
    const gatewayAddr = endpoints.gateway_addr;
    // Normalize to lowercase for comparison because the dapp may render
    // checksummed (EIP-55) form.
    const gatewayLower = gatewayAddr.toLowerCase();
    const locator = page.locator(`text=${gatewayAddr}`).or(page.locator(`text=${gatewayLower}`));
    await expect(locator.first()).toBeVisible({ timeout: 30_000 });
  });

  test("(B) authorizeAgent mines on Geth and AGENT_ROLE is confirmed on-chain", async ({
    page,
  }) => {
    // Use the devnet agent address from smoke-test lib.
    // The agent EOA derives from AGENT_PRIVATE_KEY in testing/smoke-test/src/lib.rs
    // (0xf93Ee4Cf8c6c40b329b0c0626F28333c132CF241 — printed in fixture stdout as
    // `agent_addr=0x...`). We read it from the endpoint JSON instead of hard-coding.
    // The share-receiver address is similarly fixed by the devnet fixture.
    // We use a known devnet-fixture secondary EOA for share_receiver.
    const SHARE_RECEIVER = "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec";

    // Derive agent address from the endpoint summary (smoke-test prints `agent_addr=`
    // as a plain kv line before the endpoint summary block).
    // If not present in the endpoints file, fall back to the known fixture constant.
    const agentAddr = endpoints.agent_addr ?? "0xf93Ee4Cf8c6c40b329b0c0626F28333c132CF241";

    await page.goto("/");

    // Connect via the mock wallet connector.
    await page.getByTestId("connect-mock").click();
    await expect(page.getByTestId("connected-address")).toBeVisible({ timeout: 10_000 });

    // Fill the authorize form.
    await page.getByTestId("agent-input").fill(agentAddr);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    // Wait for a valid (ok) preview to appear.
    const authorizePreview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(authorizePreview).toBeVisible({ timeout: 15_000 });

    // Submit the authorizeAgent transaction.
    await page.getByTestId("authorize-submit").click();

    // Poll eth_call until AGENT_ROLE is set on-chain.
    // Real Geth mines ~12s per block; we allow up to 120s total.
    console.log(
      `devnet-e2e: polling for AGENT_ROLE on ${endpoints.rpc_url}, ` +
        `gateway=${endpoints.gateway_addr}, agent=${agentAddr}`,
    );
    await waitForRole(endpoints.rpc_url, endpoints.gateway_addr, AGENT_ROLE, agentAddr, true);

    console.log("devnet-e2e: AGENT_ROLE confirmed on-chain.");
  });
});
