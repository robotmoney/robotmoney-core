// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * VaultSelectorDepositTab — direct vault deposit with live preview (issue #417).
 *
 * Renders a vault picker populated from VaultRegistryContext (AC §1, §3),
 * an amount entry field, and a live preview block showing estimated
 * receipts, fees, net amount, and slippage bounds from on-chain reads.
 *
 * Safety gates (all live chain reads, never cached context values per AC §11):
 *   - Submit disabled when the vault is not Active (deposits paused or
 *     retired) — live `registry.getVault()` re-query used, not the cached
 *     context status (AC §4). This gates deposits only: withdrawals stay
 *     open in every vault status (core 1494).
 *   - Submit disabled when USDC balance < entered amount (AC §5).
 *   - Approve button shown when allowance < entered amount.
 *
 * All preview values (previewDeposit, allowance) sourced exclusively from
 * useReadContract (AC §11). The component never calls the explorer API for
 * safety-critical fields.
 *
 * docs/architecture.md §5.3 — action layer: vault-selector deposit.
 * docs/technical/multi-vault-dapp-decisions.md §4.3.
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
import { erc20Abi, vaultAbi, registryAbi, VaultStatus } from "../lib/abi";
import { useVaultRegistry } from "../lib/VaultRegistryContext";
import { buildVaultPreview, type VaultPreviewContext } from "../lib/vaultPreview";
import { TxPreview } from "./TxPreview";
import { DEPOSITS_PAUSED_ABI } from "../lib/vaultDepositState";
import { parseUsdcAmount } from "./DepositWithdrawTab";
import { formatUsdc, formatShares } from "../lib/format";

type Props = Readonly<{
  usdcAddress: Address;
  registryAddress: Address;
  ctx: VaultPreviewContext;
}>;

// formatUsdc and formatShares are imported from the shared format module above.

