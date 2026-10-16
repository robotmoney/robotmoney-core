// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * WriteStatus — what happened to the last write of one guarded write hook (QA plan U5,
 * finding DR-9, issue 1737 part 4).
 *
 * Before this, the deposit and withdraw tabs dropped `write.error` and the receipt on the
 * floor: a write the guard refused (wrong chain, unpinned target), a wallet rejection and a
 * transaction that reverted on chain all looked like a button that did nothing. Each write
 * hook now renders one of these lines under its form:
 *
 *   - `<testId>-write-error`   the write was refused or failed before it was mined;
 *   - `<testId>-write-status`  waiting for the wallet, or sent and waiting for the receipt,
 *                              or mined (`data-status="success"`);
 *   - `<testId>-write-reverted` the receipt says the transaction reverted;
 *   - `<testId>-receipt-error`  the receipt could not be read.
 *
 * Nothing is rendered while the hook is idle, so a form's resting layout is unchanged.
 */
import type { Hash } from "viem";

type WriteLike = Readonly<{
  error?: Error | null;
  isPending?: boolean;
  data?: Hash | string;
}>;

type ReceiptLike = Readonly<{
  data?: { status?: string; blockNumber?: bigint } | null;
  isFetching?: boolean;
  error?: Error | null;
}>;

/** viem errors carry a one-line `shortMessage`; everything else prints its message. */
export function writeErrorText(err: Error): string {
  const short = (err as { shortMessage?: unknown }).shortMessage;
  return typeof short === "string" && short !== "" ? short : err.message;
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : hash;
}

export function WriteStatus({
  testId,
  label,
  write,
  receipt,
}: Readonly<{ testId: string; label: string; write: WriteLike; receipt?: ReceiptLike }>) {
  if (write.error) {
    return (
      <p className="error" role="alert" data-testid={`${testId}-write-error`}>
        {label} not sent: {writeErrorText(write.error)}
      </p>
    );
  }
  if (write.isPending) {
    return (
      <p className="hint" data-testid={`${testId}-write-status`} data-status="wallet">
        {label}: confirm in your wallet…
      </p>
    );
  }
  if (!write.data) return null;
  const hash = shortHash(String(write.data));
  const mined = receipt?.data;
  if (mined?.status === "reverted") {
    return (
      <p className="error" role="alert" data-testid={`${testId}-write-reverted`}>
        {label} reverted on chain in block {String(mined.blockNumber ?? "?")} (tx {hash}). No funds
        moved.
      </p>
    );
  }
  if (mined?.status === "success") {
    return (
      <p className="hint" data-testid={`${testId}-write-status`} data-status="success">
        {label} confirmed in block {String(mined.blockNumber ?? "?")} (tx {hash}).
      </p>
    );
  }
  if (receipt?.error) {
    return (
      <p className="error" role="alert" data-testid={`${testId}-receipt-error`}>
        {label} was sent (tx {hash}), but its receipt could not be read:{" "}
        {writeErrorText(receipt.error)}
      </p>
    );
  }
  return (
    <p className="hint" data-testid={`${testId}-write-status`} data-status="sent">
      {label} sent (tx {hash}). Waiting for confirmation…
    </p>
  );
}
