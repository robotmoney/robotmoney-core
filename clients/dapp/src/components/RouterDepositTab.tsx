/**
 * RouterDepositTab — multi-vault deposit via PortfolioRouter (issue #417).
 *
 * Replaces the issue #320 router deposit entrypoint and adds:
 *   - Per-leg preview shows destination vaults, weights, estimated receipts
 *     per leg, and unavailable-leg warnings (AC §6).
 *   - Submit disabled when `activeVaults()` result differs from the preview
 *     vault list — guards against vault-list changes between preview and sign
 *     (AC §7, docs/technical/portfolio-router-decisions.md §5 risk 2).
 *   - RouterContext integration for the active vault list.
 *
 * All preview values sourced exclusively from useReadContract (AC §11).
 *
 * docs/architecture.md §5.3 — action layer: router deposit.
 * docs/technical/portfolio-router-decisions.md §3.1–3.2.
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
import { ProportionPreview } from "./shared";

type Props = Readonly<{
  routerAddress: Address;
  usdcAddress: Address;
  ctx: RouterPreviewContext;
}>;

export function RouterDepositTab({ routerAddress, usdcAddress, ctx }: Props) {
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
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, routerAddress] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  // -------- router.previewDeposit (view call, AC §6 / §11) --------
  const { data: previewRaw, error: previewError } = useReadContract({
    address: routerAddress,
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
    depositAssets !== null && legs.length > 0 ? buildRouterPreview(depositAssets, legs, ctx) : null;

  // -------- activeVaults() live check (AC §7) --------
  // Compare the vault list from preview to the current activeVaults() result.
  // If the lists differ, the deposit would revert (leg ordering changed).
  const { data: currentActiveVaults } = useReadContract({
    address: routerAddress,
    abi: routerAbi,
    functionName: "activeVaults",
    query: {
      enabled: isConnected && legs.length > 0,
      // Refetch frequently to detect vault list changes in near-real-time.
      refetchInterval: 12_000,
    },
  });

  // Check if the live activeVaults list matches the preview vault list (AC §7).
  const vaultListChanged = (() => {
    if (!currentActiveVaults || legs.length === 0) return false;
    const live = currentActiveVaults as Address[];
    if (live.length !== legs.length) return true;
    return legs.some((leg, i) => leg.vault.toLowerCase() !== live[i]?.toLowerCase());
  })();

  const allowanceOk =
    depositAssets !== null && typeof allowance === "bigint" && allowance >= depositAssets;

  const approveNeeded =
    depositAssets !== null &&
    (allowance === undefined || (typeof allowance === "bigint" && allowance < depositAssets));

  // -------- approve simulation --------
  const { data: approveSim, error: approveSimError } = useSimulateContract({
    account: address,
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: depositAssets !== null ? [routerAddress, depositAssets] : undefined,
    query: { enabled: isConnected && approveNeeded === true, retry: 5 },
  });

  // -------- router.deposit simulation --------
  const hasUnavailable = routerPreview?.ok === true && routerPreview.hasUnavailable;
  const canSimDeposit =
    isConnected &&
    routerPreview?.ok === true &&
    !hasUnavailable &&
    allowanceOk &&
    !vaultListChanged;

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: routerAddress,
    abi: routerAbi,
    functionName: "deposit",
    args: depositAssets !== null ? [depositAssets, []] : undefined,
    query: { enabled: canSimDeposit, retry: 5 },
  });

  useEffect(() => {
    if (approveSimError) {
      // eslint-disable-next-line no-console
      console.error("[RouterDepositTab] approve simulate error:", approveSimError);
    }
  }, [approveSimError]);
  useEffect(() => {
    if (depositSimError) {
      // eslint-disable-next-line no-console
      console.error("[RouterDepositTab] deposit simulate error:", depositSimError);
    }
  }, [depositSimError]);
  useEffect(() => {
    if (previewError) {
      // eslint-disable-next-line no-console
      console.error("[RouterDepositTab] previewDeposit read error:", previewError);
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
    if (approveReceipt.isSuccess) void refetchAllowance();
  }, [approveReceipt.isSuccess, refetchAllowance]);

  return (
    <section data-testid="router-deposit-tab">
      <h2>Deposit via Portfolio Router</h2>
      <p>
        USDC is split across all active vaults by their governance-set weights. All legs must
        succeed (all-or-revert).
      </p>
      <label>
        Amount (USDC)
        <input
          data-testid="router-deposit-tab-amount"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </label>

      {/* Per-leg breakdown table (AC §6) */}
      {legs.length > 0 && <ProportionPreview legs={legs} />}

      {/* Vault list changed warning (AC §7) */}
      {vaultListChanged && (
        <p className="hint" data-testid="router-vault-list-changed" style={{ color: "orange" }}>
          The active vault list has changed since this preview was generated. The deposit has been
          disabled to prevent mismatched leg ordering. Refresh the page to get a fresh preview.
        </p>
      )}

      {/* All-or-revert warning when any leg is unavailable (AC §6) */}
      {hasUnavailable && (
        <p className="hint" data-testid="router-unavailable-warning" style={{ color: "red" }}>
          One or more vault legs are paused or retired. The router will revert if you sign. Wait for
          governance to update the weights or remove the unavailable vaults.
        </p>
      )}

      {routerPreview && <TxPreview preview={routerPreview} />}

      {approveNeeded && (
        <button
          type="button"
          data-testid="router-deposit-tab-approve"
          onClick={onApprove}
          disabled={!isConnected || !approveSim || isPending}
        >
          Approve USDC for router
        </button>
      )}

      <button
        type="button"
        data-testid="router-deposit-tab-submit"
        onClick={onDeposit}
        disabled={
          !isConnected ||
          !depositSim ||
          !allowanceOk ||
          isPending ||
          routerPreview?.ok !== true ||
          hasUnavailable === true ||
          vaultListChanged === true
        }
      >
        Sign router deposit with wallet
      </button>

      {approveSimError && (
        <p className="hint" data-testid="router-deposit-tab-approve-sim-error">
          approve simulate failed: {approveSimError.message}
        </p>
      )}
      {depositSimError && (
        <p className="hint" data-testid="router-deposit-tab-deposit-sim-error">
          deposit simulate failed: {depositSimError.message}
        </p>
      )}
    </section>
  );
}
