// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §2.1
// Implements: issue #1247 tasks 4.9 and 4.14, acceptance criterion 6

/**
 * ConsensusReceiptPanel — the protocol-layer surface for anchored consensus
 * recommendation receipts.
 *
 * Four things this surface must get right, each a first-class product
 * requirement rather than polish:
 *
 * 1. **The signature count is labelled as payload signatures.** The chain
 *    proves the committee produced the recommendation and that ONE submitter
 *    attested to it. It does not prove each named analyst signed. Rendering the
 *    count without that label would imply per-analyst on-chain attestation,
 *    which is false.
 * 2. **Verified vs unverified is explicit.** "Verified" means the indexer
 *    re-fetched the payload and its keccak256 matched the anchored digest.
 *    Unverified covers both a mismatch and an unreachable payload, and the
 *    surface says which.
 * 3. **Released vs recorded-only is explicit.** Most receipts are
 *    informational by design. An unreleased receipt is a permanent public
 *    record, not a pending one.
 * 4. **Applied vs not-applied per recommendation.** A public record of
 *    recommendations that were mostly not followed is honest and valuable, or
 *    misleading and damaging, and the difference is entirely presentation.
 *    "Cannot tell" is rendered as its own state and never collapsed into
 *    "not applied".
 *
 * Deliberately NOT claimed here: that the record is tamper-proof or
 * censorship-resistant. That property lands at mainnet deployment, not at
 * v0.1's devnet proof of the mechanism (docs/architecture.md §4.9).
 */
import { useEffect, useState } from "react";
import type {
  ConsensusReceipt,
  ReceiptPayload,
  AppliedState,
  FetchLike,
} from "../lib/consensusReceiptApi";
import {
  ConsensusReceiptApiClient,
  computeAppliedState,
  payloadSignatureCount,
} from "../lib/consensusReceiptApi";
import type { VaultWeight } from "../lib/explorerApi";
import { fetchRouterWeights } from "../lib/explorerApi";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ConsensusReceiptPanelProps {
  /** Base URL for the explorer-api service. */
  readonly explorerApiUrl: string;
  /**
   * Deployment's vault symbol → address map (rmUSDC, rmPROTO, rmAGENT, rmRWA).
   * When absent, applied state renders as "cannot determine" rather than
   * guessing — the bucket-vault map is per-deployment and a global or zero
   * address must never be substituted.
   */
  readonly vaultAddressBySymbol?: Readonly<Record<string, string>>;
  /** Optional fetch override for testing. */
  readonly fetch?: FetchLike;
  /** Maximum receipts to list. */
  readonly limit?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function shortHex(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function appliedLabel(state: AppliedState): string {
  switch (state) {
    case "applied":
      return "Applied — live router weights match this recommendation";
    case "not_applied":
      return "Not applied — live router weights differ from this recommendation";
    default:
      return "Cannot determine whether this recommendation was applied";
  }
}

interface Row {
  readonly receipt: ConsensusReceipt;
  readonly payload: ReceiptPayload | null;
  readonly applied: AppliedState;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ConsensusReceiptPanel(props: ConsensusReceiptPanelProps) {
  const { explorerApiUrl, vaultAddressBySymbol, limit = 25 } = props;
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = new ConsensusReceiptApiClient(explorerApiUrl, props.fetch);

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listed = await client.listReceipts(limit);

        let routerWeights: readonly VaultWeight[] | null = null;
        try {
          const rw = await fetchRouterWeights(explorerApiUrl, { fetchImpl: props.fetch });
          routerWeights = rw.current_weights;
        } catch {
          // Applied state degrades to "unknown"; the receipt list still renders.
          routerWeights = null;
        }

        const built = await Promise.all(
          listed.receipts.map(async (receipt) => {
            const payload = await client.fetchPayload(receipt.payload_uri);
            return {
              receipt,
              payload,
              applied: computeAppliedState(payload, routerWeights, vaultAddressBySymbol ?? null),
            };
          }),
        );
        if (!cancelled) setRows(built);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorerApiUrl, limit, vaultAddressBySymbol]);

  return (
    <section data-testid="consensus-receipt-panel">
      <h2>Consensus Recommendation Receipts</h2>
      <p className="hint" data-testid="consensus-receipt-disclosure">
        Each receipt is an on-chain commitment to the keccak256 of a published consensus receipt.
        The commitment records that the committee produced the recommendation and that a single
        submitter attested to it. It does not record a per-analyst on-chain approval. Releasing a
        receipt is a signalling-only act: it moves no funds and sets no router weight.
      </p>

      {loading && <p data-testid="consensus-receipt-loading">Loading receipts…</p>}
      {error && (
        <p className="error" data-testid="consensus-receipt-error">
          Could not load consensus receipts: {error}
        </p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p data-testid="consensus-receipt-empty">No consensus receipts have been anchored yet.</p>
      )}

      {rows.length > 0 && (
        <ul data-testid="consensus-receipt-list">
          {rows.map(({ receipt, payload, applied }) => {
            const sigCount = payloadSignatureCount(payload);
            return (
              <li key={receipt.receipt_id} data-testid={`consensus-receipt-${receipt.receipt_id}`}>
                <div>
                  <strong>{shortHex(receipt.receipt_id)}</strong>{" "}
                  <span>recorded {formatTimestamp(receipt.recorded_at)}</span>
                </div>
                <div>
                  submitter <code>{shortHex(receipt.submitter)}</code>, digest{" "}
                  <code>{shortHex(receipt.payload_digest)}</code>
                </div>

                <div data-testid={`verification-${receipt.receipt_id}`}>
                  {receipt.verified
                    ? "Verified — the published payload hashes to the anchored digest"
                    : payload === null
                      ? "Unverified — the published payload could not be fetched"
                      : "Unverified — the published payload does not hash to the anchored digest"}
                </div>

                <div data-testid={`release-${receipt.receipt_id}`}>
                  {receipt.released
                    ? `Released${receipt.released_at ? ` ${formatTimestamp(receipt.released_at)}` : ""}`
                    : "Recorded, not released"}
                </div>

                <div data-testid={`applied-${receipt.receipt_id}`}>{appliedLabel(applied)}</div>

                <div data-testid={`signatures-${receipt.receipt_id}`}>
                  {sigCount === null
                    ? "Payload signatures: unavailable — the published payload could not be fetched"
                    : `Payload signatures: ${sigCount} off-chain analyst signature${
                        sigCount === 1 ? "" : "s"
                      } carried in the payload (not on-chain approvals)`}
                </div>

                <div>
                  <a href={receipt.payload_uri} rel="noreferrer noopener" target="_blank">
                    Published receipt
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
