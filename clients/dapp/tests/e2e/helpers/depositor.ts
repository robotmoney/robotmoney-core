/**
 * Depositor wallets for the dapp e2e suite.
 *
 * After the timelock handover no EOA holds ADMIN_ROLE or DEFAULT_ADMIN_ROLE
 * on any contract, on the Twin chain exactly as on mainnet
 * (docs/technical/security-model.md §4, docs/technical/governance-isomorphism.md).
 * So the agent specs run as a DEPOSITOR: a fresh wallet that authorizes its
 * own agent through `commitAuthorization` + `revealAuthorization` and is then
 * the only address that can `setPolicy` / `revokeAgent` it
 * (docs/architecture.md §6, issue #269).
 *
 * A fresh key per describe block keeps the specs independent of each other
 * and of the harness USDC holder, which is also the dapp faucet's funding
 * key. The only chain writes made outside the dapp are the Twin chain
 * environment step "fund gas" (`anvil_setBalance`, the same RPC that
 * `scripts/devnet/twin-fork.ts fund-gas` sends). No role is granted to any
 * test wallet.
 */
import type { Page } from "@playwright/test";
import { createPublicClient, http, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { DevnetEndpoints } from "./devnet";
import { openDapp, openTab } from "./wallet";

export interface TestAccount {
  privateKey: Hex;
  address: Address;
}

/** Base mainnet. The fund-gas step must never run against it. */
const BASE_MAINNET_CHAIN_ID = 8453;

/** keccak256("AGENT_ROLE") — matches contracts/gateway/AccessRoles.sol. */
export const AGENT_ROLE: Hex = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";
/** keccak256("ADMIN_ROLE"). */
export const ADMIN_ROLE: Hex = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";
/** OpenZeppelin AccessControl DEFAULT_ADMIN_ROLE. */
export const DEFAULT_ADMIN_ROLE: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const GATEWAY_READ_ABI = [
  {
    type: "function",
    name: "agentOwner",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    // Solidity's public-mapping getter for `agents`: the dynamic-array
    // members of AgentPolicy are omitted.
    type: "function",
    name: "agents",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "active", type: "bool" },
      { name: "validUntil", type: "uint64" },
      { name: "maxPerPayment", type: "uint256" },
      { name: "maxPerWindow", type: "uint256" },
      { name: "shareReceiver", type: "address" },
      { name: "assetRecipient", type: "address" },
      { name: "maxWithdrawPerPayment", type: "uint256" },
      { name: "maxWithdrawPerWindow", type: "uint256" },
    ],
  },
] as const;

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;

function client(endpoints: DevnetEndpoints) {
  return createPublicClient({ transport: http(endpoints.rpc_url) });
}

