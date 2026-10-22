// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway
// Canonical: docs/technical/dapp-credential-decisions.md (amendment 2026-10-20)

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { type AgentPolicy, type PreviewContext } from "../lib/preview";
import { markRegistered } from "../lib/useVaultRegistration";
import { useConsentedRegistration } from "../lib/useConsentedRegistration";
import { PolicyFields } from "./PolicyFields";
import { RegistrationSteps, registrationIds } from "./RegistrationSteps";
import { DestinationPicker } from "./DestinationPicker";
import { tryDepositOnlyPolicy } from "../lib/agentDestinations";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  agent: string;
  setAgent: Dispatch<SetStateAction<string>>;
  shareReceiver: string;
  setShareReceiver: Dispatch<SetStateAction<string>>;
  /** The owner's selected deposit destinations. Shared with the config export. */
  destinations: string[];
  setDestinations: Dispatch<SetStateAction<string[]>>;
  routerAddress?: string;
  now: number;
}>;

const IDS = registrationIds("authorize", {
  commitSubmit: "authorize-submit",
  revealSubmit: "authorize-reveal-submit",
});

/**
 * Authorize an agent. Every wallet, an ADMIN_ROLE holder included, takes the same sequence:
 * the agent's consent, this wallet's commit, then the reveal (issue 1890). The gateway has no
 * admin shortcut, and the share receiver is always the signing wallet.
 */
export function AuthorizeTab(props: Props) {
  const { address } = useAccount();
  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(props.now / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");

  // strict: false — accept lowercase addresses (rmpc + some wallets omit
  // EIP-55 checksum casing).
  const validAgent = isAddress(props.agent, { strict: false });
  const validReceiver = isAddress(props.shareReceiver, { strict: false });

  // No policy until the owner has selected at least one vault: the gateway refuses an empty list.
  const policy: AgentPolicy | null =
    validAgent && validReceiver
      ? tryDepositOnlyPolicy(
          {
            validUntil: BigInt(validUntil),
            maxPerPayment: BigInt(maxPerPayment),
            maxPerWindow: BigInt(maxPerWindow),
            shareReceiver: props.shareReceiver as Address,
            destinations: props.destinations,
          },
          props.routerAddress,
        )
      : null;

  const r = useConsentedRegistration({
    gatewayAddress: props.gatewayAddress,
    ctx: props.ctx,
    agent: props.agent,
    policy,
  });

  // The wallet is registered only once the reveal is mined, never when the
  // wallet merely accepted it (QA plan U5): a reverted reveal binds nothing.
  useEffect(() => {
    if (r.revealMined && address) markRegistered(address);
  }, [r.revealMined, address]);

  return (
    <section data-testid="authorize-form">
      <h2>Authorize agent</h2>
      <label>
        Agent address
        <input
          data-testid="agent-input"
          value={props.agent}
          onChange={(e) => props.setAgent(e.target.value)}
          placeholder="0x..."
        />
      </label>
      <PolicyFields
        validUntil={validUntil}
        setValidUntil={setValidUntil}
        maxPerPayment={maxPerPayment}
        setMaxPerPayment={setMaxPerPayment}
        maxPerWindow={maxPerWindow}
        setMaxPerWindow={setMaxPerWindow}
        shareReceiver={props.shareReceiver}
        setShareReceiver={props.setShareReceiver}
      />
      <DestinationPicker
        selected={props.destinations}
        setSelected={props.setDestinations}
        routerAddress={props.routerAddress}
      />
      <RegistrationSteps r={r} ids={IDS} />
    </section>
  );
}
