/**
 * Issue 1888: the dapp has no on-chain committee, vote or regime surface.
 * Receipts are recorded by the submitter Safe, the dapp only shows them.
 *
 * Positive counts guard against a glob that silently matches nothing.
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const paths = Object.keys(sources).filter((p) => !p.endsWith("abi.generated.ts"));

describe("committee, vote and regime surfaces are absent", () => {
  it("scans a non-empty source tree", () => {
    expect(paths.length).toBeGreaterThan(20);
  });

  it("has no committee, vote-submit or regime component or api module", () => {
    const banned = /(Committee|VoteSubmit|RegimeFeed|committeeApi)/;
    const hits = paths.filter((p) => banned.test(p.split("/").pop() ?? ""));
    expect(hits).toEqual([]);
  });

  it("imports none of the removed modules", () => {
    const re =
      /(CommitteePanel|CommitteeAccountLayer|VoteSubmitPreview|RegimeFeedPanel|committeeApi)/;
    const hits = paths.filter((p) => !p.includes("/tests/") && re.test(sources[p] ?? ""));
    expect(hits).toEqual([]);
  });

  it("renders no committee, vote or regime tab in the app shell", () => {
    const bootstrap = sources["../../src/bootstrap.tsx"] ?? "";
    expect(bootstrap).toContain('id: "consensus-receipts"');
    const labels = [...bootstrap.matchAll(/label: "([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) expect(l).not.toMatch(/committee|vote|regime/i);
  });

  it("keeps the human deposit and redeem routes and the receipt panel available", async () => {
    const router = await import("../../src/components/RouterDepositTab");
    const dw = await import("../../src/components/DepositWithdrawTab");
    const receipts = await import("../../src/components/ConsensusReceiptPanel");
    expect(typeof router.RouterDepositTab).toBe("function");
    expect(typeof dw.DepositWithdrawTab).toBe("function");
    expect(typeof receipts.ConsensusReceiptPanel).toBe("function");
    const admin = sources["../../src/components/buildAdminTabs.tsx"] ?? "";
    expect(admin).toContain('label: "Deposit & Withdraw"');
  });
});
