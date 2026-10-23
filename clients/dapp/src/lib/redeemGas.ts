// Canonical: docs/architecture.md §5.3 — Human Dapp

import { parseVaultAddressMap } from "./consensusReceiptApi";
import type { RuntimeConfig } from "./runtimeConfig";

/**
 * Redeem gas workaround for RobotMoneyVault (rmUSDC) only (dapp issue 1760, core issue 1758).
 *
 * On Base mainnet an rmUSDC `redeem` can revert Panic(0x11) when its gas is ESTIMATED against the
 * `pending` block, which is what a wallet does. The cause is Morpho's timestamp underflow inside the
 * Moonwell Flagship valuation the vault's Morpho adapter reads, in the node's pending environment
 * (docs/technical/redeem-gas-1482.md). Core issue 1758 closed with no contract change, so an rmUSDC
 * redeem is sent with a fixed gas limit and the wallet never estimates it. The same call uses about
 * 0.94M to 1.0M gas at `latest`.
 *
 * Basket vaults (rmPROTO, rmRWA) have no Morpho adapter and need MORE than this limit:
 * `BasketVault.redeem` requires 300,000 + 400,000 per basket asset at entry (about 3.8M for a full
 * basket). A fixed 2.5M on a basket redeem reverts `InsufficientGas`, so the limit applies only to a
 * redeem whose target is a configured RobotMoneyVault address (QA plan U3). Every other redeem is
 * estimated by the wallet.
 *
 * The Withdraw tab redeems a registered vault through the router as a one-leg `redeemFor` (QA plan
 * D9). An rmUSDC leg reaches the same Morpho read, so it gets the same limit. 2.5M clears the router's
 * 1.7M entry floor, and after the 63/64 forwarding it clears the vault's 1.6M floor too. That call uses
 * about 1.12M gas (docs/technical/redeem-gas-1482.md). A basket leg is estimated by the wallet.
 *
 * REMOVE THE WORKAROUND BY SETTING THIS CONSTANT TO `undefined` (then delete this file).
 */
export const REDEEM_GAS_LIMIT_WORKAROUND_1758: bigint | undefined = 2_500_000n;

/**
 * The RobotMoneyVault addresses of this deployment, lowercased: the gateway's single vault
 * (`VITE_VAULT_ADDRESS`) and the `rmUSDC` entry of `VITE_VAULT_ADDRESSES`. Basket vaults are never in
 * the set. Pure.
 */
export function robotMoneyVaultTargets(env: RuntimeConfig): ReadonlySet<string> {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return;
    const key = value.toLowerCase();
    if (key !== "0x0000000000000000000000000000000000000000") out.add(key);
  };
  add(env.VITE_VAULT_ADDRESS);
  add(parseVaultAddressMap(env.VITE_VAULT_ADDRESSES)?.rmUSDC);
  return out;
}

/**
 * The vault a write redeems from: the target of a `redeem`, or the one leg of a one-leg router
 * `redeemFor` (QA plan D9). A `redeemFor` naming several vaults, and every other write, has none.
 */
function redeemedVault(v: { functionName?: unknown; address?: unknown; args?: unknown }): unknown {
  if (v.functionName === "redeem") return v.address;
  if (v.functionName === "redeemFor" && Array.isArray(v.args)) {
    const vaults: unknown = v.args[2];
    if (Array.isArray(vaults) && vaults.length === 1) return vaults[0];
  }
  return undefined;
}

/**
 * The write variables with the redeem gas limit added when it applies: a `redeem`, or a one-leg router
 * `redeemFor`, with no caller-set gas whose redeemed vault is in `robotMoneyVaults`. Anything else is
 * returned unchanged. Pure.
 */
export function withRedeemGasWorkaround<T>(variables: T, robotMoneyVaults: ReadonlySet<string>): T {
  const limit = REDEEM_GAS_LIMIT_WORKAROUND_1758;
  if (limit === undefined || typeof variables !== "object" || variables === null) return variables;
  const v = variables as {
    functionName?: unknown;
    gas?: unknown;
    address?: unknown;
    args?: unknown;
  };
  if (v.gas !== undefined) return variables;
  const vault = redeemedVault(v);
  if (typeof vault !== "string" || !robotMoneyVaults.has(vault.toLowerCase())) {
    return variables;
  }
  return { ...variables, gas: limit };
}
