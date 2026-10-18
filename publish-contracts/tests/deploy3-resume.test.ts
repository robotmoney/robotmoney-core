// Deploy 3 on 8453 (2026-10-18): the libs and recorder stages landed, a load-balanced RPC answered the deployer nonce from a node behind the last block, and the
// stage stopped with a false COUNT_MISMATCH. Its --resume then lost the stage manifest: the simulation rewrote it at the current nonce, it was removed, and
// `forge script --resume` never runs the script again. The stub forge now resumes like real forge (no manifest on --resume).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT, world } from "./harness.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { STALE_READ_TRIES } from "../src/safe/read-after-write.ts";

const REH = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261018" };
const recorderJson = (w: ReturnType<typeof world>) => join(w.coreDir, "deployments", "918453", "recorder.json");
const runManifest = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const failed = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
const clearStale = (w: ReturnType<typeof world>) => { const s = w.state(); delete s.stale; writeFileSync(w.statePath, JSON.stringify(s)); };

describe("a deployer stage read back through a node behind the broadcast (Deploy 3)", () => {
  test("a stale nonce after the broadcast is read again until it shows the stage: no false COUNT_MISMATCH", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    w.cfg.staleNonceReads = { [SCRIPT.recorder!]: 2 };
    expect(await w.run(["--stage", "safe,libs,recorder"])).toBe(0);
    expect(runManifest(w).stages.recorder.status).toBe("done");
  });
  test("mutation: a nonce that never shows the stage within the bound is still COUNT_MISMATCH, naming the RPC, and the manifest the broadcast wrote stays", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    w.cfg.staleNonceReads = { [SCRIPT.recorder!]: 99 };
    expect(await w.run(["--stage", "safe,libs,recorder"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(String(failed(w)!.message)).toContain("never showed");
    expect(String(failed(w)!.message)).toContain(`after ${STALE_READ_TRIES} read(s)`);
    expect(existsSync(recorderJson(w))).toBe(true);
    expect(runManifest(w).stages.recorder.status).toBe("started");
  });
  test("--resume of a stage that landed keeps the manifest its own broadcast wrote and finishes the stage", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    w.cfg.staleNonceReads = { [SCRIPT.recorder!]: 99 };
    expect(await w.run(["--stage", "safe,libs,recorder"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    // mark the broadcast's manifest, so a rewrite by the resume's simulation (the addresses of the current nonce) would show
    const own = { ...JSON.parse(readFileSync(recorderJson(w), "utf8")), written_by: "the broadcast that landed" };
    writeFileSync(recorderJson(w), JSON.stringify(own));
    clearStale(w); delete w.cfg.staleNonceReads;
    expect(await w.run(["--stage", "recorder", "--resume"])).toBe(0);
    expect(JSON.parse(readFileSync(recorderJson(w), "utf8"))).toEqual(own);
    expect(runManifest(w).stages.recorder.status).toBe("done");
  });
});