export function VaultSelectorDepositTab({ usdcAddress, registryAddress, ctx }: Props) {
  const { address, isConnected } = useAccount();
  const { vaults, isLoading: vaultsLoading } = useVaultRegistry();

  const [selectedVaultAddr, setSelectedVaultAddr] = useState<Address | "">("");
  const [amountInput, setAmountInput] = useState("");

  const depositAssets = parseUsdcAmount(amountInput);

  const vaultCtx: VaultPreviewContext | null = selectedVaultAddr
    ? { ...ctx, vault: selectedVaultAddr as Address }
    : null;

  // -------- live getVault re-query before submit (AC §4) --------
  // Must NOT use cached context status — use a live read for the gate.
  const { data: liveVaultRecord } = useReadContract({
    address: registryAddress,
    abi: registryAbi,
    functionName: "getVault",
    args: selectedVaultAddr ? [selectedVaultAddr as Address] : undefined,
    query: {
      enabled: Boolean(selectedVaultAddr) && isConnected,
      // refetch on every block to catch a deposit pause in real-time
      refetchInterval: 12_000,
    },
  });

  // `getVault` returns two outputs (metadata, status), so viem decodes it
  // as a 2-element array — index 1 is the status, not a `.status` property.
  const registryRefusesDeposits =
    liveVaultRecord !== undefined &&
    (liveVaultRecord as readonly [unknown, number])[1] !== VaultStatus.Active;

  // The vault's OWN `depositsPaused()` (issue 1731). The registry stays Active when the vault's pause switch
  // is set, so the registry read above alone would let the form look open on a closed vault. Deposit side
  // only: nothing here touches withdraw or redeem.
  const { data: livePausedFlag } = useReadContract({
    address: selectedVaultAddr ? (selectedVaultAddr as Address) : undefined,
    abi: DEPOSITS_PAUSED_ABI,
    functionName: "depositsPaused",
    query: {
      enabled: Boolean(selectedVaultAddr) && isConnected,
      refetchInterval: 12_000,
    },
  });
  const vaultRefusesDeposits = registryRefusesDeposits || livePausedFlag === true;

  // -------- live previewDeposit (AC §3) --------
  const { data: previewDepositShares } = useReadContract({
    address: selectedVaultAddr ? (selectedVaultAddr as Address) : undefined,
    abi: vaultAbi,
    functionName: "previewDeposit",
    args: depositAssets !== null ? [depositAssets] : undefined,
    query: { enabled: Boolean(selectedVaultAddr) && depositAssets !== null },
  });

  // -------- allowance read (AC §5 / §11) --------
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && selectedVaultAddr ? [address, selectedVaultAddr as Address] : undefined,
    query: { enabled: isConnected && Boolean(address) && Boolean(selectedVaultAddr) },
  });

  // -------- USDC balance read for AC §5 --------
  const { data: usdcBalance } = useReadContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  const hasInsufficientBalance =
    depositAssets !== null && typeof usdcBalance === "bigint" && usdcBalance < depositAssets;

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
    args:
      depositAssets !== null && selectedVaultAddr
        ? [selectedVaultAddr as Address, depositAssets]
        : undefined,
    query: {
      enabled: isConnected && approveNeeded === true && Boolean(selectedVaultAddr),
      retry: 5,
    },
  });

  // -------- deposit simulation --------
  const depositAction =
    depositAssets !== null && address && vaultCtx
      ? ({ kind: "vaultDeposit", assets: depositAssets, receiver: address } as const)
      : null;
  const depositPreview =
    depositAction && vaultCtx ? buildVaultPreview(depositAction, vaultCtx) : null;

  const canSimDeposit =
    isConnected &&
    depositPreview?.ok === true &&
    allowanceOk &&
    !vaultRefusesDeposits &&
    !hasInsufficientBalance;

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: selectedVaultAddr ? (selectedVaultAddr as Address) : undefined,
    abi: vaultAbi,
    functionName: "deposit",
    args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
    query: { enabled: canSimDeposit, retry: 5 },
  });

  // -------- write hooks --------
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

  useEffect(() => {
    if (approveReceipt.isSuccess) void refetchAllowance();
  }, [approveReceipt.isSuccess, refetchAllowance]);

  useEffect(() => {
    if (depositSimError) {
      // eslint-disable-next-line no-console
      console.error("[VaultSelectorDepositTab] deposit simulate error:", depositSimError);
    }
  }, [depositSimError]);
  useEffect(() => {
    if (approveSimError) {
      // eslint-disable-next-line no-console
      console.error("[VaultSelectorDepositTab] approve simulate error:", approveSimError);
    }
  }, [approveSimError]);

  const onApprove = () => {
    if (!approveSim) return;
    approveWrite.writeContract(approveSim.request);
  };

  const onDeposit = () => {
    if (!depositSim) return;
    depositWrite.writeContract(depositSim.request);
  };

  // Compute submit disabled reason for accessibility label
  const submitDisabledReason = !isConnected
    ? "wallet-not-connected"
    : !selectedVaultAddr
      ? "no-vault-selected"
      : vaultRefusesDeposits
        ? "vault-paused"
        : hasInsufficientBalance
          ? "insufficient-balance"
          : !allowanceOk
            ? "needs-approve"
            : !depositSim
              ? "sim-pending"
              : undefined;

  return (
    <section data-testid="vault-selector-deposit-tab">
      <h2>Deposit into Vault</h2>
      <p>Select a registered vault, enter an amount, and review the live preview before signing.</p>

      {/* Vault picker from VaultRegistryContext (AC §1, §3) */}
      <label>
        Select Vault
        <select
          data-testid="vault-selector"
          value={selectedVaultAddr}
          onChange={(e) => {
            setSelectedVaultAddr(e.target.value as Address | "");
            setAmountInput("");
          }}
          disabled={vaultsLoading || vaults.length === 0}
        >
          <option value="">{vaultsLoading ? "Loading vaults…" : "— choose a vault —"}</option>
          {vaults.map((v) => (
            <option key={v.vault} value={v.vault} disabled={v.status !== VaultStatus.Active}>
              {v.name || v.vault}
              {v.status === VaultStatus.DepositsPaused
                ? " [DEPOSITS PAUSED]"
                : v.status !== VaultStatus.Active
                  ? " [RETIRED]"
                  : ""}
            </option>
          ))}
        </select>
      </label>

      {/* Deposits-paused / retired vault safety gate (AC §4) */}
      {vaultRefusesDeposits && (
        <p className="hint" data-testid="vault-paused-warning" style={{ color: "red" }}>
          Deposits paused / closed. Deposits into this vault are paused or the vault is retired.
          Withdrawals stay open.
        </p>
      )}

      <label>
        Amount (USDC)
        <input
          data-testid="vault-selector-deposit-amount"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          disabled={!selectedVaultAddr || vaultRefusesDeposits}
        />
      </label>

      {/* Live preview block: estimated receipts, fees, net amount (AC §3) */}
      {typeof previewDepositShares === "bigint" && depositAssets !== null && (
        <p className="hint" data-testid="vault-deposit-preview-shares">
          Estimated receipt shares: {formatShares(previewDepositShares, "rmUSDC")}
        </p>
      )}
      {depositAssets !== null && typeof usdcBalance === "bigint" && (
        <p className="hint" data-testid="vault-deposit-balance">
          Your USDC balance: {formatUsdc(usdcBalance)}
        </p>
      )}
      {hasInsufficientBalance && (
        <p
          className="hint"
          data-testid="vault-deposit-insufficient-balance"
          style={{ color: "red" }}
        >
          Insufficient USDC balance. You have{" "}
          {usdcBalance !== undefined ? formatUsdc(usdcBalance as bigint) : "0"} but entered{" "}
          {depositAssets !== null ? formatUsdc(depositAssets) : ""}.
        </p>
      )}

      {depositPreview && <TxPreview preview={depositPreview} />}

      {approveNeeded && !vaultRefusesDeposits && (
        <button
          type="button"
          data-testid="vault-selector-deposit-approve"
          onClick={onApprove}
          disabled={!isConnected || !approveSim || isPending}
        >
          Approve USDC for vault
        </button>
      )}

      <button
        type="button"
        data-testid="vault-selector-deposit-submit"
        onClick={onDeposit}
        disabled={Boolean(submitDisabledReason) || isPending}
        aria-label={
          submitDisabledReason
            ? `Deposit disabled: ${submitDisabledReason}`
            : "Sign deposit with wallet"
        }
      >
        Sign deposit with wallet
      </button>

      {approveSimError && (
        <p className="hint" data-testid="vault-selector-approve-sim-error">
          approve simulate failed: {approveSimError.message}
        </p>
      )}
      {depositSimError && (
        <p className="hint" data-testid="vault-selector-deposit-sim-error">
          deposit simulate failed: {depositSimError.message}
        </p>
      )}
    </section>
  );
}
