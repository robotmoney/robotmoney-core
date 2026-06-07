// Canonical: docs/architecture.md §4.5 — Protocol Admin Authority

/**
 * TimelockPanel — issue #647 / docs/architecture.md §4.5
 *
 * Surfaces the on-chain state of the OpenZeppelin TimelockController:
 *   - Contract address
 *   - Minimum delay (seconds)
 *   - Proposer addresses (PROPOSER_ROLE holders)
 *   - Canceller addresses (CANCELLER_ROLE holders)
 *   - Executor policy (open vs restricted) and executor addresses
 *   - Pending operation hashes with ETA and status
 *
 * Data flow (all on-chain via wagmi useReadContract / useReadContracts):
 *   - getMinDelay()         → minDelaySecs
 *   - PROPOSER_ROLE()       → role hash, then hasRole(hash, knownAddrs)
 *   - CANCELLER_ROLE()      → role hash
 *   - EXECUTOR_ROLE()       → role hash, then hasRole(hash, address(0))
 *   - Past RoleGranted/RoleRevoked events decoded client-side to
 *     discover the member set (wagmi useWatchContractEvent not used —
 *     we read historical logs via getLogs through the public client).
 *   - Past CallScheduled events → operation ids, then getTimestamp(id)
 *     to determine pending vs done.
 *
 * Panel renders a loading state while data is fetched and an error state
 * if the contract address is unconfigured or any RPC call fails.
 *
 * Out of scope (per issue #647):
 *   - Scheduling, cancelling, or executing operations.
 *   - Role management UI.
 */
import { useEffect, useState } from "react";
import { usePublicClient, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { keccak256, toBytes, zeroAddress } from "viem";
import { timelockAbi, type TimelockState, type TimelockPendingOp } from "../lib/timelockApi";

// ─── Role selectors (keccak256 of role name strings) ─────────────────────────
// Computed once at module level — matches OZ TimelockController constants.
const PROPOSER_ROLE = keccak256(toBytes("PROPOSER_ROLE")) as `0x${string}`;
const CANCELLER_ROLE = keccak256(toBytes("CANCELLER_ROLE")) as `0x${string}`;
const EXECUTOR_ROLE = keccak256(toBytes("EXECUTOR_ROLE")) as `0x${string}`;

// Sentinel: OZ marks completed operations with getTimestamp == 1.
const DONE_TIMESTAMP = 1n;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimelockPanelProps {
  /**
   * 0x-prefixed TimelockController contract address.
   * When undefined the panel renders the config-missing error state.
   */
  readonly timelockAddress?: Address;
}

// ─── Internal state machine ───────────────────────────────────────────────────

type PanelState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; timelock: TimelockState };

// ─── Component ────────────────────────────────────────────────────────────────

