// Issue 1912, ADR-0017: the fourth vault of the Twin retire rehearsal (src/ci/twin-upgrade-lifecycle.ts, step 2c). Test setup only, Twin only: the Twin deploys the three-vault target, and the
// retire row acts on the live four-vault v0.5.0 deployment, so the rehearsal builds that state first: a router leg the deployer funds (contracts/test/helpers/RetirableLegVault.sol, a stand-in
// for rmAGENT) that the SAFE then registers and makes router-eligible through the timelock, with the default vector grown to four legs. The row itself (`govern --row retire-vault`) is the
// product code under test and runs from the lifecycle script. The behaviour of the real AgentTokenVault after a retire is proved by contracts/test/RetireVaultBatch.t.sol. Nothing here runs on Base mainnet.
import { encodeDeployData, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { REGISTRY_REDEPLOY_ABI } from "../redeploy-vault.ts";
import { artifactJson } from "../verify/codehash.ts";
import type { CastSend } from "./twin-legacy-receipt.ts";

export const RETIRABLE_LEG_CONTRACT = "RetirableLegVault";
/** The registry name the live v0.5.0 rmAGENT was registered under. */
export const FOURTH_VAULT_NAME = "Robot Money Agent Tokens";
export const LEG_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function balanceOf(address) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function retired() view returns (bool)",
  "function registry() view returns (address)",
]);
export const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export const REGISTRY_READ_ABI = parseAbi([
  "function listVaults() view returns (address[])",
  "function isRouterEligible(address vault) view returns (bool)",
  "function routerEligibleCount() view returns (uint256)",
  "function getVault(address vault) view returns ((string name, address asset, uint256 registeredAt) metadata, uint8 status)",
]);
export const ROUTER_READ_ABI = parseAbi([
  "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)",
  "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)",
  "function votedWeightsActive() view returns (bool)",
  "function previewDeposit(uint256 amount) view returns ((address vault, uint256 weightBps, uint256 legAmount, uint256 estShares, bool unavailable)[] legs)",
]);

/** Deploys the fourth vault (a plain CREATE by the deployer, nothing linked). Returns its address. */
export function deployRetirableLeg(o: { send: CastSend; outDir: string; usdc: Address; registry: Address }): Address {
  const art = artifactJson(o.outDir, RETIRABLE_LEG_CONTRACT);
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [o.usdc, o.registry] });
  return getAddress(o.send(["--create", data]).contractAddress as string) as Address;
}

/**
 * The one timelock batch that makes the fourth vault part of the deployment, built by the Safe: registerVault(vault), then migrateEligibility(vault, true, four legs). The default vector
 * takes the vault in the third slot with 0 bps, exactly the live v0.5.0 shape (rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0).
 */
export function fourthVaultBatch(o: { registry: Address; vault: Address; usdc: Address; legs: readonly [Address, Address, Address] }): { target: Address; data: Hex }[] {
  const [usdcVault, proto, rwa] = o.legs;
  const vaults = [usdcVault, proto, o.vault, rwa];
  return [
    { target: o.registry, data: encodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, functionName: "registerVault", args: [o.vault, { name: FOURTH_VAULT_NAME, asset: o.usdc, registeredAt: 0n }] }) },
    { target: o.registry, data: encodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, functionName: "migrateEligibility", args: [o.vault, true, vaults, [9500n, 500n, 0n, 0n]] }) },
  ];
}
