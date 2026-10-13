// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API

import { describeIndexFreshness } from "../lib/indexFreshness";

/**
 * The block the explorer's data is at, with a staleness hint when the indexer is behind the chain head (issue 1731).
 *
 * `blockNumber` is ALWAYS the index block (the last block the indexer committed). The block of a vault snapshot is a
 * different number that trails it by up to the snapshot heartbeat: it goes in `snapshotBlock` and is labelled
 * separately, never fed to the lag line (issue 1741).
 */
export function IndexFreshness(props: {
  readonly blockNumber: number | null | undefined;
  readonly chainHeadBlock?: number | null;
  readonly snapshotBlock?: number | null;
  readonly testId: string;
}) {
  const v = describeIndexFreshness(props.blockNumber, props.chainHeadBlock);
  return (
    <>
      <p
        data-testid={props.testId}
        data-index-stale={v.stale ? "true" : "false"}
        style={v.stale ? { color: "orange" } : undefined}
      >
        {v.text}
      </p>
      {props.snapshotBlock != null && props.snapshotBlock > 0 && (
        <p data-testid={`${props.testId}-snapshot`}>Latest snapshot block {props.snapshotBlock}</p>
      )}
    </>
  );
}
