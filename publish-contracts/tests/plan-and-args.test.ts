import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "../src/errors.ts";
import { parseCli, selectStages } from "../src/cli.ts";
import { STAGE_NAMES } from "../src/stages.ts";
import { SHA } from "./fixtures.ts";
import { world } from "./harness.ts";

async function planOf(w: ReturnType<typeof world>, extra: string[] = [], over: Record<string, unknown> = {}): Promise<{ code: number; out: any }> {
  const real = console.log;
  let captured = "";
  console.log = (s: string) => { captured += s; };
  try {
    const code = await w.run(["--stage", "plan", ...extra], over);
    return { code, out: captured ? JSON.parse(captured) : undefined };
  } finally { console.log = real; }
}

describe("rehearsal and production differ only in the arguments", () => {
  test("two invocations that differ only in chain, RPC, sheet, signer and environment give the same stage plan for the same DEPLOY_SHA", async () => {
    const twin = world({ chainId: 918453 });
    const main = world({ chainId: 8453 });
    const a = await planOf(twin, ["--environment", "rehearsal"]);
    const b = await planOf(main, ["--environment", "mainnet"], { signer: "ledger" });
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.out.plan.length).toBe(STAGE_NAMES.length);
    expect(a.out.plan).toEqual(b.out.plan);
    expect(a.out.coreSha).toBe(SHA);
    expect(a.out.chainId).not.toBe(b.out.chainId);
  });

  test("the plan job refuses a planted short delay on 8453 before any signer is involved", async () => {
    const w = world({ chainId: 8453, sheet: { TIMELOCK_MIN_DELAY: "60" } });
    expect((await planOf(w)).code).toBe(EXIT_CODES.FLOOR);
  });

  test("the plan job refuses a sheet CHAIN_ID that differs from the RPC", async () => {
    const w = world({ chainId: 918453, sheet: { CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453" } });
    expect((await planOf(w)).code).toBe(EXIT_CODES.CHAIN);
  });

  test("the plan job refuses a missing frozen file for the SHA", async () => {
    const w = world({ writeFrozen: false });
    expect((await planOf(w)).code).toBe(EXIT_CODES.COUNTS_MISSING);
  });

  test("a chain id other than 8453 and 918453 is not supported", async () => {
    const w = world({ chainId: 31337, sheet: { TIMELOCK_MIN_DELAY: "60" } });
    expect((await planOf(w)).code).toBe(EXIT_CODES.CHAIN);
  });

  test("the --call-* options need the govern verb, all three together, no --row, an address and hex calldata", () => {
    const base = ["--chain", "918453", "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    const c = ["--call-label", "x", "--call-target", `0x${"1".repeat(40)}`, "--call-data", "0xabcd"];
    expect(parseCli(["govern", ...base, ...c]).call).toEqual({ label: "x", target: `0x${"1".repeat(40)}`, data: "0xabcd" });
    expect(() => parseCli(["publish", ...base, ...c])).toThrow("govern verb only");
    expect(() => parseCli(["govern", ...base, ...c, "--row", "unpause-PROTO"])).toThrow("mutually exclusive");
    expect(() => parseCli(["govern", ...base, "--call-label", "x"])).toThrow("go together");
    expect(() => parseCli(["govern", ...base, "--call-label", "x", "--call-target", "0x12", "--call-data", "0xab"])).toThrow("address");
    expect(() => parseCli(["govern", ...base, "--call-label", "x", "--call-target", `0x${"1".repeat(40)}`, "--call-data", "abcd"])).toThrow("hex");
  });

  test("--row update-delay, batch and cancel are refused with USAGE on --chain 8453 and accepted on 918453; the unpauses are accepted on both", () => {
    const base = (chain: string) => ["--chain", chain, "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    for (const row of ["update-delay", "batch", "cancel", "4", "5", "6"]) {
      expect(() => parseCli(["govern", ...base("8453"), "--row", row])).toThrow("refused on chain 8453");
      expect(parseCli(["govern", ...base("918453"), "--row", row]).row).toBe(row);
    }
    for (const row of ["unpause-PROTO", "unpause-AGENT", "unpause-RWA", "1", "3"]) expect(parseCli(["govern", ...base("8453"), "--row", row]).row).toBe(row);
  });

  test("--row release-receipt is refused with USAGE on --chain 8453 (named error) and accepted on 918453 (issue 1579)", () => {
    const id = `0x${"ab".repeat(32)}`;
    const base = (chain: string) => ["--chain", chain, "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    expect(() => parseCli(["govern", ...base("8453"), "--row", "release-receipt", "--receipt-id", id])).toThrow("release-receipt is the on-demand receipt release: it runs on a Twin fork only and is refused on chain 8453");
    expect(parseCli(["govern", ...base("918453"), "--row", "release-receipt", "--receipt-id", id]).row).toBe("release-receipt");
  });

  test("--receipt-id goes with govern --row release-receipt only, and must be a bytes32", () => {
    const base = ["--chain", "918453", "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    const id = `0x${"AB".repeat(32)}`;
    expect(parseCli(["govern", ...base, "--row", "release-receipt", "--receipt-id", id])).toMatchObject({ row: "release-receipt", receiptId: id.toLowerCase() });
    expect(() => parseCli(["govern", ...base, "--row", "release-receipt"])).toThrow("needs --receipt-id");
    expect(() => parseCli(["govern", ...base, "--row", "unpause-PROTO", "--receipt-id", id])).toThrow("--row release-receipt only");
    expect(() => parseCli(["govern", ...base, "--receipt-id", id])).toThrow("--row release-receipt only");
    expect(() => parseCli(["govern", ...base, "--row", "release-receipt", "--receipt-id", "0x12"])).toThrow("bytes32");
    expect(() => parseCli(["publish", ...base, "--row", "release-receipt", "--receipt-id", id])).toThrow("govern verb");
  });

  test("the argument parser takes the documented flags and the aliases", () => {
    const base = ["--rpc", "http://x", "--sheet", "s", "--signer", "ledger", "--environment", "e"];
    const a = parseCli(["--chain", "8453", "--core-sha", SHA, ...base, "--resume", "--dry-run", "--stage", "libs"]);
    expect(a).toMatchObject({ chain: 8453, coreSha: SHA, resume: true, dryRun: true, stage: "libs", environment: "e" });
    const b = parseCli(["--chain-id", "918453", "--deploy-sha", SHA, ...base]);
    expect(b.chain).toBe(918453);
    expect(() => parseCli(["--chain", "8453", ...base])).toThrow("core-sha");
    expect(() => parseCli(["--chain", "8453", "--core-sha", "short", ...base])).toThrow("40 lowercase hex");
    expect(() => parseCli(["--chain", "8453", "--core-sha", SHA, "--rpc", "file:///x", "--sheet", "s", "--signer", "ledger"])).toThrow("http");
    expect(() => parseCli(["--chain", "8453", "--core-sha", SHA, "--sheet", "s", "--rpc", "http://x"])).toThrow("signer");
    expect(() => parseCli(["--private-key", "0x01", "--chain", "8453"])).toThrow();
  });

  test("stage selection: default runs through verify, deploy through timelock, all includes govern", () => {
    expect(selectStages(undefined).at(-1)).toBe("verify");
    expect(selectStages("deploy").at(-1)).toBe("timelock");
    expect(selectStages("all")).toEqual(STAGE_NAMES);
    expect(selectStages("libs,vault")).toEqual(["libs", "vault"]);
    expect(() => selectStages("bogus")).toThrow("unknown stage");
  });
});