export function TimelockPanel({ timelockAddress }: TimelockPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const publicClient = usePublicClient();

  // Phase 1 — read static scalar values (minDelay, role hashes).
  const { data: scalars, error: scalarsError } = useReadContracts({
    contracts: timelockAddress
      ? [
          {
            address: timelockAddress,
            abi: timelockAbi,
            functionName: "getMinDelay",
          } as const,
          {
            address: timelockAddress,
            abi: timelockAbi,
            functionName: "PROPOSER_ROLE",
          } as const,
          {
            address: timelockAddress,
            abi: timelockAbi,
            functionName: "CANCELLER_ROLE",
          } as const,
          {
            address: timelockAddress,
            abi: timelockAbi,
            functionName: "EXECUTOR_ROLE",
          } as const,
        ]
      : [],
    query: { enabled: !!timelockAddress },
  });

  useEffect(() => {
    if (!timelockAddress) {
      setState({
        kind: "error",
        message:
          "TimelockController address is not configured. Set VITE_TIMELOCK_ADDRESS to enable this panel.",
      });
      return;
    }

    if (scalarsError) {
      setState({ kind: "error", message: `RPC error: ${scalarsError.message}` });
      return;
    }

    if (!scalars) {
      setState({ kind: "loading" });
      return;
    }

    // Check for individual call errors.
    const minDelayResult = scalars[0];
    if (minDelayResult.status === "failure") {
      setState({
        kind: "error",
        message: `Failed to read minDelay: ${String(minDelayResult.error)}`,
      });
      return;
    }

    const minDelaySecs = minDelayResult.result as bigint;

    // Kick off the async discovery of role members and pending operations.
    void (async () => {
      try {
        if (!publicClient) {
          setState({ kind: "error", message: "No RPC client available." });
          return;
        }

        // ── Role member discovery via getLogs ──────────────────────────────

        async function fetchRoleMembers(roleHash: `0x${string}`): Promise<Address[]> {
          // RoleGranted(bytes32 indexed role, address indexed account, ...)
          const grantedLogs = await publicClient!.getLogs({
            address: timelockAddress!,
            event: {
              type: "event",
              name: "RoleGranted",
              inputs: [
                { name: "role", type: "bytes32", indexed: true },
                { name: "account", type: "address", indexed: true },
                { name: "sender", type: "address", indexed: true },
              ],
            },
            args: { role: roleHash },
            fromBlock: 0n,
            toBlock: "latest",
          });

          const revokedLogs = await publicClient!.getLogs({
            address: timelockAddress!,
            event: {
              type: "event",
              name: "RoleRevoked",
              inputs: [
                { name: "role", type: "bytes32", indexed: true },
                { name: "account", type: "address", indexed: true },
                { name: "sender", type: "address", indexed: true },
              ],
            },
            args: { role: roleHash },
            fromBlock: 0n,
            toBlock: "latest",
          });

          const members = new Set<Address>();
          for (const log of grantedLogs) {
            const account = (log.args as { account?: Address }).account;
            if (account) members.add(account);
          }
          for (const log of revokedLogs) {
            const account = (log.args as { account?: Address }).account;
            if (account) members.delete(account);
          }
          return [...members].sort();
        }

        // ── Pending operation discovery via CallScheduled logs ─────────────

        async function fetchPendingOps(): Promise<TimelockPendingOp[]> {
          const scheduledLogs = await publicClient!.getLogs({
            address: timelockAddress!,
            event: {
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
            fromBlock: 0n,
            toBlock: "latest",
          });

          // Collect unique operation ids.
          const opIds = new Set<`0x${string}`>();
          for (const log of scheduledLogs) {
            const id = (log.args as { id?: `0x${string}` }).id;
            if (id) opIds.add(id);
          }

          const nowSecs = BigInt(Math.floor(Date.now() / 1000));

          // Check each op's timestamp.
          const pending: TimelockPendingOp[] = [];
          await Promise.all(
            [...opIds].map(async (id) => {
              try {
                const ts = await publicClient!.readContract({
                  address: timelockAddress!,
                  abi: timelockAbi,
                  functionName: "getTimestamp",
                  args: [id],
                });
                const readyTs = ts as bigint;
                // ts == 0: cancelled/unknown; ts == 1 (DONE_TIMESTAMP): executed.
                if (readyTs > DONE_TIMESTAMP) {
                  pending.push({
                    operationId: id,
                    readyTimestamp: readyTs,
                    status: readyTs <= nowSecs ? "ready" : "waiting",
                  });
                }
              } catch {
                // Skip unreadable operation ids.
              }
            }),
          );

          // Sort by readyTimestamp ascending (earliest ready first).
          return pending.sort((a, b) => (a.readyTimestamp < b.readyTimestamp ? -1 : 1));
        }

        // ── Check executor policy ──────────────────────────────────────────

        async function fetchExecutorPolicy(): Promise<{
          policy: "open" | "restricted";
          executors: Address[];
        }> {
          // Open policy: address(0) holds EXECUTOR_ROLE.
          const isOpen = await publicClient!.readContract({
            address: timelockAddress!,
            abi: timelockAbi,
            functionName: "hasRole",
            args: [EXECUTOR_ROLE, zeroAddress],
          });

          if (isOpen as boolean) {
            return { policy: "open", executors: [] };
          }

          // Restricted: discover actual executor members via logs.
          const executors = await fetchRoleMembers(EXECUTOR_ROLE);
          return { policy: "restricted", executors };
        }

        const [proposers, cancellers, executorInfo, pendingOps] = await Promise.all([
          fetchRoleMembers(PROPOSER_ROLE),
          fetchRoleMembers(CANCELLER_ROLE),
          fetchExecutorPolicy(),
          fetchPendingOps(),
        ]);

        setState({
          kind: "ready",
          timelock: {
            address: timelockAddress,
            minDelaySecs,
            proposers,
            cancellers,
            executorPolicy: executorInfo.policy,
            executors: executorInfo.executors,
            pendingOps,
          },
        });
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [timelockAddress, scalars, scalarsError, publicClient]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (state.kind === "loading") {
    return (
      <section data-testid="timelock-loading">
        <h2>Timelock Controller</h2>
        <p className="hint">Loading timelock state…</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section data-testid="timelock-error">
        <h2>Timelock Controller</h2>
        <p className="error" data-testid="timelock-error-message">
          {state.message}
        </p>
      </section>
    );
  }

  const { timelock } = state;

  return (
    <section data-testid="timelock-panel">
      <h2>Timelock Controller</h2>
      <p className="hint">
        On-chain state of the OpenZeppelin TimelockController that guards all protocol-admin
        operations (architecture §4.5).
      </p>

      {/* ── Address ── */}
      <dl>
        <dt>Contract Address</dt>
        <dd>
          <code data-testid="timelock-address">{timelock.address}</code>
        </dd>

        {/* ── Min delay ── */}
        <dt>Minimum Delay</dt>
        <dd data-testid="timelock-min-delay">
          {timelock.minDelaySecs.toString()} seconds (
          {formatDelay(timelock.minDelaySecs)})
        </dd>

        {/* ── Proposers ── */}
        <dt>Proposers</dt>
        <dd data-testid="timelock-proposers">
          {timelock.proposers.length === 0 ? (
            <span className="hint">None</span>
          ) : (
            <ul>
              {timelock.proposers.map((addr) => (
                <li key={addr}>
                  <code>{addr}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>

        {/* ── Cancellers ── */}
        <dt>Cancellers</dt>
        <dd data-testid="timelock-cancellers">
          {timelock.cancellers.length === 0 ? (
            <span className="hint">None</span>
          ) : (
            <ul>
              {timelock.cancellers.map((addr) => (
                <li key={addr}>
                  <code>{addr}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>

        {/* ── Executor policy ── */}
        <dt>Executor Policy</dt>
        <dd data-testid="timelock-executor-policy">
          {timelock.executorPolicy === "open" ? (
            <span>
              Open — any address may execute after the delay (
              <code>address(0)</code> holds EXECUTOR_ROLE)
            </span>
          ) : (
            <>
              <span>Restricted — only the following addresses may execute:</span>
              <ul>
                {timelock.executors.map((addr) => (
                  <li key={addr}>
                    <code>{addr}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </dd>
      </dl>

      {/* ── Pending operations ── */}
      <h3>Pending Operations</h3>
      {timelock.pendingOps.length === 0 ? (
        <p className="hint" data-testid="timelock-no-pending-ops">
          No pending operations.
        </p>
      ) : (
        <table data-testid="timelock-pending-ops">
          <thead>
            <tr>
              <th>Operation ID</th>
              <th>Ready At (UTC)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {timelock.pendingOps.map((op) => (
              <tr key={op.operationId} data-testid={`timelock-op-${op.operationId}`}>
                <td>
                  <code data-testid="timelock-op-id">{op.operationId}</code>
                </td>
                <td data-testid="timelock-op-eta">
                  {new Date(Number(op.readyTimestamp) * 1000).toISOString()}
                </td>
                <td data-testid="timelock-op-status">
                  {op.status === "ready" ? "Ready to execute" : "Waiting for delay"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a delay in seconds as a human-readable string. */
function formatDelay(secs: bigint): string {
  const s = Number(secs);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
