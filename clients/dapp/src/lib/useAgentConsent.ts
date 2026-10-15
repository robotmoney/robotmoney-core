// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (agent consent, issue #1791)

/**
 * useAgentConsent — the consent a depositor's reveal carries (QA plan D2/U4).
 *
 * Reads `agentConsentNonce(agent)` from the gateway, holds the signature the
 * depositor pastes, and checks it against the exact fields the reveal will
 * bind (agent, this wallet as owner, share receiver, nonce, chain, gateway).
 * `consent` is the `agentConsent` argument to send: `"0x"` when the wallet
 * binds itself, the checked signature when it recovers to the agent, and
 * null otherwise. A surface must not commit while `consent` is null: the
 * reveal would revert `InvalidAgentConsent`, and the commit would be wasted.
 */
import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { isAddress, type Address, type Hex } from "viem";
import { gatewayAbi } from "./abi";
import {
  agentConsentRequired,
  checkAgentConsent,
  consentBytes,
  type AgentConsentCheck,
  type AgentConsentFields,
} from "./agentConsent";

export interface AgentConsentState {
  /** False when the wallet is the agent, or the inputs are not addresses yet. */
  required: boolean;
  /** The fields the consent must cover; null while any is unknown. */
  fields: AgentConsentFields | null;
  raw: string;
  setRaw: (v: string) => void;
  check: AgentConsentCheck;
  /** The `agentConsent` bytes to send, or null while the reveal cannot be sent. */
  consent: Hex | null;
}

export function useAgentConsent(args: {
  gateway: Address;
  agent: string;
  /** The connected wallet: it reveals, so it is the consent's `owner`. */
  revealer: Address | undefined;
  shareReceiver: string;
}): AgentConsentState {
  // The domain's chain is the one the reveal is sent on: the wallet's chain
  // (the write guard pins it to the deployment's chain on mainnet).
  const { chainId } = useAccount();
  const agentOk = isAddress(args.agent, { strict: false });
  const receiverOk = isAddress(args.shareReceiver, { strict: false });
  const required =
    agentOk &&
    args.revealer !== undefined &&
    agentConsentRequired(args.agent as Address, args.revealer);

  const { data: nonceData } = useReadContract({
    address: args.gateway,
    abi: gatewayAbi,
    functionName: "agentConsentNonce",
    args: agentOk ? [args.agent as Address] : undefined,
    query: { enabled: required },
  });
  const nonce = typeof nonceData === "bigint" ? nonceData : undefined;

  const fields: AgentConsentFields | null =
    required &&
    receiverOk &&
    nonce !== undefined &&
    args.revealer !== undefined &&
    chainId !== undefined
      ? {
          agent: args.agent as Address,
          owner: args.revealer,
          shareReceiver: args.shareReceiver as Address,
          nonce,
          chainId,
          gateway: args.gateway,
        }
      : null;

  const [raw, setRaw] = useState("");
  const [check, setCheck] = useState<AgentConsentCheck>({ status: "missing" });

  // Re-check whenever the pasted bytes or any bound field changes: a consent
  // for another agent, owner, receiver, nonce or chain must stop counting.
  const key = fields
    ? `${fields.agent}|${fields.owner}|${fields.shareReceiver}|${fields.nonce}|${fields.chainId}|${fields.gateway}`
    : "none";
  useEffect(() => {
    if (!required) {
      setCheck({ status: "not-required" });
      return;
    }
    let live = true;
    setCheck({ status: "checking" });
    void checkAgentConsent(raw, fields).then((c) => {
      if (live) setCheck(c);
    });
    return () => {
      live = false;
    };
    // `fields` is summarised by `key`; the object itself is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, key, required]);

  const effective: AgentConsentCheck = required ? check : { status: "not-required" };
  return { required, fields, raw, setRaw, check: effective, consent: consentBytes(effective) };
}
