// The verifier ties rmAGENT's expected assets to the shortlist read from the core checkout's config/agent-token-shortlist.json, whatever the symbol
// (core issue 1903, ADR-0016: BNKR is the test asset while RM is parked). The label is 'lists exactly the shortlist asset of the config'.
import { describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { verifyDeployment } from "../../src/verify/index.ts";
import { buildWorld } from "./world.ts";

const LABEL = "vault[rmAGENT]: lists exactly the shortlist asset of the config";
const SHIPPED = join(import.meta.dir, "..", "..", "..", "config", "agent-token-shortlist.json");
const BNKR = "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b";

const run = async (mutate: (w: ReturnType<typeof buildWorld>) => void) => {
  const w = buildWorld(8453);
  mutate(w);
  return (await verifyDeployment(w.opts)).checks.find((c) => c.label === LABEL);
};

describe("the verifier ties rmAGENT's asset list to the config shortlist", () => {
  test("the shipped config lists BNKR: a sheet that lists BNKR passes", async () => {
    const r = await run((w) => {
      copyFileSync(SHIPPED, join(w.opts.coreDir!, "config", "agent-token-shortlist.json"));
      w.sheet.vaults.rmAGENT.assets = [{ ...w.sheet.vaults.rmAGENT.assets[0]!, token: BNKR }];
    });
    expect(r?.ok).toBe(true);
    expect(r?.detail).toContain(BNKR.toLowerCase());
  });
  test("the shipped config lists BNKR: a sheet that lists RM fails", async () => {
    const r = await run((w) => { copyFileSync(SHIPPED, join(w.opts.coreDir!, "config", "agent-token-shortlist.json")); });
    expect(r?.ok).toBe(false);
  });
  test("a core checkout without the config file fails the label, never passes it", async () => {
    const r = await run((w) => { copyFileSync(SHIPPED, join(w.opts.coreDir!, "config", "agent-token-shortlist.json")); w.opts.coreDir = join(w.opts.coreDir!, "no-such-dir"); });
    expect(r?.ok).toBe(false);
  });
});
