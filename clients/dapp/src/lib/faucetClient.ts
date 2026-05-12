/**
 * Faucet client — drips canonical USDC into a recipient address on the
 * smoke-test full-stack devnet by signing a plain ERC-20
 * `transfer(address,uint256)` from the harness USDC holder EOA.
 *
 * Scout-time architectural decision (issue #261 scope, recorded in the
 * PR description): we bake the harness holder private key into the
 * dapp bundle ONLY in devnet/testnet builds via the build-time env var
 * `VITE_FAUCET_HARNESS_PRIVATE_KEY`. Mainnet operator builds leave the
 * variable unset, so even if a user manually drove the wallet to
 * chain-id 1 the faucet code path has no signer to sign with and the
 * FaucetTab early-returns "unavailable" — defence in depth on top of
 * the chain-ID gate in `chainClassifier.ts`. This path keeps the dapp
 * `rmpc`-faithful (no test-only branches in production builds) while
 * matching the canonical funding mechanism from #255's
 * `Fixture::fund_usdc` (real ERC-20 transfer from
 * `HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`) — no `anvil_*` cheats, no
 * impersonation. The signature is recoverable and the `Transfer` event
 * fires for the indexer.
 *
 * Read-side (`balanceOf`) routes through the user's wallet provider via
 * wagmi's `useReadContract` — per docs/security/dapp-topology.md §2 the
 * dapp never opens its own HTTP RPC. Only the *write* uses a viem
 * wallet client bound to the harness key, with `transport: custom(...)`
 * delegating the actual broadcast through the user's wallet provider.
 */

import {
  createWalletClient,
  custom,
  encodeFunctionData,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "./abi";
import { FAUCET_DRIP_AMOUNT_USDC } from "./chainClassifier";

/**
 * Minimal EIP-1193 surface viem's `custom()` actually consumes. We avoid
 * viem's own `EIP1193Provider` import here because `syncDevnetChain.ts`
 * keeps a tighter local provider shape (only `request`) — both interop
 * through this structural type.
 */
export interface Eip1193Like {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/**
 * Reads the build-time harness private key from `import.meta.env`. Returns
 * `null` (not throw) when missing or malformed — the FaucetTab uses this
 * to render the "unavailable" state. Build-time inlining means the key is
 * either present or absent in the bundle; no runtime fetch.
 */
export function readHarnessPrivateKey(env: Record<string, string | undefined>): Hex | null {
  const raw = env.VITE_FAUCET_HARNESS_PRIVATE_KEY;
  if (!raw) return null;
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isHex(normalized) || normalized.length !== 66) return null;
  return normalized as Hex;
}

export interface DripUsdcArgs {
  /** Address of the deployed USDC contract on this chain. */
  readonly usdcAddress: Address;
  /** Recipient EOA — the new account in onboarding or the wallet selected in the Faucet tab. */
  readonly recipient: Address;
  /** The user's injected EIP-1193 provider — used only as a broadcast transport. */
  readonly provider: Eip1193Like;
  /** Build-time-inlined harness private key. Must come from `readHarnessPrivateKey`. */
  readonly harnessPrivateKey: Hex;
  /** Smoke-test devnet chain ID, e.g. 918453. */
  readonly chainId: number;
}

/**
 * Sign and broadcast a USDC `transfer(recipient, FAUCET_DRIP_AMOUNT_USDC)`
 * from the harness holder EOA. Returns the transaction hash. Throws viem's
 * native error verbatim on failure — the FaucetTab surfaces `shortMessage`
 * directly per react-guide §Errors & async.
 */
export async function dripUsdc(args: DripUsdcArgs): Promise<Hex> {
  const account = privateKeyToAccount(args.harnessPrivateKey);
  const client = createWalletClient({
    account,
    transport: custom(args.provider),
  });
  return client.sendTransaction({
    chain: null,
    to: args.usdcAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [args.recipient, FAUCET_DRIP_AMOUNT_USDC],
    }),
  });
}

/**
 * Pure encoder for the drip calldata — used by the simulate-before-write
 * step in the FaucetTab and by Vitest assertions covering the calldata
 * shape. Keeping this pure means tests don't need a viem wallet client
 * or a chain at all.
 */
export function encodeDripCalldata(recipient: Address): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, FAUCET_DRIP_AMOUNT_USDC],
  });
}
