// Canonical: docs/architecture.md §5.2 — an agent address consents before another account owns it
import type { Hex } from "viem";

/**
 * Shown right after the inputs are frozen, before the owner commit. The agent address must
 * submit this hash through `commitAuthorization` from its own key first: the dapp reads it from
 * the gateway and keeps the owner commit disabled until it is there. Without it the reveal
 * reverts `OwnerConsentMissing` (core 1791). It is what stops anyone from taking an address
 * that never agreed. The consent expires after 256 blocks like the owner commit (issue 1890).
 */
export function AgentConsentNotice(props: { hash: Hex | null; testId: string }) {
  if (!props.hash) return null;
  return (
    <p className="hint" data-testid={`${props.testId}-notice`}>
      The agent address must consent first, before you sign the commit. From the agent key, call{" "}
      <code>commitAuthorization</code> with this hash:{" "}
      <code data-testid={props.testId}>{props.hash}</code>
    </p>
  );
}
