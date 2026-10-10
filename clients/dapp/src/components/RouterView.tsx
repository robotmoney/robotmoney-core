// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * RouterView — reads GET /v1/router/weights, GET /v1/governance/proposals,
 * and GET /v1/vaults.
 *
 * Shows the Portfolio Router weights, the pending governance proposal (if
 * any), and the weight-change history. Works without a connected wallet.
 *
 * Weights come from the ROUTER ITSELF (issue 1741), read through wagmi (no
 * wallet needed), at the latest block, refetched every WEIGHTS_REFETCH_MS:
 *   - `getEffectiveWeights()` + `votedWeightsActive()` give the vector the
 *     router routes by and which kind it is: "Effective: voted" when
 *     `votedWeightsActive()` is true, "Effective: default" when it is false.
 *   - `getWeights()` is the voted vector, `getDefaultWeights()` the default one;
 *     both are shown so the two can never be mistaken for each other.
 * The explorer API is NOT the source of the effective weights: its
 * `current_weights` was the last WeightsSet OR DefaultWeightsSet event, so a
 * later default-vector change displayed as the effective vector while the
 * voted vector still overrode it. The explorer supplies the vault names, the
 * pending proposal and the weight-change history only. When the router cannot
 * be read the tab says "unknown" and shows no label.
 *
 * Enhancements (issue #615):
 * - Resolves vault hex addresses to human-readable names via /v1/vaults.
 * - Displays bps as both raw value and percentage (bps / 100).
 * - Renders a proportional bar for each weight entry.
 *
 * issue #318 — protocol layer.
 */
import { useEffect, useState } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { routerAbi } from "../lib/abi";
import { useWriteChainGuard } from "../lib/useGuardedWriteContract";
import { depositsReadAllowed } from "../lib/useVaultsDepositsPaused";
import type {
  FetchLike,
  RouterWeightsResponse,
  ProposalSummary,
  ProposalsResponse,
  VaultsResponse,
} from "../lib/explorerApi";
import { fetchRouterWeights, fetchProposals, fetchVaults } from "../lib/explorerApi";
import { formatPercentFromNumber } from "../lib/format";

/** How often the router weights are read again, in ms (the same cadence as the router deposit tab). */
export const WEIGHTS_REFETCH_MS = 12_000;

interface RouterViewProps {
  apiUrl: string;
  fetchImpl?: FetchLike;
  /** The PortfolioRouter. Absent means the weights cannot be read: the tab says so and labels nothing. */
  routerAddress?: Address;
}

type Vector = readonly { readonly vault: string; readonly bps: number }[];

/** A `(address[] vaults, uint256[] bps)` return as a vector; undefined when it is not that shape. */
function toVector(raw: unknown): Vector | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [vaults, bps] = raw as [unknown, unknown];
  if (!Array.isArray(vaults) || !Array.isArray(bps) || vaults.length !== bps.length) {
    return undefined;
  }
  return vaults.map((v, i) => ({ vault: String(v), bps: Number(bps[i]) }));
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ok";
      weights: RouterWeightsResponse;
      pendingProposal: ProposalSummary | null;
      vaultNames: Record<string, string>;
    };

