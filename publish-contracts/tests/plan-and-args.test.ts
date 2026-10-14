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

  test("--row update-delay, batch and cancel parse on both chains (issue 1727: whether 8453 accepts them depends on the sheet DEPLOYMENT_KIND, so runGovern refuses them in production, see rehearsal-govern.test.ts); the unpauses are accepted on both", () => {
    const base = (chain: string) => ["--chain", chain, "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    for (const row of ["update-delay", "batch", "cancel", "5", "6", "7"]) {
      expect(parseCli(["govern", ...base("8453"), "--row", row]).row).toBe(row);
      expect(parseCli(["govern", ...base("918453"), "--row", row]).row).toBe(row);
    }
    for (const row of ["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA", "1", "4"]) expect(parseCli(["govern", ...base("8453"), "--row", row]).row).toBe(row);
  });

  test("--row release-receipt is accepted on --chain 8453 and on 918453 (issue 1611), and still needs its receipt id", () => {
    const id = `0x${"ab".repeat(32)}`;
    const base = (chain: string) => ["--chain", chain, "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    for (const chain of ["8453", "918453"]) expect(parseCli(["govern", ...base(chain), "--row", "release-receipt", "--receipt-id", id]).row).toBe("release-receipt");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "release-receipt"])).toThrow("needs --receipt-id");
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

  test("--row apply-receipt takes --receipt-id and --payload on 8453 and 918453, and needs both (issue 1696)", () => {
    const id = `0x${"AB".repeat(32)}`;
    const base = (chain: string) => ["--chain", chain, "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    for (const chain of ["8453", "918453"]) expect(parseCli(["govern", ...base(chain), "--row", "apply-receipt", "--receipt-id", id, "--payload", "p.json"])).toMatchObject({ row: "apply-receipt", receiptId: id.toLowerCase(), payload: "p.json" });
    expect(() => parseCli(["govern", ...base("8453"), "--row", "apply-receipt", "--payload", "p.json"])).toThrow("needs --receipt-id");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "apply-receipt", "--receipt-id", id])).toThrow("needs --payload");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "apply-receipt", "--receipt-id", "0x12", "--payload", "p.json"])).toThrow("bytes32");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "release-receipt", "--receipt-id", id, "--payload", "p.json"])).toThrow("--payload goes with --row apply-receipt only");
    expect(() => parseCli(["govern", ...base("8453"), "--payload", "p.json"])).toThrow("--payload goes with --row apply-receipt only");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "unpause-PROTO", "--receipt-id", id])).toThrow("--row release-receipt only");
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

describe("--owner-signer grammar", () => {
  const base = ["--chain", "8453", "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
  const OWNER = `0x${"ab".repeat(20)}`;
  test("ledger:PATH@0xOWNER and trezor:PATH@0xOWNER are accepted, keystore specs pass through", () => {
    const specs = [`ledger:m/44'/60'/0'/0/0@${OWNER}`, `trezor:m/44'/60'/1'/0/0@${OWNER}`, "keystore:/k/a"];
    expect(parseCli([...base, ...specs.flatMap((s) => ["--owner-signer", s])]).ownerSigners).toEqual(specs);
  });
  test("malformed hardware owner specs are refused with USAGE", () => {
    for (const bad of ["ledger", "trezor", `ledger:m/44'/60'/0'/0/0`, `ledger:@${OWNER}`, `ledger:44/60@${OWNER}`, `ledger:m/44'/60'/0'/0/0@0x12`, `ledger:m/44'/60'/0'/0/0@${OWNER}x`]) {
      expect(() => parseCli([...base, "--owner-signer", bad])).toThrow("bad --owner-signer");
    }
  });
});

// QA plan v1 D7: the set-unwind-guard row takes its own --admin-arg keys, checked at parse time (before any signer or passphrase prompt), on 8453 and 918453.
describe("--row set-unwind-guard and its --admin-arg values (QA plan v1 D7)", () => {
  const base = (chain: string) => ["--chain", chain, "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
  const token = `0x${"7".repeat(40)}`;
  const args = ["--admin-arg", "vault=PROTO", "--admin-arg", `token=${token}`, "--admin-arg", "min-usdc-out=2000000", "--admin-arg", "max-loss-bps=500"];
  test("accepted on both chains; the values reach the parsed arguments", () => {
    for (const chain of ["8453", "918453"]) {
      expect(parseCli(["govern", ...base(chain), "--row", "set-unwind-guard", ...args])).toMatchObject({ row: "set-unwind-guard", adminArgs: { vault: "PROTO", token, "min-usdc-out": "2000000", "max-loss-bps": "500" } });
    }
    expect(parseCli(["govern", ...base("8453"), "--row", "set-unwind-guard", ...args, "--admin-arg", "override-allowed=false"]).adminArgs).toMatchObject({ "override-allowed": "false" });
  });
  test("refused with USAGE: no arguments, a self-administration key, rmUSDC, a zero floor; and the row's keys with any other row", () => {
    expect(() => parseCli(["govern", ...base("8453"), "--row", "set-unwind-guard"])).toThrow("vault=");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "set-unwind-guard", ...args, "--admin-arg", "threshold=2"])).toThrow("--admin-arg takes key=value with key vault");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "set-unwind-guard", ...args, "--admin-arg", "vault=USDC"])).toThrow("rmUSDC has no emergency unwind guard");
    expect(() => parseCli(["govern", ...base("8453"), "--row", "set-unwind-guard", ...args, "--admin-arg", "min-usdc-out=0"])).toThrow("min-usdc-out 0");
    expect(() => parseCli(["govern", ...base("918453"), "--row", "unpause-PROTO", ...args])).toThrow("--admin-arg goes with a self-administration row");
  });
});
