// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * PortfolioPosition — issue #319, account layer.
 *
 * Displays receipt-token balances per registered vault for a watched address.
 * Fetches indexed position data from `GET /v1/accounts/:address/positions`
 * (the explorer API).
 *
 * Position value (core 1795, QA plan X8) is what the shares pay at redeem,
 * never the gross `convertToAssets`, which ignores the exit fee and a basket
 * vault's slippage floor (rmAGENT read about 3% high). The first source that
 * has a value wins:
 *   1. the parent's `usdcValues` override;
 *   2. `vault.previewRedeem(shares)` read live on chain (`usePreviewRedeemValues`);
 *   3. the explorer's `usdc_value`, the same `previewRedeem` semantics at its
 *      latest snapshot (used when the chain read is not allowed, e.g. the
 *      mainnet build with no wallet on Base).
 * No caller used to pass `usdcValues`, so every value showed "—". Only this
 * component knows the watched address's shares, so it reads them itself. Each
 * shown value carries the PRD NAV disclaimer (`NavDisclosure`, prd.md §9).
 *
 * Renders:
 *   - One row per vault with non-zero indexed share balance.
 *   - A composite portfolio total (sum of all per-vault USDC values when
 *     provided; otherwise just the share totals).
 *   - Loading, error, and empty states.
 *
 * No wallet or signature required — data flows from the explorer API index and
 * read-only chain calls; nothing here feeds a signature.
 *
 * Each card also shows the address's exclusion claim when its vault owes one
 * (core 1820, QA plan U5): read on chain through `useExclusionClaims`, never
 * from the explorer. A holder who exited keeps the claim but has no indexed
 * position, so the deployment's RobotMoneyVault (`VITE_VAULT_ADDRESS`, the only
 * vault family with an exclusion ledger) is always read, and a claim on a vault
 * with no position gets its own line.
 *
 * docs/architecture.md §5.3.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  fetchAccountPositions,
  type AccountPosition,
  type AccountPositionsResponse,
  type FetchLike,
} from "../lib/explorerApi";
import { NavDisclosure, VaultPositionCard } from "./shared";
import { formatSharesString, formatUsdc, formatUsdcString } from "../lib/format";
import { useVaultShareSymbols } from "../lib/useVaultShareSymbols";
import { usePreviewRedeemValues } from "../lib/usePreviewRedeemValues";
import { useExclusionClaims } from "../lib/useExclusionClaims";
import { useRuntimeConfig } from "../lib/RuntimeConfigContext";

export interface PortfolioPositionProps {
  /** Address to inspect (watched-address or connected wallet). */
  readonly address: Address;
  /** Resolved explorer API base URL (no trailing slash required). */
  readonly apiUrl: string;
  /**
   * Optional override: map from vault_address (lower-case hex) to the USDC the
   * shares pay at redeem (decimal string, 6-decimal units). When absent the
   * component reads `vault.previewRedeem(shares)` itself, then falls back to
   * the explorer's `usdc_value`, then to a dash.
   */
  readonly usdcValues?: Readonly<Record<string, string>>;
  /** Optional fetch implementation; tests inject a mock. */
  readonly fetchImpl?: FetchLike;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; positions: readonly AccountPosition[]; blockNumber: number }
  | { kind: "error"; message: string };

