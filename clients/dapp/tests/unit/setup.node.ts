import { afterEach, beforeEach, vi } from "vitest";

// console.error guard for node-environment tests (env-example-warning, faucet-shared-amount).
// Same rule as the browser project: any unexpected console.error fails the test.
const _capturedErrors: string[] = [];

beforeEach(() => {
  _capturedErrors.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    _capturedErrors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (_capturedErrors.length > 0) {
    const lines = _capturedErrors.splice(0);
    throw new Error(
      `Unexpected console.error in unit test (${lines.length}):\n${lines.join("\n")}`,
    );
  }
});
