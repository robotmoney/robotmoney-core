/**
 * Playwright wallet injection helper.
 *
 * Installs a minimal EIP-1193 provider as `window.ethereum` *before*
 * any dapp code loads, so the dapp's production `injected()` wagmi
 * connector picks it up exactly as it would pick up MetaMask. No
 * test-only code in the dapp bundle — the only seam is at the browser
 * level.
 *
 * Read methods (eth_call, eth_getBlockByNumber, …) are forwarded to
 * the real RPC URL via fetch().
 * Write methods (eth_sendTransaction, personal_sign, eth_sign,
 * eth_signTypedData*) are forwarded to viem in the Node-side test
 * runner via Playwright `exposeBinding`, then signed and broadcast
 * with the supplied private key.
 */
import type { Page } from "@playwright/test";
import { createWalletClient, http, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DevnetEndpoints } from "./devnet";

interface InjectWalletOptions {
  privateKey: Hex;
  rpcUrl: string;
  chainId: number;
}

interface RpcRequest {
  method: string;
  params?: unknown[];
}

const FORWARDED_WRITE_METHODS = new Set([
  "eth_sendTransaction",
  "eth_signTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
]);

/**
 * Inject a browser-side EIP-1193 provider that signs writes with
 * `privateKey` and forwards reads to `rpcUrl`.
 *
 * Must be awaited before the first `page.goto()` so the provider is
 * present at module-evaluation time of the dapp bundle.
 */
export async function injectWallet(page: Page, opts: InjectWalletOptions): Promise<void> {
  const account = privateKeyToAccount(opts.privateKey);
  const walletClient = createWalletClient({
    account,
    transport: http(opts.rpcUrl),
  });

  await page.exposeBinding("__rmpcRpc", async (_source, body: unknown) => {
    const res = await fetch(opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  });

  await page.exposeBinding("__rmpcSign", async (_source, req: RpcRequest) => {
    switch (req.method) {
      case "eth_sendTransaction": {
        const [tx] = (req.params ?? []) as Array<{
          to?: Address;
          data?: Hex;
          value?: Hex;
          gas?: Hex;
        }>;
        return walletClient.sendTransaction({
          chain: null,
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });
      }
      case "personal_sign":
      case "eth_sign": {
        const params = (req.params ?? []) as Hex[];
        // personal_sign: [data, address]; eth_sign: [address, data]
        const message = req.method === "personal_sign" ? params[0] : params[1];
        return walletClient.signMessage({ message: { raw: message } });
      }
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        const params = (req.params ?? []) as [Address, string];
        const typedData = JSON.parse(params[1]);
        return walletClient.signTypedData(typedData);
      }
      default:
        throw new Error(`Unhandled signing method: ${req.method}`);
    }
  });

  await page.addInitScript(
    ({
      address,
      chainIdHex,
      writeMethods,
    }: {
      address: string;
      chainIdHex: string;
      writeMethods: string[];
    }) => {
      const writeSet = new Set(writeMethods);
      let nextId = 1;
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

      const provider = {
        isMetaMask: false,
        isRobotMoneyTestWallet: true,
        chainId: chainIdHex,
        selectedAddress: address,
        async request(req: { method: string; params?: unknown[] }) {
          switch (req.method) {
            case "eth_accounts":
            case "eth_requestAccounts":
              return [address];
            case "eth_chainId":
            case "net_version":
              return chainIdHex;
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            default:
              break;
          }
          if (writeSet.has(req.method)) {
            return (
              window as unknown as {
                __rmpcSign: (r: { method: string; params?: unknown[] }) => Promise<unknown>;
              }
            ).__rmpcSign({ method: req.method, params: req.params });
          }
          const result = (await (
            window as unknown as {
              __rmpcRpc: (
                body: unknown,
              ) => Promise<{ result?: unknown; error?: { message: string } }>;
            }
          ).__rmpcRpc({
            jsonrpc: "2.0",
            id: nextId++,
            method: req.method,
            params: req.params ?? [],
          })) as { result?: unknown; error?: { message: string } };
          if (result.error) throw new Error(result.error.message);
          return result.result;
        },
        on(event: string, handler: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(handler);
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
          const list = listeners[event];
          if (!list) return;
          const i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
        },
      };
      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: false,
      });
    },
    {
      address: account.address,
      chainIdHex: `0x${opts.chainId.toString(16)}`,
      writeMethods: Array.from(FORWARDED_WRITE_METHODS),
    },
  );
}

/**
 * Click the unified "Connect wallet" button. Use after `injectWallet`
 * and `page.goto()`. The button is rendered by StatusHeader (and as a
 * fallback by AgentsPanel when the gate is active).
 */
export async function connectInjectedWallet(page: Page): Promise<void> {
  const { expect } = await import("@playwright/test");
  const button = page.getByTestId("connect-wallet").first();
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByTestId("connected-address")).toBeVisible({ timeout: 10_000 });
}

/**
 * Combined "open the dapp as <role>" setup: inject the role's wallet
 * provider, navigate to the smoke-test dapp URL, and (optionally)
 * connect. The default role is `admin` (the gateway deployer).
 */
export async function openDapp(
  page: Page,
  endpoints: DevnetEndpoints,
  opts: { role?: "admin" | "pauser" | "agent"; connect?: boolean } = {},
): Promise<void> {
  const role = opts.role ?? "admin";
  const privateKey = (
    role === "pauser"
      ? endpoints.pauser_private_key
      : role === "agent"
        ? endpoints.agent_private_key
        : endpoints.admin_private_key
  ) as Hex;
  await injectWallet(page, {
    privateKey,
    rpcUrl: endpoints.rpc_url,
    chainId: endpoints.chain_id,
  });
  await page.goto(endpoints.dapp_url);
  if (opts.connect !== false) {
    await connectInjectedWallet(page);
  }
  // fork/devnet env classes bypass the registration gate
  // (see useVaultRegistration.ts), so AdminFlow mounts directly.
}

/**
 * Activate a named tab in the AdminFlow. Tabs render only the active
 * panel into the DOM, so specs must call this before interacting with
 * any form testid that lives inside a tab.
 */
export type AdminTabId =
  | "authorize"
  | "deposit-withdraw"
  | "pause"
  | "revoke"
  | "rotation"
  | "admin-role"
  | "pauser-role"
  | "faucet"
  | "history"
  | "export";

export async function openTab(page: Page, tabId: AdminTabId): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click();
  await page.getByTestId(`tabpanel-${tabId}`).waitFor({ state: "visible" });
}