export function RouterView({ apiUrl, fetchImpl, routerAddress }: RouterViewProps) {
  const [state, setState] = useState<State>({ phase: "loading" });
  // Reads go through the wallet provider, which answers for the chain it is on. On the mainnet class a wallet that
  // is absent or on another chain would answer with ITS chain's contract at the router address, so the read is
  // pinned to the deployment's chain and runs only when the write-chain guard allows it (as in
  // useVaultsDepositsPaused). Otherwise the tab says "unknown" and labels nothing.
  const { state: guard } = useWriteChainGuard();
  const readAllowed = depositsReadAllowed(guard);
  const chainId = guard.kind === "ok" ? guard.targetChainId : undefined;
  const chain = useReadContracts({
    allowFailure: true,
    contracts: (
      ["getEffectiveWeights", "votedWeightsActive", "getWeights", "getDefaultWeights"] as const
    ).map((functionName) => ({
      address: routerAddress as Address,
      abi: routerAbi,
      functionName,
      chainId,
    })),
    query: { enabled: routerAddress != null && readAllowed, refetchInterval: WEIGHTS_REFETCH_MS },
  });

  useEffect(() => {
    const ac = new AbortController();
    const opts = { fetchImpl, signal: ac.signal };

    Promise.all([
      fetchRouterWeights(apiUrl, opts),
      fetchProposals(apiUrl, opts),
      fetchVaults(apiUrl, opts),
    ])
      .then(
        ([weights, proposals, vaultsResp]: [
          RouterWeightsResponse,
          ProposalsResponse,
          VaultsResponse,
        ]) => {
          const pendingProposal = proposals.proposals.find((p) => p.status === "open") ?? null;
          // Build a map from lower-cased vault address → display name.
          const vaultNames: Record<string, string> = {};
          for (const v of vaultsResp.vaults) {
            vaultNames[v.address.toLowerCase()] = v.name;
          }
          setState({ phase: "ok", weights, pendingProposal, vaultNames });
        },
      )
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState({ phase: "error", message: String(err) });
      });
    return () => ac.abort();
  }, [apiUrl, fetchImpl]);

  const names = state.phase === "ok" ? state.vaultNames : {};
  /**
   * Resolve a vault address to its human-readable name.
   * Falls back to the raw hex address when the vault is not in the registry.
   */
  function resolveVaultName(address: string): string {
    return names[address.toLowerCase()] ?? address;
  }

  // The four router reads: effective vector, voted flag, voted vector, default vector (in that order).
  // A blocked read has no data to show, even if an earlier one cached some on another chain.
  const [effectiveR, activeR, votedR, defaultR] = readAllowed ? (chain.data ?? []) : [];
  const effective = effectiveR?.status === "success" ? toVector(effectiveR.result) : undefined;
  const votedActive = activeR?.status === "success" ? activeR.result : undefined;
  const voted = votedR?.status === "success" ? toVector(votedR.result) : undefined;
  const defaults = defaultR?.status === "success" ? toVector(defaultR.result) : undefined;
  const chainLoading = routerAddress != null && readAllowed && chain.isLoading;
  // The label needs BOTH the effective vector and the flag. One of them missing is "unknown", never a guess.
  const source: "voted" | "default" | null =
    effective !== undefined && typeof votedActive === "boolean"
      ? votedActive
        ? "voted"
        : "default"
      : null;

  return (
    <section data-testid="router-view" className="router-view">
      <h2>Portfolio Router</h2>

      <h3>Current Weights</h3>
      {chainLoading ? (
        <p data-testid="router-view-weights-loading">Reading the router…</p>
      ) : source === null || effective === undefined ? (
        <p data-testid="router-view-weights-unknown" role="alert">
          Effective weights unknown:{" "}
          {routerAddress == null
            ? "the router address is not configured."
            : !readAllowed
              ? "connect a wallet on the deployment's chain to read the router."
              : "the router could not be read."}
        </p>
      ) : (
        <>
          <p
            data-testid="router-view-weight-source"
            data-weight-source={source}
            className="weight-source-label"
          >
            {source === "voted" ? "Effective: voted" : "Effective: default"}
          </p>
          <p className="hint" data-testid="router-view-weights-note">
            Read from the router itself (getEffectiveWeights, votedWeightsActive) at its latest
            block, refreshed every {WEIGHTS_REFETCH_MS / 1000} s.
          </p>
          <WeightTable
            vector={effective}
            testPrefix="router-view-weight"
            tableTestId="router-view-weights-table"
            emptyTestId="router-view-weights-empty"
            emptyText="The router has no weights set."
            resolveVaultName={resolveVaultName}
          />
          <h4>Voted vector {votedActive ? "(in effect)" : "(not in effect)"}</h4>
          {voted === undefined ? (
            <p data-testid="router-view-voted-unknown">unknown</p>
          ) : (
            <WeightTable
              vector={voted}
              testPrefix="router-view-voted-weight"
              tableTestId="router-view-voted-table"
              emptyTestId="router-view-voted-empty"
              emptyText="No voted vector: no proposal has set weights."
              resolveVaultName={resolveVaultName}
            />
          )}
          <h4>Default vector {votedActive ? "(overridden by the voted vector)" : "(in effect)"}</h4>
          {defaults === undefined ? (
            <p data-testid="router-view-default-unknown">unknown</p>
          ) : (
            <WeightTable
              vector={defaults}
              testPrefix="router-view-default-weight"
              tableTestId="router-view-default-table"
              emptyTestId="router-view-default-empty"
              emptyText="No default vector set."
              resolveVaultName={resolveVaultName}
            />
          )}
        </>
      )}

      {state.phase === "loading" && <p data-testid="router-view-loading">Loading router state…</p>}
      {state.phase === "error" && <p data-testid="router-view-error">{state.message}</p>}
      {state.phase === "ok" && (
        <ExplorerSections
          weights={state.weights}
          pendingProposal={state.pendingProposal}
          resolveVaultName={resolveVaultName}
        />
      )}
    </section>
  );
}

