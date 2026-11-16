/**
 * OPS-07 and FLOW-08: every deposit stop is shown with its cause, end and cancel deadline, with both guard
 * bands and keeper liveness. The component is pure over the two queue reads, so nothing is mocked.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "./helpers/render";
import { FlowQueueTerms } from "../../src/components/FlowQueueTerms";
import {
  formatBandBps,
  formatUnixUtc,
  resolveFlowTerms,
  type FlowLiveness,
  type FlowQuote,
} from "../../src/lib/flowQueueTerms";

const quote: FlowQuote = {
  feeBps: 10n,
  cancelCutoff: 1_800_000_000n,
  earliestSettle: 1_800_003_600n,
  holdEnds: 1_800_007_200n,
  refBandBps: 90,
  legBandBps: 100,
};
const live: FlowLiveness = {
  keeperConfigured: true,
  queuePausedNow: false,
  queuePausedUntil: 0n,
  depositsStoppedNow: false,
  windDownActive: false,
  cancelBuffer: 900,
  maxPause: 172_800,
};

describe("resolveFlowTerms", () => {
  it("a healthy queue has no stop and no warning", () => {
    const v = resolveFlowTerms(quote, live);
    expect(v.stops).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.cancelDeadline).toBe(1_800_000_000n);
    expect([v.refBandBps, v.legBandBps]).toEqual([90, 100]);
  });
  it("lists every stop, a pause with its end", () => {
    const v = resolveFlowTerms(quote, {
      ...live,
      queuePausedNow: true,
      queuePausedUntil: 1_800_050_000n,
      depositsStoppedNow: true,
      windDownActive: true,
    });
    expect(v.stops.map((s) => s.kind)).toEqual(["queue-paused", "deposits-stopped", "wind-down"]);
    expect(v.stops[0].endsAt).toBe(1_800_050_000n);
    expect(v.stops[1].endsAt).toBeNull();
  });
  it("a zero band is off and a missing keeper warns", () => {
    const v = resolveFlowTerms(
      { ...quote, refBandBps: 0, legBandBps: 0 },
      { ...live, keeperConfigured: false },
    );
    expect([v.refBandBps, v.legBandBps]).toEqual([null, null]);
    expect(v.warnings).toHaveLength(3);
  });
});

describe("formatting", () => {
  it("formats UTC time and bands", () => {
    expect(formatUnixUtc(1_800_000_000n)).toBe("2027-01-15 08:00 UTC");
    expect(formatUnixUtc(0n)).toBe("not set");
    expect(formatBandBps(90)).toBe("90 bps");
    expect(formatBandBps(null)).toBe("off");
  });
});

describe("FlowQueueTerms", () => {
  it("shows terms, bands, keeper and no stop when open", () => {
    render(<FlowQueueTerms quote={quote} liveness={live} />);
    expect(screen.getByTestId("flow-cancel-deadline").textContent).toContain(
      "2027-01-15 08:00 UTC",
    );
    expect(screen.getByTestId("flow-cancel-deadline").textContent).toContain("900s");
    expect(screen.getByTestId("flow-ref-band").textContent).toBe("90 bps");
    expect(screen.getByTestId("flow-leg-band").textContent).toBe("100 bps");
    expect(screen.getByTestId("flow-keeper").textContent).toBe("Configured");
    expect(screen.getByTestId("flow-fee").textContent).toBe("10 bps");
    expect(screen.getByTestId("flow-earliest-settlement").textContent).toBe("2027-01-15 09:00 UTC");
    expect(screen.getByTestId("flow-hold-ends").textContent).toBe("2027-01-15 10:00 UTC");
    expect(screen.getByText(/Matched flows and net trades/)).toBeTruthy();
    expect(screen.queryByTestId("flow-stop-queue-paused")).toBeNull();
  });
  it("shows each stop with its end and the cancel deadline", () => {
    render(
      <FlowQueueTerms
        quote={quote}
        liveness={{
          ...live,
          queuePausedNow: true,
          queuePausedUntil: 1_800_050_000n,
          depositsStoppedNow: true,
        }}
      />,
    );
    const paused = screen.getByTestId("flow-stop-queue-paused").textContent ?? "";
    expect(paused).toContain("Ends 2027-01-15 21:53 UTC");
    expect(paused).toContain("Cancel a locked deposit until 2027-01-15 08:00 UTC");
    expect(screen.getByTestId("flow-stop-deposits-stopped").textContent).toContain(
      "No end time is set",
    );
  });
  it("shows off bands and the keeper warning", () => {
    render(
      <FlowQueueTerms
        quote={{ ...quote, refBandBps: 0 }}
        liveness={{ ...live, keeperConfigured: false }}
      />,
    );
    expect(screen.getByTestId("flow-ref-band").textContent).toBe("off");
    expect(screen.getByTestId("flow-keeper").textContent).toBe("Not configured");
    expect(screen.getAllByTestId("flow-warning")).toHaveLength(2);
  });
});
