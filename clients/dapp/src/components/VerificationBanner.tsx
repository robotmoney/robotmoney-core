// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * VerificationBanner — gateway bytecode hash verification status.
 * Rendered at the app shell so the refusal banner is visible before
 * wallet connect / before the Agents panel mounts. A refusal names its
 * cause in one sentence (QA plan U5, finding DR-9).
 */
import type { VerificationState } from "../lib/useGatewayVerifier";
import { describeVerificationCause } from "../lib/gatewayVerifier";

type Props = Readonly<{
  state: VerificationState;
  refresh: () => void;
}>;

export function VerificationBanner({ state, refresh }: Props) {
  if (state.status === "verified" || state.status === "idle") return null;
  return (
    <div className="verification-banner-wrap">
      <section data-testid="gateway-verification-status">
        {state.status === "pending" && (
          <p data-testid="gateway-verification-pending">
            Verifying gateway bytecode hash… Admin writes are disabled until verification completes.
          </p>
        )}
        {state.status === "refused" && (
          <p data-testid="gateway-verification-refused" className="unsafe-banner">
            <strong>Gateway verification refused — admin writes disabled.</strong>{" "}
            <span data-testid="gateway-verification-cause" data-cause={state.cause}>
              {describeVerificationCause(state.cause)}
            </span>{" "}
            {state.detail && (
              <span data-testid="gateway-verification-refused-detail">({state.detail}) </span>
            )}
            <button type="button" data-testid="gateway-verification-retry" onClick={refresh}>
              Re-verify
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
