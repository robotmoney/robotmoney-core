/**
 * useAgentRegistration — decides whether a connected wallet should bypass
 * the onboarding wizard. A wallet is "registered" when it satisfies
 * either of the protocol's two onboarding signals:
 *
 *   1. It has authorized at least one agent on the gateway. Real check
 *      should read `AgentAuthorized` events from the gateway filtered by
 *      tx-sender — neither field is indexed, so this needs either an
 *      indexer or a full log scan. Until we have an indexer-backed
 *      `getAgentsByAdmin(user)` API, we use a localStorage flag set
 *      optimistically when the user signs Authorize.
 *
 *   2. It already holds vault shares (rmUSDC). A non-zero
 *      `vault.balanceOf(address)` means the wallet has deposited into the
 *      vault directly or received shares from someone who did — either
 *      way it is not a first-time user and the wizard is noise.
 *
 * Neither signal depends on env class — the same rules apply on devnet,
 * testnet, and mainnet. A fresh wallet on smoke-test devnet correctly
 * sees the wizard until it authorizes an agent or receives shares.
 */
import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { erc20Abi } from "./abi";

export type RegistrationStatus = "disconnected" | "unregistered" | "registered";

const STORAGE_PREFIX = "rm:agent-registered:";

function storageKey(addr: string): string {
  return `${STORAGE_PREFIX}${addr.toLowerCase()}`;
}

export function markRegistered(addr: string): void {
  try {
    localStorage.setItem(storageKey(addr), "1");
    window.dispatchEvent(new Event("rm:registration-changed"));
  } catch {
    // localStorage may be unavailable (private mode, etc) — caller
    // falls back to a normal write flow on next reload.
  }
}

export function useAgentRegistration(vaultAddress: Address): RegistrationStatus {
  const { address, isConnected } = useAccount();

  const [flag, setFlag] = useState<boolean>(false);
  useEffect(() => {
    if (!address) {
      setFlag(false);
      return;
    }
    const read = () => {
      try {
        setFlag(localStorage.getItem(storageKey(address)) === "1");
      } catch {
        setFlag(false);
      }
    };
    read();
    window.addEventListener("rm:registration-changed", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("rm:registration-changed", read);
      window.removeEventListener("storage", read);
    };
  }, [address]);

  const { data: shareBalance } = useReadContract({
    address: vaultAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });

  if (!isConnected) return "disconnected";
  const hasShares = typeof shareBalance === "bigint" && shareBalance > 0n;
  return flag || hasShares ? "registered" : "unregistered";
}
