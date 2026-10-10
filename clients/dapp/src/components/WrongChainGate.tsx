// Canonical: docs/architecture.md §5.3 — Human Dapp

import type { ReactElement, ReactNode } from "react";
import { useSwitchChain } from "wagmi";
import { useWriteChainGuard } from "../lib/useGuardedWriteContract";
import { BASE_MAINNET_CHAIN_NAME } from "../lib/writeChainGuard";

/**
 * WrongChainGate (issue 1729). On the `mainnet` class, when the connected wallet is
 * not on Base, render the switch prompt INSTEAD of the children. Nothing under it
 * mounts, so no balance, price or position read for the wrong chain is shown, and
 * no write control exists. The guarded write hook refuses independently.
 */
export function WrongChainGate({ children }: { children: ReactNode }) {
  const { state } = useWriteChainGuard();
  const { switchChain, isPending, error } = useSwitchChain();
  if (state.kind !== "wrong-chain") return children as ReactElement;
  return (
    <section className="wrong-chain-gate" data-testid="wrong-chain-gate" role="alert">
      <h2>
        Switch your wallet to {BASE_MAINNET_CHAIN_NAME} (chain {state.targetChainId})
      </h2>
      <p>
        Your wallet is on chain {state.connectedChainId}. Deposits, withdrawals and balances are
        disabled until it is on {BASE_MAINNET_CHAIN_NAME}.
      </p>
      <button
        type="button"
        data-testid="wrong-chain-switch"
        disabled={isPending}
        onClick={() => switchChain({ chainId: state.targetChainId })}
      >
        {isPending ? "Waiting for wallet…" : `Switch to ${BASE_MAINNET_CHAIN_NAME}`}
      </button>
      {error && <p data-testid="wrong-chain-error">Could not switch: {error.message}</p>}
    </section>
  );
}
