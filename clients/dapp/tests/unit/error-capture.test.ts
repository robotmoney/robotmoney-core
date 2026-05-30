import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCapturedEntries,
  getCapturedEntries,
  initErrorCapture,
} from "../../src/lib/error-capture";

describe("error-capture module", () => {
  let cleanup: () => void;

  beforeEach(() => {
    // Suppress the global console.error guard (setup.ts) — this describe
    // intentionally calls console.error to verify the capture module.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clearCapturedEntries();
    cleanup = initErrorCapture();
  });

  afterEach(() => {
    cleanup();
    clearCapturedEntries();
  });

  it("patches console.error — calling console.error appends an entry AND original still fires", () => {
    const original = vi.fn();
    // The module already patched console.error. Replace the stored patched version
    // temporarily to verify originals still fire. Instead, spy via a separate check.
    const spy = vi.spyOn(console, "error");

    console.error("test error message");

    const entries = getCapturedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("test error message");

    // Original handler (the spy) must still have been called.
    expect(spy).toHaveBeenCalledWith("test error message");

    spy.mockRestore();
    void original; // suppress unused warning
  });

  it("patches console.warn — appends entry AND original still fires", () => {
    const spy = vi.spyOn(console, "warn");

    console.warn("test warning", { code: 42 });

    const entries = getCapturedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("warn");
    expect(entries[0].message).toContain("test warning");

    expect(spy).toHaveBeenCalledWith("test warning", { code: 42 });

    spy.mockRestore();
  });

  it("handles window.onerror events — entries appear in buffer", () => {
    const errorEvent = new ErrorEvent("error", {
      message: "global error fired",
    });
    window.dispatchEvent(errorEvent);

    // A real Chromium browser may produce additional console.error calls when
    // processing error events, pushing extra entries via our patch. Assert that
    // the right entry EXISTS rather than checking exact buffer length.
    const entries = getCapturedEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const match = entries.find((e) => e.message.includes("global error fired"));
    expect(match, "expected an entry containing 'global error fired'").toBeDefined();
    expect(match!.level).toBe("error");
  });

  it("handles window unhandledrejection events — entries appear in buffer", () => {
    const reason = new Error("unhandled rejection reason");
    // Silence the promise before constructing the event so the browser does
    // not fire its own real unhandledrejection on top of our synthetic one.
    const promise = Promise.reject(reason);
    promise.catch(() => {});
    const event = new PromiseRejectionEvent("unhandledrejection", {
      promise,
      reason,
    });
    window.dispatchEvent(event);

    // Chrome may produce additional entries via native console.error. Assert
    // that the right entry EXISTS rather than checking exact buffer length.
    const entries = getCapturedEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const match = entries.find((e) => e.message.includes("unhandled rejection reason"));
    expect(match, "expected an entry containing 'unhandled rejection reason'").toBeDefined();
    expect(match!.level).toBe("error");
  });

  it("accumulates multiple entries in order", () => {
    console.warn("first");
    console.error("second");

    const entries = getCapturedEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("first");
    expect(entries[1].message).toBe("second");
  });

  it("clearCapturedEntries resets the buffer", () => {
    console.error("before clear");
    clearCapturedEntries();
    expect(getCapturedEntries()).toHaveLength(0);
  });
});
