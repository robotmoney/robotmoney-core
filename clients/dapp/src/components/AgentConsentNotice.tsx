// Canonical: docs/architecture.md §5.2 — an agent address consents before another account owns it
import type { Hex } from "viem";

/**
 * Shown between the commit and the reveal. The agent address must submit this hash through
 * `commitAuthorization` from its own key, otherwise the reveal reverts `OwnerConsentMissing`
 * (core 1791). It is what stops anyone from taking an address that never agreed.
 */
export function AgentConsentNotice(props: { hash: Hex | null; testId: string }) {
  if (!props.hash) return null;
  return (
    <p className="hint" data-testid={`${props.testId}-notice`}>
      The agent address must consent before you reveal. From the agent key, call{" "}
      <code>commitAuthorization</code> with this hash:{" "}
      <code data-testid={props.testId}>{props.hash}</code>
    </p>
  );
}
