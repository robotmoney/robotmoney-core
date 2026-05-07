/**
 * Minimal ABI excerpt for the human-dapp admin/policy actions.
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
  | "revokeAgent"
  | "pause"
  | "unpause"
  | "grantRole"
  | "revokeRole";

/**
 * Role identifiers handled by the dapp's role grant/revoke flow.
 * AGENT_ROLE has its own dedicated authorize/revoke surface (because it
 * carries a policy struct); the role-bytes32 path here is for ADMIN_ROLE
 * and PAUSER_ROLE only — AGENT_ROLE is intentionally excluded so the
 * operator cannot grant it without setting a policy.
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
