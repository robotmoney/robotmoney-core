// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (V4 price recorder)

import { useEffect } from "react";
import { useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { Address, Hash } from "viem";
import { PRICE_RECORDER_ABI } from "../lib/priceRecorder";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";

/**
 * Refresh a stale price recorder (dapp issue 1760). `record()` is permissionless
 * (contracts/adapters/UniswapV4PriceRecorder.sol:151), so the connected user may send it. It goes through the
 * guarded write hook like every other write. When the receipt lands every read is refetched, so the deposit
 * form reopens as soon as `isFresh()` is true.
 */
export function RefreshPriceButton(props: { readonly recorders: readonly string[] }) {
  const write = useGuardedWriteContract();
  const queryClient = useQueryClient();
  const receipt = useWaitForTransactionReceipt({
    hash: write.data as Hash | undefined,
    query: { enabled: Boolean(write.data) },
  });
  useEffect(() => {
    if (receipt.isSuccess) void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  const busy = write.isPending || receipt.isFetching;
  const recorder = props.recorders[0];
  return (
    <span>
      <button
        type="button"
        data-testid="refresh-price"
        disabled={busy || !recorder}
        onClick={() => {
          if (recorder) {
            write.writeContract({
              address: recorder as Address,
              abi: PRICE_RECORDER_ABI,
              functionName: "record",
            });
          }
        }}
      >
        {busy ? "Refreshing price..." : "Refresh price"}
      </button>
      {write.error && (
        <span className="hint" data-testid="refresh-price-error" role="alert">
          {" "}
          refresh failed: {write.error.message}
        </span>
      )}
    </span>
  );
}
