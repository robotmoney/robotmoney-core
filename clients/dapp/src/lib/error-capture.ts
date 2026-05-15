/**
 * Unified error-capture module.
 *
 * Patches console.error, console.warn, window.onerror, and
 * window.addEventListener('unhandledrejection') to capture a bounded
 * circular buffer of runtime diagnostics without swallowing the originals.
 *
 * Call `initErrorCapture()` once at application startup (before React renders).
 * Components read `getCapturedEntries()` or subscribe via `onCaptureUpdate()`.
 */

export type CaptureLevel = "warn" | "error";

export interface CaptureEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: CaptureLevel;
  readonly message: string;
  readonly stack?: string;
}

const MAX_ENTRIES = 100;

let nextId = 0;
const buffer: CaptureEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;

function push(level: CaptureLevel, message: string, stack?: string): void {
  const entry: CaptureEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    message,
    stack,
  };
  if (buffer.length >= MAX_ENTRIES) {
    buffer.shift();
  }
  buffer.push(entry);
  for (const listener of listeners) {
    listener();
  }
}

function formatValues(values: unknown[]): string {
  return values
    .map((v) => {
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    })
    .join(" ");
}

/**
 * Install the global patches. Safe to call multiple times — only installs once.
 * Returns a cleanup function that removes all patches (for test teardown).
 */
export function initErrorCapture(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...values: unknown[]) => {
    origError(...values);
    push("error", formatValues(values));
  };

  console.warn = (...values: unknown[]) => {
    origWarn(...values);
    push("warn", formatValues(values));
  };

  const handleError = (event: ErrorEvent) => {
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    push("error", event.message || String(event.error) || "window error", stack);
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const stack = reason instanceof Error ? reason.stack : undefined;
    const message =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : `Unhandled rejection: ${String(reason)}`;
    push("error", message, stack);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
  }

  return () => {
    console.error = origError;
    console.warn = origWarn;
    if (typeof window !== "undefined") {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    }
    installed = false;
  };
}

/** Return a snapshot of the current buffer (newest last). */
export function getCapturedEntries(): readonly CaptureEntry[] {
  return buffer.slice();
}

/** Subscribe to buffer changes. Returns an unsubscribe function. */
export function onCaptureUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clear the buffer (useful in tests). */
export function clearCapturedEntries(): void {
  buffer.length = 0;
  nextId = 0;
}
