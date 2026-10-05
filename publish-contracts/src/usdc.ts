// USDC is a constant on every chain (plan principle 12): Base USDC, the Circle FiatTokenProxy at the same address on Base mainnet and
// on the Twin chain (918453), which is a pinned lazy fork of real Base state and so carries it unpatched. A mock token is refused by its code hash.
// Core pins the same address (ExpectedChainGuard.sol BASE_USDC). Pure constants and one check: no chain access here.
import { keccak256 } from "viem";
import { PublishError } from "./errors.ts";

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
/** keccak256 of the FiatTokenProxy runtime code at USDC_ADDRESS (1852 bytes), read from Base mainnet. */
export const USDC_PROXY_CODE_HASH = "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab" as const;

export interface UsdcCodeResult { ok: boolean; detail: string }

/** The on-chain code of USDC_ADDRESS against the pinned FiatTokenProxy hash. `pinned` is injectable for tests only. */
export function checkUsdcCode(code: string, pinned: string = USDC_PROXY_CODE_HASH): UsdcCodeResult {
  if (!/^0x[0-9a-fA-F]*$/.test(code) || code.length <= 2) return { ok: false, detail: `no code at USDC ${USDC_ADDRESS}` };
  const h = keccak256(code as `0x${string}`);
  return { ok: h === pinned.toLowerCase(), detail: h === pinned.toLowerCase() ? `code hash ${h}` : `code hash ${h}, pinned FiatTokenProxy ${pinned}: a mock or changed token` };
}

/** Throws USAGE-class refusal before any send when the token at USDC_ADDRESS is not the pinned FiatTokenProxy. */
export function assertUsdcCode(code: string, pinned?: string): void {
  const r = checkUsdcCode(code, pinned);
  if (!r.ok) throw new PublishError("CHAIN", `USDC check failed: ${r.detail}`, { usdc: USDC_ADDRESS });
}
