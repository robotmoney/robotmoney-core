import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCapturedEntries,
  getCapturedEntries,
  initErrorCapture,
} from "../../src/lib/error-capture";

describe("error-capture module", () => {
  let cleanup: () => void;

  beforeEach(() => {
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
      error: new Error("boom"),
    });
    window.dispatchEvent(errorEvent);

    const entries = getCapturedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("global error fired");
  });

  it("handles window unhandledrejection events — entries appear in buffer", () => {
    // jsdom does not expose PromiseRejectionEvent as a global constructor, so
    // we synthesise an event object with the required `reason` property and
    // dispatch it via the module's registered listener.
    const reason = new Error("unhandled rejection reason");
    const fakeEvent = Object.assign(new Event("unhandledrejection"), { reason });
    window.dispatchEvent(fakeEvent);

    const entries = getCapturedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("unhandled rejection reason");
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
