// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * GovernancePanel — issue #322 / #364 / docs/architecture.md §5.3
 *
 * Displays the active governance proposal: proposed weight vector,
 * current vote tally, quorum threshold, time remaining, and execution
 * state. Connected accounts with admin-assigned voting power see a
 * "Vote" button that encodes a `RouterGovernance.vote(proposalId)` call
 * and hands it to the wallet.
 *
 * NOTE: Current governance is admin-weighted (MVP mock). Voting power is
 * assigned by ADMIN_ROLE, not derived from token holdings. Token-holder
 * voting is a future goal.
 *
 * Data flow:
 *   - Proposal list and tally: fetched from GET /v1/governance/proposals
 *     (indexed API per §12 — no live RPC for proposal state).
 *   - Voting power: the connected wallet's live power is read for display via
 *     `RouterGovernance.votingPower(connectedAddress)`, but vote eligibility is
 *     gated on the proposal's SNAPSHOT power — `proposalVoteSnapshot(id)` then
 *     `getPastVotes(voter, snapshotBlock)` (DAPP-1). RouterGovernance uses
 *     admin-assigned on-chain voting power, not an ERC-20 token.
 *   - Voting: wagmi `useWriteContract` encodes vote(proposalId) calldata
 *     against the on-chain RouterGovernance ABI before wallet invocation.
 *
 * Out of scope (per issue #322):
 *   - Proposal creation UI.
 *   - execute() trigger from dapp.
 *
 * ── DAPP-1/DAPP-2 remediation (off-chain scan residual; issue #1025) ─────────
 * Canonical: docs/code-review/20260619-code-review-internal-claude-scan-verification.md (dapp
 * subsystem table). Both findings flagged by the 2026-06-19 scan are FIXED:
 *
 * DAPP-1 (Med) — vote gating now uses SNAPSHOT power, not CURRENT power.
 *   The "Vote" button was gated on `votingPower` read live from
 *   `RouterGovernance.votingPower(connectedAddress)`. On-chain `vote()` settles
 *   against the proposal's SNAPSHOT power captured at propose() time, so the
 *   live read showed the wrong eligibility for any account whose power changed
 *   after the snapshot. The gate now reads `proposalVoteSnapshot(proposalId)`
 *   for the snapshot block, then `getPastVotes(voter, snapshotBlock)` for the
 *   pinned power, and feeds that into `canVote`. The live `votingPower` read is
 *   retained for display only; the vote-encode path is unchanged.
 *
 * DAPP-2 (Med) — router deposit now submits NON-ZERO per-leg share floors.
 *   Fixed in the SIBLING component `RouterDepositTab.tsx`: the deposit
 *   simulation previously called `router.deposit(depositAssets, [])` with an
 *   empty `minSharesPerLeg` array (no slippage floor). It now derives a
 *   non-zero floor per leg from the `previewDeposit` per-leg `estShares` minus
 *   a tolerance (`deriveMinSharesPerLeg` in lib/routerPreview.ts) and passes
 *   that array as the second `deposit` arg.
 */
import { useEffect, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useSimulateContract } from "wagmi";
import type { Address } from "viem";
import type { FetchLike } from "../lib/explorerApi";
import { fetchProposals, type ProposalSummary, type ProposalsResponse } from "../lib/governanceApi";
import { PLACEHOLDER } from "../lib/format";

// ─── RouterGovernance ABI (vote + votingPower) ───────────────────────────────

/**
 * Minimal ABI fragments for RouterGovernance.
 * Tracks the canonical interface in `contracts/RouterGovernance.sol`.
 * Only the functions needed by this component appear here; the full
 * ABI lives with the Foundry contracts.
 */
export const routerGovernanceVoteAbi = [
  {
    type: "function",
    name: "vote",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "votingPower",
    stateMutability: "view",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // DAPP-1 (issue #1025): snapshot-pinned vote-power accessors. On-chain
  // `vote()` settles against the proposal's snapshot block, so eligibility
  // must be gated on snapshot power, not the connected wallet's live power.
  {
    type: "function",
    name: "proposalVoteSnapshot",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPastVotes",
    stateMutability: "view",
    inputs: [
      { name: "voter", type: "address" },
      { name: "blockNumber", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface GovernancePanelProps {
  /** 0x-prefixed RouterGovernance contract address. */
  readonly governanceAddress: Address;
  /** Resolved explorer API base URL (no trailing slash). */
  readonly apiUrl: string;
  /**
   * Optional fetch implementation. Tests inject a mock; production
   * code uses the global `fetch`.
   */
  readonly fetchImpl?: FetchLike;
}

// ─── Internal state machine ───────────────────────────────────────────────────

type PanelState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "no-proposal" }
  | {
      kind: "ready";
      proposals: readonly ProposalSummary[];
      latestBlock: number;
      indexedAt: string;
    };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return a human-readable status label with emoji. */
function statusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open — voting in progress";
    case "passed":
      return "Passed — awaiting execution";
    case "executed":
      return "Executed — weights applied";
    case "expired":
      return "Expired — quorum not reached";
    default:
      return status;
  }
}

/** Format a Unix-seconds timestamp as a readable UTC string. */
function formatTimestamp(unixSec: number): string {
  return new Date(unixSec * 1000).toUTCString();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GovernancePanel(props: GovernancePanelProps) {
  const { address, isConnected } = useAccount();
  const [panelState, setPanelState] = useState<PanelState>({ kind: "loading" });
  const [selectedProposalId, setSelectedProposalId] = useState<number | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [voteSuccess, setVoteSuccess] = useState<string | null>(null);

  // ── Fetch proposals from indexed API ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setPanelState({ kind: "loading" });
    fetchProposals(props.apiUrl, {
      fetchImpl: props.fetchImpl,
      signal: ac.signal,
    })
      .then((res: ProposalsResponse) => {
        if (cancelled) return;
        if (res.proposals.length === 0) {
          setPanelState({ kind: "no-proposal" });
          return;
        }
        setPanelState({
          kind: "ready",
          proposals: res.proposals,
          latestBlock: res.block_number,
          indexedAt: res.indexed_at,
        });
        // Auto-select the first open proposal, or the first proposal.
        const openProposal = res.proposals.find((p) => p.status === "open");
        setSelectedProposalId(openProposal?.proposal_id ?? res.proposals[0].proposal_id);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPanelState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [props.apiUrl, props.fetchImpl]);

  // ── Live admin-assigned voting power (display only) ─────────────────────────
  // RouterGovernance uses admin-assigned on-chain voting power — not ERC-20
  // token balances. The connected wallet's *current* power is shown to the user
  // for context, but vote eligibility/weight is gated on SNAPSHOT power below
  // (DAPP-1) because on-chain `vote()` settles against the proposal's snapshot.
  const { data: votingPower } = useReadContract({
    address: props.governanceAddress,
    abi: routerGovernanceVoteAbi,
    functionName: "votingPower",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  // ── Derive the selected proposal ────────────────────────────────────────────
  const proposals = panelState.kind === "ready" ? panelState.proposals : [];
  const selectedProposal =
    selectedProposalId !== null
      ? (proposals.find((p) => p.proposal_id === selectedProposalId) ?? null)
      : null;

  // ── Snapshot-pinned voting power (DAPP-1, issue #1025) ──────────────────────
  // 1. Read the proposal's snapshot block captured at propose() time.
  const { data: snapshotBlock } = useReadContract({
    address: props.governanceAddress,
    abi: routerGovernanceVoteAbi,
    functionName: "proposalVoteSnapshot",
    args: selectedProposal ? [BigInt(selectedProposal.proposal_id)] : undefined,
    query: { enabled: selectedProposal !== null },
  });

  // 2. Read the connected wallet's power AT that snapshot block — this is the
  //    power the contract's vote() will actually settle against.
  const { data: snapshotVotingPower } = useReadContract({
    address: props.governanceAddress,
    abi: routerGovernanceVoteAbi,
    functionName: "getPastVotes",
    args: address && typeof snapshotBlock === "bigint" ? [address, snapshotBlock] : undefined,
    query: {
      enabled: isConnected && Boolean(address) && typeof snapshotBlock === "bigint",
    },
  });

  // ── vote() simulation + write ────────────────────────────────────────────────
  // Gate eligibility on SNAPSHOT power (DAPP-1), not the live `votingPower`:
  // an account whose power changed after the snapshot must see the eligibility
  // the contract will actually enforce.
  const canVote =
    isConnected &&
    Boolean(address) &&
    selectedProposal !== null &&
    selectedProposal.status === "open" &&
    typeof snapshotVotingPower === "bigint" &&
    snapshotVotingPower > 0n;

  const { data: voteSim } = useSimulateContract({
    account: address,
    address: props.governanceAddress,
    abi: routerGovernanceVoteAbi,
    functionName: "vote",
    args: selectedProposal ? [BigInt(selectedProposal.proposal_id)] : undefined,
    query: { enabled: canVote },
  });

  const voteWrite = useWriteContract();

  const onVote = () => {
    if (!voteSim) return;
    setVoteError(null);
    setVoteSuccess(null);
    voteWrite.writeContract(voteSim.request, {
      onSuccess: (txHash: string) => {
        setVoteSuccess(`Vote submitted. tx: ${txHash}`);
      },
      onError: (err: Error) => {
        setVoteError(err.message);
      },
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <section data-testid="governance-panel">
      <h2>Admin-weighted governance (MVP) — Weight Proposals</h2>

      {panelState.kind === "loading" && <p data-testid="governance-loading">Loading proposals…</p>}

      {panelState.kind === "error" && (
        <p data-testid="governance-error">Failed to load proposals: {panelState.message}</p>
      )}

      {panelState.kind === "no-proposal" && (
        <p data-testid="governance-no-proposal">No proposals found.</p>
      )}

      {panelState.kind === "ready" && (
        <>
          <p data-testid="governance-freshness">
            Indexed to block <code>{panelState.latestBlock}</code> at{" "}
            <code>{panelState.indexedAt}</code>
          </p>

          {/* Voting power — admin-assigned on-chain weight */}
          {isConnected && (
            <p data-testid="governance-voting-power">
              Your voting power:{" "}
              <strong data-testid="governance-voting-power-value">
                {typeof votingPower === "bigint"
                  ? votingPower.toLocaleString("en-US")
                  : PLACEHOLDER}
              </strong>
            </p>
          )}

          {/* Snapshot voting power — the power vote() actually settles against
              (DAPP-1, issue #1025). This, not the live power above, gates the
              vote button for the selected proposal. */}
          {isConnected && selectedProposal !== null && (
            <p data-testid="governance-snapshot-voting-power">
              Your voting power at this proposal&apos;s snapshot:{" "}
              <strong data-testid="governance-snapshot-voting-power-value">
                {typeof snapshotVotingPower === "bigint"
                  ? snapshotVotingPower.toLocaleString("en-US")
                  : PLACEHOLDER}
              </strong>
            </p>
          )}

          {/* Proposal list / selector */}
          {proposals.length > 1 && (
            <div data-testid="governance-proposal-list">
              <label htmlFor="proposal-select">Proposal:</label>
              <select
                id="proposal-select"
                data-testid="governance-proposal-select"
                value={selectedProposalId ?? ""}
                onChange={(e) => setSelectedProposalId(Number(e.target.value))}
              >
                {proposals.map((p) => (
                  <option key={p.proposal_id} value={p.proposal_id}>
                    #{p.proposal_id} — {p.status}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Selected proposal detail */}
          {selectedProposal && (
            <div data-testid="governance-proposal-detail">
              <h3 data-testid="governance-proposal-id">Proposal #{selectedProposal.proposal_id}</h3>

              <p data-testid="governance-proposal-description">{selectedProposal.description}</p>

              <dl>
                <dt>Status</dt>
                <dd data-testid="governance-proposal-status">
                  {statusLabel(selectedProposal.status)}
                </dd>

                <dt>Proposer</dt>
                <dd data-testid="governance-proposal-proposer">
                  <code>{selectedProposal.proposer}</code>
                </dd>

                <dt>Created at</dt>
                <dd data-testid="governance-proposal-created-at">
                  {formatTimestamp(selectedProposal.created_at)}
                </dd>

                <dt>Deadline block</dt>
                <dd data-testid="governance-proposal-deadline-block">
                  {selectedProposal.deadline_block}
                </dd>

                <dt>Votes for</dt>
                <dd data-testid="governance-proposal-votes-for">{selectedProposal.votes_for}</dd>

                <dt>Votes against</dt>
                <dd data-testid="governance-proposal-votes-against">
                  {selectedProposal.votes_against}
                </dd>
              </dl>

              {/* Execution state for executed proposals */}
              {selectedProposal.status === "executed" && (
                <p data-testid="governance-proposal-executed-state">
                  Proposal executed — weights applied on-chain.
                </p>
              )}

              {/* Voting prompt — only for open proposals */}
              {selectedProposal.status === "open" && (
                <div data-testid="governance-voting-prompt">
                  <p>
                    Casting a vote encodes{" "}
                    <code>RouterGovernance.vote({selectedProposal.proposal_id})</code> against{" "}
                    <code data-testid="governance-contract-address">{props.governanceAddress}</code>
                    .
                  </p>
                  <button
                    type="button"
                    data-testid="governance-vote-button"
                    onClick={onVote}
                    disabled={!canVote || !voteSim || voteWrite.isPending}
                  >
                    {voteWrite.isPending ? "Signing…" : "Vote"}
                  </button>
                  {!isConnected && (
                    <p data-testid="governance-connect-hint">Connect your wallet to vote.</p>
                  )}
                  {isConnected &&
                    typeof snapshotVotingPower === "bigint" &&
                    snapshotVotingPower === 0n && (
                      <p data-testid="governance-no-voting-power-hint">
                        You held no voting power at this proposal&apos;s snapshot block and cannot
                        vote on it.
                      </p>
                    )}
                  {voteError && <p data-testid="governance-vote-error">Vote failed: {voteError}</p>}
                  {voteSuccess && <p data-testid="governance-vote-success">{voteSuccess}</p>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
