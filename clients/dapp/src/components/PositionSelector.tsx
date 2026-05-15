/**
 * PositionSelector — lists the connected user's non-zero vault receipt
 * balances fetched from GET /v1/accounts/:address/positions and lets the
 * user pick one vault to redeem from (issue #321).
 *
 * Renders:
 *   - A loading state while the API call is in flight.
 *   - An error message if the API call fails.
 *   - An empty-state message when the user holds no receipt tokens.
 *   - A radio-button list of non-zero positions.
 *
 * The selected vault address and share balance are surfaced to the parent
 * via `onSelect`; the parent passes them into the redeem flow.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { fetchPositions, type VaultPosition } from "../lib/usePositions";

type Props = Readonly<{
  /** Connected account whose positions are fetched. */
  account: Address;
  /** Explorer API base URL, e.g. "http://localhost:8080". */
  explorerApiUrl: string;
  /** Called with the selected vault and share balance (as a decimal string). */
  onSelect: (vault: Address, shares: string) => void;
  /** Currently selected vault, for controlled selection state. */
  selectedVault?: Address;
}>;

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; positions: readonly VaultPosition[] };

/**
 * Returns only the positions whose shares balance is not zero.
 * Shares are decimal strings (6 dp) — treat anything that parses to a
 * non-zero BigInt as non-zero.
 */
function nonZero(positions: readonly VaultPosition[]): VaultPosition[] {
  return positions.filter((p) => {
    try {
      // Strip decimal point for comparison; "0.000000" → 0n
      const raw = p.shares.replace(".", "");
      return BigInt(raw) !== 0n;
    } catch {
      return false;
    }
  });
}

export function PositionSelector({ account, explorerApiUrl, onSelect, selectedVault }: Props) {
  const [load, setLoad] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();

    setLoad({ status: "loading" });
    fetchPositions(explorerApiUrl, account, { signal: controller.signal })
      .then((resp) => {
        if (aborted) return;
        setLoad({ status: "ok", positions: nonZero(resp.positions) });
      })
      .catch((err: unknown) => {
        if (aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoad({ status: "error", message });
      });

    return () => {
      aborted = true;
      controller.abort();
    };
  }, [account, explorerApiUrl]);

  if (load.status === "idle" || load.status === "loading") {
    return (
      <p data-testid="position-selector-loading" className="hint">
        Loading positions…
      </p>
    );
  }

  if (load.status === "error") {
    return (
      <p data-testid="position-selector-error" className="hint">
        Failed to load positions: {load.message}
      </p>
    );
  }

  const positions = load.positions;

  if (positions.length === 0) {
    return (
      <p data-testid="position-selector-empty" className="hint">
        No vault positions found. Deposit USDC first to receive receipt tokens.
      </p>
    );
  }

  return (
    <fieldset data-testid="position-selector">
      <legend>Select vault position to redeem</legend>
      {positions.map((p) => {
        const id = `pos-${p.vault_addr}`;
        const isSelected = selectedVault?.toLowerCase() === p.vault_addr.toLowerCase();
        return (
          <label key={p.vault_addr} htmlFor={id} data-testid={`position-option-${p.vault_addr}`}>
            <input
              id={id}
              type="radio"
              name="position-selector"
              value={p.vault_addr}
              checked={isSelected}
              onChange={() => onSelect(p.vault_addr as Address, p.shares)}
            />
            {p.vault_name ? (
              <>
                {p.vault_name} — {p.shares} rmUSDC
              </>
            ) : (
              <>
                {p.vault_addr} — {p.shares} rmUSDC
              </>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
