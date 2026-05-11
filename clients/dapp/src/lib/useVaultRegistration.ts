/**
 * useAgentRegistration — decides whether a connected wallet has
 * authorized at least one agent (the protocol's "registration" step).
 *
 * Real check should read AgentAuthorized events from the gateway and
 * filter by parsed `shareReceiver` (or by tx-sender) — neither field
 * is indexed, so this needs either an indexer or a full log scan. For
 * the scaffold we use a localStorage flag set optimistically when the
 * user clicks Authorize. TODO: replace with on-chain check once an
 * indexer-backed `getAgentsByAdmin(user)` API exists.
 *
 * fork/devnet env classes auto-bypass the gate so smoke-test fixtures
 * (and Playwright) don't need to seed localStorage.
 */
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

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

export function useAgentRegistration(
  envClass: "fork" | "devnet" | "testnet" | "mainnet",
): RegistrationStatus {
  const { address, isConnected } = useAccount();
  const bypass = envClass === "fork" || envClass === "devnet";

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

  if (!isConnected) return "disconnected";
  if (bypass) return "registered";
  return flag ? "registered" : "unregistered";
}
