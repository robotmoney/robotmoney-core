import { describe, expect, test } from "bun:test";
import { PublishError } from "../src/errors.ts";
import { assertFloors, delayFloor, plaintextSignerReason, MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "../src/floors.ts";
import { callerInputs, parseSheet } from "../src/sheet.ts";
import { sheetText } from "./fixtures.ts";

const sheetFor = (chain: number, extra: Record<string, string | null> = {}) => parseSheet(sheetText({ CHAIN_ID: String(chain), EXPECTED_CHAIN_ID: String(chain), ...extra }));
const base = (chain: number, extra: Record<string, string | null> = {}, o: Record<string, unknown> = {}) =>
  ({ rpcChainId: chain, sheet: sheetFor(chain, extra), caller: callerInputs({}), signerSpec: "keystore:/dev/shm/k/DEPLOYER", env: {}, environment: "mainnet", githubActions: false, ...o }) as Parameters<typeof assertFloors>[0];
const kind = (f: () => void): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind + ": " + (e as Error).message; } return undefined; };

describe("delay floor keyed to the chain id", () => {
  test("the floor is 172800 on 8453 and 1 elsewhere", () => {
    expect(delayFloor(MAINNET_CHAIN_ID)).toBe(172800);
    expect(delayFloor(TWIN_CHAIN_ID)).toBe(1);
    expect(delayFloor(31337)).toBe(1);
  });
  test("timelock delay 60 on chain 8453 is refused", () => {
    expect(kind(() => assertFloors(base(8453, { TIMELOCK_MIN_DELAY: "60" })))).toContain("FLOOR");
    expect(kind(() => assertFloors(base(8453, { TIMELOCK_MIN_DELAY: "172799" })))).toContain("172800");
  });
  test("timelock delay 172800 on chain 8453 is accepted", () => {
    expect(kind(() => assertFloors(base(8453, { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" })))).toBeUndefined();
  });
  test("timelock delay 60 on chain 918453 is accepted", () => {
    expect(kind(() => assertFloors(base(918453, { TIMELOCK_MIN_DELAY: "60" })))).toBeUndefined();
  });
  test("a short GOVERN_NEW_DELAY on 8453 is refused too", () => {
    expect(kind(() => assertFloors(base(8453, { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "3600" })))).toContain("GOVERN_NEW_DELAY");
  });
  test("there is no flag that lifts the floor on 8453", () => {
    // the sheet parser refuses the old switches, so no sheet can reach the floor check with one
    expect(() => parseSheet(sheetText({}, ["ALLOW_SHORT_TIMELOCK_DELAY=true"]))).toThrow(PublishError);
    expect(() => parseSheet(sheetText({}, ["REHEARSAL=1"]))).toThrow(PublishError);
  });
});

describe("YES and plaintext keys are keyed to the chain id", () => {
  const good = { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" };
  test("YES=1 on chain 8453 is refused", () => {
    expect(kind(() => assertFloors(base(8453, good, { caller: callerInputs({ YES: "1" }) })))).toContain("YES=1 is refused");
  });
  test("YES=1 on chain 918453 is accepted", () => {
    expect(kind(() => assertFloors(base(918453, {}, { caller: callerInputs({ YES: "1" }) })))).toBeUndefined();
  });
  test("a plaintext key is refused on 8453 in every form", () => {
    for (const spec of ["--private-key 0x01", "plaintext:KEY", "private-key", "0x" + "11".repeat(32), "keystore:/dev/shm/k:/dev/shm/pw"]) {
      expect(kind(() => assertFloors(base(8453, good, { signerSpec: spec })))).toContain("plaintext");
    }
    expect(kind(() => assertFloors(base(8453, good, { env: { PRIVATE_KEY: "x" } })))).toContain("PRIVATE_KEY");
    expect(kind(() => assertFloors(base(8453, good, { env: { ETH_PASSWORD: "x" } })))).toContain("ETH_PASSWORD");
  });
  test("an encrypted keystore, the engine hand-off and hardware wallets pass on 8453", () => {
    for (const spec of ["keystore:/home/me/.foundry/keystores/deployer", "env:signer", "ledger", "trezor"]) expect(kind(() => assertFloors(base(8453, good, { signerSpec: spec })))).toBeUndefined();
  });
  test("a rehearsal key file passes on 918453", () => {
    expect(kind(() => assertFloors(base(918453, {}, { signerSpec: "keystore:/dev/shm/k/DEPLOYER:/dev/shm/k/pw" })))).toBeUndefined();
  });
  test("measure is refused on 8453", () => {
    expect(kind(() => assertFloors(base(8453, good, { measure: true })))).toContain("--measure");
  });
  test("CONFIRM=environment needs GitHub Actions and an environment name on 8453", () => {
    const c = callerInputs({ CONFIRM: "environment" });
    expect(kind(() => assertFloors(base(8453, good, { caller: c })))).toContain("GitHub Actions");
    expect(kind(() => assertFloors(base(8453, good, { caller: c, githubActions: true, environment: "local" })))).toContain("--environment");
    expect(kind(() => assertFloors(base(8453, good, { caller: c, githubActions: true, environment: "mainnet" })))).toBeUndefined();
  });
  test("plaintextSignerReason is silent for a clean spec", () => {
    expect(plaintextSignerReason("ledger", {})).toBeUndefined();
  });
});