export function PortfolioPosition(props: PortfolioPositionProps) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setState({ kind: "loading" });

    fetchAccountPositions(props.apiUrl, props.address, {
      fetchImpl: props.fetchImpl,
      signal: ac.signal,
    })
      .then((res: AccountPositionsResponse) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          positions: res.positions,
          blockNumber: res.block_number,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [props.address, props.apiUrl, props.fetchImpl]);

  const usdcValues = props.usdcValues ?? {};
  // Each vault's own share symbol (issue 1767).
  const symbolOf = useVaultShareSymbols(
    state.kind === "ready" ? state.positions.map((p) => p.vault_address) : [],
  );
  // USDC owed to this address from each vault's exclusion records (core 1820). The
  // RobotMoneyVault is read even without a position: an exiter keeps the claim.
  const configured = useRuntimeConfig().VITE_VAULT_ADDRESS;
  const primaryVault = configured && !/^0x0{40}$/i.test(configured) ? configured : undefined;
  const positionVaults = state.kind === "ready" ? state.positions.map((p) => p.vault_address) : [];
  const exclusionClaims = useExclusionClaims(
    state.kind === "ready" && primaryVault ? [...positionVaults, primaryVault] : positionVaults,
    props.address,
  );
  const positionKeys = new Set(positionVaults.map((v) => v.toLowerCase()));
  const claimsWithoutPosition = [...exclusionClaims].filter(([v]) => !positionKeys.has(v));
  // What each position pays at redeem, read on chain (core 1795, QA plan X8).
  const exitValues = usePreviewRedeemValues(
    state.kind === "ready"
      ? state.positions.map((p) => ({ vault: p.vault_address, shares: p.shares }))
      : [],
  );

  /** Raw USDC the position pays at redeem: override, then live previewRedeem, then the explorer. */
  function valueOf(pos: AccountPosition): string | undefined {
    const key = pos.vault_address.toLowerCase();
    return usdcValues[key] ?? exitValues.get(key)?.toString() ?? pos.usdc_value ?? undefined;
  }

  /** Compute composite total when all vaults have a USDC value. */
  function compositeTotal(positions: readonly AccountPosition[]): bigint | null {
    if (positions.length === 0) return 0n;
    let total = 0n;
    for (const p of positions) {
      const v = valueOf(p);
      if (v === undefined) return null;
      try {
        total += BigInt(v);
      } catch {
        return null;
      }
    }
    return total;
  }

  return (
    <section data-testid="portfolio-position">
      <h2>Portfolio position</h2>
      <p data-testid="portfolio-position-address">
        Address: <code>{props.address}</code>
      </p>

      {state.kind === "loading" && (
        <p data-testid="portfolio-position-loading">Loading positions…</p>
      )}

      {state.kind === "error" && (
        <p data-testid="portfolio-position-error">Failed to load positions: {state.message}</p>
      )}

      {state.kind === "ready" && (
        <>
          <p data-testid="portfolio-position-freshness">
            Indexed at block <code>{state.blockNumber}</code>
          </p>

          {state.positions.length === 0 ? (
            <p data-testid="portfolio-position-empty">No positions indexed for this address.</p>
          ) : (
            <>
              <div className="table-scroll">
                <table data-testid="portfolio-position-table">
                  <thead>
                    <tr>
                      <th>Vault</th>
                      <th>Risk</th>
                      <th>Shares</th>
                      <th>Est. USDC at redeem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.positions.map((pos) => {
                      const usdc = valueOf(pos);
                      return (
                        <tr key={pos.vault_address} data-testid="portfolio-position-row">
                          <td data-testid="portfolio-position-row-vault">{pos.vault_name}</td>
                          <td data-testid="portfolio-position-row-risk">{pos.risk_label}</td>
                          <td data-testid="portfolio-position-row-shares">
                            {formatSharesString(pos.shares, symbolOf(pos.vault_address))}
                          </td>
                          <td data-testid="portfolio-position-row-usdc">
                            {formatUsdcString(usdc)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p data-testid="portfolio-position-total">
                Composite total (USDC):{" "}
                <strong>
                  {(() => {
                    const total = compositeTotal(state.positions);
                    return total !== null ? formatUsdc(total) : "—";
                  })()}
                </strong>
              </p>
              <NavDisclosure testId="portfolio-position-nav-disclosure" />

              {/* Shared VaultPositionCard view — satisfies the shared-component
                  wiring requirement (issue #381). Each card is independently
                  visible and testable without the table. */}
              <div className="vault-card-grid" data-testid="portfolio-position-cards">
                {state.positions.map((pos) => {
                  const usdc = valueOf(pos);
                  const claim = exclusionClaims.get(pos.vault_address.toLowerCase());
                  return (
                    <VaultPositionCard
                      key={pos.vault_address}
                      vaultAddress={pos.vault_address}
                      vaultName={pos.vault_name}
                      shares={formatSharesString(pos.shares, symbolOf(pos.vault_address))}
                      riskLabel={pos.risk_label}
                      usdcValue={usdc !== undefined ? formatUsdcString(usdc) : undefined}
                      exclusionClaim={claim !== undefined ? formatUsdc(claim) : undefined}
                    />
                  );
                })}
              </div>
            </>
          )}

          {claimsWithoutPosition.length > 0 && (
            <div data-testid="portfolio-position-exclusion-only">
              {claimsWithoutPosition.map(([vault, amount]) => (
                <p key={vault} data-testid="portfolio-position-exclusion-only-row">
                  Exclusion claim on vault <code>{vault}</code>:{" "}
                  <strong>{formatUsdc(amount)}</strong>. It is USDC recovered from an adapter the
                  vault excluded, owed to this address as a holder at the moment of exclusion, and
                  it stays claimable after a full exit.
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
