// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway
// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (2026-10-06 amendment, 2026-10-20 amendment)

import type { FormEvent } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import type { PreviewContext } from "../lib/preview";
import { useRotationState } from "../lib/useRotationState";
import { TxPreview } from "./TxPreview";
import { PolicyFields } from "./PolicyFields";
import { WriteStatus } from "./WriteStatus";
import { RegistrationSteps, registrationIds } from "./RegistrationSteps";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  now: number;
}>;

const IDS = registrationIds("rotation", {
  commitSubmit: "rotation-authorize-submit",
  revealSubmit: "rotation-reveal-submit",
  complete: "rotation-complete",
});

export function RotationTab(props: Props) {
  const { isConnected } = useAccount();
  const r = useRotationState(props.gatewayAddress, props.ctx, props.now);

  const disableRevoke = !isConnected || !r.previewsOk || r.step !== "idle" || r.isPending;

  return (
    <section data-testid="rotation-form">
      <h2>Agent rotation (revoke old → register new)</h2>
      <p>
        Every step&apos;s preview must be confirmed before wallet signing begins. Do not close this
        dialog between transactions.
      </p>

      {r.combinedRiskAnnotation && (
        <p data-testid="rotation-combined-risk" className="rotation-risk-banner">
          {r.combinedRiskAnnotation}
        </p>
      )}
      {r.combinedError && (
        <p data-testid="rotation-preview-error" className="error">
          {r.combinedError}
        </p>
      )}
      <p data-testid="rotation-registration-path">
        Every wallet registers the new agent the same way: the new agent consents from its own key,
        this wallet commits, then this wallet reveals. No role is needed. This wallet becomes the
        new agent&apos;s owner and share receiver.
      </p>
      {r.newAgentOwnedWarning && (
        <p data-testid="rotation-new-agent-owned" className="error">
          {r.newAgentOwnedWarning}
        </p>
      )}

      <label>
        Old agent address (to revoke)
        <input
          data-testid="rotation-old-agent-input"
          value={r.oldAgent}
          onChange={(e) => r.setOldAgent(e.target.value)}
          placeholder="0x..."
        />
      </label>
      <label>
        New agent address (to register)
        <input
          data-testid="rotation-new-agent-input"
          value={r.newAgent}
          onChange={(e) => r.setNewAgent(e.target.value)}
          placeholder="0x..."
        />
      </label>
      <PolicyFields
        testIdPrefix="rotation-"
        validUntil={r.validUntil}
        setValidUntil={r.setValidUntil}
        maxPerPayment={r.maxPerPayment}
        setMaxPerPayment={r.setMaxPerPayment}
        maxPerWindow={r.maxPerWindow}
        setMaxPerWindow={r.setMaxPerWindow}
        shareReceiver={r.shareReceiver}
        setShareReceiver={r.setShareReceiver}
      />

      <form
        data-testid="rotation-step1"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          r.onRevoke();
        }}
      >
        <h3>Step 1: revoke old agent</h3>
        {r.revokePreview && <TxPreview preview={r.revokePreview} />}
        <button type="submit" data-testid="rotation-revoke-submit" disabled={disableRevoke}>
          Step 1 — Sign revokeAgent(old) with wallet
        </button>
        <WriteStatus
          testId="rotation-revoke"
          label="Revoke"
          write={r.revokeStatus.write}
          receipt={r.revokeStatus.receipt}
        />
      </form>

      <section data-testid="rotation-step2">
        <h3>Step 2: register the new agent (consent, commit, reveal)</h3>
        <RegistrationSteps
          r={r.registration}
          ids={IDS}
          enabled={r.registrationOpen}
          completeText="Rotation complete. Verify on-chain state."
        />
      </section>
    </section>
  );
}
