// Core 1554, rewritten for the Uniswap V4 pool in core 1676: the Twin chain step that funds the live RM/USDC V4 pool through the real V4
// PositionManager so the rmAGENT deploy and its deposits have depth. The step itself is proven on the Twin chain (the twin publish jobs run it
// for real, and the smoke test deposits through the funded pool). These tests cover the parts that need no chain: the tick maths, the config
// read, the transaction sequence against a recording RPC, and the refusals that keep it off a real chain.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, toHex, encodeAbiParameters, encodeFunctionResult, type Hex } from "viem";
import {
  ACTION_MINT_POSITION, ACTION_SETTLE_PAIR, PERMIT2, RM_POOL_FUNDER, RM_POOL_LIQUIDITY, UNISWAP_V4_POSITION_MANAGER,
  fundRmPool, readRmPoolFacts, tickRangeAround, TwinError, type Rpc,
} from "../src/rehearsal/twin.ts";

const core = join(import.meta.dir, "..", "..");
const STATE_VIEW_ABI = parseAbi(["function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)", "function getLiquidity(bytes32) view returns (uint128)"]);

describe("fund-rm-pool", () => {
  test("the tick range floors negative ticks to the spacing bucket that holds the price (RM pool: spacing 582)", () => {
    expect(tickRangeAround(-403_009, 582)).toEqual([-403_326, -402_744]);
    expect(tickRangeAround(-403_326, 582)).toEqual([-403_326, -402_744]);
    expect(tickRangeAround(150, 200)).toEqual([0, 200]);
  });
  test("the facts are the RM entry of the committed shortlist: the Uniswap V4 pool with its full PoolKey", () => {
    const f = readRmPoolFacts(core);
    expect(f.token.toLowerCase()).toBe("0x65021a79aeef22b17cdc1b768f5e79a8618beba3");
    expect(f.poolId).toBe("0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391");
    expect(f.key).toEqual({ currency0: f.token, currency1: f.usdc, fee: 29100, tickSpacing: 582, hooks: "0x0000000000000000000000000000000000000000" });
    expect(f.poolManager).toBe("0x498581fF718922c3f8e6A244956aF099B2652b2b");
  });
  test("a core checkout without a UniswapV4 RM entry is refused", () => {
    expect(() => readRmPoolFacts(join(core, "publish-contracts", "tests", "fixtures"))).toThrow();
  });
  test("Base mainnet is refused before any write", async () => {
    const calls: string[] = [];
    const rpc: Rpc = async (m) => { calls.push(m); if (m === "eth_chainId") return "0x2105"; return null; };
    await expect(fundRmPool(rpc, readRmPoolFacts(core))).rejects.toThrow(/Base mainnet/);
    expect(calls).toEqual(["eth_chainId"]);
  });
  test("a PoolKey whose hash is not the pool id is refused before any write", async () => {
    const calls: string[] = [];
    const rpc: Rpc = async (m) => { calls.push(m); if (m === "eth_chainId") return "0xe0cb5"; if (m === "anvil_nodeInfo") return {}; throw new Error(`unexpected ${m}`); };
    const f = readRmPoolFacts(core);
    await expect(fundRmPool(rpc, { ...f, key: { ...f.key, tickSpacing: 200 } })).rejects.toThrow(/hashes to/);
    expect(calls.some((m) => m.startsWith("anvil_set") || m === "eth_sendTransaction")).toBe(false);
  });
  test("an uninitialized pool is a loud error, not something the helper creates", async () => {
    const f = readRmPoolFacts(core);
    const rpc: Rpc = async (m) => {
      if (m === "eth_chainId") return "0xe0cb5";
      if (m === "anvil_nodeInfo") return {};
      if (m === "eth_call") return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getSlot0", result: [0n, 0, 0, 0] });
      throw new Error(`unexpected ${m}`);
    };
    await expect(fundRmPool(rpc, f)).rejects.toThrow(/not initialized/);
  });

  test("the sequence: approve Permit2, Permit2 approve the PositionManager, then one MINT_POSITION + SETTLE_PAIR with the config PoolKey", async () => {
    const f = readRmPoolFacts(core);
    const sent: { to: string; data: Hex }[] = [];
    let liquidity = 1_000_000_000_000_000_000n;
    const balances = new Map<string, bigint>();
    const rpc: Rpc = async (m, params = []) => {
      switch (m) {
        case "eth_chainId": return "0xe0cb5";
        case "anvil_nodeInfo": return {};
        case "eth_getCode": return String(params[0]).toLowerCase() === RM_POOL_FUNDER ? "0x" : "0x6001";
        case "eth_getBalance": return "0xde0b6b3a7640000";
        case "anvil_impersonateAccount": case "anvil_stopImpersonatingAccount": case "anvil_setBalance": return null;
        case "anvil_setStorageAt": {
          // RM balance slot 0 mapping, or the USDC balance slot 9 mapping: remember the value by token
          balances.set(String(params[0]).toLowerCase(), BigInt(String(params[2])));
          return null;
        }
        case "eth_call": {
          const { to, data } = params[0] as { to: string; data: Hex };
          if (to.toLowerCase() === f.stateView.toLowerCase()) {
            if (data.startsWith("0xc815641c")) return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getSlot0", result: [140638623150169292817n, -403009, 0, 29100] });
            return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getLiquidity", result: liquidity });
          }
          // balanceOf(funder) for RM and USDC
          return toHex(balances.get(to.toLowerCase()) ?? 0n, { size: 32 });
        }
        case "eth_sendTransaction": {
          const tx = params[0] as { to: string; data: Hex };
          sent.push({ to: tx.to, data: tx.data });
          if (tx.to.toLowerCase() === UNISWAP_V4_POSITION_MANAGER.toLowerCase()) liquidity += RM_POOL_LIQUIDITY;
          return `0x${(sent.length).toString(16).padStart(64, "0")}`;
        }
        case "eth_getTransactionReceipt": return { status: "0x1" };
        default: throw new Error(`unexpected ${m}`);
      }
    };
    const r = await fundRmPool(rpc, f, { usdcCodeHash: keccak256("0x6001") });
    expect(r.ticks).toEqual([-403_326, -402_744]);
    expect(r.liquidity).toBe(1_000_000_000_000_000_000n + RM_POOL_LIQUIDITY);
    // 2 ERC20 approvals + 2 Permit2 approvals + the mint
    expect(sent.map((s) => s.to.toLowerCase())).toEqual([
      f.token.toLowerCase(), PERMIT2.toLowerCase(), f.usdc.toLowerCase(), PERMIT2.toLowerCase(), UNISWAP_V4_POSITION_MANAGER.toLowerCase(),
    ]);
    const mint = decodeFunctionData({ abi: parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline)"]), data: sent[4]!.data });
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], mint.args[0] as Hex);
    expect(actions).toBe(`0x${ACTION_MINT_POSITION.toString(16).padStart(2, "0")}${ACTION_SETTLE_PAIR.toString(16).padStart(2, "0")}`);
    expect(params).toHaveLength(2);
    const POOL_KEY = { type: "tuple", components: [{ name: "c0", type: "address" }, { name: "c1", type: "address" }, { name: "fee", type: "uint24" }, { name: "ts", type: "int24" }, { name: "hooks", type: "address" }] } as const;
    const [key, lo, hi, liq] = decodeAbiParameters([POOL_KEY, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }], params[0]!);
    // the minted key is the config key, whose hash is the pool id (the position is in the real pool, not another one)
    expect(keccak256(encodeAbiParameters([POOL_KEY], [key]))).toBe(f.poolId);
    expect([lo, hi, liq]).toEqual([-403_326, -402_744, RM_POOL_LIQUIDITY]);
    const [c0, c1] = decodeAbiParameters([{ type: "address" }, { type: "address" }], params[1]!);
    expect([c0.toLowerCase(), c1.toLowerCase()]).toEqual([f.key.currency0.toLowerCase(), f.key.currency1.toLowerCase()]);
  });

  test("a pool that did not take the position is a loud error, not a green step", async () => {
    const f = readRmPoolFacts(core);
    const balances = new Map<string, bigint>();
    const rpc: Rpc = async (m, params = []) => {
      switch (m) {
        case "eth_chainId": return "0xe0cb5";
        case "anvil_nodeInfo": return {};
        case "eth_getCode": return String(params[0]).toLowerCase() === RM_POOL_FUNDER ? "0x" : "0x6001";
        case "eth_getBalance": return "0xde0b6b3a7640000";
        case "anvil_impersonateAccount": case "anvil_stopImpersonatingAccount": case "anvil_setBalance": return null;
        case "anvil_setStorageAt": balances.set(String(params[0]).toLowerCase(), BigInt(String(params[2]))); return null;
        case "eth_call": {
          const { to, data } = params[0] as { to: string; data: Hex };
          if (to.toLowerCase() === f.stateView.toLowerCase()) {
            if (data.startsWith("0xc815641c")) return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getSlot0", result: [1n, -403009, 0, 29100] });
            return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getLiquidity", result: 5n }); // never rises
          }
          return toHex(balances.get(to.toLowerCase()) ?? 0n, { size: 32 });
        }
        case "eth_sendTransaction": return `0x${"01".repeat(32)}`;
        case "eth_getTransactionReceipt": return { status: "0x1" };
        default: throw new Error(`unexpected ${m}`);
      }
    };
    await expect(fundRmPool(rpc, f, { usdcCodeHash: keccak256("0x6001") })).rejects.toThrow(TwinError);
  });
});
