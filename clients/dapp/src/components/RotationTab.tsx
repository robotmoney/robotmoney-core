// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway
// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (2026-10-06 amendment)

import type { FormEvent } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import type { PreviewContext } from "../lib/preview";
import { useRotationState } from "../lib/useRotationState";
import { TxPreview } from "./TxPreview";
import { PolicyFields } from "./PolicyFields";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  now: number;
}>;

export function RotationTab(props: Props) {
  const { isConnected } = useAccount();
  const r = useRotationState(props.gatewayAddress, props.ctx, props.now);

  const depositor = r.authorizePath === "depositor";
  const disableRevoke = !isConnected || !r.previewsOk || r.step !== "idle" || r.isPending;
  const disableAuthorize =
    !isConnected || !r.authorizeOk || r.step !== "revoke-sent" || r.isPending;
  const disableReveal = !isConnected || !r.revealReady || r.isPending;

  return (
    <section data-testid="rotation-form">
      <h2>Agent rotation (revoke old → authorize new)</h2>
      <p>
        Both previews must be confirmed before wallet signing begins. Do not close this dialog
        between transactions.
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
      {depositor && (
        <p data-testid="rotation-depositor-path">
          This wallet does not hold ADMIN_ROLE, so the new agent is authorized with
          commitAuthorization then revealAuthorization. No role is needed and this wallet becomes
          the new agent&apos;s owner.
        </p>
      )}
      {r.depositorError && (
        <p data-testid="rotation-depositor-error" className="error">
          {r.depositorError}
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
        New agent address (to authorize)
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
      </form>

      <form
        data-testid="rotation-step2"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          r.onAuthorize();
        }}
      >
        <h3>Step 2: authorize new agent</h3>
        {r.authorizePreview && <TxPreview preview={r.authorizePreview} />}
        <button type="submit" data-testid="rotation-authorize-submit" disabled={disableAuthorize}>
          {depositor
            ? "Step 2 — Sign commitAuthorization(new) with wallet"
            : "Step 2 — Sign authorizeAgent(new) with wallet"}
        </button>
      </form>

      {depositor && (
        <form
          data-testid="rotation-step3"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            r.onReveal();
          }}
        >
          <h3>Step 3: reveal new agent</h3>
          <p>Enabled one block after the commit transaction mines.</p>
          <button type="submit" data-testid="rotation-reveal-submit" disabled={disableReveal}>
            Step 3 — Sign revealAuthorization(new) with wallet
          </button>
        </form>
      )}

      {r.step === "done" && (
        <p data-testid="rotation-complete">Rotation complete. Verify on-chain state.</p>
      )}
    </section>
  );
}
