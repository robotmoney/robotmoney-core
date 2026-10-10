// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API

/**
 * What the dapp says about how current the explorer's index is (issue 1731).
 *
 * The explorer reports `block_number` (the last block the indexer committed) and `chain_head_block` (the head
 * the indexer last saw). Before the fix the API read the newest `indexer_runs` row and reported 0 whenever a
 * tick was in flight, so the dapp showed "Block 0" while the index sat at the head. A block of 0 now means
 * "nothing indexed yet" and is never printed as a block.
 *
 * The indexer reads only blocks that are `CONFIRMATIONS` (5) old, so a healthy index is about five blocks
 * behind the head. On Base (2 s blocks) a lag over `STALE_AFTER_BLOCKS` is about a minute, which no healthy
 * tick produces: the hint turns on past that.
 */
export const STALE_AFTER_BLOCKS = 30;

export interface IndexFreshnessView {
  /** The text: "Block 123", "Block 123 · indexer 400 blocks behind", or "Not indexed yet". */
  readonly text: string;
  /** Blocks between the head and the index, when both are known. */
  readonly behind: number | null;
  readonly stale: boolean;
}

export function describeIndexFreshness(
  blockNumber: number | null | undefined,
  chainHeadBlock: number | null | undefined,
): IndexFreshnessView {
  if (blockNumber == null || blockNumber <= 0) {
    return { text: "Not indexed yet", behind: null, stale: false };
  }
  if (chainHeadBlock == null || chainHeadBlock <= 0) {
    return { text: `Block ${blockNumber}`, behind: null, stale: false };
  }
  const behind = Math.max(0, chainHeadBlock - blockNumber);
  const stale = behind > STALE_AFTER_BLOCKS;
  return {
    text: stale
      ? `Block ${blockNumber} · indexer ${behind} blocks behind (head ${chainHeadBlock})`
      : `Block ${blockNumber}`,
    behind,
    stale,
  };
}
