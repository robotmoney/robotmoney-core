/**
 * MultiVaultWithdrawalTab — withdraw from any registered vault (issue #417).
 *
 * Renders a position picker showing receipt balances across all registered
 * vaults (aggregated via batched per-vault balanceOf reads). User selects a
 * position, enters a shares or USDC amount, and sees a live preview before
 * signing (AC §8, §9, §10).
 *
 * Safety gates (all live chain reads per AC §11):
 *   - Position list sourced from per-vault `vault.balanceOf(address)` calls
 *     batched via useContractReads (AC §8).
 *   - Preview block shows estimated USDC out, exit fee, and net amount from
 *     live `previewRedeem` and `exitFeeBps` reads (AC §9).
 *   - Submit disabled when `maxRedeem` is zero for the selected vault (AC §10).
 *
 * All preview values sourced exclusively from useReadContract (AC §11).
 *
 * docs/architecture.md §5.3 — action layer: multi-vault withdrawal.
 * docs/technical/multi-vault-dapp-decisions.md §4.3.
 */
import { useEffect, useState, useMemo } from "react";
import {
  useAccount,
  useReadContracts,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import type { Address, Hash } from "viem";
import { vaultAbi } from "../lib/abi";
import { useVaultRegistry } from "../lib/VaultRegistryContext";
import { buildVaultPreview, type VaultPreviewContext } from "../lib/vaultPreview";
import { TxPreview } from "./TxPreview";
import { parseUsdcAmount } from "./DepositWithdrawTab";

type Props = Readonly<{
  ctx: VaultPreviewContext;
}>;

/** Format a raw 6-decimal USDC bigint for UI display. */
function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")} USDC`;
}

/** Format a raw 6-decimal shares bigint for UI display. */
function formatShares(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")} rmUSDC`;
}

