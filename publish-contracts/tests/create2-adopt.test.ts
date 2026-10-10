// Adoption of the CREATE2 libraries forge deploys by itself inside the basket stages (issue 1721): BasketAssetConfigGuard, TwapTickMath and BasketViews
// (BasketViews links TwapTickMath). When they already sit on chain forge leaves their creations out, so the stage plans fewer transactions than its frozen count.
import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { buildCreate2Libraries, predictedLibraryAddress } from "../src/libs-adopt.ts";
import { getStageTable } from "../src/stages.ts";
import { COUNTS, SHA } from "./fixtures.ts";
import { SCRIPT, world, type World } from "./harness.ts";

const OUT = join(import.meta.dir, "fixtures", "build-out");
const BUILT = buildCreate2Libraries(getStageTable().create2Libraries!, OUT);
const GUARD = BUILT.get("BasketAssetConfigGuard")!, TWAP = BUILT.get("TwapTickMath")!, VIEWS = BUILT.get("BasketViews")!;
const THREE = [GUARD, TWAP, VIEWS];
const A = "0x000000000000000000000000000000000000a001";
const tickArt = JSON.parse(readFileSync(join(OUT, "TickMath.sol", "TickMath.json"), "utf8"));
const TICK = predictedLibraryAddress(tickArt.bytecode.object);
const manifest = (w: World) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const lastError = (w: World) => w.logs().filter((l) => l.event === "run.failed").pop();
const forgeScripts = (w: World) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcastsOf = (w: World, file: string) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast") && c.args[1].includes(file));
const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);

/** A world with the build output in the core checkout. `have`: the create2 libraries already on chain with the right code. `plan`: the ones the proto simulation still plans to create. */
function proWorld(o: { have?: typeof THREE; plan?: typeof THREE; code?: Record<string, string>; startNonce?: number; writeFrozen?: boolean; libsAdopted?: boolean } = {}): World {
  const w = world({ startNonce: o.startNonce ?? 0, writeFrozen: o.writeFrozen });
  cpSync(OUT, join(w.coreDir, "out"), { recursive: true });
  const have = o.have ?? [], plan = o.plan ?? [];
  w.cfg.counts[SCRIPT.proto] = COUNTS.proto! - have.length;
  const codeAt: Record<string, string> = {};
  for (const b of have) codeAt[b.address.toLowerCase()] = b.runtime;
  Object.assign(w.cfg, { codeAt: { ...codeAt, ...(o.code ?? {}) }, creates: { [SCRIPT.proto]: plan.map((b) => b.address.toLowerCase()) } });
  if (o.libsAdopted) Object.assign(w.cfg, { zeroTx: SCRIPT.libs, libsAddress: TICK, codeAt: { ...w.cfg.codeAt, [TICK.toLowerCase()]: `0x73${TICK.slice(2).toLowerCase()}${tickArt.deployedBytecode.object.slice(44)}` } });
  return w;
}

describe("the create2 libraries of the table and their addresses", () => {
  test("the table lists the three libraries of the basket stages and no other stage lists any", () => {
    const t = getStageTable();
    expect(t.create2Libraries!.map((l) => l.artifact)).toEqual(["BasketAssetConfigGuard", "TwapTickMath", "BasketViews"]);
    expect(t.stages.filter((s) => s.create2Libraries?.length).map((s) => s.name)).toEqual(["proto", "agent", "rwa"]);
  });
  test("the resolved addresses are the ones forge deploys to on Base (the 8453 broadcast of the proto stage)", () => {
    expect(GUARD.address.toLowerCase()).toBe("0xb026a232f54d381a47a9e2640d04084830f0ae58");
    expect(TWAP.address.toLowerCase()).toBe("0x7fdc1e387486c81f97a2379ce897b202d4e815e2");
    expect(VIEWS.address.toLowerCase()).toBe("0xe0a16a5b9a4edd2e0723b74f593c1053f8cbe6ba");
  });
  test("BasketViews links TwapTickMath: its runtime code carries TwapTickMath's address, and changing that address changes its own address", () => {
    expect(VIEWS.runtime.toLowerCase()).toContain(TWAP.address.slice(2).toLowerCase());
    const art = getStageTable().create2Libraries!;
    const moved = buildCreate2Libraries(art, OUT);
    expect(moved.get("BasketViews")!.address).toBe(VIEWS.address);
    expect(VIEWS.runtimeHash).toBe(keccak256(VIEWS.runtime));
  });
  test("a library that links one the table does not list fails closed", () => {
    const only = getStageTable().create2Libraries!.filter((l) => l.artifact === "BasketViews");
    expect(() => buildCreate2Libraries(only, OUT)).toThrow("create2Libraries");
  });
});