function WeightTable(props: {
  readonly vector: Vector;
  readonly testPrefix: string;
  readonly tableTestId: string;
  readonly emptyTestId: string;
  readonly emptyText: string;
  readonly resolveVaultName: (address: string) => string;
}) {
  const { vector, testPrefix, resolveVaultName } = props;
  if (vector.length === 0) return <p data-testid={props.emptyTestId}>{props.emptyText}</p>;
  return (
    <div className="table-scroll">
      <table data-testid={props.tableTestId}>
        <thead>
          <tr>
            <th>Vault</th>
            <th>Weight (bps)</th>
            <th>Allocation</th>
          </tr>
        </thead>
        <tbody>
          {vector.map((w) => (
            <tr key={w.vault} data-testid={`${testPrefix}-row`}>
              <td data-testid={`${testPrefix}-vault`}>{resolveVaultName(w.vault)}</td>
              <td data-testid={`${testPrefix}-bps`}>
                <span data-testid={`${testPrefix}-bps-raw`}>{w.bps}</span>
                {" bps ("}
                <span data-testid={`${testPrefix}-bps-pct`}>{formatPercentFromNumber(w.bps)}</span>
                {")"}
              </td>
              <td data-testid={`${testPrefix}-bar-cell`}>
                <div
                  data-testid={`${testPrefix}-bar`}
                  className="weight-bar"
                  style={{
                    width: formatPercentFromNumber(w.bps),
                    background: "var(--accent, #4f8ef7)",
                    height: "0.75em",
                    borderRadius: "2px",
                    minWidth: "2px",
                  }}
                  title={`${formatPercentFromNumber(w.bps)}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The pending proposal and the indexed weight-change history: what the explorer knows. */
function ExplorerSections(props: {
  readonly weights: RouterWeightsResponse;
  readonly pendingProposal: ProposalSummary | null;
  readonly resolveVaultName: (address: string) => string;
}) {
  const { weights, pendingProposal, resolveVaultName } = props;
  return (
    <>
      <h3>Pending Proposal</h3>
      {pendingProposal == null ? (
        <p data-testid="router-view-no-proposal">No pending proposal.</p>
      ) : (
        <div data-testid="router-view-pending-proposal" className="stat-card">
          <p>
            <strong>#{pendingProposal.proposal_id}</strong>:{" "}
            <span data-testid="router-view-proposal-description">
              {pendingProposal.description}
            </span>
          </p>
          <p>
            Status: <span data-testid="router-view-proposal-status">{pendingProposal.status}</span>
          </p>
          <p>Deadline block: {pendingProposal.deadline_block}</p>
        </div>
      )}

      <h3>Weight History</h3>
      {weights.history.length === 0 ? (
        <p data-testid="router-view-history-empty">No weight history.</p>
      ) : (
        <div className="table-scroll">
          <table data-testid="router-view-history-table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Tx Hash</th>
                <th>Weights</th>
              </tr>
            </thead>
            <tbody>
              {weights.history.map((entry) => (
                <tr key={entry.block_number} data-testid="router-view-history-row">
                  <td data-testid="router-view-history-block">{entry.block_number}</td>
                  <td data-testid="router-view-history-tx" className="font-mono">
                    {entry.tx_hash}
                  </td>
                  <td>
                    {entry.weights
                      .map(
                        (w) =>
                          `${resolveVaultName(w.vault)}: ${w.bps}bps (${formatPercentFromNumber(w.bps)})`,
                      )
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p data-testid="router-view-freshness">
        Weight history indexed to block {weights.block_number}
      </p>
    </>
  );
}
