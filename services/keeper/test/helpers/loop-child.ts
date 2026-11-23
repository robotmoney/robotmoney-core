// Child process for test/loop.test.ts: takes the state-dir lock (exit 2 when held), runs the real loop with real
// process signals and a one-hour wait, and exits 0 when the loop stops.
import { runLoop } from "../../src/loop.ts";
import { acquireLock, LockError } from "../../src/state.ts";

const dir = process.argv[2]!;
let release: () => void;
try {
  release = acquireLock(dir);
} catch (e) {
  process.exit(e instanceof LockError ? 2 : 1);
}
process.on("exit", () => release());
await runLoop({
  tick: async () => {
    queueMicrotask(() => process.stdout.write("waiting\n"));
    return { nextWaitSecs: 3600 };
  },
});
process.exit(0);
