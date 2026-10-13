/**
 * Issue 1731: the dapp shows the real indexed block and a staleness hint, never "Block 0".
 */
import { describe, expect, it } from "vitest";
import { render } from "./helpers/render";
import { describeIndexFreshness, STALE_AFTER_BLOCKS } from "../../src/lib/indexFreshness";
import { IndexFreshness } from "../../src/components/IndexFreshness";
import { VaultCards } from "../../src/components/VaultCards";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike } from "../../src/lib/explorerApi";
import { vi } from "vitest";

describe("describeIndexFreshness", () => {
  it("block 0 or null means nothing is indexed yet, never 'Block 0'", () => {
    expect(describeIndexFreshness(0, 1000).text).toBe("Not indexed yet");
    expect(describeIndexFreshness(null, 1000).text).toBe("Not indexed yet");
    expect(describeIndexFreshness(undefined, undefined).text).not.toContain("Block 0");
  });
  it("shows the block alone when the head is unknown", () => {
    expect(describeIndexFreshness(1234, null)).toEqual({
      text: "Block 1234",
      behind: null,
      stale: false,
    });
  });
  it("a healthy lag (a few confirmations) is not stale and adds no hint", () => {
    const v = describeIndexFreshness(1000, 1005);
    expect(v).toEqual({ text: "Block 1000", behind: 5, stale: false });
    expect(describeIndexFreshness(1000, 1000 + STALE_AFTER_BLOCKS).stale).toBe(false);
  });
  it("past the threshold it says how many blocks behind and the head", () => {
    const v = describeIndexFreshness(1000, 1500);
    expect(v.stale).toBe(true);
    expect(v.behind).toBe(500);
    expect(v.text).toBe("Block 1000 · indexer 500 blocks behind (head 1500)");
    expect(describeIndexFreshness(1000, 1001 + STALE_AFTER_BLOCKS).stale).toBe(true);
  });
  it("a head below the block (reorg, clock skew) is not negative", () => {
    expect(describeIndexFreshness(1000, 990).behind).toBe(0);
  });
});

describe("IndexFreshness component", () => {
  it("renders the hint and marks itself stale", () => {
    const { getByTestId } = render(
      <IndexFreshness blockNumber={1000} chainHeadBlock={1500} testId="f" />,
    );
    const el = getByTestId("f");
    expect(el.textContent).toContain("indexer 500 blocks behind");
    expect(el.getAttribute("data-index-stale")).toBe("true");
  });
  it("renders a plain block when current", () => {
    const { getByTestId } = render(
      <IndexFreshness blockNumber={1000} chainHeadBlock={1005} testId="f" />,
    );
    expect(getByTestId("f").textContent).toBe("Block 1000");
    expect(getByTestId("f").getAttribute("data-index-stale")).toBe("false");
  });
});

describe("the explorer's chain head reaches the page", () => {
  it("VaultCards prints 'indexer N blocks behind' from /v1/vaults chain_head_block", async () => {
    const body = { vaults: [], block_number: 1000, chain_head_block: 1500, indexed_at: "" };
    const fetchImpl = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      json: async () => body,
    })) as unknown as FetchLike;
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={fetchImpl}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const el = await findByTestId("landing-vault-cards-freshness");
    expect(el.textContent).toBe("Block 1000 · indexer 500 blocks behind (head 1500)");
    expect(el.getAttribute("data-index-stale")).toBe("true");
  });

  it("a block_number of 0 is printed as 'Not indexed yet', never 'Block 0'", async () => {
    const body = { vaults: [], block_number: 0, chain_head_block: null, indexed_at: "" };
    const fetchImpl = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      json: async () => body,
    })) as unknown as FetchLike;
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={fetchImpl}>
        <VaultCards />
      </ExplorerProvider>,
    );
    expect((await findByTestId("landing-vault-cards-freshness")).textContent).toBe(
      "Not indexed yet",
    );
  });
});