/** Shorten an address for display. */
function shorten(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function MultiVaultWithdrawalTab({ ctx }: Props) {
  const { address, isConnected } = useAccount();
  const { vaults } = useVaultRegistry();

  const [selectedVault, setSelectedVault] = useState<Address | "">("");
  const [sharesInput, setSharesInput] = useState("");

  const withdrawShares = parseUsdcAmount(sharesInput);

  // -------- batched balanceOf reads across all registered vaults (AC §8) --------
  // One eth_call batch rather than N independent reads.
  const { data: balancesRaw, refetch: refetchBalances } = useReadContracts({
    contracts: vaults.map((v) => ({
      address: v.vault,
      abi: vaultAbi,
      functionName: "balanceOf" as const,
      args: [address ?? "0x0000000000000000000000000000000000000000"] as const,
    })),
    query: { enabled: isConnected && Boolean(address) && vaults.length > 0 },
  });

  // Map vault address -> balance bigint; filter out zero balances for display.
  const balanceByVault = useMemo(() => {
    const map = new Map<string, bigint>();
    if (!balancesRaw || !address) return map;
    for (let i = 0; i < vaults.length; i++) {
      const result = balancesRaw[i];
      if (result?.status === "success" && typeof result.result === "bigint" && result.result > 0n) {
        map.set(vaults[i].vault.toLowerCase(), result.result);
      }
    }
    return map;
  }, [balancesRaw, vaults, address]);

  // Live balanceOf for the selected vault (for display in form).
  const selectedBalance = selectedVault
    ? (balanceByVault.get(selectedVault.toLowerCase()) ?? 0n)
    : 0n;

  // -------- maxRedeem live check (AC §10 / §11) --------
  const { data: maxRedeemValue } = useReadContract({
    address: selectedVault ? (selectedVault as Address) : undefined,
    abi: vaultAbi,
    functionName: "maxRedeem",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) && Boolean(selectedVault) },
  });

  const maxRedeemIsZero =
    selectedVault && maxRedeemValue !== undefined && (maxRedeemValue as bigint) === 0n;

  // -------- live previewRedeem (AC §9 / §11) --------
  const { data: previewRedeemAssets } = useReadContract({
    address: selectedVault ? (selectedVault as Address) : undefined,
    abi: vaultAbi,
    functionName: "previewRedeem",
    args: withdrawShares !== null ? [withdrawShares] : undefined,
    query: { enabled: Boolean(selectedVault) && withdrawShares !== null },
  });

  // -------- live exitFeeBps (AC §9 / §11) --------
  const { data: exitFeeBpsValue } = useReadContract({
    address: selectedVault ? (selectedVault as Address) : undefined,
    abi: vaultAbi,
    functionName: "exitFeeBps",
    query: { enabled: Boolean(selectedVault) },
  });

  const hasInsufficientBalance = withdrawShares !== null && selectedBalance < withdrawShares;

  // -------- redeem simulation --------
  const vaultCtx: VaultPreviewContext | null = selectedVault
    ? { ...ctx, vault: selectedVault as Address }
    : null;

  const redeemAction =
    withdrawShares !== null &&
    address &&
    vaultCtx &&
    !hasInsufficientBalance &&
    !maxRedeemIsZero &&
    selectedVault
      ? ({
          kind: "vaultRedeem",
          shares: withdrawShares,
          receiver: address,
          owner: address,
        } as const)
      : null;

  const redeemPreview = redeemAction && vaultCtx ? buildVaultPreview(redeemAction, vaultCtx) : null;

  const { data: redeemSim, error: redeemSimError } = useSimulateContract({
    account: address,
    address: selectedVault ? (selectedVault as Address) : undefined,
    abi: vaultAbi,
    functionName: "redeem",
    args: redeemAction
      ? [redeemAction.shares, redeemAction.receiver, redeemAction.owner]
      : undefined,
    query: { enabled: isConnected && redeemPreview?.ok === true, retry: 5 },
  });

  // -------- write hooks --------
  const withdrawWrite = useWriteContract();
  const withdrawReceipt = useWaitForTransactionReceipt({
    hash: withdrawWrite.data as Hash | undefined,
    query: { enabled: Boolean(withdrawWrite.data) },
  });

  const isPending = withdrawWrite.isPending || withdrawReceipt.isFetching;

  useEffect(() => {
    if (withdrawReceipt.isSuccess) void refetchBalances();
  }, [withdrawReceipt.isSuccess, refetchBalances]);

  useEffect(() => {
    if (redeemSimError) {
      // eslint-disable-next-line no-console
      console.error("[MultiVaultWithdrawalTab] redeem simulate error:", redeemSimError);
    }
  }, [redeemSimError]);

  const onWithdraw = () => {
    if (!redeemSim) return;
    withdrawWrite.writeContract(redeemSim.request);
  };

  // List of vaults with non-zero balances for the position picker.
  const positionsWithBalance = vaults.filter(
    (v) => (balanceByVault.get(v.vault.toLowerCase()) ?? 0n) > 0n,
  );

  return (
    <section data-testid="multi-vault-withdrawal-tab">
      <h2>Withdraw from Vault</h2>
      <p>
        Select a vault position, enter the shares to redeem, and review the live preview before
        signing.
      </p>

      {/* Position picker across all registered vaults (AC §8) */}
      {isConnected && address ? (
        <div data-testid="vault-position-list">
          {balanceByVault.size === 0 ? (
            <p className="hint" data-testid="no-positions">
              No vault positions found for this wallet.
            </p>
          ) : (
            <div>
              <p className="hint">Your positions:</p>
              {positionsWithBalance.map((v) => {
                const bal = balanceByVault.get(v.vault.toLowerCase()) ?? 0n;
                return (
                  <label key={v.vault} data-testid={`position-${v.vault}`}>
                    <input
                      type="radio"
                      name="selected-vault"
                      value={v.vault}
                      checked={selectedVault === v.vault}
                      onChange={() => {
                        setSelectedVault(v.vault);
                        setSharesInput("");
                      }}
                    />{" "}
                    {v.name || shorten(v.vault)} — {formatShares(bal)}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <p className="hint" data-testid="connect-wallet-hint">
          Connect your wallet to see positions.
        </p>
      )}

      {/* maxRedeem zero gate (AC §10) */}
      {maxRedeemIsZero && selectedVault && (
        <p className="hint" data-testid="max-redeem-zero-warning" style={{ color: "red" }}>
          maxRedeem is zero for this vault. Withdrawals are currently blocked.
        </p>
      )}

      <label>
        Shares to redeem (rmUSDC)
        <input
          data-testid="multi-vault-withdraw-amount"
          value={sharesInput}
          onChange={(e) => setSharesInput(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          disabled={!selectedVault || Boolean(maxRedeemIsZero)}
        />
      </label>

      {selectedVault && (
        <p className="hint" data-testid="multi-vault-selected-balance">
          Balance: {formatShares(selectedBalance)}
        </p>
      )}

      {hasInsufficientBalance && (
        <p className="hint" data-testid="multi-vault-insufficient-balance" style={{ color: "red" }}>
          Insufficient balance: you hold {formatShares(selectedBalance)} but entered{" "}
          {withdrawShares !== null ? formatShares(withdrawShares) : ""}.
        </p>
      )}

      {/* Live preview block: estimated USDC out, exit fee, net amount (AC §9) */}
      {typeof previewRedeemAssets === "bigint" && withdrawShares !== null && (
        <div data-testid="multi-vault-redeem-preview">
          <p className="hint" data-testid="multi-vault-preview-usdc-out">
            Estimated USDC out: {formatUsdc(previewRedeemAssets as bigint)}
          </p>
          {typeof exitFeeBpsValue === "bigint" && exitFeeBpsValue > 0n && (
            <p className="hint" data-testid="multi-vault-preview-exit-fee">
              Exit fee: {Number(exitFeeBpsValue as bigint) / 100}% ({exitFeeBpsValue.toString()}{" "}
              bps)
            </p>
          )}
        </div>
      )}

      {redeemPreview && <TxPreview preview={redeemPreview} />}

      <button
        type="button"
        data-testid="multi-vault-withdraw-submit"
        onClick={onWithdraw}
        disabled={
          !isConnected ||
          !redeemSim ||
          isPending ||
          redeemPreview?.ok !== true ||
          hasInsufficientBalance === true ||
          Boolean(maxRedeemIsZero)
        }
      >
        Sign withdraw with wallet
      </button>

      {redeemSimError && (
        <p className="hint" data-testid="multi-vault-redeem-sim-error">
          redeem simulate failed: {redeemSimError.message}
        </p>
      )}
    </section>
  );
}
