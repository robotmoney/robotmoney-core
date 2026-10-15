// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (agent consent, issue #1791)

/**
 * AgentConsentField — collects the agent's EIP-712 consent for a depositor
 * reveal (QA plan D2/U4).
 *
 * When the agent is not the connected wallet, the gateway's
 * `revealAuthorization` needs the agent's `AgentConsent` signature. The dapp
 * never holds an agent key: it shows the exact fields the signature must
 * cover and the `rmpc agent-consent` command that produces it, takes the
 * pasted signature, and says whether it recovers to the agent. The surface
 * keeps its commit disabled until the status is `ok`, so no commit is spent
 * on a reveal that would revert `InvalidAgentConsent`.
 *
 * Test ids, under `<prefix>-agent-consent`: the field itself, `-input`,
 * `-status` (with `data-status`) and `-command`.
 */
import type { Address } from "viem";
import type { AgentConsentState } from "../lib/useAgentConsent";
import { rmpcAgentConsentCommand } from "../lib/agentConsent";

function short(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function statusText(state: AgentConsentState): string {
  const c = state.check;
  switch (c.status) {
    case "not-required":
      return "No agent consent needed: this wallet is the agent.";
    case "missing":
      return "Paste the agent's consent signature to continue.";
    case "malformed":
      return `Not a consent signature: ${c.reason}.`;
    case "nonce-unknown":
      return "Reading the agent's consent nonce from the gateway…";
    case "checking":
      return "Checking the signature…";
    case "wrong-signer":
      return (
        `This signature is from ${c.recovered}, not the agent, or it covers other fields ` +
        "(owner, share receiver, nonce, chain or gateway). The reveal would revert InvalidAgentConsent."
      );
    case "ok":
      return "Agent consent verified: it recovers to the agent for exactly these fields.";
  }
}

export function AgentConsentField({
  testIdPrefix,
  consent,
  disabled,
}: Readonly<{ testIdPrefix: string; consent: AgentConsentState; disabled?: boolean }>) {
  const id = `${testIdPrefix}-agent-consent`;
  if (!consent.required) return null;
  const f = consent.fields;
  const bad = consent.check.status === "malformed" || consent.check.status === "wrong-signer";
  return (
    <fieldset data-testid={id} className="agent-consent">
      <legend>Agent consent (required)</legend>
      <p className="hint">
        The agent is not this wallet, so the gateway binds it only with the agent&apos;s EIP-712
        signature (AgentConsent, issue 1791). It authorizes one reveal, by this wallet only, on this
        chain and gateway only.
        {f && (
          <>
            {" "}
            Ask the agent to run{" "}
            <code data-testid={`${id}-command`}>{rmpcAgentConsentCommand(f.owner)}</code> and paste
            the <code>signature</code> it prints.
          </>
        )}
      </p>
      {f && (
        <dl data-testid={`${id}-fields`} className="agent-consent-fields">
          <dt>agent</dt>
          <dd title={f.agent}>{short(f.agent)}</dd>
          <dt>owner (this wallet)</dt>
          <dd title={f.owner}>{short(f.owner)}</dd>
          <dt>shareReceiver</dt>
          <dd title={f.shareReceiver}>{short(f.shareReceiver)}</dd>
          <dt>nonce</dt>
          <dd>{f.nonce.toString()}</dd>
          <dt>chainId / gateway</dt>
          <dd title={f.gateway}>
            {f.chainId} / {short(f.gateway)}
          </dd>
        </dl>
      )}
      <label>
        Agent consent signature (65 bytes, 0x…)
        <input
          data-testid={`${id}-input`}
          value={consent.raw}
          onChange={(e) => consent.setRaw(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          disabled={disabled}
        />
      </label>
      <p
        data-testid={`${id}-status`}
        data-status={consent.check.status}
        className={bad ? "error" : "hint"}
        role={bad ? "alert" : undefined}
      >
        {statusText(consent)}
      </p>
    </fieldset>
  );
}
