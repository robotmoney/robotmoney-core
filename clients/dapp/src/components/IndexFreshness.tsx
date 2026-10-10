// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API

import { describeIndexFreshness } from "../lib/indexFreshness";

/** The block the explorer's data is at, with a staleness hint when the indexer is behind the chain head (issue 1731). */
export function IndexFreshness(props: {
  readonly blockNumber: number | null | undefined;
  readonly chainHeadBlock?: number | null;
  readonly testId: string;
}) {
  const v = describeIndexFreshness(props.blockNumber, props.chainHeadBlock);
  return (
    <p
      data-testid={props.testId}
      data-index-stale={v.stale ? "true" : "false"}
      style={v.stale ? { color: "orange" } : undefined}
    >
      {v.text}
    </p>
  );
}
