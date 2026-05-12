/**
 * DepositWithdrawTab — wires the ERC-4626 vault entrypoints into the
 * dapp (issue #257). Two symmetric sub-flows:
 *
 *   Deposit:  USDC.approve(vault, assets) → vault.deposit(assets, receiver)
 *   Withdraw: vault.redeem(shares, receiver, owner)
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
import { useEffect, useState } from "react";
import {
  useAccount,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import type { Address, Hash } from "viem";
import { erc20Abi, vaultAbi } from "../lib/abi";
import { buildVaultPreview, type VaultPreviewContext } from "../lib/vaultPreview";
import { TxPreview } from "./TxPreview";

type Props = Readonly<{
  vaultAddress: Address;
  usdcAddress: Address;
  ctx: VaultPreviewContext;
}>;

/**
 * Parse a human-typed amount (e.g. "1.5") into a 6-decimal bigint, the
 * unit RobotMoneyVault and USDC use. Returns `null` on any input the
 * user could not have intended as a positive USDC amount (empty,
 * non-numeric, negative, more than 6 fractional digits).
 *
 * Kept pure and exported so the vitest can exercise the amount logic
 * without rendering the component (see test plan).
 */
export function parseUsdcAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, 6);
  const value = BigInt(whole) * 1_000_000n + BigInt(padded || "0");
  if (value === 0n) return null;
  return value;
}

export function DepositWithdrawTab(props: Props) {
  const { address, isConnected } = useAccount();
  // Three independent write hooks so each action exposes its own
  // `data` (tx hash) and `isPending`. We then wait for each receipt
  // before refetching downstream reads — without this gate the
  // `writeContract` callback fires when the hash is returned, not when
  // the tx is mined, so allowance/share-balance reads race past the
  // pending state and the deposit/withdraw submit never enables.
  const approveWrite = useWriteContract();
  const depositWrite = useWriteContract();
  const withdrawWrite = useWriteContract();

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

  const isPending =
    approveWrite.isPending ||
    depositWrite.isPending ||
    withdrawWrite.isPending ||
    approveReceipt.isFetching ||
    depositReceipt.isFetching ||
    withdrawReceipt.isFetching;

  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");

  const depositAssets = parseUsdcAmount(depositInput);
  const withdrawShares = parseUsdcAmount(withdrawInput);

  // -------- allowance read --------
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: props.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, props.vaultAddress] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  // -------- share balance read-back --------
  const { data: shareBalance, refetch: refetchShareBalance } = useReadContract({
    address: props.vaultAddress,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  // -------- deposit preview + simulation --------
  const depositAction =
    depositAssets !== null && address
      ? ({ kind: "vaultDeposit", assets: depositAssets, receiver: address } as const)
      : null;
  const depositPreview = depositAction ? buildVaultPreview(depositAction, props.ctx) : null;

  const allowanceOk =
    depositAssets !== null && typeof allowance === "bigint" && allowance >= depositAssets;

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: props.vaultAddress,
    abi: vaultAbi,
    functionName: "deposit",
    args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
    query: {
      enabled: isConnected && depositPreview?.ok === true && allowanceOk === true,
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
    args: depositAssets !== null ? [props.vaultAddress, depositAssets] : undefined,
    query: { enabled: isConnected && approveNeeded === true, retry: 5 },
  });

  // -------- redeem preview + simulation --------
  const redeemAction =
    withdrawShares !== null && address
      ? ({
          kind: "vaultRedeem",
          shares: withdrawShares,
          receiver: address,
          owner: address,
        } as const)
      : null;
  const redeemPreview = redeemAction ? buildVaultPreview(redeemAction, props.ctx) : null;

  const { data: redeemSim, error: redeemSimError } = useSimulateContract({
    account: address,
    address: props.vaultAddress,
    abi: vaultAbi,
    functionName: "redeem",
    args: redeemAction
      ? [redeemAction.shares, redeemAction.receiver, redeemAction.owner]
      : undefined,
    query: { enabled: isConnected && redeemPreview?.ok === true, retry: 5 },
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

  const onApprove = () => {
    if (!approveSim) return;
    approveWrite.writeContract(approveSim.request);
  };

  const onDeposit = () => {
    if (!depositSim) return;
    depositWrite.writeContract(depositSim.request);
  };

  const onWithdraw = () => {
    if (!redeemSim) return;
    withdrawWrite.writeContract(redeemSim.request);
  };

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
    }
  }, [withdrawReceipt.isSuccess, refetchShareBalance]);

  return (
    <div className="form-grid">
      <section data-testid="deposit-form">
        <h2>Deposit USDC</h2>
        <p>Approve USDC, then deposit into the vault to receive rmUSDC shares.</p>
        <label>
          Amount (USDC)
          <input
            data-testid="deposit-amount"
            value={depositInput}
            onChange={(e) => setDepositInput(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </label>
        {depositPreview && <TxPreview preview={depositPreview} />}
        {approveNeeded && (
          <button
            type="button"
            data-testid="deposit-approve"
            onClick={onApprove}
            disabled={!isConnected || !approveSim || isPending}
          >
            Approve USDC for vault
          </button>
        )}
        <button
          type="button"
          data-testid="deposit-submit"
          onClick={onDeposit}
          disabled={
            !isConnected || !depositSim || !allowanceOk || isPending || depositPreview?.ok !== true
          }
        >
          Sign deposit with wallet
        </button>
        <p className="hint" data-testid="deposit-share-balance">
          rmUSDC balance: {typeof shareBalance === "bigint" ? shareBalance.toString() : "—"}
        </p>
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

      <section data-testid="withdraw-form">
        <h2>Withdraw</h2>
        <p>Burn rmUSDC shares to redeem USDC (net of exitFeeBps).</p>
        <label>
          Shares (rmUSDC)
          <input
            data-testid="withdraw-amount"
            value={withdrawInput}
            onChange={(e) => setWithdrawInput(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </label>
        {redeemPreview && <TxPreview preview={redeemPreview} />}
        <button
          type="button"
          data-testid="withdraw-submit"
          onClick={onWithdraw}
          disabled={!isConnected || !redeemSim || isPending || redeemPreview?.ok !== true}
        >
          Sign withdraw with wallet
        </button>
        {redeemSimError && (
          <p className="hint" data-testid="redeem-sim-error">
            redeem simulate failed: {redeemSimError.message}
          </p>
        )}
      </section>
    </div>
  );
}
