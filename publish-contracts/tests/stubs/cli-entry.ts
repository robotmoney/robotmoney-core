#!/usr/bin/env bun
// The CLI as a real child process, for core-harness-contract.test.ts. It is src/cli.ts main() with the same test doubles the other tests use
// (stub forge and cast on PATH, a fake Safe API, a fake signer, a fake timelock). The argument vector and the environment are the caller's:
// process.argv and process.env go to main() untouched, and stdout is the real stdout.
// Test doubles stand in for the TOOLS and the chain only. Nothing here proves a Safe, a signer set or governance (see the repo CLAUDE.md, item b).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import "../preload.ts"; // loads core's stage table before the harness module reads the stage list (imports run in order)
import { main } from "../../src/cli.ts";
import { parseSheet } from "../../src/sheet.ts";
import { fakeTimelock } from "../govern-world.ts";
import { world } from "../harness.ts";

const dir = process.env.CONTRACT_TEST_WORLD!;
const w = world({ dir, chainId: 918453 });
const sheet = parseSheet(readFileSync(join(dir, "sheet.env"), "utf8"));
const tl = fakeTimelock(sheet);
const OWNER_KEYS = ["SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"];
const LABELS = ["chain: id equals sheet", "manifest: vault.json present", "deployer: holds no role on any contract (log scan)"];

const deps = w.deps({
  env: process.env, cwd: process.cwd(), logSink: undefined, prompt: undefined,
  govern: { api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, maxWaitSeconds: 10_000 },
  ownerSigner: async (spec: string) => {
    const i = OWNER_KEYS.indexOf(basename(spec.split(":")[1] ?? ""));
    if (i < 0) throw new Error(`the owner signer ${spec} is not a SAFE_OWNER keystore`);
    return { kind: "keystore", modes: ["raw"], address: async () => sheet.safeOwners[i] } as never;
  },
  verify: { verifyDeployment: (async () => ({ ok: true, checks: LABELS.map((label) => ({ label, ok: true, detail: "" })) })) as never },
});
process.exit(await main(process.argv.slice(2), deps));
