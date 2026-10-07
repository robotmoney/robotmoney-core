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
 * Execute (core 1544): a ready single-call operation whose payload the dapp can
 * rebuild and decode offers "Prepare execute proposal". It opens the same
 * Safe -> Timelock flow as the admin tabs (SafeProposalPanel) for
 * `timelock.execute(...)`. The panel stays read-only otherwise.
 *
 * Out of scope (per issue #647):
 *   - Scheduling or cancelling operations from this panel.
 *   - Role management UI.
 */
import { useEffect, useState } from "react";
import { usePublicClient, useReadContracts } from "wagmi";
import type { Address, Hex } from "viem";
import { decodeFunctionData, keccak256, toBytes, zeroAddress } from "viem";
import { gatewayAbi } from "../lib/abi";
import { timelockOperationId } from "../lib/safeProposal";
import {
  timelockAbi,
  type TimelockPendingOp,
  type TimelockScheduledCall,
  type TimelockState,
} from "../lib/timelockApi";
import { SafeProposalPanel } from "./SafeProposalPanel";

// ─── Role selectors (keccak256 of role name strings) ─────────────────────────
const PROPOSER_ROLE = keccak256(toBytes("PROPOSER_ROLE")) as `0x${string}`;
const CANCELLER_ROLE = keccak256(toBytes("CANCELLER_ROLE")) as `0x${string}`;
const EXECUTOR_ROLE = keccak256(toBytes("EXECUTOR_ROLE")) as `0x${string}`;

const DONE_TIMESTAMP = 1n;

// ─── Module-level async helpers ──────────────────────────────────────────────

async function fetchRoleMembers(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  timelockAddress: Address,
  roleHash: `0x${string}`,
): Promise<Address[]> {
  const grantedLogs = await publicClient.getLogs({
    address: timelockAddress,
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

  const revokedLogs = await publicClient.getLogs({
    address: timelockAddress,
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

  return reconstructRoleMembers(grantedLogs, revokedLogs);
}

/**
 * Replay RoleGranted/RoleRevoked events **in chronological order** to derive
 * the current member set (DAPP-6 / RPC-14).
 *
 * The naive approach — add every grant, then delete every revoke — is
 * order-blind and corrupts a `grant → revoke → re-grant` history: the final
 * re-grant is dropped because all revokes are applied last. AccessControl emits
 * these events in chain order, so the correct reconstruction merges the
 * grant/revoke streams, sorts by `(blockNumber, logIndex)`, and applies each
 * event as it occurred — the last event for an account wins, so a re-granted
 * member is correctly shown as present.
 *
 * Exported for unit testing.
 */
export interface RoleEventLog {
  readonly args: { readonly account?: Address };
  readonly blockNumber?: bigint;
  readonly logIndex?: number;
}

export function reconstructRoleMembers(
  grantedLogs: readonly RoleEventLog[],
  revokedLogs: readonly RoleEventLog[],
): Address[] {
  interface Transition {
    blockNumber: bigint;
    logIndex: number;
    account: Address;
    granted: boolean;
  }

  const events: Transition[] = [];
  const collect = (logs: readonly RoleEventLog[], granted: boolean) => {
    for (const log of logs) {
      const account = log.args.account;
      if (!account) continue;
      events.push({
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        account,
        granted,
      });
    }
  };
  collect(grantedLogs, true);
  collect(revokedLogs, false);

  // Chronological replay: order by (blockNumber, logIndex). bigint comparison
  // is exact; logIndex breaks within-block ties.
  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const members = new Set<Address>();
  for (const e of events) {
    if (e.granted) members.add(e.account);
    else members.delete(e.account);
  }
  return [...members].sort();
}

interface ScheduledLog {
  readonly args: {
    readonly id?: Hex;
    readonly target?: Address;
    readonly value?: bigint;
    readonly data?: Hex;
    readonly predecessor?: Hex;
  };
}

async function fetchPendingOps(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  timelockAddress: Address,
  nowSecs: bigint,
): Promise<TimelockPendingOp[]> {
  const scheduledLogs = (await publicClient.getLogs({
    address: timelockAddress,
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
  })) as unknown as readonly ScheduledLog[];

  const saltLogs = (await publicClient.getLogs({
    address: timelockAddress,
    event: {
      type: "event",
      name: "CallSalt",
      inputs: [
        { name: "id", type: "bytes32", indexed: true },
        { name: "salt", type: "bytes32", indexed: false },
      ],
    },
    fromBlock: 0n,
    toBlock: "latest",
  })) as unknown as ReadonlyArray<{ args: { id?: Hex; salt?: Hex } }>;
  const saltById = new Map<Hex, Hex>();
  for (const log of saltLogs) {
    if (log.args.id && log.args.salt) saltById.set(log.args.id, log.args.salt);
  }

  const scheduledById = new Map<Hex, ScheduledLog[]>();
  for (const log of scheduledLogs) {
    const id = log.args.id;
    if (!id) continue;
    scheduledById.set(id, [...(scheduledById.get(id) ?? []), log]);
  }

  const pending: TimelockPendingOp[] = [];
  await Promise.all(
    [...scheduledById.keys()].map(async (id) => {
      try {
        const ts = await publicClient.readContract({
          address: timelockAddress,
          abi: timelockAbi,
          functionName: "getTimestamp",
          args: [id],
        });
        const readyTs = ts as bigint;
        if (readyTs > DONE_TIMESTAMP) {
          // The chain is the authority on readiness (its clock moves with the
          // delay, not with the browser's). Fall back to the wall clock only
          // when the node does not answer isOperationReady.
          let ready = readyTs <= nowSecs;
          try {
            const answer = await publicClient.readContract({
              address: timelockAddress,
              abi: timelockAbi,
              functionName: "isOperationReady",
              args: [id],
            });
            if (typeof answer === "boolean") ready = answer;
          } catch {
            /* keep the wall-clock verdict */
          }
          pending.push({
            operationId: id,
            readyTimestamp: readyTs,
            status: ready ? "ready" : "waiting",
            call: rebuildCall(id, scheduledById.get(id) ?? [], saltById.get(id)),
          });
        }
      } catch {
        // Skip unreadable operation ids.
      }
    }),
  );

  return pending.sort((a, b) => (a.readyTimestamp < b.readyTimestamp ? -1 : 1));
}

/**
 * Rebuild the `execute` arguments of a single-call operation. Returns undefined
 * (so no execute proposal is offered) for a batch, a call with value, or any
 * operation whose rebuilt `hashOperation` differs from its id.
 */
function rebuildCall(
  id: Hex,
  logs: readonly ScheduledLog[],
  salt: Hex | undefined,
): TimelockScheduledCall | undefined {
  const [only] = logs;
  if (logs.length !== 1 || !only) return undefined;
  const { target, value, data, predecessor } = only.args;
  if (!target || !data || !predecessor || (value ?? 0n) !== 0n) return undefined;
  const call: TimelockScheduledCall = {
    target,
    data,
    predecessor,
    salt: salt ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
  return timelockOperationId(call).toLowerCase() === id.toLowerCase() ? call : undefined;
}

/** The function the dapp can decode from an operation's inner call, or undefined. */
function decodeInner(data: Hex): string | undefined {
  try {
    return decodeFunctionData({ abi: gatewayAbi, data }).functionName;
  } catch {
    return undefined;
  }
}

async function fetchExecutorPolicy(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  timelockAddress: Address,
): Promise<{ policy: "open" | "restricted"; executors: Address[] }> {
  const isOpen = await publicClient.readContract({
    address: timelockAddress,
    abi: timelockAbi,
    functionName: "hasRole",
    args: [EXECUTOR_ROLE, zeroAddress],
  });

  if (isOpen as boolean) {
    return { policy: "open", executors: [] };
  }

  const executors = await fetchRoleMembers(publicClient, timelockAddress, EXECUTOR_ROLE);
  return { policy: "restricted", executors };
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimelockPanelProps {
  readonly timelockAddress?: Address;
  /** The Safe that proposes to the timelock (core 1544). Absent: execute proposals are blocked. */
  readonly safeAddress?: Address;
  /** Wall-clock ms, injected from parent — never call Date.now in render. */
  readonly now: number;
}

// ─── Internal state machine ───────────────────────────────────────────────────

type PanelState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; timelock: TimelockState };

// ─── Component ────────────────────────────────────────────────────────────────

export function TimelockPanel({ timelockAddress, safeAddress, now }: TimelockPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [executing, setExecuting] = useState<string | null>(null);
  const publicClient = usePublicClient();

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

    const minDelayResult = scalars[0];
    if (minDelayResult === undefined) {
      setState({ kind: "error", message: "minDelay read returned no result." });
      return;
    }
    if (minDelayResult.status === "failure") {
      setState({
        kind: "error",
        message: `Failed to read minDelay: ${String(minDelayResult.error)}`,
      });
      return;
    }

    const minDelaySecs = minDelayResult.result as bigint;

    void (async () => {
      try {
        if (!publicClient) {
          setState({ kind: "error", message: "No RPC client available." });
          return;
        }

        const nowSecs = BigInt(Math.floor(now / 1000));

        const [proposers, cancellers, executorInfo, pendingOps] = await Promise.all([
          fetchRoleMembers(publicClient, timelockAddress, PROPOSER_ROLE),
          fetchRoleMembers(publicClient, timelockAddress, CANCELLER_ROLE),
          fetchExecutorPolicy(publicClient, timelockAddress),
          fetchPendingOps(publicClient, timelockAddress, nowSecs),
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
  }, [timelockAddress, scalars, scalarsError, publicClient, now]);

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
          {timelock.minDelaySecs.toString()} seconds ({formatDelay(timelock.minDelaySecs)})
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
              Open — any address may execute after the delay (<code>address(0)</code> holds
              EXECUTOR_ROLE)
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
        <div className="table-scroll">
          <table data-testid="timelock-pending-ops">
            <thead>
              <tr>
                <th>Operation ID</th>
                <th>Ready At (UTC)</th>
                <th>Status</th>
                <th>Execute</th>
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
                  <td>
                    {op.status === "ready" && op.call && decodeInner(op.call.data) && (
                      <button
                        type="button"
                        data-testid={`timelock-op-execute-${op.operationId}`}
                        onClick={() =>
                          setExecuting(executing === op.operationId ? null : op.operationId)
                        }
                      >
                        Prepare execute proposal
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {timelock.pendingOps.map((op) =>
        executing === op.operationId && op.call ? (
          <div key={op.operationId} data-testid={`timelock-op-execute-panel-${op.operationId}`}>
            <h4>Execute proposal for {op.operationId}</h4>
            <p className="hint">
              Inner call: <code>{decodeInner(op.call.data)}</code> on <code>{op.call.target}</code>
            </p>
            <SafeProposalPanel
              testId={`timelock-exec-${op.operationId}`}
              safeAddress={safeAddress}
              timelockAddress={timelock.address}
              request={{
                kind: "execute",
                target: op.call.target,
                data: op.call.data,
                predecessor: op.call.predecessor,
                salt: op.call.salt,
                action: "execute",
                description: `execute operation ${op.operationId}`,
              }}
            />
          </div>
        ) : null,
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