/** A new random EOA with no balance, no role, and no history. */
export function freshAccount(): TestAccount {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/**
 * A new random EOA funded with gas through the Twin chain "fund gas" step,
 * ready to sign its own commit/reveal, setPolicy and revokeAgent calls.
 */
export async function freshDepositor(
  endpoints: DevnetEndpoints,
  gasWei: bigint = 10n ** 18n,
): Promise<TestAccount> {
  const account = freshAccount();
  const pc = client(endpoints);
  const chainId = await pc.getChainId();
  if (chainId === BASE_MAINNET_CHAIN_ID || chainId !== endpoints.chain_id) {
    throw new Error(
      `freshDepositor: refusing to fund gas on chain ${chainId} ` +
        `(expected the Twin chain ${endpoints.chain_id})`,
    );
  }
  const res = await fetch(endpoints.rpc_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [account.address, `0x${gasWei.toString(16)}`],
    }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (!res.ok || body.error) {
    throw new Error(
      `freshDepositor: fund gas failed for ${account.address}: ` +
        (body.error?.message ?? `HTTP ${res.status}`),
    );
  }
  const balance = await pc.getBalance({ address: account.address });
  if (balance !== gasWei) {
    throw new Error(`freshDepositor: ${account.address} balance ${balance} != ${gasWei}`);
  }
  return account;
}

export async function agentOwnerOf(endpoints: DevnetEndpoints, agent: Address): Promise<Address> {
  return client(endpoints).readContract({
    address: endpoints.gateway_addr as Address,
    abi: GATEWAY_READ_ABI,
    functionName: "agentOwner",
    args: [agent],
  });
}

export async function gatewayHasRole(
  endpoints: DevnetEndpoints,
  role: Hex,
  account: Address,
): Promise<boolean> {
  return client(endpoints).readContract({
    address: endpoints.gateway_addr as Address,
    abi: GATEWAY_READ_ABI,
    functionName: "hasRole",
    args: [role, account],
  });
}

export interface OnChainAgentPolicy {
  active: boolean;
  maxPerPayment: bigint;
  maxPerWindow: bigint;
  shareReceiver: Address;
}

/** The stored policy of `agent` (zeroed after a revoke). */
export async function agentPolicyOf(
  endpoints: DevnetEndpoints,
  agent: Address,
): Promise<OnChainAgentPolicy> {
  const [active, , maxPerPayment, maxPerWindow, shareReceiver] = await client(
    endpoints,
  ).readContract({
    address: endpoints.gateway_addr as Address,
    abi: GATEWAY_READ_ABI,
    functionName: "agents",
    args: [agent],
  });
  return { active, maxPerPayment, maxPerWindow, shareReceiver };
}

/**
 * Poll the gateway until `agentOwner(agent)` equals `owner` (pass
 * `zeroAddress` to wait for a revoke) and `hasRole(AGENT_ROLE, agent)`
 * matches. Throws with the last observed state on timeout.
 */
export async function waitForAgentState(
  endpoints: DevnetEndpoints,
  agent: Address,
  owner: Address,
): Promise<void> {
  const expectRole = owner.toLowerCase() !== zeroAddress;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastOwner: Address = zeroAddress;
  let lastRole = false;
  while (Date.now() < deadline) {
    lastOwner = await agentOwnerOf(endpoints, agent);
    lastRole = await gatewayHasRole(endpoints, AGENT_ROLE, agent);
    if (lastOwner.toLowerCase() === owner.toLowerCase() && lastRole === expectRole) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `waitForAgentState: timed out after ${POLL_TIMEOUT_MS / 1000}s for agent ${agent}: ` +
      `expected owner=${owner} AGENT_ROLE=${expectRole}; ` +
      `last owner=${lastOwner} AGENT_ROLE=${lastRole}`,
  );
}

/**
 * Drive the dapp's Authorize tab (commit, then reveal) as `depositor` so
 * `agent` becomes a depositor-owned agent. A caller without ADMIN_ROLE must
 * name itself as shareReceiver (RobotMoneyGateway._validatePolicy), so the
 * depositor's own address is used. Resolves once the chain shows
 * `agentOwner(agent) == depositor` and AGENT_ROLE on the agent.
 */
export async function authorizeOwnAgentViaUi(
  page: Page,
  endpoints: DevnetEndpoints,
  depositor: TestAccount,
  agent: Address,
): Promise<void> {
  const { expect } = await import("@playwright/test");
  await openDapp(page, endpoints, { privateKey: depositor.privateKey });
  await openTab(page, "authorize");
  await page.getByTestId("agent-input").fill(agent);
  await page.getByTestId("shareReceiver-input").fill(depositor.address);
  await expect(page.locator('[data-testid="tx-preview"][data-ok="true"]').first()).toBeVisible();

  // Step 1 of 2: commit.
  await page.getByTestId("authorize-submit").click();
  // Step 2 of 2: reveal, enabled once a block has passed since the commit.
  const reveal = page.getByTestId("authorize-reveal-submit");
  await expect(reveal).toBeEnabled({ timeout: 60_000 });
  await reveal.click();

  await waitForAgentState(endpoints, agent, depositor.address);
}
