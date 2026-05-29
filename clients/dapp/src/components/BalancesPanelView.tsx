// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * BalancesPanelView — pure render layer of the main-page wallet
 * balances panel (issue #463). All data flows in via props; the
 * container `BalancesPanel.tsx` owns the wagmi `useAccount`,
 * `useBalance`, and `useReadContracts` calls.
 *
 * Renders, in this order:
 *   1. USDC (6 decimals)
 *   2. ETH (18 decimals)
 *   3. RM (18 decimals) — only when `rmAvailable === true`
 *   4. One row per element of `receipts` (per registered vault the
 *      connected wallet holds shares in).
 *
 * Zero balances render as the literal "0" (not omitted) per AC §4.
 * When `connected === false` the panel shows a connect prompt instead
 * of any balance rows.
 *
 * Unit tests render this component directly with stub data and no
 * wagmi/QueryClient fixture per docs/development/react-guide.md §Layout.
 */
import type { Address } from "viem";
import { formatUsdc, formatEth, formatTokenBalance } from "../lib/format";

export interface BalancesPanelReceipt {
  readonly vaultAddress: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: bigint;
}

export interface BalancesPanelViewProps {
  /** True when a wallet is connected. When false, the panel shows a connect prompt. */
  readonly connected: boolean;
  /** USDC balance (raw, 6 decimals expected). `undefined` while loading. */
  readonly usdcBalance: bigint | undefined;
  readonly usdcDecimals: number;
  readonly usdcSymbol: string;
  /** ETH balance (raw, 18 decimals). `undefined` while loading. */
  readonly ethBalance: bigint | undefined;
  readonly ethSymbol: string;
  /**
   * RM balance. The row only renders when `rmAvailable === true`
   * (the parent gates this on VITE_RM_TOKEN_ADDRESS being set).
   */
  readonly rmAvailable: boolean;
  readonly rmBalance?: bigint;
  readonly rmDecimals?: number;
  readonly rmSymbol?: string;
  /** Per-vault receipt token rows (only those with non-zero shares). */
  readonly receipts: ReadonlyArray<BalancesPanelReceipt>;
}

export function BalancesPanelView(props: BalancesPanelViewProps) {
  if (!props.connected) {
    return (
      <section className="balances-panel" data-testid="balances-panel">
        <h2>Wallet balances</h2>
        <p className="hint" data-testid="balances-panel-disconnected">
          Connect a wallet to view your balances.
        </p>
      </section>
    );
  }

  return (
    <section className="balances-panel" data-testid="balances-panel">
      <h2>Wallet balances</h2>
      <table data-testid="balances-panel-table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="balances-panel-row-usdc">
            <td data-testid="balances-panel-row-usdc-symbol">{props.usdcSymbol}</td>
            <td data-testid="balances-panel-row-usdc-amount">{formatUsdc(props.usdcBalance)}</td>
          </tr>
          <tr data-testid="balances-panel-row-eth">
            <td data-testid="balances-panel-row-eth-symbol">{props.ethSymbol}</td>
            <td data-testid="balances-panel-row-eth-amount">{formatEth(props.ethBalance)}</td>
          </tr>
          {props.rmAvailable && (
            <tr data-testid="balances-panel-row-rm">
              <td data-testid="balances-panel-row-rm-symbol">{props.rmSymbol ?? "RM"}</td>
              <td data-testid="balances-panel-row-rm-amount">
                {formatTokenBalance(
                  props.rmBalance,
                  props.rmDecimals ?? 18,
                  props.rmSymbol ?? "RM",
                )}
              </td>
            </tr>
          )}
          {props.receipts.map((r) => (
            <tr key={r.vaultAddress} data-testid={`balances-panel-row-receipt-${r.vaultAddress}`}>
              <td data-testid={`balances-panel-row-receipt-${r.vaultAddress}-symbol`}>
                {r.symbol}
              </td>
              <td data-testid={`balances-panel-row-receipt-${r.vaultAddress}-amount`}>
                {formatTokenBalance(r.balance, r.decimals, r.symbol)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
