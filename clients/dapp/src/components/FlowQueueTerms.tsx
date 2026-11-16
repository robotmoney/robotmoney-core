// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.11.3 item 8 and §8 (OPS-07, FLOW-08)

import {
  formatBandBps,
  formatUnixUtc,
  resolveFlowTerms,
  type FlowLiveness,
  type FlowQuote,
} from "../lib/flowQueueTerms";

/** Do not render old terms as current when either queue read is unavailable. */
export function FlowQueueTermsReadState(props: {
  readonly quote?: FlowQuote;
  readonly liveness?: FlowLiveness;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly error: boolean;
}) {
  if (props.error || props.stale) {
    return <p role="alert">Queue terms are unavailable or stale. Refresh before continuing.</p>;
  }
  if (props.loading) return <p>Loading queue terms…</p>;
  if (!props.quote || !props.liveness) return <p role="alert">Queue terms are unavailable.</p>;
  return <FlowQueueTerms quote={props.quote} liveness={props.liveness} />;
}

/**
 * Terms of a deposit made now. It shows each deposit stop with its cause, its end and the cancel deadline,
 * the guard bands, and keeper and Safe liveness (OPS-07, FLOW-08). It shows no price: the queue quotes none.
 * It takes the two chain reads as props, so a screen that already reads the queue can mount it.
 */
export function FlowQueueTerms(props: {
  readonly quote: FlowQuote;
  readonly liveness: FlowLiveness;
}) {
  const view = resolveFlowTerms(props.quote, props.liveness);
  return (
    <section data-testid="flow-queue-terms" aria-label="Deposit terms">
      {view.stops.map((s) => (
        <p
          key={s.kind}
          role="alert"
          className="hint"
          data-testid={`flow-stop-${s.kind}`}
          style={{ color: "red", fontWeight: 600 }}
        >
          {s.cause}
          {s.endsAt !== null ? ` Ends ${formatUnixUtc(s.endsAt)}.` : " No end time is set."} Cancel
          a locked deposit until {formatUnixUtc(view.cancelDeadline)}.
        </p>
      ))}
      <dl>
        <dt>Fee</dt>
        <dd data-testid="flow-fee">{props.quote.feeBps.toString()} bps</dd>
        <dt>Earliest settlement</dt>
        <dd data-testid="flow-earliest-settlement">{formatUnixUtc(props.quote.earliestSettle)}</dd>
        <dt>Hold ends</dt>
        <dd data-testid="flow-hold-ends">{formatUnixUtc(props.quote.holdEnds)}</dd>
        <dt>Cancel deadline</dt>
        <dd data-testid="flow-cancel-deadline">
          {formatUnixUtc(view.cancelDeadline)} ({view.cancelBufferSecs}s before the epoch closes)
        </dd>
        <dt>Reference band</dt>
        <dd data-testid="flow-ref-band">{formatBandBps(view.refBandBps)}</dd>
        <dt>Per-swap band</dt>
        <dd data-testid="flow-leg-band">{formatBandBps(view.legBandBps)}</dd>
        <dt>Keeper</dt>
        <dd data-testid="flow-keeper">{view.keeperConfigured ? "Configured" : "Not configured"}</dd>
      </dl>
      <p>Matched flows and net trades can change the composition of the fund.</p>
      {view.warnings.map((w) => (
        <p
          key={w}
          role="alert"
          className="hint"
          data-testid="flow-warning"
          style={{ color: "orange" }}
        >
          {w}
        </p>
      ))}
    </section>
  );
}
