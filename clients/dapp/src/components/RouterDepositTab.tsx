// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * RouterDepositTab — multi-vault deposit via PortfolioRouter (issue #417).
 *
 * Replaces the issue #320 router deposit entrypoint and adds:
 *   - Per-leg preview shows destination vaults, weights, estimated receipts
 *     per leg, and unavailable-leg warnings (AC §6).
 *   - Submit disabled when `getEffectiveWeights()`'s vault list differs from
 *     the preview vault list — guards against vault-list changes between
 *     preview and sign (AC §7, docs/technical/portfolio-router-decisions.md
 *     §5 risk 2). `getEffectiveWeights()` is the live read the router itself
 *     routes `previewDeposit`/`deposit` by, read directly here via
 *     `useReadContract`.
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
} from "wagmi";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";
import type { Address, Hash } from "viem";
import { erc20Abi, routerAbi } from "../lib/abi";
import {
  buildRouterPreview,
  computeVaultListChanged,
  deriveMinSharesPerLeg,
  normaliseAddress,
  type RouterPreviewContext,
  type LegPreview,
} from "../lib/routerPreview";
import { TxPreview } from "./TxPreview";
import { DepositsClosedNotice } from "./DepositsClosedNotice";
import { useDepositStates } from "../lib/useDepositStates";
import { depositsBlocked, type DepositState } from "../lib/vaultDepositState";
import { parseUsdcAmount } from "./DepositWithdrawTab";
import { ProportionPreview } from "./shared";

type Props = Readonly<{
  routerAddress: Address;
  usdcAddress: Address;
  ctx: RouterPreviewContext;
}>;

export function RouterDepositTab({ routerAddress, usdcAddress, ctx }: Props) {
  const { address, isConnected } = useAccount();
  const approveWrite = useGuardedWriteContract();
  const depositWrite = useGuardedWriteContract();

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

  // Root cause (issue #1036): `router.previewDeposit` may decode a leg whose
  // `vault` field is missing/undefined in the live router-deposit path (partial
  // or transition-state tuple). Normalising the address at the source keeps a
  // defined, checksummed `vault` flowing to every consumer (ProportionPreview,
  // deriveMinSharesPerLeg, buildRouterPreview, computeVaultListChanged); when it
  // genuinely can't be resolved we fall back to the raw value (possibly
  // undefined), which every consumer now guards against rather than crashing.
  const legs: LegPreview[] = Array.isArray(previewRaw)
    ? (
        previewRaw as Array<{
          vault: Address | undefined;
          weightBps: bigint;
          legAmount: bigint;
          estShares: bigint;
          unavailable: boolean;
        }>
      ).map((l) => ({
        vault: (normaliseAddress(l.vault) ?? l.vault) as Address,
        weightBps: l.weightBps,
        legAmount: l.legAmount,
        estShares: l.estShares,
        unavailable: l.unavailable,
      }))
    : [];

  const routerPreview =
    depositAssets !== null && legs.length > 0 ? buildRouterPreview(depositAssets, legs, ctx) : null;

  // -------- deposits closed on a leg vault (issue 1731) --------
  // The router deposit is all-or-revert across its legs, so it is enabled ONLY when every leg vault is in the
  // known-open state. A leg that is paused, retired or unknown closes the whole router deposit. Withdraw and
  // redeem are not touched.
  const legVaults = legs.map((l) => l.vault).filter((v): v is Address => typeof v === "string");
  const legStates = useDepositStates(legVaults);
  const closedLegs = legVaults.filter((v) => {
    const st = legStates.get(v.toLowerCase());
    return !st || depositsBlocked(st);
  });
  const pausedLegCount = closedLegs.length;
  const routerDepositsClosed = pausedLegCount > 0;
  const firstClosed = closedLegs[0] && legStates.get(closedLegs[0].toLowerCase());
  const closedState: DepositState = routerDepositsClosed
    ? (firstClosed ?? { kind: "unknown" })
    : { kind: "open", source: "chain" };

  // -------- getEffectiveWeights() live check (AC §7) --------
  // Compare the vault list from preview to the router's current effective
  // weight vector — the same vector `previewDeposit` itself routes by, so this
  // detects exactly the leg-ordering/membership changes that would make the
  // preview stale. Replaces the never-implemented `activeVaults()` selector
  // (issue #1281).
  const { data: effectiveWeights } = useReadContract({
    address: routerAddress,
    abi: routerAbi,
    functionName: "getEffectiveWeights",
    query: {
      enabled: isConnected && legs.length > 0,
      // Refetch frequently to detect vault list changes in near-real-time.
      refetchInterval: 12_000,
    },
  });

  const currentActiveVaults = Array.isArray(effectiveWeights)
    ? (effectiveWeights[0] as Address[] | undefined)
    : undefined;

  // Check if the live effective-weights vault list matches the preview vault
  // list (AC §7). Delegated to a null-safe helper (issue #1036): an undefined
  // leg vault must not crash the component — it is treated as "list changed"
  // (submit disabled).
  const vaultListChanged = computeVaultListChanged(legs, currentActiveVaults);

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
    !routerDepositsClosed &&
    !vaultListChanged;

  // DAPP-2 (issue #1025): submit non-zero per-leg share floors derived from the
  // preview's per-leg estimated shares (minus a slippage tolerance) so each leg
  // keeps slippage protection. Replaces the previous empty `[]` floors array.
  const minSharesPerLeg = deriveMinSharesPerLeg(legs);

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: routerAddress,
    abi: routerAbi,
    functionName: "deposit",
    args: depositAssets !== null ? [depositAssets, minSharesPerLeg] : undefined,
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
          disabled={routerDepositsClosed}
        />
      </label>

      <DepositsClosedNotice
        state={closedState}
        scope={`Router deposit (${pausedLegCount} of ${legVaults.length} leg vaults closed)`}
        testId="router-deposits-closed"
      />

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
          One or more vault legs have deposits paused or are retired. The router deposit will revert
          if you sign. Withdrawals from those vaults stay open. Wait for governance to update the
          weights or remove the unavailable vaults.
        </p>
      )}

      {routerPreview && <TxPreview preview={routerPreview} />}

      {approveNeeded && (
        <button
          type="button"
          data-testid="router-deposit-tab-approve"
          onClick={onApprove}
          disabled={!isConnected || !approveSim || isPending || routerDepositsClosed}
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
          routerDepositsClosed ||
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
