// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway
// Canonical: docs/technical/dapp-credential-decisions.md (amendment 2026-10-20)

/**
 * RegistrationSteps — the one rendering of the owner-consented registration sequence
 * (issue 1890), shared by the Authorize tab, the onboarding wizard and the rotation tab so
 * they cannot drift. All state lives in `useConsentedRegistration`.
 *
 * The visible order is the enforced order:
 *   1. freeze the exact inputs;
 *   2. the agent's consent (read from the gateway) - the owner commit stays disabled before it;
 *   3. the owner commit;
 *   4. the reveal, one block later and inside both expiry windows.
 */
import type { FormEvent } from "react";
import type { ConsentedRegistration } from "../lib/useConsentedRegistration";
import { COMMIT_EXPIRY_BLOCKS } from "../lib/consent";
import { TxPreview } from "./TxPreview";
import { WriteStatus } from "./WriteStatus";
import { AgentConsentNotice } from "./AgentConsentNotice";

/** The test ids one host (tab or wizard) wants for the shared controls. */
export type RegistrationIds = Readonly<{
  freeze: string;
  reset: string;
  commitSubmit: string;
  revealSubmit: string;
  consentHash: string;
  consentStatus: string;
  commitPreview: string;
  revealPreview: string;
  waiting: string;
  expired: string;
  stale: string;
  complete: string;
  /** Prefix of the WriteStatus lines: `<prefix>-commit` and `<prefix>-reveal`. */
  status: string;
}>;

export function registrationIds(prefix: string, overrides: Partial<RegistrationIds> = {}) {
  return {
    freeze: `${prefix}-freeze`,
    reset: `${prefix}-reset`,
    commitSubmit: `${prefix}-commit-submit`,
    revealSubmit: `${prefix}-reveal-submit`,
    consentHash: `${prefix}-consent-hash`,
    consentStatus: `${prefix}-consent-status`,
    commitPreview: `${prefix}-commit-preview`,
    revealPreview: `${prefix}-reveal-preview`,
    waiting: `${prefix}-reveal-waiting`,
    expired: `${prefix}-expired`,
    stale: `${prefix}-stale`,
    complete: `${prefix}-complete`,
    status: prefix,
    ...overrides,
  } satisfies RegistrationIds;
}

const CONSENT_TEXT = {
  self: "This wallet is the agent, so the reveal itself is the consent. No separate consent is needed.",
  unknown: "Waiting to read the agent's consent from the gateway…",
  missing:
    "The agent has not committed its consent yet. The owner commit stays disabled until the gateway shows it.",
  live: "The agent's consent is on the gateway and live. You can sign the owner commit.",
  expired: `The agent's consent is older than ${COMMIT_EXPIRY_BLOCKS} blocks. The agent must commit it again, then freeze these inputs again.`,
} as const;

type Props = Readonly<{
  r: ConsentedRegistration;
  ids: RegistrationIds;
  /** False keeps the freeze button disabled (rotation: until the old agent is revoked). */
  enabled?: boolean;
  /** Extra text under the freeze button when the wallet is not the share receiver. */
  completeText?: string;
}>;

export function RegistrationSteps({ r, ids, enabled = true, completeText }: Props) {
  const onCommit = (e: FormEvent) => {
    e.preventDefault();
    r.onCommit();
  };
  const onReveal = (e: FormEvent) => {
    e.preventDefault();
    r.onReveal();
  };

  if (!r.frozen) {
    return (
      <div data-testid={`${ids.status}-start`}>
        <p className="hint">
          Registration needs the agent&apos;s own consent first, then this wallet&apos;s commit,
          then the reveal. Freeze the inputs to start: the consent hash, the commit and the reveal
          are all built from the frozen values.
        </p>
        {!r.receiverIsOwner && r.canFreeze === false && (
          <p data-testid={`${ids.status}-receiver-note`} className="hint">
            The share receiver must be the signing wallet. The gateway reverts any other receiver
            for every account, ADMIN_ROLE holders included.
          </p>
        )}
        <button
          type="button"
          data-testid={ids.freeze}
          disabled={!enabled || !r.canFreeze || r.isPending}
          onClick={r.freeze}
        >
          Freeze inputs and start
        </button>
      </div>
    );
  }

  const commitSent = r.commitTxHash !== null;
  const waitingText =
    r.commitBlock === null
      ? "Commit transaction submitted — waiting for it to mine…"
      : "Commitment confirmed. Waiting for one block to pass before the reveal can be submitted.";

  return (
    <div data-testid={`${ids.status}-frozen`}>
      {r.stale && (
        <p data-testid={ids.stale} className="error">
          An input, the wallet or the chain changed after the inputs were frozen. Every step is
          disabled. Start over to freeze the new values.
        </p>
      )}
      <p className="hint">
        Frozen: agent <code>{r.frozen.agent}</code>, owner and share receiver{" "}
        <code>{r.frozen.owner}</code>.
      </p>

      <AgentConsentNotice testId={ids.consentHash} hash={r.consentHash} />
      <p data-testid={ids.consentStatus} data-status={r.consent}>
        {CONSENT_TEXT[r.consent]}
      </p>

      {r.commitPreview && (
        <div data-testid={ids.commitPreview}>
          <TxPreview preview={r.commitPreview} />
        </div>
      )}
      {r.revealPreview && (
        <div data-testid={ids.revealPreview}>
          <p className="hint">The reveal this registration will sign, with this policy:</p>
          <TxPreview preview={r.revealPreview} />
        </div>
      )}
      <form onSubmit={onCommit}>
        <button
          type="submit"
          data-testid={ids.commitSubmit}
          disabled={!r.commitReady || commitSent}
        >
          Sign commit transaction
        </button>
        <WriteStatus
          testId={`${ids.status}-commit`}
          label="Commit"
          write={r.commitStatus.write}
          receipt={commitSent ? r.commitStatus.receipt : undefined}
        />
      </form>

      {commitSent && (
        <>
          <p>
            {waitingText}
            {!r.revealReady && r.expiry === "ok" && (
              <span data-testid={ids.waiting}>
                {r.commitBlock === null ? "Mining…" : "Waiting for next block…"}
              </span>
            )}
          </p>
          {r.expiry !== "ok" && (
            <p data-testid={ids.expired} data-expiry={r.expiry} className="error">
              {r.expiry === "commit-expired"
                ? `The owner commit is older than ${COMMIT_EXPIRY_BLOCKS} blocks. Start over and commit again.`
                : `The agent's consent is older than ${COMMIT_EXPIRY_BLOCKS} blocks. The agent must consent again.`}
            </p>
          )}
          <form onSubmit={onReveal}>
            <button type="submit" data-testid={ids.revealSubmit} disabled={!r.revealReady}>
              Sign reveal transaction
            </button>
            <WriteStatus
              testId={`${ids.status}-reveal`}
              label="Reveal"
              write={r.revealStatus.write}
              receipt={r.revealTxHash !== null ? r.revealStatus.receipt : undefined}
            />
          </form>
        </>
      )}

      {r.revealMined && (
        <p data-testid={ids.complete} className="hint">
          {completeText ?? "Agent registered: this wallet is its recorded owner."}
        </p>
      )}
      <button type="button" data-testid={ids.reset} onClick={r.reset} disabled={r.isPending}>
        Start over
      </button>
    </div>
  );
}
