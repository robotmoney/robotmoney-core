/**
 * RouterDepositSection — multi-vault deposit via PortfolioRouter (issue #320).
 *
 * Flow:
 *   1. User enters an amount.
 *   2. `router.previewDeposit(amount)` is called (view, no gas).
 *   3. Per-leg breakdown renders: vault address, weight %, estimated shares,
 *      and an UNAVAILABLE warning for any paused/retired leg.
 *   4. If any leg is unavailable, the submit stays disabled and a warning
 *      explains which legs are blocked.
 *   5. USDC approve → router.deposit (approve router for the full amount,
 *      router handles per-vault leg approvals internally).
 *
 * The router's all-or-revert semantics mean a single unavailable leg blocks
 * the entire deposit — the preview makes this visible before signing.
 */
import { useEffect, useState } from "react";
import {
  useAccount,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import type { Address, Hash } from "viem";
import { erc20Abi, routerAbi } from "../lib/abi";
import {
  buildRouterPreview,
  type RouterPreviewContext,
  type LegPreview,
} from "../lib/routerPreview";
import { TxPreview } from "./TxPreview";
import { parseUsdcAmount } from "./DepositWithdrawTab";

type Props = Readonly<{
  routerAddress: Address;
  usdcAddress: Address;
  ctx: RouterPreviewContext;
}>;

function LegTable({ legs }: { legs: LegPreview[] }) {
  return (
    <table data-testid="router-leg-table">
      <thead>
        <tr>
          <th>Vault</th>
          <th>Weight</th>
          <th>USDC leg</th>
          <th>Est. shares</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {legs.map((leg, i) => (
          <tr
            key={leg.vault}
            data-testid={`router-leg-row-${i}`}
            style={leg.unavailable ? { color: "red" } : undefined}
          >
            <td>
              <code>
                {leg.vault.slice(0, 8)}…{leg.vault.slice(-4)}
              </code>
            </td>
            <td>{((Number(leg.weightBps) / 10_000) * 100).toFixed(2)}%</td>
            <td>{formatUsdc(leg.legAmount)}</td>
            <td>{leg.unavailable ? "—" : formatShares(leg.estShares)}</td>
            <td data-testid={`router-leg-status-${i}`}>
              {leg.unavailable ? "⚠ UNAVAILABLE" : "Active"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

function formatShares(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

export function RouterDepositSection(props: Props) {
  const { address, isConnected } = useAccount();
  const approveWrite = useWriteContract();
  const depositWrite = useWriteContract();

  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveWrite.data as Hash | undefined,
    query: { enabled: Boolean(approveWrite.data) },
  });
  const depositReceipt = useWaitForTransactionReceipt({
    hash: depositWrite.data as Hash | undefined,
    query: { enabled: Boolean(depositWrite.data) },
  });

  const isPending =
    approveWrite.isPending ||
    depositWrite.isPending ||
    approveReceipt.isFetching ||
    depositReceipt.isFetching;

  const [amountInput, setAmountInput] = useState("");
  const depositAssets = parseUsdcAmount(amountInput);

  // -------- allowance read --------
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: props.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, props.routerAddress] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  // -------- router.previewDeposit (view call) --------
  const { data: previewRaw, error: previewError } = useReadContract({
    address: props.routerAddress,
    abi: routerAbi,
    functionName: "previewDeposit",
    args: depositAssets !== null ? [depositAssets] : undefined,
    query: { enabled: isConnected && depositAssets !== null },
  });

  const legs: LegPreview[] = Array.isArray(previewRaw)
    ? (
        previewRaw as Array<{
          vault: Address;
          weightBps: bigint;
          legAmount: bigint;
          estShares: bigint;
          unavailable: boolean;
        }>
      ).map((l) => ({
        vault: l.vault,
        weightBps: l.weightBps,
        legAmount: l.legAmount,
        estShares: l.estShares,
        unavailable: l.unavailable,
      }))
    : [];

  const routerPreview =
    depositAssets !== null && legs.length > 0
      ? buildRouterPreview(depositAssets, legs, props.ctx)
      : null;

  const allowanceOk =
    depositAssets !== null && typeof allowance === "bigint" && allowance >= depositAssets;

  const approveNeeded =
    depositAssets !== null &&
    (allowance === undefined || (typeof allowance === "bigint" && allowance < depositAssets));

  // -------- approve simulation --------
  const { data: approveSim, error: approveSimError } = useSimulateContract({
    account: address,
    address: props.usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: depositAssets !== null ? [props.routerAddress, depositAssets] : undefined,
    query: { enabled: isConnected && approveNeeded === true, retry: 5 },
  });

  // -------- router.deposit simulation --------
  const canSimDeposit =
    isConnected && routerPreview?.ok === true && !routerPreview.hasUnavailable && allowanceOk;

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: props.routerAddress,
    abi: routerAbi,
    functionName: "deposit",
    args: depositAssets !== null ? [depositAssets, []] : undefined,
    query: { enabled: canSimDeposit, retry: 5 },
  });

  useEffect(() => {
    if (approveSimError) {
      // eslint-disable-next-line no-console
      console.error("[RouterDepositSection] approve simulate error:", approveSimError);
    }
  }, [approveSimError]);
  useEffect(() => {
    if (depositSimError) {
      // eslint-disable-next-line no-console
      console.error("[RouterDepositSection] deposit simulate error:", depositSimError);
    }
  }, [depositSimError]);
  useEffect(() => {
    if (previewError) {
      // eslint-disable-next-line no-console
      console.error("[RouterDepositSection] previewDeposit read error:", previewError);
    }
  }, [previewError]);

  const onApprove = () => {
    if (!approveSim) return;
    approveWrite.writeContract(approveSim.request);
  };

  const onDeposit = () => {
    if (!depositSim) return;
    depositWrite.writeContract(depositSim.request);
  };

  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void refetchAllowance();
    }
  }, [approveReceipt.isSuccess, refetchAllowance]);

  const hasUnavailable = routerPreview?.ok === true && routerPreview.hasUnavailable;

  return (
    <section data-testid="router-deposit-form">
      <h2>Deposit via Portfolio Router</h2>
      <p>
        USDC is split across all active vaults by their governance-set weights. All legs must
        succeed (all-or-revert).
      </p>
      <label>
        Amount (USDC)
        <input
          data-testid="router-deposit-amount"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </label>

      {/* Per-leg breakdown table */}
      {legs.length > 0 && <LegTable legs={legs} />}

      {/* All-or-revert warning when any leg is unavailable */}
      {hasUnavailable && (
        <p className="hint" data-testid="router-unavailable-warning" style={{ color: "red" }}>
          One or more vault legs are paused or retired. The router will revert if you sign. Wait for
          governance to update the weights or remove the unavailable vaults.
        </p>
      )}

      {/* Structured calldata preview (TxPreview component) */}
      {routerPreview && <TxPreview preview={routerPreview} />}

      {approveNeeded && (
        <button
          type="button"
          data-testid="router-deposit-approve"
          onClick={onApprove}
          disabled={!isConnected || !approveSim || isPending}
        >
          Approve USDC for router
        </button>
      )}

      <button
        type="button"
        data-testid="router-deposit-submit"
        onClick={onDeposit}
        disabled={
          !isConnected ||
          !depositSim ||
          !allowanceOk ||
          isPending ||
          routerPreview?.ok !== true ||
          hasUnavailable === true
        }
      >
        Sign router deposit with wallet
      </button>

      {approveSimError && (
        <p className="hint" data-testid="router-approve-sim-error">
          approve simulate failed: {approveSimError.message}
        </p>
      )}
      {depositSimError && (
        <p className="hint" data-testid="router-deposit-sim-error">
          deposit simulate failed: {depositSimError.message}
        </p>
      )}
    </section>
  );
}
