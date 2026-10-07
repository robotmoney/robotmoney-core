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
    name: "isOperationReady",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
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
    name: "CallSalt",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
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
  /**
   * The scheduled call, rebuilt from the CallScheduled and CallSalt logs, present
   * only for a single-call operation whose `hashOperation` equals `operationId`.
   * The Safe execute proposal (core 1544) is offered only when this is present.
   */
  readonly call?: TimelockScheduledCall;
}

/** The arguments `timelock.execute` needs to run a scheduled single-call operation. */
export interface TimelockScheduledCall {
  readonly target: Address;
  readonly data: `0x${string}`;
  readonly predecessor: `0x${string}`;
  readonly salt: `0x${string}`;
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
  /** Set when the log scan may have started late (see `ScanRange.incomplete`). */
  readonly scanWarning?: string;
}

// ─── Bounded log scans ────────────────────────────────────────────────────────

/**
 * Widest `eth_getLogs` range every common RPC accepts. Providers (and a Twin
 * fork, which forwards the pre-fork part of a range upstream) reject a call
 * such as `fromBlock: 0, toBlock: latest` with "limited to a 500 range".
 */
export const LOG_PAGE_BLOCKS = 500n;

/** The reads `findDeploymentBlock` needs. A viem public client satisfies it. */
export interface DeploymentProbeClient {
  getBlockNumber(): Promise<bigint>;
  getCode(args: { address: Address; blockNumber?: bigint }): Promise<`0x${string}` | undefined>;
}

/** A block range to scan, plus whether the search for its start was cut short by a failed probe. */
export interface ScanRange {
  readonly from: bigint;
  readonly to: bigint;
  /**
   * True when an `eth_getCode` probe errored (state not available). The scan then
   * starts later than the true deployment block, so older events may be missing.
   * The panel shows a visible warning instead of hiding it.
   */
  readonly incomplete: boolean;
}

/**
 * First block at which `address` has code. Exponential search back from the
 * head, then a binary search, so a recently deployed contract costs a handful
 * of `eth_getCode` calls. A probe that errors (state no longer available) counts
 * as "no code" so the search terminates, and the result is flagged `incomplete`.
 */
export async function findDeploymentBlock(
  client: DeploymentProbeClient,
  address: Address,
): Promise<ScanRange> {
  const latest = await client.getBlockNumber();
  let incomplete = false;
  const hasCode = async (blockNumber: bigint): Promise<boolean> => {
    try {
      const code = await client.getCode({ address, blockNumber });
      return code !== undefined && code !== "0x";
    } catch {
      incomplete = true;
      return false;
    }
  };
  if (!(await hasCode(latest))) return { from: latest, to: latest, incomplete };

  let present = latest; // has code
  let absent = -1n; // has no code; -1 until a probe finds one
  let step = 64n;
  while (absent < 0n) {
    const probe = present - step;
    if (probe <= 0n) {
      if (await hasCode(0n)) return { from: 0n, to: latest, incomplete };
      absent = 0n;
    } else if (await hasCode(probe)) {
      present = probe;
      step *= 2n;
    } else {
      absent = probe;
    }
  }
  while (present - absent > 1n) {
    const mid: bigint = (present + absent) / 2n;
    if (await hasCode(mid)) present = mid;
    else absent = mid;
  }
  return { from: present, to: latest, incomplete };
}

/**
 * Parse the optional `VITE_TIMELOCK_DEPLOY_BLOCK` runtime-config value. A set,
 * valid value lets the panel skip the deployment-block search. Anything else
 * (unset, empty, not a non-negative integer) returns undefined.
 */
export function parseDeployBlock(value: string | undefined): bigint | undefined {
  const v = (value ?? "").trim();
  return /^\d+$/.test(v) ? BigInt(v) : undefined;
}

/** Pages fetched at once. Bounds the load on a rate-limited RPC. */
export const LOG_PAGE_CONCURRENCY = 8;

/**
 * Run `fetchPage(from, to)` over [from, to] in pages of at most LOG_PAGE_BLOCKS
 * blocks, LOG_PAGE_CONCURRENCY at a time. Results come back in block order.
 */
export async function scanInPages<T>(
  range: { from: bigint; to: bigint },
  fetchPage: (from: bigint, to: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  const pages: Array<[bigint, bigint]> = [];
  for (let start = range.from; start <= range.to; start += LOG_PAGE_BLOCKS) {
    const end = start + LOG_PAGE_BLOCKS - 1n;
    pages.push([start, end < range.to ? end : range.to]);
  }
  const out: T[] = [];
  for (let i = 0; i < pages.length; i += LOG_PAGE_CONCURRENCY) {
    const batch = await Promise.all(
      pages.slice(i, i + LOG_PAGE_CONCURRENCY).map(([from, to]) => fetchPage(from, to)),
    );
    for (const logs of batch) out.push(...logs);
  }
  return out;
}