describe("a fresh run: the first basket stage creates the libraries itself", () => {
  test("nothing is adopted: the libraries it created are recorded, the later basket stages do not adopt them, the nonce is the plain frozen sum", async () => {
    const w = proWorld({ plan: THREE });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const m = manifest(w);
    expect(m.stages.proto.created).toEqual(THREE.map((b) => b.address.toLowerCase()));
    for (const s of ["libs", "proto", "agent", "rwa"]) expect(m.stages[s].adopted).toBeUndefined();
    expect(w.state().nonces[A]).toBe(sum + PROOF_TX_NONCES);
  });
});

describe("a fresh measuring run", () => {
  test("adopts nothing: the libraries the first basket stage created are not adopted by the later basket stages, and the counts file is unmarked", async () => {
    const w = proWorld({ plan: THREE, writeFrozen: false });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    for (const s of ["proto", "agent", "rwa"]) expect(manifest(w).stages[s].adopted).toBeUndefined();
    const f = JSON.parse(readFileSync(join(w.countsDir, `${SHA}.json`), "utf8"));
    expect(f.measured.adopted).toBeUndefined();
  });
});

describe("a run where the libraries already exist", () => {
  test("all three adopted: proto sends the frozen count less three, records the libraries, the nonce follows, agent and rwa are untouched", async () => {
    const w = proWorld({ have: THREE });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(lastError(w)).toBeUndefined();
    const p = manifest(w).stages.proto;
    expect(p).toMatchObject({ status: "done", adopted: true, count: COUNTS.proto, dryRunCount: COUNTS.proto! - 3, broadcastCount: COUNTS.proto! - 3 });
    expect(p.adoption.deployerTxs).toBe(COUNTS.proto! - 3);
    expect(p.adoption.libraries.map((l: any) => [l.name, l.address.toLowerCase(), l.codeHash])).toEqual(THREE.map((b) => [b.name, b.address.toLowerCase(), b.runtimeHash]));
    for (const s of ["agent", "rwa"]) expect(manifest(w).stages[s].adopted).toBeUndefined();
    expect(w.state().nonces[A]).toBe(sum - 3 + PROOF_TX_NONCES);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.summed_frozen_counts === sum - 3)).toBe(true);
  });

  test("the later stages start where the adopted stage left off (the adopted stage contributes what it sent)", async () => {
    const w = proWorld({ have: THREE });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const m = manifest(w);
    expect(m.stages.agent.startNonce).toBe(m.stages.proto.startNonce + COUNTS.proto! - 3);
  });

  test("partial: two exist, one is still planned: the stage adopts exactly two", async () => {
    const w = proWorld({ have: [GUARD, TWAP], plan: [VIEWS] });
    w.cfg.counts[SCRIPT.proto] = COUNTS.proto! - 2;
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const p = manifest(w).stages.proto;
    expect(p.adoption.libraries.map((l: any) => l.name)).toEqual(["BasketAssetConfigGuard", "TwapTickMath"]);
    expect(p.adoption.deployerTxs).toBe(COUNTS.proto! - 2);
    expect(w.state().nonces[A]).toBe(sum - 2 + PROOF_TX_NONCES);
  });

  test("all four: TickMath in libs and the three in proto, one full run, the nonce is the frozen sum less libs less three plus the proof", async () => {
    const w = proWorld({ have: THREE, libsAdopted: true });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(lastError(w)).toBeUndefined();
    expect(manifest(w).stages.libs.adopted).toBe(true);
    expect(manifest(w).stages.proto.adopted).toBe(true);
    expect(w.state().nonces[A]).toBe(sum - COUNTS.libs! - 3 + PROOF_TX_NONCES);
    expect(broadcastsOf(w, SCRIPT.libs)).toEqual([]);
  });

  test("a stray extra deployer transaction after an adopted stage is still detected", async () => {
    const w = proWorld({ have: THREE });
    w.cfg.sent = { [SCRIPT.timelock]: COUNTS.timelock! + 1 };
    expect(await w.run(["--stage", "deploy"])).not.toBe(0);
    expect(["COUNT_MISMATCH", "NONCE"]).toContain(lastError(w)?.kind);
  });

  test("an adopted stage whose broadcast sends more than it planned is a COUNT_MISMATCH", async () => {
    const w = proWorld({ have: THREE });
    w.cfg.sent = { [SCRIPT.proto]: COUNTS.proto! - 2 };
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
  });

  test("the code at an adopted address is not the build's: LIBS_ADOPTION, nothing broadcast for the stage", async () => {
    const w = proWorld({ have: THREE, code: { [TWAP.address.toLowerCase()]: TWAP.runtime.slice(0, -2) + (TWAP.runtime.endsWith("00") ? "01" : "00") } });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w)?.message).toContain("TwapTickMath");
    expect(broadcastsOf(w, SCRIPT.proto)).toEqual([]);
  });

  test("BasketViews code built against another TwapTickMath address is refused (the link is part of the hash)", async () => {
    const other = VIEWS.runtime.toLowerCase().split(TWAP.address.slice(2).toLowerCase()).join("00".repeat(19) + "01");
    const w = proWorld({ have: THREE, code: { [VIEWS.address.toLowerCase()]: other } });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
  });

  test("a library the simulation leaves out that has no code on chain is refused: the stage planned fewer transactions for a reason nothing explains", async () => {
    const w = proWorld({ have: [GUARD, TWAP], code: { [VIEWS.address.toLowerCase()]: "0x" } });
    w.cfg.counts[SCRIPT.proto] = COUNTS.proto! - 3; // three fewer, but BasketViews is neither planned nor on chain
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w)?.message).toContain("NO code");
  });

  test("fewer transactions than the adopted libraries explain is COUNT_MISMATCH", async () => {
    const w = proWorld({ have: THREE });
    w.cfg.counts[SCRIPT.proto] = COUNTS.proto! - 5;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(broadcastsOf(w, SCRIPT.proto)).toEqual([]);
  });

  test("a stage that lists no create2 library and plans fewer transactions still fails, libraries on chain or not", async () => {
    const w = proWorld({ have: THREE });
    w.cfg.counts[SCRIPT.registry] = COUNTS.registry! - 1;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
  });

  test("a basket stage that plans fewer transactions with every library planned (nothing absent) is the plain COUNT_MISMATCH", async () => {
    const w = proWorld({ plan: THREE });
    w.cfg.counts[SCRIPT.proto] = COUNTS.proto! - 1;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
  });

  test("a measuring run adopts, measures the reduced count and MARKS the counts file; nothing loads it as frozen", async () => {
    const w = proWorld({ have: THREE, writeFrozen: false });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const f = JSON.parse(readFileSync(join(w.countsDir, `${SHA}.json`), "utf8"));
    expect(f.counts.proto).toBe(COUNTS.proto! - 3);
    expect(f.measured.adopted).toEqual(["proto"]);
  });

  test("a dry run adopts too and sends nothing to the target", async () => {
    const w = proWorld({ have: THREE });
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    expect(w.logs().some((l) => l.event === "stage.simulated" && l.stage === "proto" && Array.isArray(l.adopted_create2) && l.adopted_create2.length === 3)).toBe(true);
  });

  test("a measuring dry run adopts in the first basket stage only: the later basket stages see the libraries as already accounted for", async () => {
    const w = proWorld({ have: THREE, writeFrozen: false });
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    const sim = w.logs().filter((l) => l.event === "stage.simulated" && ["proto", "agent", "rwa"].includes(l.stage));
    expect(sim.map((l) => [l.stage, l.adopted_create2?.length ?? 0])).toEqual([["proto", 3], ["agent", 0], ["rwa", 0]]);
  });

  test("with no build output nothing is adopted and a short count is the plain COUNT_MISMATCH", async () => {
    const w = proWorld({ have: THREE });
    require("node:fs").rmSync(join(w.coreDir, "out"), { recursive: true, force: true });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.COUNT_MISMATCH);
  });
});
