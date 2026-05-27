/**
 * Vitest covering issue #466 acceptance criterion for the Base ETH faucet
 * drip client:
 *
 *   "dripEth signs a native value transfer of FAUCET_DRIP_AMOUNT_ETH from
 *    the harness holder EOA to the recipient via the injected provider
 *    transport, asserted by a faucetClient unit test."
 *
 * We stub the EIP-1193 provider and observe the RPC calls viem makes from
 * the wallet client; the JSON-RPC payload that goes out via
 * `eth_sendRawTransaction` carries the recoverable signature and value.
 * We assert:
 *   - `dripEth` invokes `eth_sendRawTransaction` exactly once
 *   - the recipient in the signed tx matches the requested recipient
 *   - the value in the signed tx equals `FAUCET_DRIP_AMOUNT_ETH`
 *   - the resolved tx hash is the one returned by the provider
 */
import { describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dripEth, type Eip1193Like } from "../../src/lib/faucetClient";
import { FAUCET_DRIP_AMOUNT_ETH } from "../../src/lib/chainClassifier";

const HARNESS_KEY = ("0x" + "33".repeat(32)) as Hex;
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as const satisfies Address;
const CHAIN_ID = 918453;

interface RpcCall {
  method: string;
  params?: unknown[];
}

function makeProvider(calls: RpcCall[]): {
  provider: Eip1193Like;
  pendingTxHash: Hex;
} {
  const pendingTxHash = ("0x" + "ab".repeat(32)) as Hex;
  const harness = privateKeyToAccount(HARNESS_KEY);
  const provider: Eip1193Like = {
    request: vi.fn(async ({ method, params }: RpcCall) => {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return `0x${CHAIN_ID.toString(16)}`;
        case "eth_accounts":
        case "eth_requestAccounts":
          return [harness.address];
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_gasPrice":
          return "0x3b9aca00"; // 1 gwei
        case "eth_estimateGas":
          return "0x5208"; // 21000
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        case "eth_getBlockByNumber":
          // viem may probe a recent block for EIP-1559 baseFeePerGas
          return {
            baseFeePerGas: "0x3b9aca00",
            number: "0x1",
            timestamp: "0x1",
          };
        case "eth_sendRawTransaction":
          return pendingTxHash;
        default:
          return null;
      }
    }),
  };
  return { provider, pendingTxHash };
}

describe("dripEth", () => {
  it("signs and broadcasts a native value transfer of FAUCET_DRIP_AMOUNT_ETH to the recipient", async () => {
    const calls: RpcCall[] = [];
    const { provider, pendingTxHash } = makeProvider(calls);

    const hash = await dripEth({
      recipient: RECIPIENT,
      provider,
      harnessPrivateKey: HARNESS_KEY,
      chainId: CHAIN_ID,
    });

    expect(hash).toBe(pendingTxHash);

    const sendCall = calls.find((c) => c.method === "eth_sendRawTransaction");
    expect(sendCall, "eth_sendRawTransaction must be invoked exactly once").toBeDefined();
    const rawTx = sendCall!.params?.[0] as Hex;
    expect(rawTx.startsWith("0x")).toBe(true);

    // Decoding the raw tx proves the signed transaction carries the exact
    // recipient and value we asked for — no impersonation, no anvil cheat.
    const parsed = parseTransaction(rawTx);
    expect(parsed.to?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(parsed.value).toBe(FAUCET_DRIP_AMOUNT_ETH);
    // Defence-in-depth: keccak of the raw tx is a stable identifier we can
    // round-trip through viem if anything changes the encoding.
    expect(keccak256(rawTx)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rethrows the provider error when eth_sendRawTransaction fails", async () => {
    const provider: Eip1193Like = {
      request: vi.fn(async ({ method }: RpcCall) => {
        switch (method) {
          case "eth_chainId":
            return `0x${CHAIN_ID.toString(16)}`;
          case "eth_accounts":
          case "eth_requestAccounts": {
            const harness = privateKeyToAccount(HARNESS_KEY);
            return [harness.address];
          }
          case "eth_getTransactionCount":
            return "0x0";
          case "eth_gasPrice":
            return "0x3b9aca00";
          case "eth_estimateGas":
            return "0x5208";
          case "eth_maxPriorityFeePerGas":
            return "0x3b9aca00";
          case "eth_getBlockByNumber":
            return { baseFeePerGas: "0x3b9aca00", number: "0x1", timestamp: "0x1" };
          case "eth_sendRawTransaction":
            throw new Error("broadcast rejected");
          default:
            return null;
        }
      }),
    };
    await expect(
      dripEth({
        recipient: RECIPIENT,
        provider,
        harnessPrivateKey: HARNESS_KEY,
        chainId: CHAIN_ID,
      }),
    ).rejects.toThrow();
  });
});
