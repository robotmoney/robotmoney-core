/**
 * Playwright E2E — Deposit/Withdraw tab end-to-end against the
 * smoke-test full-stack Geth+Lighthouse devnet (issue #257).
 *
 * Flow:
 *   1. Boot devnet via globalSetup.
 *   2. Use the harness USDC holder private key to top up the admin EOA
 *      with the deposit amount via a plain ERC-20 `transfer`.
 *   3. Open the dapp as admin, navigate to the Deposit/Withdraw tab.
 *   4. Drive Approve → Deposit and assert `vault.balanceOf(admin)`
 *      increases.
 *   5. Drive Withdraw (redeem all rmUSDC) and assert
 *      `vault.balanceOf(admin)` decreases and `USDC.balanceOf(admin)`
 *      is credited back within `exitFeeBps` tolerance.
 *
 * The same dapp bundle that ships is what CI exercises — no
 * test-only code paths in the dapp.
 */
import { test, expect } from "./helpers/fixtures";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";
import { erc20Abi, vaultAbi } from "../../src/lib/abi";

const DEPOSIT_USDC = 10_000_000n; // 10 USDC, 6 decimals
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

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

async function readUint(rpc: string, to: string, data: string): Promise<bigint> {
  const hex = await ethCall(rpc, to, data);
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

async function usdcBalanceOf(rpc: string, usdc: string, who: string): Promise<bigint> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [who as Address],
  });
  return readUint(rpc, usdc, data);
}

async function vaultBalanceOf(rpc: string, vault: string, who: string): Promise<bigint> {
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: "balanceOf",
    args: [who as Address],
  });
  return readUint(rpc, vault, data);
}

async function exitFeeBps(rpc: string, vault: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "exitFeeBps", args: [] });
  return readUint(rpc, vault, data);
}

/**
 * Top up `recipient` with `amount` USDC by signing an ERC-20 transfer
 * from the harness USDC holder. Mirrors the Rust fork-e2e fixture's
 * `Fixture::fund_usdc` path.
 *
 * IMPORTANT: this awaits the transaction *receipt*, not just the
 * broadcast. Without that, subsequent `usdcBalanceOf` reads race past
 * the unmined fund tx and the deposit assertion observes a phantom
 * USDC credit when the fund tx finally lands (admin's balance goes
 * UP by `amount - DEPOSIT_USDC` instead of DOWN by DEPOSIT_USDC).
 */
async function fundUsdc(
  endpoints: DevnetEndpoints,
  recipient: Address,
  amount: bigint,
): Promise<void> {
  const account = privateKeyToAccount(endpoints.harness_usdc_holder_private_key as Hex);
  const wallet = createWalletClient({ account, transport: http(endpoints.rpc_url) });
  const publicClient = createPublicClient({ transport: http(endpoints.rpc_url) });
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amount],
  });
  const hash = await wallet.sendTransaction({
    chain: null,
    to: endpoints.usdc_addr as Address,
    data,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

async function waitUntil<T>(predicate: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v !== null) return v;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`vault-deposit-withdraw: timed out waiting for ${description}`);
}

test.describe("Deposit & Withdraw tab — vault round-trip on smoke-test devnet", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("approve+deposit then redeem mines real txs and updates balances", async ({ page }) => {
    // Pre-fund the admin EOA with USDC from the harness holder.
    await fundUsdc(endpoints, endpoints.admin_addr as Address, DEPOSIT_USDC * 2n);

    await openDapp(page, endpoints, { role: "admin" });
    await openTab(page, "deposit-withdraw");

    // Shared VaultPositionCard is visible in the withdraw section (issue #381).
    // selectedVault defaults to props.vaultAddress so the card renders immediately.
    await expect(page.getByTestId("vault-position-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("vault-position-card-shares")).toBeVisible();

    const admin = endpoints.admin_addr;
    const usdcStart = await usdcBalanceOf(endpoints.rpc_url, endpoints.usdc_addr, admin);
    const sharesStart = await vaultBalanceOf(endpoints.rpc_url, endpoints.vault_addr, admin);

    // ---- Deposit half ----
    // Enter 10 USDC.
    await page.getByTestId("deposit-amount").fill("10");

    // Structured preview renders for the deposit.
    const depositPreviewFn = page.getByTestId("deposit-form").getByTestId("tx-preview-fn");
    await expect(depositPreviewFn).toContainText("deposit", { timeout: 10_000 });

    // Submit is disabled until allowance is sufficient.
    const submit = page.getByTestId("deposit-submit");
    await expect(submit).toBeDisabled();

    // Approve USDC.
    const approve = page.getByTestId("deposit-approve");
    await expect(approve).toBeEnabled({ timeout: 30_000 });
    await approve.click();

    // Wait for allowance to land on-chain and submit to enable.
    await expect(submit).toBeEnabled({ timeout: 60_000 });
    await submit.click();

    // Poll until vault.balanceOf(admin) strictly increased.
    const sharesAfter = await waitUntil(async () => {
      const cur = await vaultBalanceOf(endpoints.rpc_url, endpoints.vault_addr, admin);
      return cur > sharesStart ? cur : null;
    }, "vault.balanceOf(admin) to increase after deposit");
    expect(sharesAfter).toBeGreaterThan(sharesStart);

    const usdcAfterDeposit = await usdcBalanceOf(endpoints.rpc_url, endpoints.usdc_addr, admin);
    // USDC should have been pulled by the vault.
    expect(usdcStart - usdcAfterDeposit).toBeGreaterThanOrEqual(DEPOSIT_USDC);

    // ---- Withdraw half ----
    // Withdraw all newly minted shares (sharesAfter - sharesStart).
    const sharesToRedeem = sharesAfter - sharesStart;
    // Format shares as a 6-decimal decimal string the input accepts.
    const whole = sharesToRedeem / 1_000_000n;
    const frac = (sharesToRedeem % 1_000_000n).toString().padStart(6, "0");
    const sharesInput = `${whole}.${frac}`;

    await page.getByTestId("withdraw-amount").fill(sharesInput);

    const redeemPreviewFn = page.getByTestId("withdraw-form").getByTestId("tx-preview-fn");
    await expect(redeemPreviewFn).toContainText("redeem", { timeout: 10_000 });

    const withdrawSubmit = page.getByTestId("withdraw-submit");
    await expect(withdrawSubmit).toBeEnabled({ timeout: 30_000 });
    await withdrawSubmit.click();

    // Poll until shares strictly decreased and USDC was credited back.
    const sharesAfterRedeem = await waitUntil(async () => {
      const cur = await vaultBalanceOf(endpoints.rpc_url, endpoints.vault_addr, admin);
      return cur < sharesAfter ? cur : null;
    }, "vault.balanceOf(admin) to decrease after redeem");
    expect(sharesAfterRedeem).toBeLessThan(sharesAfter);

    const usdcFinal = await usdcBalanceOf(endpoints.rpc_url, endpoints.usdc_addr, admin);

    // USDC delta over the full round-trip must be within exitFeeBps of zero.
    // (Some rounding tolerance accepted: 1 base unit.)
    const fee = await exitFeeBps(endpoints.rpc_url, endpoints.vault_addr);
    const tolerated = (DEPOSIT_USDC * fee) / 10_000n + 1n;
    const lost = usdcStart - usdcFinal;
    expect(lost).toBeLessThanOrEqual(tolerated);
  });
});
