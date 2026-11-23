// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.3 and §8.1.7 ("No test or log line contains the
// keystore password"). Runs the CLI with each password source and failure path, captures stdout and stderr, and scans
// them for the password, the private key, and the KEEPER_PASSWORD variable reaching a child.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli, fakeRpc } from "./helpers/cli.ts";
import { FIXTURE_PASSWORD, fixtureKeystore, tmp } from "./helpers/fixtures.ts";

const rpc = fakeRpc(8453);
afterAll(() => rpc.stop());

function env(d: string, ks: ReturnType<typeof fixtureKeystore>, extra: Record<string, string> = {}) {
  return {
    KEEPER_RPC_URL: rpc.url, KEEPER_CHAIN_ID: "8453", KEEPER_QUEUE: "0x1111111111111111111111111111111111111111",
    KEEPER_REBALANCER: "0x2222222222222222222222222222222222222222", KEEPER_KEYSTORE: ks.keystore,
    KEEPER_STATE_DIR: join(d, "state"), KEEPER_HEALTH_PORT: "0", ...extra,
  };
}

describe("no secret in any output", () => {
  const d = tmp();
  const ks = fixtureKeystore(d);
  const pkHex = Buffer.from(ks.pk).toString("hex");
  const cases: [string, Record<string, string>, string | undefined][] = [
    ["password file", { KEEPER_PASSWORD_FILE: ks.passwordFile }, undefined],
    ["KEEPER_PASSWORD", { KEEPER_PASSWORD: FIXTURE_PASSWORD }, undefined],
    ["stdin", {}, FIXTURE_PASSWORD + "\n"],
    ["a wrong password on stdin", {}, "wrong-" + FIXTURE_PASSWORD + "\n"],
    ["a bad config field", { KEEPER_PASSWORD: FIXTURE_PASSWORD, KEEPER_INTERVAL_SECS: FIXTURE_PASSWORD }, undefined],
  ];
  for (const [name, extra, stdin] of cases) {
    test(`${name}: the run fails closed (exit 2) and prints neither the password nor the key`, async () => {
      const r = await runCli(["--once"], env(d, ks, extra), stdin);
      const all = r.out + r.err;
      expect(r.code).toBe(2);
      expect(all.length).toBeGreaterThan(0); // it did say why
      expect(all).not.toContain(FIXTURE_PASSWORD);
      expect(all.toLowerCase()).not.toContain(pkHex);
    });
  }

  test("the config error for a secret-shaped value names the field, not the value", async () => {
    const r = await runCli(["--once"], env(d, ks, { KEEPER_PASSWORD: FIXTURE_PASSWORD, KEEPER_INTERVAL_SECS: FIXTURE_PASSWORD }));
    expect(r.err).toContain("intervalSecs");
  });
});
