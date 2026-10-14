/**
 * Mainnet-class browser check (QA plan U5, issue 1737 item 3).
 *
 * Runs against a bundle built with VITE_ENV_CLASS=mainnet (playwright.mainnet.config.ts), with a mocked
 * `window.ethereum` that sits on one chain and records every method the dapp asks it. It proves, in a
 * real browser, what the unit tests prove with fakes:
 *   - the mainnet banner is always visible;
 *   - a wallet on Ethereum (1) or the Robot Money devnet (918453) gets the wrong-chain gate instead of
 *     the app, so no deposit or approve control exists, and switching to Base lifts the gate;
 *   - no signing or sending method ever reaches the wallet.
 *
 * The chain ids come from the repo constants, never a literal.
 */
import { expect, test, type Page } from "@playwright/test";
import { BASE_MAINNET_CHAIN_ID } from "../../src/lib/writeChainGuard";
import { MAINNET_CHAIN_IDS, ROBOT_MONEY_DEVNET_CHAIN_ID } from "../../src/lib/chainClassifier";

const ETHEREUM_CHAIN_ID = MAINNET_CHAIN_IDS.find((id) => id !== BASE_MAINNET_CHAIN_ID)!;
const ACCOUNT = "0x1111111111111111111111111111111111111111";

/** Methods that sign or send. None may reach the wallet in these specs. */
const SIGN_OR_SEND = [
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
];

/** Install a recording EIP-1193 wallet on `chainId` before the page loads. */
async function installWallet(page: Page, chainId: number) {
  await page.addInitScript(
    ({ startChainId, account }) => {
      const calls: string[] = [];
      let current = startChainId;
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const hex = (n: number) => `0x${n.toString(16)}`;
      const emit = (event: string, ...args: unknown[]) =>
        (listeners[event] ?? []).forEach((fn) => fn(...args));
      const fail = (code: number, message: string) => Object.assign(new Error(message), { code });
      const wallet = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          calls.push(method);
          switch (method) {
            case "eth_chainId":
              return hex(current);
            case "net_version":
              return String(current);
            case "eth_accounts":
            case "eth_requestAccounts":
              return [account];
            case "wallet_requestPermissions":
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_switchEthereumChain": {
              current = Number((params?.[0] as { chainId: string }).chainId);
              emit("chainChanged", hex(current));
              return null;
            }
            case "eth_blockNumber":
              return "0x1";
            case "eth_getBalance":
              return "0x0";
            case "eth_getCode":
              return "0x";
            case "eth_call":
              throw fail(3, "execution reverted");
            default:
              throw fail(4200, `mock wallet: unsupported ${method}`);
          }
        },
        on: (event: string, fn: (...a: unknown[]) => void) => {
          (listeners[event] ??= []).push(fn);
        },
        removeListener: (event: string, fn: (...a: unknown[]) => void) => {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      };
      Object.assign(window, { ethereum: wallet, __walletCalls: calls });
    },
    { startChainId: chainId, account: ACCOUNT },
  );
}

async function walletCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls);
}

test.describe("mainnet-class bundle", () => {
  test("shows the mainnet banner before any wallet connects", async ({ page }) => {
    await page.goto("/");
    const banner = page.getByTestId("mainnet-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(`chain ${BASE_MAINNET_CHAIN_ID}`);
  });

  for (const chainId of [ETHEREUM_CHAIN_ID, ROBOT_MONEY_DEVNET_CHAIN_ID]) {
    test(`a wallet on chain ${chainId} gets the wrong-chain gate and nothing is sent`, async ({
      page,
    }) => {
      await installWallet(page, chainId);
      await page.goto("/");
      await expect(page.getByTestId("mainnet-banner")).toBeVisible();
      await page.getByTestId("connect-wallet").click();

      const gate = page.getByTestId("wrong-chain-gate");
      await expect(gate).toBeVisible();
      await expect(gate).toContainText(`chain ${BASE_MAINNET_CHAIN_ID}`);
      await expect(gate).toContainText(`chain ${chainId}`);
      // The app is replaced by the gate: no deposit, approve or withdraw control exists.
      await expect(page.getByTestId("dapp-surface-tabs")).toHaveCount(0);
      for (const id of ["deposit-submit", "deposit-approve", "withdraw-submit"]) {
        await expect(page.getByTestId(id)).toHaveCount(0);
      }
      await expect(page.getByTestId("mainnet-banner")).toBeVisible();
      expect((await walletCalls(page)).filter((m) => SIGN_OR_SEND.includes(m))).toEqual([]);

      // Switching to Base lifts the gate; still nothing was signed or sent.
      await page.getByTestId("wrong-chain-switch").click();
      await expect(gate).toHaveCount(0);
      await expect(page.getByTestId("dapp-surface-tabs")).toBeVisible();
      expect(await walletCalls(page)).toContain("wallet_switchEthereumChain");
      expect((await walletCalls(page)).filter((m) => SIGN_OR_SEND.includes(m))).toEqual([]);
    });
  }

  test("a wallet on Base sees the app with the banner, and nothing is sent without a click", async ({
    page,
  }) => {
    await installWallet(page, BASE_MAINNET_CHAIN_ID);
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("dapp-surface-tabs")).toBeVisible();
    await expect(page.getByTestId("wrong-chain-gate")).toHaveCount(0);
    await expect(page.getByTestId("mainnet-banner")).toBeVisible();
    // Let reads settle: still no signing or sending method reached the wallet.
    await page.waitForTimeout(2_000);
    expect(await walletCalls(page)).toContain("eth_chainId");
    expect((await walletCalls(page)).filter((m) => SIGN_OR_SEND.includes(m))).toEqual([]);
  });
});
