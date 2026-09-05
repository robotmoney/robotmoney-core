// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * Live registry-decode coverage — BalancesPanel receipt rows (issue #1348).
 *
 * This is the only assertion in the suite that depends on the dapp
 * successfully decoding `VaultRegistry.getVault` against a real chain.
 *
 * Why it is needed: `getVault` returns TWO top-level outputs
 * (`VaultMetadata`, `status`). `abi.ts` previously declared a single 9-field
 * tuple, so every decode failed. `VaultRegistryContext` swallows per-call
 * failures (`if (result.status !== "success") continue`), so a broken decode
 * degrades SILENTLY to an empty vault list — nothing throws, nothing logs.
 * `BalancesPanel` (mounted app-wide, `main.tsx:160`) is the only mounted
 * consumer of the resulting `VaultRecord[]`, and it renders one receipt row
 * per registered vault the wallet holds shares in. So:
 *
 *   decode broken -> vaults = [] -> no receipt rows -> this spec is RED.
 *
 * Every other dapp-e2e assertion about vaults reads the explorer API
 * (`GET /v1/vaults`, `GET /v1/accounts/:address/positions`) rather than the
 * registry, so none of them can catch a registry decode regression.
 * Deliberately assert the receipt ROW, not merely that the panel renders —
 * the panel renders fine with an empty vault list, which is exactly the
 * false-green this spec exists to prevent.
 *
 * The wallet must actually hold shares for the row to be legitimate, and the
 * demo seeder funds derived depositor EOAs rather than the admin EOA, so this
 * spec makes its own signed deposit first rather than depending on state left
 * behind by another spec.
 */
import { test, expect } from "@playwright/test";
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
import { openDapp } from "./helpers/wallet";
import { erc20Abi, vaultAbi } from "../../src/lib/abi";

/** 5 USDC (6 decimals) — enough to mint a clearly non-zero share balance. */
const DEPOSIT_USDC = 5_000_000n;

/** Raw `vault.balanceOf(who)` via eth_call — no wallet needed. */
async function vaultBalanceOf(rpc: string, vault: string, who: string): Promise<bigint> {
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: "balanceOf",
    args: [who as Address],
  });
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: vault, data }, "latest"],
    }),
  });
  const j = (await res.json()) as { result?: string };
  return j.result && j.result !== "0x" ? BigInt(j.result) : 0n;
}

/** Sign USDC.approve(vault, amount) + vault.deposit(amount, admin) and await both. */
async function depositAsAdmin(endpoints: DevnetEndpoints, amount: bigint): Promise<void> {
  const account = privateKeyToAccount(endpoints.admin_private_key as Hex);
  const wallet = createWalletClient({ account, transport: http(endpoints.rpc_url) });
  const publicClient = createPublicClient({ transport: http(endpoints.rpc_url) });

  const approveTx = await wallet.sendTransaction({
    chain: null,
    to: endpoints.usdc_addr as Address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [endpoints.vault_addr as Address, amount],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });

  const depositTx = await wallet.sendTransaction({
    chain: null,
    to: endpoints.vault_addr as Address,
    data: encodeFunctionData({
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount, account.address],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx, timeout: 60_000 });
}

test.describe("VaultRegistry getVault decode — live receipt rows", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("BalancesPanel renders a receipt row for a registry-listed vault the wallet holds", async ({
    page,
  }) => {
    // The primary vault is registered with the registry at deploy time
    // (contracts/script/DeployVaultRegistry.s.sol), so it appears in
    // listVaults() and must therefore decode through getVault().
    await depositAsAdmin(endpoints, DEPOSIT_USDC);

    // Guard against a vacuous UI assertion: confirm on-chain that the wallet
    // really does hold shares, so a missing row means a decode/derivation
    // fault rather than an empty position.
    const shares = await vaultBalanceOf(
      endpoints.rpc_url,
      endpoints.vault_addr,
      endpoints.admin_addr,
    );
    expect(
      shares,
      "admin must hold vault shares for the receipt row to be expected",
    ).toBeGreaterThan(0n);

    await openDapp(page, endpoints, { role: "admin" });

    await expect(page.getByTestId("balances-panel")).toBeVisible({ timeout: 30_000 });

    // The discriminating assertion. Address casing follows whatever
    // listVaults() returns (viem checksums it), so match case-insensitively.
    const receiptRow = page.locator(
      `[data-testid="balances-panel-row-receipt-${endpoints.vault_addr}" i]`,
    );
    await expect(
      receiptRow,
      "no receipt row for a registry-listed vault the wallet holds shares in — " +
        "VaultRegistryContext decoded zero vaults, which means registryAbi.getVault " +
        "has drifted from VaultRegistry.sol again (issue #1348)",
    ).toBeVisible({ timeout: 60_000 });

    // The row is populated from a real ERC-4626 read off the vault address
    // derived from the decoded record, so both cells must carry real values.
    const symbol = page.locator(
      `[data-testid="balances-panel-row-receipt-${endpoints.vault_addr}-symbol" i]`,
    );
    const amount = page.locator(
      `[data-testid="balances-panel-row-receipt-${endpoints.vault_addr}-amount" i]`,
    );
    await expect(symbol).not.toBeEmpty();
    await expect(amount).not.toBeEmpty();
    await expect(amount).not.toContainText("undefined");
  });
});
