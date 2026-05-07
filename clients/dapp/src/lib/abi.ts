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
] as const;

export type AdminActionName = "authorizeAgent" | "revokeAgent" | "pause" | "unpause";
