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
 * Write handlers re-check every gate their button uses before they send, so a
 * stale simulation cannot go out (issue 1737 part 4), and each write renders its
 * refusal, wallet error and receipt status (`WriteStatus`, finding DR-9). Leg
 * share estimates print each leg vault's own symbol (issue 1773).
 *
 * Unavailable legs (QA plan D4): the router skips a leg `previewDeposit` reports
 * unavailable and renormalizes the rest, so an unavailable leg no longer
 * disables the deposit. The simulation is the revert gate, and the tab says the
 * legs are skipped and shows each leg's renormalized USDC. A 0 bps leg is never
 * funded, so its deposit state (paused, retired, stale price) does not close
 * the router deposit either.
 *
 * Leg pins (security round 2, ADR-0014): the router forwards each leg's USDC
 * into that vault, so a leg the chain showed does not match its pins
 * (`ctx.refusedTargets`) disables the approve and the deposit, and the tab
 * names it. Every leg of the effective weight vector counts, as in the write
 * guard and rmpc. The preview badges "[bytecode verified]" only when the
 * router and every leg are verified (`routerPreview.ts`).
 *
 * docs/architecture.md §5.3 — action layer: router deposit.
 * docs/technical/portfolio-router-decisions.md §3.1–3.2.
 */
import { withGasLimit, routerDepositGasLimit } from "../lib/depositGas";
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
  refusedRouterLegs,
  refusedRouterLegsText,
  type RouterPreviewContext,
  type LegPreview,
} from "../lib/routerPreview";
import { TxPreview } from "./TxPreview";
import { DepositsClosedNotice } from "./DepositsClosedNotice";
import { useDepositStates } from "../lib/useDepositStates";
import { depositsBlocked, type DepositState } from "../lib/vaultDepositState";
import { parseUsdcAmount } from "../lib/format";
import { ProportionPreview } from "./shared";
import { WriteStatus } from "./WriteStatus";
import { useVaultShareSymbols } from "../lib/useVaultShareSymbols";

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

  // Each leg vault's own share symbol for the preview's leg summary (issue 1773).
  const shareSymbolOf = useVaultShareSymbols(
    legs.map((l) => l.vault).filter((v): v is Address => typeof v === "string"),
  );
  const routerPreview =
    depositAssets !== null && legs.length > 0
      ? buildRouterPreview(depositAssets, legs, { ...ctx, shareSymbolOf })
      : null;

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
      // Always on: the closed notice needs the leg vaults before an amount is typed (and without a wallet).
      // Refetch frequently to detect vault list changes in near-real-time.
      refetchInterval: 12_000,
    },
  });

  // -------- deposits closed on a leg vault (issue 1731) --------
  // The router deposit is enabled ONLY when every leg vault that carries weight is in the known-open
  // state. A weighted leg that is paused, retired or unknown closes the whole router deposit. A 0 bps leg
  // never receives USDC (the router skips it, issue 1746), so its state does not close the deposit.
  // Withdraw and redeem are not touched.
  // The leg vaults come from the preview once an amount is typed. Before that they come from the router's
  // effective weights, so the closed notice shows on page load, before any amount is entered.
  const weightVaults = Array.isArray(effectiveWeights)
    ? ((effectiveWeights[0] as Address[] | undefined) ?? [])
    : [];
  const weightBpsList = Array.isArray(effectiveWeights)
    ? ((effectiveWeights[1] as readonly bigint[] | undefined) ?? [])
    : [];
  const weightedLeg = (bps: unknown): boolean => typeof bps !== "bigint" || bps > 0n;
  const previewVaults = legs
    .filter((l) => weightedLeg(l.weightBps))
    .map((l) => l.vault)
    .filter((v): v is Address => typeof v === "string");
  const previewKnown = legs.some((l) => typeof l.vault === "string");
  const legVaults = previewKnown
    ? previewVaults
    : weightVaults.filter((_, i) => weightedLeg(weightBpsList[i]));
  const legStates = useDepositStates(legVaults);
  const closedLegs = legVaults.filter((v) => {
    const st = legStates.get(v.toLowerCase());
    return !st || depositsBlocked(st);
  });
  const pausedLegCount = closedLegs.length;
  // No known weighted leg vaults (weights not read yet) cannot be confirmed open: closed.
  const routerDepositsClosed = pausedLegCount > 0 || legVaults.length === 0;
  const firstClosed = closedLegs[0] && legStates.get(closedLegs[0].toLowerCase());
  const closedState: DepositState = routerDepositsClosed
    ? (firstClosed ?? { kind: "unknown" })
    : { kind: "open", source: "chain" };

  const currentActiveVaults = Array.isArray(effectiveWeights)
    ? (effectiveWeights[0] as Address[] | undefined)
    : undefined;

  // Check if the live effective-weights vault list matches the preview vault
  // list (AC §7). Delegated to a null-safe helper (issue #1036): an undefined
  // leg vault must not crash the component — it is treated as "list changed"
  // (submit disabled).
  const vaultListChanged = computeVaultListChanged(legs, currentActiveVaults);

  // -------- leg vaults that failed their pins (security round 2, ADR-0014) --------
  // The write guard refuses a router deposit unless the router and every vault of its effective
  // weight vector match their pins. A leg the chain showed does not match closes the deposit here
  // too, before any approval, whether it carries weight or not. The live weights and the preview
  // legs both count.
  const refusedLegs = refusedRouterLegs([...weightVaults, ...legs.map((l) => l.vault)], ctx);
  const legsRefused = refusedLegs.length > 0;

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
    query: { enabled: isConnected && approveNeeded === true && !legsRefused, retry: 5 },
  });

  // -------- router.deposit simulation --------
  // An unavailable leg does not gate the deposit: the router skips it and renormalizes (QA plan D4).
  // The simulation is the revert gate.
  const hasUnavailable = routerPreview?.ok === true && routerPreview.hasUnavailable;
  const canSimDeposit =
    isConnected &&
    routerPreview?.ok === true &&
    allowanceOk &&
    !routerDepositsClosed &&
    !legsRefused &&
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

  // Defence in depth (issue 1737 part 4): the same gates as the buttons, plus the simulation's
  // target, so a handler reached another way with a stale simulation never sends.
  const sameAddress = (a: unknown): boolean =>
    typeof a === "string" && a.toLowerCase() === routerAddress.toLowerCase();

  const onApprove = () => {
    if (!approveSim || routerDepositsClosed || legsRefused) return;
    if (!sameAddress(approveSim.request.args?.[0])) return;
    approveWrite.writeContract(approveSim.request);
  };

  const onDeposit = () => {
    if (!depositSim || !canSimDeposit) return;
    if (!sameAddress(depositSim.request.address)) return;
    // The router's entry floor is 1.7M per effective-weight leg (QA plan U3). `previewDeposit` returns
    // one leg per entry of that vector, and submit requires it to match `getEffectiveWeights()`.
    const legCount = Math.max(legs.length, currentActiveVaults?.length ?? 0);
    depositWrite.writeContract(withGasLimit(depositSim.request, routerDepositGasLimit(legCount)));
  };

  useEffect(() => {
    if (approveReceipt.isSuccess) void refetchAllowance();
  }, [approveReceipt.isSuccess, refetchAllowance]);

  return (
    <section data-testid="router-deposit-tab">
      <h2>Deposit via Portfolio Router</h2>
      <p>
        USDC is split across all active vaults by their governance-set weights. A leg that cannot
        take a deposit is skipped and the rest renormalized. Every leg the router funds must succeed
        (all-or-revert).
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
        scope={
          legVaults.length === 0
            ? "Router deposit (leg vaults not yet known)"
            : `Router deposit (${pausedLegCount} of ${legVaults.length} leg vaults closed)`
        }
        testId="router-deposits-closed"
      />

      {/* A leg vault failed its pins: the router would forward USDC into unreviewed code. */}
      {legsRefused && (
        <p className="error" data-testid="router-leg-unverified">
          {refusedRouterLegsText(refusedLegs)}
        </p>
      )}

      {/* Per-leg breakdown table (AC §6) */}
      {legs.length > 0 && <ProportionPreview legs={legs} legStates={legStates} />}

      {/* Vault list changed warning (AC §7) */}
      {vaultListChanged && (
        <p className="hint" data-testid="router-vault-list-changed" style={{ color: "orange" }}>
          The active vault list has changed since this preview was generated. The deposit has been
          disabled to prevent mismatched leg ordering. Refresh the page to get a fresh preview.
        </p>
      )}

      {/* Unavailable legs are skipped and the rest renormalized (AC §6, QA plan D4) */}
      {hasUnavailable && (
        <p className="hint" data-testid="router-unavailable-warning" style={{ color: "orange" }}>
          Unavailable legs are skipped. The USDC leg amounts below are renormalized across the legs
          that can take the deposit, so the split differs from the governance weights. Withdrawals
          from the skipped vaults stay open.
        </p>
      )}

      {routerPreview && <TxPreview preview={routerPreview} />}

      {approveNeeded && (
        <button
          type="button"
          data-testid="router-deposit-tab-approve"
          onClick={onApprove}
          disabled={!isConnected || !approveSim || isPending || routerDepositsClosed || legsRefused}
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
          routerDepositsClosed ||
          legsRefused ||
          vaultListChanged === true
        }
      >
        Sign router deposit with wallet
      </button>

      <WriteStatus
        testId="router-deposit-tab-approve"
        label="USDC approval"
        write={approveWrite}
        receipt={approveReceipt}
      />
      <WriteStatus
        testId="router-deposit-tab-deposit"
        label="Router deposit"
        write={depositWrite}
        receipt={depositReceipt}
      />

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
