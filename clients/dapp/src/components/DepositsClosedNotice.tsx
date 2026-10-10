// Canonical: docs/architecture.md §4.1 — Vault Family

import { depositStateLabel, depositStateReason, type DepositState } from "../lib/vaultDepositState";

/**
 * The unmistakable "deposits are closed" line on a deposit form (issue 1731). It renders nothing while
 * deposits are open. `scope` names what is closed ("This vault", "The router deposit"). The wording keeps
 * withdraw and redeem open, because `pauseDeposits()` closes the deposit side only.
 */
export function DepositsClosedNotice(props: {
  readonly state: DepositState;
  readonly scope?: string;
  readonly testId?: string;
}) {
  if (props.state.kind === "open") return null;
  const reason = depositStateReason(props.state);
  return (
    <p
      className="hint deposits-closed-notice"
      role="alert"
      data-testid={props.testId ?? "deposits-closed-notice"}
      data-deposit-state={props.state.kind}
      style={{ color: props.state.kind === "unknown" ? "orange" : "red", fontWeight: 600 }}
    >
      {props.scope ? `${props.scope}: ` : ""}
      {props.state.kind === "unknown" ? "" : `${depositStateLabel(props.state)}. `}
      {reason}
    </p>
  );
}
