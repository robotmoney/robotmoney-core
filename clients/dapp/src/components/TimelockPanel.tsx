/**
 * TimelockPanel — issue #414 / docs/security-model.md §4
 *
 * Displays the on-chain TimelockController state:
 *   - Minimum delay before a scheduled operation can execute.
 *   - Proposer and executor addresses.
 *   - Pending (scheduled but not yet executed) operations with:
 *       - Operation id (bytes32 hex).
 *       - Ready timestamp (when execution becomes allowed).
 *       - Time remaining until ready (or "Ready to execute").
 *
 * Data is read directly from the on-chain TimelockController via wagmi
 * `useReadContracts` calls — the dapp does not cache this in the indexer.
 * All reads are read-only; no wallet interaction is needed to display the panel.
 *
 * The panel is intentionally display-only: it surfaces the security posture
 * so users can verify that admin operations are timelock-gated, and lets
 * them see any pending proposals before they execute. Initiating or executing
 * timelock operations is an admin workflow done via the Safe UI.
 *
 * Canonical: docs/security-model.md §4 (Timelock bypass → Mitigated)
 * Implements: issue #414
 */

import { useEffect, useMemo, useState } from "react";
import { useBlockNumber, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { keccak256, toBytes } from "viem";

// ─── TimelockController ABI fragments ────────────────────────────────────────

/**
 * Minimal ABI for the OZ TimelockController functions this panel uses.
 * Tracks `lib/openzeppelin-contracts/contracts/governance/TimelockController.sol`.
 */
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
    anonymous: false,
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** One pending timelocked operation. */
export interface PendingOp {
  /** 0x-hex operation id (bytes32). */
  readonly operationId: string;
  /** Unix timestamp (seconds) after which execution is allowed. */
  readonly readyTimestamp: bigint;
}

/** Component props. */
export interface TimelockPanelProps {
  /** 0x-prefixed TimelockController address. */
  readonly timelockAddress: Address;
  /**
   * The Safe address whose proposer/executor membership is displayed.
   * This is the expected proposer — the panel checks and shows whether it
   * holds PROPOSER_ROLE and EXECUTOR_ROLE.
   */
  readonly safeAddress: Address;
  /**
   * Pre-computed list of pending operation ids. These come from off-chain
   * log scanning (e.g. the parent page fetches CallScheduled events and
   * passes the op ids here). The panel reads each timestamp on-chain.
   *
   * When not provided, the panel shows the min delay and role info only.
   */
  readonly pendingOpIds?: readonly `0x${string}`[];
  /**
   * Current wall-clock time in **milliseconds** (i.e. `Date.now()`).
   * Injected at the call site so this component stays testable and
   * pure w.r.t. the real clock (react-guide §Prime directives).
   */
  readonly now: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Role hashes (pre-computed; match on-chain keccak256 values). */
const PROPOSER_ROLE = keccak256(toBytes("PROPOSER_ROLE"));
const EXECUTOR_ROLE = keccak256(toBytes("EXECUTOR_ROLE"));

/** Format seconds into a human-readable duration string. */
function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return "0s";
  const s = Number(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/** Sentinel value for a completed operation (matches OZ implementation). */
const DONE_TIMESTAMP = 1n;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * TimelockPanel renders the live state of the deployed TimelockController.
 *
 * It performs all reads via `useReadContracts` so they are batched into a
 * single multicall where the provider supports it. No wallet connection is
 * required — all calls are `eth_call` view reads.
 */
export function TimelockPanel({
  timelockAddress,
  safeAddress,
  pendingOpIds = [],
  now,
}: TimelockPanelProps) {
  const { data: blockNumber } = useBlockNumber({ watch: false });

  // Batch 1: static timelock info + role membership for Safe.
  const staticContracts = useMemo(
    () => [
      {
        address: timelockAddress,
        abi: timelockAbi,
        functionName: "getMinDelay" as const,
      },
      {
        address: timelockAddress,
        abi: timelockAbi,
        functionName: "hasRole" as const,
        args: [PROPOSER_ROLE, safeAddress] as const,
      },
      {
        address: timelockAddress,
        abi: timelockAbi,
        functionName: "hasRole" as const,
        args: [EXECUTOR_ROLE, safeAddress] as const,
      },
    ],
    [timelockAddress, safeAddress],
  );

  const { data: staticData, isLoading: staticLoading } = useReadContracts({
    contracts: staticContracts,
    query: { staleTime: 30_000 },
  });

  // Batch 2: getTimestamp for each pending op id.
  const timestampContracts = useMemo(
    () =>
      pendingOpIds.map((id) => ({
        address: timelockAddress,
        abi: timelockAbi,
        functionName: "getTimestamp" as const,
        args: [id] as const,
      })),
    [timelockAddress, pendingOpIds],
  );

  const { data: timestampData, isLoading: tsLoading } = useReadContracts({
    contracts: timestampContracts,
    query: { enabled: pendingOpIds.length > 0, staleTime: 30_000 },
  });

  // Current wall-clock time (seconds) for "time remaining" display.
  // `now` is injected as a prop (react-guide §Prime directives — no Date.now in render).
  const [nowSecs, setNowSecs] = useState(BigInt(Math.floor(now / 1000)));
  useEffect(() => {
    setNowSecs(BigInt(Math.floor(now / 1000)));
  }, [now]);

  // Derive display values.
  const minDelay = staticData?.[0]?.result as bigint | undefined;
  const safeIsProposer = staticData?.[1]?.result as boolean | undefined;
  const safeIsExecutor = staticData?.[2]?.result as boolean | undefined;

  // Build pending ops list (exclude completed / cancelled ops).
  const pendingOps: PendingOp[] = useMemo(() => {
    if (!timestampData || pendingOpIds.length === 0) return [];
    return pendingOpIds
      .map((id, i) => {
        const ts = timestampData[i]?.result as bigint | undefined;
        return { operationId: id, readyTimestamp: ts ?? 0n };
      })
      .filter((op) => op.readyTimestamp > DONE_TIMESTAMP)
      .sort((a, b) => (a.readyTimestamp < b.readyTimestamp ? -1 : 1));
  }, [pendingOpIds, timestampData]);

  const isLoading = staticLoading || tsLoading;

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <section aria-label="Timelocked proposals" className="timelock-panel">
      <h2>Timelock</h2>

      {isLoading && <p className="timelock-loading">Loading timelock state…</p>}

      {!isLoading && (
        <>
          {/* Min delay */}
          <div className="timelock-info">
            <span className="timelock-label">Minimum delay</span>
            <span className="timelock-value">
              {minDelay !== undefined ? formatDuration(minDelay) : "unavailable"}
            </span>
          </div>

          {/* Safe role membership */}
          <div className="timelock-info">
            <span className="timelock-label">Safe proposer ({safeAddress.slice(0, 8)}…)</span>
            <span className={`timelock-badge ${safeIsProposer ? "badge-ok" : "badge-warn"}`}>
              {safeIsProposer === undefined
                ? "—"
                : safeIsProposer
                  ? "PROPOSER ✓"
                  : "not a proposer ✗"}
            </span>
          </div>

          <div className="timelock-info">
            <span className="timelock-label">Safe executor ({safeAddress.slice(0, 8)}…)</span>
            <span className={`timelock-badge ${safeIsExecutor ? "badge-ok" : "badge-warn"}`}>
              {safeIsExecutor === undefined
                ? "—"
                : safeIsExecutor
                  ? "EXECUTOR ✓"
                  : "not an executor ✗"}
            </span>
          </div>

          {/* Pending operations */}
          <h3>Scheduled operations ({pendingOps.length})</h3>
          {pendingOps.length === 0 ? (
            <p className="timelock-empty">No pending operations.</p>
          ) : (
            <table className="timelock-ops-table">
              <thead>
                <tr>
                  <th>Operation ID</th>
                  <th>Ready at (UTC)</th>
                  <th>Time remaining</th>
                </tr>
              </thead>
              <tbody>
                {pendingOps.map((op) => {
                  const remainingSecs = op.readyTimestamp - nowSecs;
                  const isReady = remainingSecs <= 0n;
                  const readyDate = new Date(Number(op.readyTimestamp) * 1000).toUTCString();
                  return (
                    <tr key={op.operationId} className={isReady ? "op-ready" : "op-waiting"}>
                      <td className="op-id">
                        <code>{op.operationId}</code>
                      </td>
                      <td>{readyDate}</td>
                      <td>
                        {isReady ? (
                          <span className="badge-ok">Ready to execute</span>
                        ) : (
                          <span>{formatDuration(remainingSecs)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Footer note */}
          {blockNumber !== undefined && (
            <p className="timelock-footer">
              Block {blockNumber.toString()} • reads via wallet provider
            </p>
          )}
        </>
      )}
    </section>
  );
}
