// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * DepositWithdrawTab — wires the ERC-4626 vault entrypoints into the
 * dapp (issue #257, extended in issue #321 for multi-vault withdrawal).
 * Two symmetric sub-flows:
 *
 *   Deposit:  USDC.approve(vault, assets) → vault.deposit(assets, receiver)
 *   Withdraw: select position via PositionSelector → share.approve(router, shares)
 *             → router.redeemFor(owner, owner, [vault], [shares], [floor], deadline)
 *
 * The Withdraw sub-flow lists the user's non-zero receipt balances via the
 * explorer-API PositionSelector (issue #321). Selecting a position prefills
 * the vault address and share balance; live `vault.previewRedeem(shares)`
 * surfaces estimated net USDC and the exit fee before the user signs.
 * Signing is refused when the shares input exceeds the on-chain balance.
 *
 * Extended in issue #320 to support a vault-selector:
 *   - When `registryAddress` and `routerAddress` are non-zero, a
 *     DestinationSelector is rendered above the deposit form.
 *   - Selecting "Portfolio Router" switches the deposit section to
 *     RouterDepositTab (multi-vault, all-or-revert).
 *   - Selecting a specific vault uses the original single-vault flow.
 *   - Withdraw always targets the primary vault (unchanged from #257).
 *
 * Redeem targets (QA plan U4, finding DR-5): the PositionSelector rows come
 * from the explorer API, which may never choose a signing target. A selected
 * vault is redeemed only when it is `props.vaultAddress` (runtime config) or a
 * vault `useVaultRegistry()` lists; any other row is refused with a visible
 * reason, and no read, simulation, preview or write is made against it.
 *
 * Write handlers (QA plan U5, issue 1737 part 4, finding DR-9): each handler
 * re-checks the state its button is gated on (deposits open, preview ok, the
 * simulation's target is the current one) before it calls the write, so a
 * stale simulation cannot send. Every write renders its refusal, wallet error
 * and receipt status through `WriteStatus`. Share counts print the vault's own
 * symbol (issue 1773), and the position card shows the holder's exclusion
 * claim when the vault owes one (core 1820).
 *
 * Redeem floor (QA plan D9, finding E8, SR-M16): a direct `vault.redeem` has
 * no minimum-out, so a registered vault is redeemed through the Portfolio
 * Router as a one-leg `redeemFor` whose `minAssetsPerLeg` is the live
 * `previewRedeem(shares)` less 0.50% (`routerRedeem.ts`). The router spends
 * the holder's shares, so the holder first approves it for exactly `shares`;
 * an allowance the redeem will not spend is shown with a revoke button. The
 * tab falls back to `vault.redeem`, saying why and that it has no floor, only
 * where the router cannot take the exit (no router, an unregistered vault, a
 * mainnet build with no router pin), so an exit never depends on the router.
 *
 * Both flows follow the same "simulate before write" gate used by
 * AuthorizeTab and RotationTab — `useSimulateContract` must return a
 * valid request before the submit button enables, and the TxPreview
 * block renders the decoded calldata first. If the user's current
 * USDC allowance is below the entered amount, the deposit submit
 * stays disabled and a separate `Approve USDC` button is rendered.
 *
 * Note: the issue body refers to `gateway.depositToken`, but the
 * deployed gateway only exposes an AGENT_ROLE-gated `deposit` entry
 * point. Depositors interact directly with the ERC-4626 vault — this
 * matches the production rmpc deposit flow (the gateway pulls USDC
 * from the agent's caller and forwards into the same vault).
 */
import { withGasLimit, VAULT_DEPOSIT_GAS_LIMIT } from "../lib/depositGas";
import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";
import { redeemFailureHint } from "../lib/redeemFailureHint";
import type { Address, Hash } from "viem";
import { erc20Abi, routerAbi, vaultAbi } from "../lib/abi";
import { buildVaultPreview, type VaultPreviewContext } from "../lib/vaultPreview";
import { TxPreview } from "./TxPreview";
import { DepositsClosedNotice } from "./DepositsClosedNotice";
import { useDepositState } from "../lib/useDepositStates";
import { depositsBlocked } from "../lib/vaultDepositState";
import { DestinationSelector, ROUTER_DESTINATION, type Destination } from "./DestinationSelector";
import { RouterDepositTab } from "./RouterDepositTab";
import { ROUTER_SLIPPAGE_TOLERANCE_BPS, type RouterPreviewContext } from "../lib/routerPreview";
import { useVaultRegistry } from "../lib/VaultRegistryContext";
import { acceptedRedeemTarget, redeemTargetAllowlist } from "../lib/redeemTarget";
import {
  buildRouterRedeemPreview,
  chooseRedeemRoute,
  deriveMinAssets,
  directRedeemReasonText,
  leftoverRouterAllowance,
  needsShareApproval,
  routerRedeemCall,
  routerRedeemDeadline,
  type RouterRedeemInputs,
} from "../lib/routerRedeem";
import { parseCodePins } from "../lib/codePins";
import { useRuntimeConfig } from "../lib/RuntimeConfigContext";
import { isMainnetClass } from "../lib/writeChainGuard";
import { PositionSelector } from "./PositionSelector";
import { VaultPositionCard, ReceiptValueDisplay } from "./shared";
import { WriteStatus } from "./WriteStatus";
import { useVaultShareSymbols } from "../lib/useVaultShareSymbols";
import { useExclusionClaims } from "../lib/useExclusionClaims";
import {
  formatUsdc,
  formatShares,
  formatPercent,
  formatInputAmount,
  parseSharesAmount,
  parseUsdcAmount,
  SHARE_DECIMALS,
} from "../lib/format";

type Props = Readonly<{
  vaultAddress: Address;
  usdcAddress: Address;
  ctx: VaultPreviewContext;
  /** Optional: registry address for listing registered vaults (issue #320). */
  registryAddress?: Address;
  /** Optional: Portfolio Router address for multi-vault deposits (issue #320). */
  routerAddress?: Address;
  /**
   * Explorer API base URL used by PositionSelector to list the user's
   * non-zero vault positions (issue #321). When omitted, PositionSelector
   * is not rendered and the single-vault withdraw input is shown directly.
   */
  explorerApiUrl?: string;
}>;

// formatUsdcPreview is an alias for the centralized formatUsdc.
const formatUsdcPreview = formatUsdc;

/** Same address, any case. A simulation built for another target must not be sent. */
const sameAddress = (a: unknown, b: string | undefined): boolean =>
  typeof a === "string" && b !== undefined && a.toLowerCase() === b.toLowerCase();

export function DepositWithdrawTab(props: Props) {
  const { address, isConnected } = useAccount();

  // Vault selector state (issue #320). Default to the primary vault so the
  // existing single-vault flow is unchanged when no selector is available.
  const hasSelector =
    Boolean(props.registryAddress) &&
    Boolean(props.routerAddress) &&
    props.registryAddress !== "0x0000000000000000000000000000000000000000" &&
    props.routerAddress !== "0x0000000000000000000000000000000000000000";

  const [destination, setDestination] = useState<Destination>(props.vaultAddress);

  // The single-vault deposit target. When the DestinationSelector picks a
  // specific vault, that address — not props.vaultAddress — must drive the
  // allowance read, deposit simulation, and approve calls (scan finding
  // DAPP-4). Falls back to props.vaultAddress when the router is selected
  // (router path is rendered separately) or no selector is present, so the
  // legacy single-vault flow is unchanged.
  const depositVault: Address =
    destination !== ROUTER_DESTINATION ? destination : props.vaultAddress;
  // Independent write hooks so each action exposes its own
  // `data` (tx hash) and `isPending`. We then wait for each receipt
  // before refetching downstream reads — without this gate the
  // `writeContract` callback fires when the hash is returned, not when
  // the tx is mined, so allowance/share-balance reads race past the
  // pending state and the deposit/withdraw submit never enables.
  const approveWrite = useGuardedWriteContract();
  const depositWrite = useGuardedWriteContract();
  const withdrawWrite = useGuardedWriteContract();
  // The router redeem's share approval and its revoke (QA plan D9).
  const shareApproveWrite = useGuardedWriteContract();

  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveWrite.data as Hash | undefined,
    query: { enabled: Boolean(approveWrite.data) },
  });
  const depositReceipt = useWaitForTransactionReceipt({
    hash: depositWrite.data as Hash | undefined,
    query: { enabled: Boolean(depositWrite.data) },
  });
  const withdrawReceipt = useWaitForTransactionReceipt({
    hash: withdrawWrite.data as Hash | undefined,
    query: { enabled: Boolean(withdrawWrite.data) },
  });
  const shareApproveReceipt = useWaitForTransactionReceipt({
    hash: shareApproveWrite.data as Hash | undefined,
    query: { enabled: Boolean(shareApproveWrite.data) },
  });

  const isPending =
    approveWrite.isPending ||
    depositWrite.isPending ||
    withdrawWrite.isPending ||
    shareApproveWrite.isPending ||
    approveReceipt.isFetching ||
    depositReceipt.isFetching ||
    withdrawReceipt.isFetching ||
    shareApproveReceipt.isFetching;

  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");

  // Multi-vault: selected vault drives the redeem simulation.
  // Defaults to props.vaultAddress so direct amount entry works without clicking
  // PositionSelector. The PositionSelector is always rendered with selectedVault=undefined
  // so its radios are never pre-checked — a pre-checked radio never fires onChange,
  // which would leave the withdrawInput empty when clicked.
  const [selectedVault, setSelectedVault] = useState<Address | undefined>(props.vaultAddress);

  // The selection is untrusted (it may come from an explorer row). Only an
  // accepted target drives the reads, the simulation, the preview and the write.
  const { vaults: registeredVaults, isLoading: registryLoading } = useVaultRegistry();
  const redeemAllowlist = useMemo(
    () => redeemTargetAllowlist(registeredVaults, props.vaultAddress),
    [registeredVaults, props.vaultAddress],
  );
  const redeemVault = acceptedRedeemTarget(selectedVault, redeemAllowlist);
  const redeemTargetRefused = selectedVault !== undefined && redeemVault === undefined;

  // Each vault's own share symbol (issue 1773): never a hardcoded unit.
  const symbolOf = useVaultShareSymbols([depositVault, redeemVault ?? props.vaultAddress]);
  const depositSymbol = symbolOf(depositVault);
  const redeemSymbol = symbolOf(redeemVault ?? props.vaultAddress);
  // The holder's exclusion claim on the accepted redeem target (core 1820).
  const exclusionClaims = useExclusionClaims(redeemVault ? [redeemVault] : [], address);
  const exclusionClaim = redeemVault ? exclusionClaims.get(redeemVault.toLowerCase()) : undefined;

  // Which contract the redeem is signed against (QA plan D9): the router when it can take the exit,
  // else the vault directly. On the mainnet class the write guard refuses an approval to a router
  // the build has no code-hash pin for, so such a build redeems directly rather than offer an
  // approval that can never be sent.
  const runtimeEnv = useRuntimeConfig();
  const codePins = useMemo(() => parseCodePins(runtimeEnv), [runtimeEnv]);
  const route = chooseRedeemRoute({
    router: props.routerAddress,
    vault: redeemVault,
    registered: registeredVaults,
    registryLoading,
    routerUnpinned:
      isMainnetClass(runtimeEnv) &&
      props.routerAddress !== undefined &&
      !codePins.has(props.routerAddress.toLowerCase()),
  });
  const redeemRouter = route.kind === "router" ? route.router : undefined;

  const depositAssets = parseUsdcAmount(depositInput);

  // Deposits are enabled ONLY in the known-open state of the vault being deposited into (issue 1731): its
  // live `depositsPaused()`, else the fresh explorer snapshot. Paused, retired and unknown all disable the form.
  // The withdraw form below never reads this, because `pauseDeposits()` leaves exits open.
  const depositClosedState = useDepositState(depositVault);
  const depositsClosed = depositsBlocked(depositClosedState);
  const withdrawShares = parseSharesAmount(withdrawInput);

  // -------- allowance read --------
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: props.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, depositVault] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  // -------- share balance read-back (per selected vault) --------
  const { data: shareBalance, refetch: refetchShareBalance } = useReadContract({
    address: redeemVault,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) && redeemVault !== undefined },
  });

  // -------- previewRedeem — live chain call for net USDC and exit fee --------
  // Gives the user an estimated output before signing. Runs whenever
  // withdrawShares is a valid amount and the vault is selected.
  const { data: previewRedeemAssets } = useReadContract({
    address: redeemVault,
    abi: vaultAbi,
    functionName: "previewRedeem",
    args: withdrawShares !== null ? [withdrawShares] : undefined,
    query: { enabled: isConnected && withdrawShares !== null && redeemVault !== undefined },
  });

  // -------- insufficient balance check --------
  // Guard: shares entered must not exceed the on-chain balance. This is a
  // hard refusal — the signing prompt is never shown when balance < shares.
  const hasInsufficientBalance =
    withdrawShares !== null && typeof shareBalance === "bigint" && shareBalance < withdrawShares;

  // -------- router share allowance (QA plan D9) --------
  // The router spends the holder's shares in `redeemFor`, so it needs an
  // allowance on the vault's share token covering exactly the shares.
  const { data: routerShareAllowance, refetch: refetchRouterShareAllowance } = useReadContract({
    address: redeemVault,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && redeemRouter ? [address, redeemRouter] : undefined,
    query: {
      enabled:
        isConnected && Boolean(address) && redeemVault !== undefined && redeemRouter !== undefined,
    },
  });
  const shareApprovalNeeded =
    redeemRouter !== undefined &&
    withdrawShares !== null &&
    needsShareApproval(routerShareAllowance, withdrawShares);
  const routerAllowanceLeftover =
    redeemRouter !== undefined && leftoverRouterAllowance(routerShareAllowance, withdrawShares);

  // The floor is the live previewRedeem less the router tolerance. The deadline moves in 5-minute
  // steps, so the simulation's arguments stay stable between renders.
  const minAssets =
    typeof previewRedeemAssets === "bigint" ? deriveMinAssets(previewRedeemAssets) : null;
  const routerRedeemInputs: RouterRedeemInputs | null =
    redeemRouter !== undefined &&
    redeemVault !== undefined &&
    withdrawShares !== null &&
    address &&
    !hasInsufficientBalance &&
    minAssets !== null
      ? {
          vault: redeemVault,
          shares: withdrawShares,
          minAssets,
          holder: address,
          deadline: routerRedeemDeadline(Date.now()),
        }
      : null;

  // -------- deposit preview + simulation --------
  const depositAction =
    depositAssets !== null && address
      ? ({ kind: "vaultDeposit", assets: depositAssets, receiver: address } as const)
      : null;
  // Build the deposit preview against the selected deposit target so the
  // decoded TxPreview reports the vault the user actually deposits into
  // (DAPP-4) rather than the default props.vaultAddress.
  const depositCtx: VaultPreviewContext = {
    ...props.ctx,
    vault: depositVault,
    shareSymbol: depositSymbol,
  };
  const depositPreview = depositAction ? buildVaultPreview(depositAction, depositCtx) : null;

  const allowanceOk =
    depositAssets !== null && typeof allowance === "bigint" && allowance >= depositAssets;

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: depositVault,
    abi: vaultAbi,
    functionName: "deposit",
    args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
    query: {
      enabled:
        isConnected && depositPreview?.ok === true && allowanceOk === true && !depositsClosed,
      retry: 5,
    },
  });

  // -------- approve simulation (only when needed) --------
  const approveNeeded =
    depositAssets !== null &&
    (allowance === undefined || (typeof allowance === "bigint" && allowance < depositAssets));
  const { data: approveSim, error: approveSimError } = useSimulateContract({
    account: address,
    address: props.usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: depositAssets !== null ? [depositVault, depositAssets] : undefined,
    query: { enabled: isConnected && approveNeeded === true, retry: 5 },
  });

  // -------- redeem preview + simulation --------
  // Use the accepted redeem target (which may differ from props.vaultAddress
  // when PositionSelector is active) to build the preview context and
  // simulation. A refused selection builds neither.
  const redeemCtx: VaultPreviewContext = {
    ...props.ctx,
    vault: redeemVault ?? props.vaultAddress,
    shareSymbol: redeemSymbol,
  };
  // The direct `vault.redeem` is built only on the direct route (QA plan D9).
  const redeemAction =
    route.kind === "direct" &&
    withdrawShares !== null &&
    address &&
    !hasInsufficientBalance &&
    redeemVault !== undefined
      ? ({
          kind: "vaultRedeem",
          shares: withdrawShares,
          receiver: address,
          owner: address,
        } as const)
      : null;
  const routerRedeemPreview =
    routerRedeemInputs && redeemRouter
      ? buildRouterRedeemPreview(routerRedeemInputs, {
          ...props.ctx,
          router: redeemRouter,
          shareSymbol: redeemSymbol,
        })
      : null;
  const directRedeemPreview = redeemAction ? buildVaultPreview(redeemAction, redeemCtx) : null;
  const redeemPreview = directRedeemPreview ?? routerRedeemPreview;

  const { data: directRedeemSim, error: directRedeemSimError } = useSimulateContract({
    account: address,
    address: redeemVault,
    abi: vaultAbi,
    functionName: "redeem",
    args: redeemAction
      ? [redeemAction.shares, redeemAction.receiver, redeemAction.owner]
      : undefined,
    query: { enabled: isConnected && directRedeemPreview?.ok === true, retry: 5 },
  });

  // The router redeem simulates once the router may spend the shares: before
  // the approval it would revert on the vault's allowance check.
  const routerCall = routerRedeemInputs ? routerRedeemCall(routerRedeemInputs) : null;
  const { data: routerRedeemSim, error: routerRedeemSimError } = useSimulateContract({
    account: address,
    address: redeemRouter,
    abi: routerAbi,
    functionName: "redeemFor",
    args: routerCall?.args,
    query: {
      enabled: isConnected && routerRedeemPreview?.ok === true && !shareApprovalNeeded,
      retry: 5,
    },
  });
  const redeemSimError = directRedeemSimError ?? routerRedeemSimError;
  // The approval is offered only for a redeem that is otherwise ready to sign.
  const showShareApproval = shareApprovalNeeded && routerRedeemPreview?.ok === true;

  // Exactly the entered shares, to the router, on the redeemed vault's share token.
  const { data: shareApproveSim, error: shareApproveSimError } = useSimulateContract({
    account: address,
    address: redeemVault,
    abi: erc20Abi,
    functionName: "approve",
    args: redeemRouter && withdrawShares !== null ? [redeemRouter, withdrawShares] : undefined,
    query: { enabled: isConnected && showShareApproval, retry: 5 },
  });
  // Clears an allowance the next redeem would leave standing.
  const { data: shareRevokeSim } = useSimulateContract({
    account: address,
    address: redeemVault,
    abi: erc20Abi,
    functionName: "approve",
    args: redeemRouter ? [redeemRouter, 0n] : undefined,
    query: { enabled: isConnected && routerAllowanceLeftover, retry: 5 },
  });

  // Surface simulate failures to the console so the e2e test (which
  // forwards `page.on('console')` to test output) can diagnose why a
  // submit button stayed disabled. Without this, a silent simulate
  // failure looks identical to a still-loading simulation.
  useEffect(() => {
    if (depositSimError) {
      // eslint-disable-next-line no-console
      console.error("[DepositWithdrawTab] deposit simulate error:", depositSimError);
    }
  }, [depositSimError]);
  useEffect(() => {
    if (approveSimError) {
      // eslint-disable-next-line no-console
      console.error("[DepositWithdrawTab] approve simulate error:", approveSimError);
    }
  }, [approveSimError]);
  useEffect(() => {
    if (redeemSimError) {
      // eslint-disable-next-line no-console
      console.error("[DepositWithdrawTab] redeem simulate error:", redeemSimError);
    }
  }, [redeemSimError]);
  useEffect(() => {
    if (shareApproveSimError) {
      // eslint-disable-next-line no-console
      console.error("[DepositWithdrawTab] share approve simulate error:", shareApproveSimError);
    }
  }, [shareApproveSimError]);

  // Defence in depth (issue 1737 part 4): the buttons are disabled in these states, but a handler
  // reached another way with a stale simulation must still refuse.
  const onApprove = () => {
    if (!approveSim || depositsClosed) return;
    if (!sameAddress(approveSim.request.args?.[0], depositVault)) return;
    approveWrite.writeContract(approveSim.request);
  };

  const onDeposit = () => {
    if (!depositSim || depositsClosed || depositPreview?.ok !== true || !allowanceOk) return;
    if (!sameAddress(depositSim.request.address, depositVault)) return;
    depositWrite.writeContract(withGasLimit(depositSim.request, VAULT_DEPOSIT_GAS_LIMIT));
  };

  // Only an approval of exactly the entered shares, to the router, on the redeemed vault's token.
  const onApproveShares = () => {
    if (!shareApproveSim || !shareApprovalNeeded || redeemVault === undefined) return;
    if (!sameAddress(shareApproveSim.request.address, redeemVault)) return;
    if (!sameAddress(shareApproveSim.request.args?.[0], redeemRouter)) return;
    if (shareApproveSim.request.args?.[1] !== withdrawShares) return;
    shareApproveWrite.writeContract(shareApproveSim.request);
  };

  const onRevokeShares = () => {
    if (!shareRevokeSim || !routerAllowanceLeftover || redeemVault === undefined) return;
    if (!sameAddress(shareRevokeSim.request.address, redeemVault)) return;
    if (!sameAddress(shareRevokeSim.request.args?.[0], redeemRouter)) return;
    if (shareRevokeSim.request.args?.[1] !== 0n) return;
    shareApproveWrite.writeContract(shareRevokeSim.request);
  };

  const onWithdraw = () => {
    if (redeemVault === undefined || redeemPreview?.ok !== true) return;
    if (hasInsufficientBalance) return;
    if (route.kind === "router") {
      if (!routerRedeemSim || shareApprovalNeeded) return;
      // Defence in depth: the simulated call goes to the router and redeems
      // exactly one leg, the accepted vault.
      if (!sameAddress(routerRedeemSim.request.address, route.router)) return;
      const legs = routerRedeemSim.request.args?.[2];
      if (!legs || legs.length !== 1 || !sameAddress(legs[0], redeemVault)) return;
      withdrawWrite.writeContract(routerRedeemSim.request);
      return;
    }
    if (route.kind !== "direct" || !directRedeemSim) return;
    // Defence in depth: a simulation left over from an earlier selection must
    // not send a redeem to a target other than the accepted one.
    if (acceptedRedeemTarget(directRedeemSim.request.address, redeemAllowlist) !== redeemVault) {
      return;
    }
    withdrawWrite.writeContract(directRedeemSim.request);
  };
  const withdrawReady =
    route.kind === "router"
      ? Boolean(routerRedeemSim) && !shareApprovalNeeded
      : route.kind === "direct" && Boolean(directRedeemSim);

  // Refetch on-chain state once each tx is mined. `isSuccess` flips
  // exactly once per receipt so the effect runs at most once per write.
  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void refetchAllowance();
    }
  }, [approveReceipt.isSuccess, refetchAllowance]);
  useEffect(() => {
    if (depositReceipt.isSuccess) {
      void refetchAllowance();
      void refetchShareBalance();
    }
  }, [depositReceipt.isSuccess, refetchAllowance, refetchShareBalance]);
  useEffect(() => {
    if (withdrawReceipt.isSuccess) {
      void refetchShareBalance();
      if (redeemRouter) void refetchRouterShareAllowance();
    }
  }, [withdrawReceipt.isSuccess, refetchShareBalance, redeemRouter, refetchRouterShareAllowance]);
  useEffect(() => {
    if (shareApproveReceipt.isSuccess && redeemRouter) {
      void refetchRouterShareAllowance();
    }
  }, [shareApproveReceipt.isSuccess, redeemRouter, refetchRouterShareAllowance]);

  const routerCtx: RouterPreviewContext | null =
    hasSelector && props.routerAddress ? { ...props.ctx, router: props.routerAddress } : null;

  return (
    <div className="form-grid">
      {/* Vault / router selector — only shown when registry+router are configured */}
      {hasSelector && props.registryAddress && props.routerAddress && (
        <DestinationSelector
          registryAddress={props.registryAddress}
          routerAddress={props.routerAddress}
          selected={destination}
          onSelect={setDestination}
        />
      )}

      {/* Router deposit path */}
      {destination === ROUTER_DESTINATION && routerCtx ? (
        <RouterDepositTab
          routerAddress={props.routerAddress as Address}
          usdcAddress={props.usdcAddress}
          ctx={routerCtx}
        />
      ) : (
        /* Single-vault deposit path (unchanged from issue #257) */
        <section data-testid="deposit-form">
          <h2>Deposit USDC</h2>
          <p>Approve USDC, then deposit into the vault to receive {depositSymbol}.</p>
          <DepositsClosedNotice
            state={depositClosedState}
            scope="This vault"
            testId="deposit-closed-notice"
          />
          <label>
            Amount (USDC)
            <input
              data-testid="deposit-amount"
              value={depositInput}
              onChange={(e) => setDepositInput(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              disabled={depositsClosed}
            />
          </label>
          {depositPreview && <TxPreview preview={depositPreview} />}
          {approveNeeded && (
            <button
              type="button"
              data-testid="deposit-approve"
              onClick={onApprove}
              disabled={!isConnected || !approveSim || isPending || depositsClosed}
            >
              Approve USDC for vault
            </button>
          )}
          <button
            type="button"
            data-testid="deposit-submit"
            onClick={onDeposit}
            disabled={
              !isConnected ||
              !depositSim ||
              !allowanceOk ||
              isPending ||
              depositsClosed ||
              depositPreview?.ok !== true
            }
          >
            Sign deposit with wallet
          </button>
          <ReceiptValueDisplay
            shares={
              typeof shareBalance === "bigint" ? formatShares(shareBalance, redeemSymbol) : "0"
            }
            label={`${redeemSymbol} balance`}
          />
          <WriteStatus
            testId="deposit-approve"
            label="USDC approval"
            write={approveWrite}
            receipt={approveReceipt}
          />
          <WriteStatus
            testId="deposit"
            label="Deposit"
            write={depositWrite}
            receipt={depositReceipt}
          />
          {approveSimError && (
            <p className="hint" data-testid="approve-sim-error">
              approve simulate failed: {approveSimError.message}
            </p>
          )}
          {depositSimError && (
            <p className="hint" data-testid="deposit-sim-error">
              deposit simulate failed: {depositSimError.message}
            </p>
          )}
        </section>
      )}

      <section data-testid="withdraw-form">
        <h2>Withdraw</h2>
        <p>Select a vault position, then burn {redeemSymbol} to redeem USDC (net of exitFeeBps).</p>
        {props.explorerApiUrl && isConnected && address && (
          <PositionSelector
            account={address}
            explorerApiUrl={props.explorerApiUrl}
            selectedVault={undefined}
            onSelect={(vault, sharesStr) => {
              setSelectedVault(vault);
              // Pre-fill the input with the full position balance so the
              // user can adjust if desired. The explorer sends raw shares; the input takes decimal shares.
              setWithdrawInput(
                /^\d+$/.test(sharesStr)
                  ? formatInputAmount(BigInt(sharesStr), SHARE_DECIMALS)
                  : sharesStr,
              );
            }}
          />
        )}
        <label>
          Shares ({redeemSymbol})
          <input
            data-testid="withdraw-amount"
            value={withdrawInput}
            onChange={(e) => setWithdrawInput(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </label>
        {redeemTargetRefused && selectedVault !== undefined && (
          <p className="error" data-testid="withdraw-target-unregistered">
            Refusing to redeem from {selectedVault}: the on-chain VaultRegistry does not list this
            vault. The position list comes from the explorer, which cannot choose a signing target.
          </p>
        )}
        {redeemVault !== undefined && (
          <VaultPositionCard
            vaultAddress={redeemVault}
            vaultName={redeemVault}
            shares={
              typeof shareBalance === "bigint" ? formatShares(shareBalance, redeemSymbol) : "0"
            }
            exclusionClaim={exclusionClaim !== undefined ? formatUsdc(exclusionClaim) : undefined}
          />
        )}
        <ReceiptValueDisplay
          shares={typeof shareBalance === "bigint" ? formatShares(shareBalance, redeemSymbol) : "0"}
          label={`${redeemSymbol} balance`}
        />
        {hasInsufficientBalance && (
          <p className="hint" data-testid="withdraw-insufficient-balance">
            Insufficient balance: you hold{" "}
            {typeof shareBalance === "bigint" ? formatShares(shareBalance, redeemSymbol) : "0"} but
            entered {withdrawShares !== null ? formatShares(withdrawShares, redeemSymbol) : "0"}.
            Reduce the amount before signing.
          </p>
        )}
        {typeof previewRedeemAssets === "bigint" && withdrawShares !== null && (
          <p className="hint" data-testid="withdraw-preview-redeem">
            Estimated USDC out: {formatUsdcPreview(previewRedeemAssets)} (net of exit fee)
          </p>
        )}
        {/* Which contract the redeem goes to, and its floor or why it has none (QA plan D9). */}
        {redeemVault !== undefined && (
          <p className="hint" data-testid="withdraw-route" data-route={route.kind}>
            {route.kind === "router"
              ? minAssets !== null
                ? `Routed through the Portfolio Router: the redeem reverts unless the vault pays at least ${formatUsdc(minAssets)} (previewRedeem less ${formatPercent(ROUTER_SLIPPAGE_TOLERANCE_BPS)}).`
                : `Routed through the Portfolio Router: the redeem carries a minimum-out floor of previewRedeem less ${formatPercent(ROUTER_SLIPPAGE_TOLERANCE_BPS)}.`
              : route.kind === "direct"
                ? `This redeem calls the vault directly and has no minimum-out floor: ${directRedeemReasonText(route.reason)}.`
                : "Reading the vault registry to choose the redeem route…"}
          </p>
        )}
        {redeemPreview && <TxPreview preview={redeemPreview} />}
        {showShareApproval && (
          <>
            <p className="hint" data-testid="withdraw-approve-hint">
              The router redeems your shares for you, so approve it for exactly the{" "}
              {withdrawShares !== null ? formatShares(withdrawShares, redeemSymbol) : redeemSymbol}{" "}
              to redeem. The redeem spends the whole allowance.
            </p>
            <button
              type="button"
              data-testid="withdraw-approve"
              onClick={onApproveShares}
              disabled={!isConnected || !shareApproveSim || isPending}
            >
              Approve {redeemSymbol} for the router
            </button>
          </>
        )}
        <button
          type="button"
          data-testid="withdraw-submit"
          onClick={onWithdraw}
          disabled={
            !isConnected ||
            !withdrawReady ||
            isPending ||
            redeemPreview?.ok !== true ||
            hasInsufficientBalance === true ||
            redeemVault === undefined
          }
        >
          Sign withdraw with wallet
        </button>
        {routerAllowanceLeftover && typeof routerShareAllowance === "bigint" && (
          <>
            <p className="hint" data-testid="withdraw-router-allowance-leftover">
              The router holds an allowance of {formatShares(routerShareAllowance, redeemSymbol)} on
              your shares that the redeem entered here will not spend. Revoke it unless you redeem
              that much now.
            </p>
            <button
              type="button"
              data-testid="withdraw-revoke"
              onClick={onRevokeShares}
              disabled={!isConnected || !shareRevokeSim || isPending}
            >
              Revoke router allowance
            </button>
          </>
        )}
        <WriteStatus
          testId="withdraw-approve"
          label="Share approval"
          write={shareApproveWrite}
          receipt={shareApproveReceipt}
        />
        <WriteStatus
          testId="withdraw"
          label="Withdraw"
          write={withdrawWrite}
          receipt={withdrawReceipt}
        />
        {redeemSimError && (
          <p className="hint" data-testid="redeem-sim-error">
            redeem simulate failed: {redeemSimError.message}
          </p>
        )}
        {redeemSimError && redeemFailureHint(redeemSimError.message) && (
          <p className="hint" data-testid="redeem-in-kind-hint">
            {redeemFailureHint(redeemSimError.message)}
          </p>
        )}
      </section>
    </div>
  );
}
