/**
 * Test helper: an agent whose key the unit tests hold, so they can sign the
 * gateway's EIP-712 AgentConsent the way `rmpc agent-consent` does (issue
 * 1791) and paste it into the dapp.
 */
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { act } from "react";
import { fireEvent, screen, waitFor } from "./render";
import { agentConsentTypedData, type AgentConsentFields } from "../../../src/lib/agentConsent";

/** Anvil account #1 (0x70997970…79C8). Never a real key. */
export const CONSENT_AGENT_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const CONSENT_AGENT = privateKeyToAccount(CONSENT_AGENT_KEY);

/** The consent `CONSENT_AGENT` signs for these fields. */
export function signAgentConsent(fields: Omit<AgentConsentFields, "agent">): Promise<Hex> {
  return CONSENT_AGENT.signTypedData(
    agentConsentTypedData({ ...fields, agent: CONSENT_AGENT.address }),
  );
}

/**
 * Paste `signature` into the `<prefix>-agent-consent-input` field and wait
 * until the dapp reports `expected` (default `ok`).
 */
export async function pasteAgentConsent(
  prefix: string,
  signature: string,
  expected = "ok",
): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId(`${prefix}-agent-consent-input`), {
      target: { value: signature },
    });
  });
  await waitFor(() =>
    expect(screen.getByTestId(`${prefix}-agent-consent-status`).getAttribute("data-status")).toBe(
      expected,
    ),
  );
}
