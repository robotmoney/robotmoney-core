/**
 * Minimal ABI excerpt for the depositor-owned agent-policy actions
 * (issue #269 — each depositor is the sole authority over her own
 * agent). The `authorizeAgent` / `setPolicy` / `revokeAgent` surface is
 * permissionless on the contract; gating is by recorded `agentOwner`,
 * not by `ADMIN_ROLE`. `ADMIN_ROLE` survives only as a protocol-wide
 * kill-switch counterweight to `pause` (`unpause`) held by the
 * contract-upgrader.
 *
 * Tracks the canonical interface in
 * `contracts/gateway/interfaces/IGateway.sol`. Only the functions the
 * dapp needs to encode/decode appear here; the full ABI lives with the
 * Rust client (`clients/rust-payment-client/abi/`).
 */
export const gatewayAbi = [
  {
    type: "function",
    name: "authorizeAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "active", type: "bool" },
          { name: "validUntil", type: "uint64" },
          { name: "maxPerPayment", type: "uint256" },
          { name: "maxPerWindow", type: "uint256" },
          { name: "shareReceiver", type: "address" },
          { name: "allowedDestinations", type: "address[]" },
          { name: "assetRecipient", type: "address" },
          { name: "maxWithdrawPerPayment", type: "uint256" },
          { name: "maxWithdrawPerWindow", type: "uint256" },
          { name: "allowedSourceVaults", type: "address[]" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "active", type: "bool" },
          { name: "validUntil", type: "uint64" },
          { name: "maxPerPayment", type: "uint256" },
          { name: "maxPerWindow", type: "uint256" },
          { name: "shareReceiver", type: "address" },
          { name: "allowedDestinations", type: "address[]" },
          { name: "assetRecipient", type: "address" },
          { name: "maxWithdrawPerPayment", type: "uint256" },
          { name: "maxWithdrawPerWindow", type: "uint256" },
          { name: "allowedSourceVaults", type: "address[]" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeAgent",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "agentOwner",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "pause",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "unpause",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
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
  // OpenZeppelin AccessControl — used to grant/revoke ADMIN_ROLE and
  // PAUSER_ROLE. Caller must hold the role's admin role (DEFAULT_ADMIN_ROLE
  // for ADMIN/PAUSER per `contracts/gateway/AccessRoles.sol`).
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
] as const;

export type AdminActionName =
  | "authorizeAgent"
  | "setPolicy"
  | "revokeAgent"
  | "pause"
  | "unpause"
  | "grantRole"
  | "revokeRole";

/**
 * Role identifiers handled by the dapp's role grant/revoke flow.
 * AGENT_ROLE has its own dedicated depositor-owned authorize/revoke
 * surface (because it carries a policy struct and is gated on
 * `msg.sender == agentOwner[agent]`, not on any privileged role).
 * The role-bytes32 path here is for ADMIN_ROLE and PAUSER_ROLE only —
 * AGENT_ROLE is intentionally excluded so it can never be granted
 * without setting a policy through the depositor-owned surface.
 */
export type RoleName = "ADMIN_ROLE" | "PAUSER_ROLE";

/**
 * keccak256 of the role string, matching `contracts/gateway/AccessRoles.sol`:
 *   bytes32 public constant ADMIN_ROLE  = keccak256("ADMIN_ROLE");
 *   bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
 * Hard-coded to keep the dapp pure and avoid an extra RPC round trip.
 */
export const ROLE_HASH: Record<RoleName, `0x${string}`> = {
  ADMIN_ROLE: "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775",
  PAUSER_ROLE: "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a",
};

export const ADMIN_ROLE_HASH = ROLE_HASH.ADMIN_ROLE;
export const PAUSER_ROLE_HASH = ROLE_HASH.PAUSER_ROLE;

/**
 * Minimal ERC-20 ABI fragment used by the testnet/devnet faucet (issue
 * #261) for `transfer(address,uint256)` writes and `balanceOf(address)`
 * read-backs. The faucet drips canonical USDC by signing a plain ERC-20
 * `transfer` from the harness holder EOA — the same path the smoke-test
 * fixture's `Fixture::fund_usdc` uses on the Rust side (issue #255).
 *
 * Kept minimal on purpose: the dapp only needs `transfer` (write) and
 * `balanceOf` (read-back). All other ERC-20 surface lives with the Rust
 * client.
 */
export const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // `approve` + `allowance` are required by the Deposit/Withdraw tab
  // (issue #257). USDC is a standard ERC-20 on Base; users approve the
  // vault to pull `assets` before calling `deposit(assets, receiver)`.
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Minimal ERC-4626 ABI excerpt for the Deposit/Withdraw tab (issue #257).
 * RobotMoneyVault is a standard ERC-4626 vault; the dapp drives
 * `deposit(assets,receiver)` and `redeem(shares,receiver,owner)`
 * directly against the vault contract (the gateway's `deposit` entry
 * point is AGENT_ROLE-only and not exposed to depositors). Only the
 * functions the dapp needs to encode/decode and read back appear here;
 * the full ABI lives with the Foundry contracts and the Rust fork-e2e
 * crate.
 */
export const vaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewDeposit",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewRedeem",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxRedeem",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "exitFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type VaultActionName = "deposit" | "redeem";

/**
 * Minimal VaultRegistry ABI excerpt for VaultRegistryContext and the
 * DestinationSelector (issue #320, extended issue #417).
 * Exposes:
 *   - `listVaults()` — enumerate all registered vault addresses.
 *   - `getVault(address)` — per-vault metadata including status, name,
 *     riskLabel, and depositCap (docs/technical/vault-registry-decisions.md §3.4).
 *
 * VaultRecord.status encodes as uint8: 0=Active, 1=Paused, 2=Retired.
 * The `VaultSelectorDepositTab` calls `getVault` live before submit to
 * guard against cached paused-vault state (issue #417 AC §4).
 */
export const registryAbi = [
  {
    type: "function",
    name: "listVaults",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "addresses", type: "address[]" }],
  },
  {
    type: "function",
    name: "getVault",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [
      {
        name: "record",
        type: "tuple",
        components: [
          { name: "vault", type: "address" },
          { name: "name", type: "string" },
          { name: "riskLabel", type: "string" },
          { name: "mandate", type: "string" },
          { name: "status", type: "uint8" },
          { name: "receiptToken", type: "address" },
          { name: "depositCap", type: "uint256" },
          { name: "exitFeeBps", type: "uint16" },
          { name: "registeredAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

/** VaultStatus enum — matches VaultRegistry.sol's enum order. */
export const VaultStatus = { Active: 0, Paused: 1, Retired: 2 } as const;
export type VaultStatusValue = (typeof VaultStatus)[keyof typeof VaultStatus];

/**
 * Decoded on-chain vault record from `registry.getVault(address)`.
 * The `status` field is a uint8 enum matching `VaultStatus` above.
 */
export interface VaultRecord {
  vault: `0x${string}`;
  name: string;
  riskLabel: string;
  mandate: string;
  status: VaultStatusValue;
  receiptToken: `0x${string}`;
  depositCap: bigint;
  exitFeeBps: number;
  registeredAt: bigint;
}

/**
 * Minimal PortfolioRouter ABI excerpt for the DestinationSelector and
 * router deposit flow (issue #320, extended issue #417). Exposes:
 *   - `previewDeposit(amount)` — per-vault breakdown without state change.
 *   - `deposit(amount, minSharesPerLeg)` — all-or-revert multi-vault deposit.
 *   - `activeVaults()` — current active vault list; used by RouterDepositTab
 *     to detect vault-list changes between preview and submit (AC §7).
 *
 * The LegPreview tuple matches `PortfolioRouter.sol`'s `LegPreview` struct:
 * { vault, weightBps, legAmount, estShares, unavailable }.
 */
export const routerAbi = [
  {
    type: "function",
    name: "previewDeposit",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [
      {
        name: "legs",
        type: "tuple[]",
        components: [
          { name: "vault", type: "address" },
          { name: "weightBps", type: "uint256" },
          { name: "legAmount", type: "uint256" },
          { name: "estShares", type: "uint256" },
          { name: "unavailable", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "minSharesPerLeg", type: "uint256[]" },
    ],
    outputs: [{ name: "sharesPerLeg", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "activeVaults",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "vaults", type: "address[]" }],
  },
] as const;

export type RouterActionName = "deposit";
