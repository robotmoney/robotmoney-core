// Issue 1727: the verifier reads the deployment kind. A production verify refuses a timelock below 172800 s, a rehearsal verify refuses 172800 s and above, and below 900 s.
// The deployer nonce of a rehearsal is counted from the start nonce the run manifest recorded.
import { describe, expect, test } from "bun:test";
import { PROOF_TX_NONCES } from "../../src/counts.ts";
import { verifyDeployment } from "../../src/verify/index.ts";
import { DEPLOYER, TIMELOCK, buildWorld, failed } from "./world.ts";

const KIND_LABEL = "deployment kind: the timelock delay agrees with the kind";
const rehearsal = (delay: number) => { const w = buildWorld(8453); w.chain.set(TIMELOCK, "getMinDelay", BigInt(delay)); w.sheet.timelockDelay = delay; w.sheet.deploymentKind = "rehearsal"; w.opts.deployerStartNonce = 0; return w; };

describe("the verifier by deployment kind on 8453", () => {
  test("a rehearsal at 900 s passes, and so does a rehearsal one second below the production floor", async () => {
    expect(failed(await verifyDeployment(rehearsal(900).opts))).toEqual([]);
    expect(failed(await verifyDeployment(rehearsal(172799).opts))).toEqual([]);
  });
  test("a rehearsal verify against 172800 s fails the kind label (the chain cannot tell it from production)", async () => {
    expect(failed(await verifyDeployment(rehearsal(172800).opts))).toEqual([KIND_LABEL]);
  });
  test("a rehearsal verify against 899 s fails both the floor and the kind label", async () => {
    expect(failed(await verifyDeployment(rehearsal(899).opts))).toEqual(["timelock: min delay at least chain floor", KIND_LABEL]);
  });
  test("a production verify (the default, no kind) against 900 s fails; against 172800 s it passes", async () => {
    const w = buildWorld(8453);
    w.chain.set(TIMELOCK, "getMinDelay", 900n); w.sheet.timelockDelay = 900;
    expect(failed(await verifyDeployment(w.opts))).toEqual(["timelock: min delay at least chain floor", KIND_LABEL]);
    expect(failed(await verifyDeployment(buildWorld(8453).opts))).toEqual([]);
  });
  test("the failing label detail names the kind and the delay", async () => {
    const r = await verifyDeployment(rehearsal(172800).opts);
    expect(r.checks.find((c) => c.label === KIND_LABEL)!.detail).toContain("[rehearsal 172800s]");
  });
});

describe("the deployer nonce of a rehearsal is relative to the recorded start", () => {
  const NONCE_LABEL = "deployer: nonce equals sum of frozen counts";
  const sum = (w: ReturnType<typeof buildWorld>) => Object.values(w.opts.frozenCounts).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES;
  test("start 118: the live nonce 118 + sum passes, the absolute sum fails, a stray fails", async () => {
    const w = rehearsal(900);
    w.opts.deployerStartNonce = 118;
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), sum(w) + 118);
    expect(failed(await verifyDeployment(w.opts))).toEqual([]);
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), sum(w));
    expect(failed(await verifyDeployment(w.opts))).toEqual([NONCE_LABEL]);
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), sum(w) + 119);
    expect(failed(await verifyDeployment(w.opts))).toEqual([NONCE_LABEL]);
  });
  test("a rehearsal without a recorded start fails the nonce label; production ignores any start", async () => {
    const w = rehearsal(900);
    w.opts.deployerStartNonce = undefined;
    expect(failed(await verifyDeployment(w.opts))).toEqual([NONCE_LABEL]);
    const p = buildWorld(8453);
    p.opts.deployerStartNonce = 118;
    expect(failed(await verifyDeployment(p.opts))).toEqual([]); // production counts from 0 whatever else is passed
  });
});
