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
] as const;

export type AdminActionName = "authorizeAgent" | "revokeAgent" | "pause" | "unpause";

/**
 * keccak256("ADMIN_ROLE") and keccak256("PAUSER_ROLE") — pre-computed so
 * the dapp never needs to hash at runtime. Keep in sync with
 * contracts/gateway/AccessRoles.sol.
 */
export const ADMIN_ROLE_HASH =
  "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775" as const;
export const PAUSER_ROLE_HASH =
  "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a" as const;
