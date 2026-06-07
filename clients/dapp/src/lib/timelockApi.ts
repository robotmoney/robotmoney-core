// Canonical: docs/architecture.md §4.5 — Protocol Admin Authority

/**
 * timelockApi — on-chain reads for TimelockController state.
 *
 * Mirrors the fields surfaced by `rmpc get-timelock`
 * (clients/rust-payment-client/src/commands/get_timelock.rs):
 *
 *   - address             — TimelockController contract address.
 *   - minDelaySecs        — Minimum delay in seconds (getMinDelay()).
 *   - proposers           — Addresses holding PROPOSER_ROLE.
 *   - cancellers          — Addresses holding CANCELLER_ROLE.
 *   - executorPolicy      — "open" when address(0) holds EXECUTOR_ROLE,
 *                           "restricted" otherwise.
 *   - pendingOps          — Operations scheduled but not yet executed
 *                           or cancelled (getTimestamp(id) > 1).
 *
 * Minimal ABI fragments for the OpenZeppelin TimelockController interface
 * are defined here to avoid a dependency on the full compiled ABI.
 *
 * Used exclusively by TimelockPanel (issue #647).
 */

import type { Address } from "viem";

// ─── ABI fragments ────────────────────────────────────────────────────────────

/** Minimal TimelockController ABI — only the views needed by TimelockPanel. */
export const timelockAbi = [
  {
    type: "function",
    name: "getMinDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "PROPOSER_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "CANCELLER_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "EXECUTOR_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
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
    type: "function",
    name: "getTimestamp",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Events used to discover role members and pending operations.
  {
    type: "event",
    name: "RoleGranted",
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "RoleRevoked",
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "CallScheduled",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "target", type: "address", indexed: false },
      { name: "value", type: "uint256", indexed: false },
      { name: "data", type: "bytes", indexed: false },
      { name: "predecessor", type: "bytes32", indexed: false },
      { name: "delay", type: "uint256", indexed: false },
    ],
  },
] as const;

// ─── Data shapes ──────────────────────────────────────────────────────────────

/** One pending TimelockController operation. */
export interface TimelockPendingOp {
  /** 0x-hex operation id (bytes32). */
  readonly operationId: string;
  /** Unix timestamp (seconds) after which the operation is executable. */
  readonly readyTimestamp: bigint;
  /** Human-readable status: "waiting" (delay not elapsed) or "ready" (executable). */
  readonly status: "waiting" | "ready";
}

/** Full TimelockController state surfaced by the panel. */
export interface TimelockState {
  /** Contract address. */
  readonly address: Address;
  /** Minimum delay in seconds. */
  readonly minDelaySecs: bigint;
  /** Addresses holding PROPOSER_ROLE. */
  readonly proposers: readonly Address[];
  /** Addresses holding CANCELLER_ROLE. */
  readonly cancellers: readonly Address[];
  /**
   * "open"       — address(0) holds EXECUTOR_ROLE (anyone can execute).
   * "restricted" — only specific addresses hold EXECUTOR_ROLE.
   */
  readonly executorPolicy: "open" | "restricted";
  /** Addresses holding EXECUTOR_ROLE (empty when executorPolicy === "open"). */
  readonly executors: readonly Address[];
  /** Operations scheduled but not yet executed or cancelled. */
  readonly pendingOps: readonly TimelockPendingOp[];
}
