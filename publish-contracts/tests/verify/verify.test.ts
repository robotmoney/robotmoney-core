import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { PROOF_TX_NONCES } from "../../src/counts.ts";
import { getStageTable } from "../../src/stages.ts";
import { verifyDeployment } from "../../src/verify/index.ts";
import { keccak256, toHex } from "viem";
import { padTopic } from "../../src/verify/logs.ts";
import { ADMIN_ROLE, EMERGENCY_ROLE, SAFE_GUARD_SLOT, WEIGHT_SETTER_ROLE, stageManifestFile, SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP } from "../../src/verify/constants.ts";
import { USDC_ADDRESS, USDC_PROXY_CODE_HASH } from "../../src/usdc.ts";
import { LABELS_TXT, rewriteLabelsTxt, verifySection } from "./labels-file.ts";
import { buildWorld, failed, addr, DEPLOYER, SAFE, SEED_SHARES, VAULTS, REGISTRY, TIMELOCK, GATEWAY, OWNERS, ROUTER, GOV, REC, type World } from "./world.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "expected-labels.json");

describe("healthy deployment", () => {
  test("passes with every check green", async () => {
    const w = buildWorld();
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("labels are unique and carry no address or number", async () => {
    const r = await verifyDeployment(buildWorld().opts);
    const labels = r.checks.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) { expect(l).not.toMatch(/0x[0-9a-f]{4}/i); expect(l.replace(/GS\d+/g, "").replace("maxSlippageBps equals 500", "")).not.toMatch(/\d{3,}/); }
  });
});

describe("the deploy authorizes no agent (core 1527)", () => {
  test("agents: no agent authorized at handover is ok with zero gateway agent logs, and the manifest and role checks are ok", async () => {
    const r = await verifyDeployment(buildWorld().opts);
    for (const l of ["agents: no agent authorized at handover", "agents: manifest lists zero agents", "agents: no address holds AGENT_ROLE after handover", "agents: manifest says deployer owns no listed agent"]) {
      expect(r.checks.find((c) => c.label === l)?.ok, l).toBe(true);
    }
  });
  test("one AgentAuthorized log on the gateway fails it, as does one AgentOwnershipTransferred log", async () => {
    for (const sig of [SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP]) {
      const w = buildWorld();
      w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(sig)), padTopic(OWNERS[0]!), padTopic(DEPLOYER)], data: "0x", blockNumber: 300n });
      expect(failed(await verifyDeployment(w.opts))).toEqual(["agents: no agent authorized at handover"]);
    }
  });
});

describe("agents the depositors authorize after the handover are theirs (core 1527)", () => {
  const log = (block: bigint) => ({ address: GATEWAY, topics: [keccak256(toHex(SIG_AGENT_AUTHORIZED)), padTopic(OWNERS[0]!), padTopic(OWNERS[1]!)], data: "0x" as const, blockNumber: block });
  test("an AgentAuthorized log after the handover block passes, one at or before it fails", async () => {
    const after = buildWorld();
    after.chain.logs.push(log(4000n));
    after.opts.handoverBlock = 3000n;
    expect(failed(await verifyDeployment(after.opts))).toEqual([]);
    const before = buildWorld();
    before.chain.logs.push(log(3000n));
    before.opts.handoverBlock = 3000n;
    expect(failed(await verifyDeployment(before.opts))).toEqual(["agents: no agent authorized at handover"]);
  });
});

describe("a receipt the Safe applied through the timelock (issue 1696)", () => {
  const LABEL = "receipt: applied receipt is released and its weights are on the router";
  const RID = `0x${"ab".repeat(32)}` as `0x${string}`;
  const vaults = () => Object.values(VAULTS).map((v) => v.address);
  const BPS = [4000, 3000, 2000, 1000];
  /** The router holds the applied vector and the receipt reads released. */
  const applied = (over: { released?: boolean; routerBps?: number[] } = {}) => {
    const w = buildWorld();
    w.opts.appliedReceipt = { receiptId: RID, vaults: vaults(), bps: BPS };
    w.chain.set(REC, "isReleased", () => over.released ?? true);
    w.chain.set(ROUTER, "getDefaultWeights", [vaults(), (over.routerBps ?? BPS).map((x) => BigInt(x))]);
    return w;
  };
  test("no application: the label is present and passes, and the sheet vector is still required", async () => {
    const ok = await verifyDeployment(buildWorld().opts);
    expect(ok.checks.find((c) => c.label === LABEL)).toMatchObject({ ok: true });
    const w = buildWorld();
    w.chain.set(ROUTER, "getDefaultWeights", [vaults(), BPS.map((x) => BigInt(x))]);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["router: default weights equal sheet"]);
  });
  test("applied, released and on the router: every check passes, the sheet vector having been superseded", async () => {
    const r = await verifyDeployment(applied().opts);
    expect(failed(r)).toEqual([]);
    expect(r.checks.find((c) => c.label === LABEL)).toMatchObject({ ok: true });
    expect(r.checks.find((c) => c.label === LABEL)!.detail).toContain(RID);
  });
  test("applied but the receipt reads not released fails the label", async () => {
    expect(failed(await verifyDeployment(applied({ released: false }).opts))).toEqual([LABEL]);
  });
  test("applied but the router holds another vector fails the label and the weights label", async () => {
    expect(failed(await verifyDeployment(applied({ routerBps: [5000, 3000, 2000, 0] }).opts)).sort()).toEqual([LABEL, "router: default weights equal sheet"].sort());
  });
});

describe("label drift", () => {
  test("Twin chain label set equals mainnet label set equals the committed fixture", async () => {
    const main = (await verifyDeployment(buildWorld(8453).opts)).checks.map((c) => c.label);
    const twin = (await verifyDeployment(buildWorld(918453).opts)).checks.map((c) => c.label);
    expect(twin).toEqual(main);
    if (process.env.UPDATE_LABELS === "1") {
      writeFileSync(FIXTURE, JSON.stringify(main, null, 2) + "\n");
      rewriteLabelsTxt(main);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as string[];
    expect(main.filter((l) => !expected.includes(l))).toEqual([]);
    expect(expected.filter((l) => !main.includes(l))).toEqual([]);
    expect(main).toEqual(expected);
    // verifier-labels.txt is the second committed copy (core 1604): its [verify] section must be the same list, in the same order.
    expect(verifySection(readFileSync(LABELS_TXT, "utf8"))).toEqual(main);
  });

  test("a Twin chain run with a short delay passes while the same delay fails on 8453", async () => {
    const twin = buildWorld(918453);
    expect((await verifyDeployment(twin.opts)).ok).toBe(true);
    const main = buildWorld(8453);
    main.chain.set(TIMELOCK, "getMinDelay", 60n);
    main.sheet.timelockDelay = 60;
    expect(failed(await verifyDeployment(main.opts))).toEqual(["timelock: min delay at least chain floor", "deployment kind: the timelock delay agrees with the kind"]);
  });
});

describe("mutations fail with the expected label", () => {
  test("deployer holds ADMIN on a vault", async () => {
    const w = buildWorld();
    w.chain.grant(VAULTS.rmPROTO.address, ADMIN_ROLE, DEPLOYER);
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("vault[rmPROTO]: ADMIN_ROLE not held by deployer");
    expect(f).not.toContain("vault[rmUSDC]: ADMIN_ROLE not held by deployer");
  });

  test("deployer holds a role the manifests do not name (log scan)", async () => {
    const w = buildWorld();
    const stray = addr(0x5712a7);
    w.chain.roleGrantedLog(stray, ADMIN_ROLE, DEPLOYER, 900n);
    w.chain.grant(stray, ADMIN_ROLE, DEPLOYER);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["deployer: holds no role on any contract (log scan)"]);
  });

  test("threshold-1 Safe", async () => {
    const w = buildWorld();
    w.chain.threshold = 1;
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("safe: threshold equals sheet");
    expect(f).toContain("safe: threshold at least 2");
  });

  test("Safe owners differ from the sheet", async () => {
    const w = buildWorld();
    w.chain.owners = [OWNERS[0], OWNERS[1], addr(0xbad)];
    expect(failed(await verifyDeployment(w.opts))).toContain("safe: owners equal sheet");
  });

  test("Safe has a module and a guard", async () => {
    const w = buildWorld();
    w.chain.modules = [addr(0x30d)];
    w.chain.storage.set(`${SAFE.toLowerCase()}|${SAFE_GUARD_SLOT}`, ("0x" + "0".repeat(60) + "beef") as `0x${string}`);
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("safe: no module enabled");
    expect(f).toContain("safe: no guard set");
  });

  test("missing vault: manifest lists a vault the registry does not", async () => {
    const w = buildWorld();
    w.chain.set(REGISTRY, "listVaults", Object.values(VAULTS).slice(0, 3).map((v) => v.address));
    w.chain.set(REGISTRY, "vaultCount", 3n);
    expect(failed(await verifyDeployment(w.opts))).toContain("vault set: manifests equal registry.listVaults");
  });

  test("a vault manifest named by the core table is missing: the run fails on it and reads nothing else", async () => {
    const w = buildWorld();
    const rwa = getStageTable().vaults.find((v) => v.key === "RWA")!;
    rmSync(join(w.manifestDir, basename(rwa.manifest)));
    expect(failed(await verifyDeployment(w.opts))).toEqual([`manifest: ${basename(rwa.manifest)} present`]);
  });

  test("a manifest the table does not know (the old vault-rmRWA.json) does not satisfy the verifier", async () => {
    const w = buildWorld();
    const rwa = getStageTable().vaults.find((v) => v.key === "RWA")!;
    rmSync(join(w.manifestDir, basename(rwa.manifest)));
    writeFileSync(join(w.manifestDir, "vault-rmRWA.json"), JSON.stringify({ chain_id: 8453, vault: VAULTS.rmRWA.address }));
    expect(failed(await verifyDeployment(w.opts))).toEqual([`manifest: ${basename(rwa.manifest)} present`]);
  });

  test("unlinked registry on a vault", async () => {
    const w = buildWorld();
    w.chain.set(VAULTS.rmAGENT.address, "registry", "0x0000000000000000000000000000000000000000");
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmAGENT]: registry link"]);
  });

  test("emergency key lost EMERGENCY on a vault", async () => {
    const w = buildWorld();
    w.chain.revoke(VAULTS.rmRWA.address, EMERGENCY_ROLE, w.sheet.emergency);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmRWA]: EMERGENCY_ROLE held by emergency key"]);
  });

  test("basket asset config differs from the sheet", async () => {
    const w = buildWorld();
    w.sheet.vaults.rmRWA.assets[0].swapFee = 100;
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmRWA]: asset config equals sheet"]);
  });

  test("rmAGENT maxSlippageBps read back on chain: 500 passes, any other value fails (core 1695)", async () => {
    const L = "vault[rmAGENT]: maxSlippageBps equals 500";
    const ok = await verifyDeployment(buildWorld().opts);
    expect(ok.checks.find((c) => c.label === L)).toMatchObject({ ok: true });
    for (const bad of [499n, 501n, 291n, 0n]) {
      const w = buildWorld();
      w.chain.set(VAULTS.rmAGENT.address, "maxSlippageBps", bad);
      expect(failed(await verifyDeployment(w.opts))).toEqual([L]);
    }
    // the other vaults are not asked for it
    expect(ok.checks.filter((c) => c.label.endsWith("maxSlippageBps equals 500")).map((c) => c.label)).toEqual([L]);
  });

  test("a missing sheet entry fails exactly the labels that vault kind owns (core 1695)", async () => {
    const common = ["tvlCap equals sheet", "perDepositCap equals sheet", "exitFeeBps equals sheet", "feeRecipient equals sheet", "feeRecipient is not deployer", "paused state equals sheet", "router eligibility equals sheet"];
    const basket = ["asset config equals sheet", "navDeviationGuardBps equals sheet", "navDeviationGuardBps above zero", "pool liquidity meets the sheet floor"];
    const usdc = ["seed present", "totalSupply above zero", "manifest deployer share balance after seed is zero", "seed share receiver is named and is not the deployer", "deployer holds no shares", "seed share receiver holds the seed shares"];
    const want: Record<string, string[]> = {
      rmUSDC: [...common, ...usdc],
      rmPROTO: [...common, ...basket],
      rmAGENT: [...common, ...basket, "maxSlippageBps equals 500"],
      rmRWA: [...common, ...basket],
    };
    for (const key of Object.keys(want)) {
      const w = buildWorld();
      delete (w.opts.sheet.vaults as any)[key];
      const got = failed(await verifyDeployment(w.opts)).filter((l) => l.startsWith(`vault[${key}]: `)).map((l) => l.slice(`vault[${key}]: `.length));
      expect(got.sort()).toEqual([...want[key]!].sort());
    }
  });

  test("rmAGENT must be paused", async () => {
    const w = buildWorld();
    w.chain.set(VAULTS.rmAGENT.address, "depositsPaused", false);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmAGENT]: paused state equals sheet"]);
  });

  test("rmUSDC seed missing", async () => {
    const w = buildWorld();
    w.chain.set(VAULTS.rmUSDC.address, "totalAssets", 0n);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmUSDC]: seed present"]);
  });

  test("fee recipient is the deployer", async () => {
    const w = buildWorld();
    w.chain.set(VAULTS.rmPROTO.address, "feeRecipient", DEPLOYER);
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("vault[rmPROTO]: feeRecipient is not deployer");
  });

  test("the bare frozen sum is not enough: the deployer also sent the prove-control transaction (core 1712)", async () => {
    const w = buildWorld();
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), Object.values(w.opts.frozenCounts).reduce((a, b) => a + b, 0));
    expect(failed(await verifyDeployment(w.opts))).toEqual(["deployer: nonce equals sum of frozen counts"]);
  });

  test("deployer nonce differs from the frozen sum", async () => {
    const w = buildWorld();
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), 56);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["deployer: nonce equals sum of frozen counts"]);
  });

  test("on-chain code differs from the build outside the immutable ranges", async () => {
    const w = buildWorld();
    const key = VAULTS.rmUSDC.address.toLowerCase();
    const code = w.chain.codes.get(key)!;
    w.chain.codes.set(key, (code.slice(0, -2) + "ff") as `0x${string}`);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmUSDC]: runtime code equals build artifact (masked)"]);
  });

  test("a missing manifest stops the run with a failed presence label", async () => {
    const w = buildWorld();
    rmSync(join(w.manifestDir, "router.json"));
    const r = await verifyDeployment(w.opts);
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["manifest: router.json present"]);
  });

  test("RPC chain id differs from the sheet", async () => {
    const w = buildWorld();
    w.chain.chain = 1;
    expect(failed(await verifyDeployment(w.opts))).toContain("chain: id equals sheet");
  });
});

describe("log scan", () => {
  test("scans in chunks no larger than the RPC cap", async () => {
    const w = buildWorld();
    w.chain.head = 9999n;
    await verifyDeployment(w.opts);
    expect(w.chain.logCalls.length).toBeGreaterThan(5);
    for (const c of w.chain.logCalls) expect(c.to - c.from + 1n).toBeLessThanOrEqual(2000n);
  });

  test("retries on 429 and still passes", async () => {
    const w = buildWorld();
    w.chain.rateLimits = 3;
    expect((await verifyDeployment(w.opts)).ok).toBe(true);
  });

  test("a persistent failure fails the scan instead of reading as no logs", async () => {
    const w = buildWorld();
    w.chain.maxLogSpan = 10n; // the chunk size of 2000 now errors on every call
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("deployer: holds no role on any contract (log scan)");
    expect(f).toContain("agents: no agent authorized at handover");
  });
});

describe("USDC is the pinned FiatTokenProxy (principle 12)", () => {
  test("a mock token at the USDC address fails the code-hash label", async () => {
    const w = buildWorld();
    w.chain.codes.set(USDC_ADDRESS.toLowerCase(), "0x6001600155" as `0x${string}`);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["usdc: code hash equals pinned FiatTokenProxy"]);
  });
  test("no code at the USDC address fails the same label", async () => {
    const w = buildWorld();
    w.chain.codes.delete(USDC_ADDRESS.toLowerCase());
    expect(failed(await verifyDeployment(w.opts))).toEqual(["usdc: code hash equals pinned FiatTokenProxy"]);
  });
  test("without the test seam the real pin applies, so the test world's stand-in code fails", async () => {
    const w = buildWorld();
    const { usdcCodeHash: _unused, ...real } = w.opts;
    expect(failed(await verifyDeployment(real))).toEqual(["usdc: code hash equals pinned FiatTokenProxy"]);
  });
  test("the pin is the FiatTokenProxy code hash read from Base mainnet", () => {
    expect(USDC_PROXY_CODE_HASH).toBe("0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab");
    expect(USDC_ADDRESS).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

describe("rmUSDC seed shares: the deployer ends with none and the receiver holds them", () => {
  test("the deployer holding shares fails", async () => {
    const w = buildWorld();
    w.chain.set(VAULTS.rmUSDC.address, "balanceOf", (a: any[]) => (String(a[0]).toLowerCase() === DEPLOYER.toLowerCase() ? 1n : SEED_SHARES));
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmUSDC]: deployer holds no shares"]);
  });
  test("a receiver that holds fewer shares than the manifest says fails", async () => {
    const w = buildWorld();
    w.chain.set(VAULTS.rmUSDC.address, "balanceOf", () => 0n);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmUSDC]: seed share receiver holds the seed shares"]);
  });
  test("the receiver being the deployer fails, and so does a manifest that disagrees with the sheet", async () => {
    const w = buildWorld();
    const p = join(w.manifestDir, "vault.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...m, seed_share_receiver: DEPLOYER }));
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("vault[rmUSDC]: seed share receiver is named and is not the deployer");
    expect(f).toContain("vault[rmUSDC]: seed share receiver equals sheet");
  });
  test("a manifest that records deployer shares after the seed fails", async () => {
    const w = buildWorld();
    const p = join(w.manifestDir, "vault.json");
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), deployer_share_balance_after: 5 }));
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmUSDC]: manifest deployer share balance after seed is zero"]);
  });
  test("a manifest without seed fields fails every seed share check", async () => {
    const w = buildWorld();
    const p = join(w.manifestDir, "vault.json");
    const { seed_share_receiver: _a, seed_shares: _b, deployer_share_balance_after: _c, ...rest } = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify(rest));
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain("vault[rmUSDC]: manifest deployer share balance after seed is zero");
    expect(f).toContain("vault[rmUSDC]: seed share receiver holds the seed shares");
  });
});

describe("deployer nonce after govern", () => {
  test("with the recorded end-of-deploy nonce, govern gas above the frozen sum passes", async () => {
    const w = buildWorld();
    const sum = Object.values(w.opts.frozenCounts).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES;
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), sum + 7);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["deployer: nonce equals sum of frozen counts"]);
    expect(failed(await verifyDeployment({ ...w.opts, deployerNonceAtDeployEnd: sum }))).toEqual([]);
  });
  test("a recorded nonce that is not the frozen sum fails, and a live nonce below the record fails", async () => {
    const w = buildWorld();
    const sum = Object.values(w.opts.frozenCounts).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES;
    expect(failed(await verifyDeployment({ ...w.opts, deployerNonceAtDeployEnd: sum + 1 }))).toEqual(["deployer: nonce equals sum of frozen counts"]);
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), sum - 1);
    expect(failed(await verifyDeployment({ ...w.opts, deployerNonceAtDeployEnd: sum }))).toEqual(["deployer: nonce equals sum of frozen counts"]);
  });
});

describe("rotation of the weight setter (core 1616, ADR-0002)", () => {
  const NEW_GOV = addr(0x60c);
  /** The chain after a completed rotation: the new RouterGovernance is configured as the deploy scripts leave a governance contract, holds the weight setter alone, and holds router ADMIN_ROLE. */
  function rotate(w: World, { updateManifest }: { updateManifest: boolean }): void {
    const g = GOV.toLowerCase(), n = NEW_GOV.toLowerCase();
    w.chain.codes.set(n, w.chain.codes.get(g)!);
    for (const [k, v] of [...w.chain.handlers]) if (k.startsWith(`${g}:`)) w.chain.handlers.set(`${n}:${k.slice(g.length + 1)}`, v);
    for (const r of [...w.chain.roles]) { const [at, role, who] = r.split("|"); if (at === g) w.chain.roles.add(`${n}|${role}|${who}`); }
    w.chain.revoke(ROUTER, WEIGHT_SETTER_ROLE, GOV);
    w.chain.grant(ROUTER, WEIGHT_SETTER_ROLE, NEW_GOV);
    w.chain.revoke(ROUTER, ADMIN_ROLE, GOV);
    w.chain.grant(ROUTER, ADMIN_ROLE, NEW_GOV);
    if (updateManifest) {
      const p = join(w.manifestDir, stageManifestFile(getStageTable(), "governance"));
      const o = JSON.parse(readFileSync(p, "utf8"));
      o.governance = NEW_GOV;
      writeFileSync(p, JSON.stringify(o));
    }
  }

  test("a pending rotation fails closed on its own label, on Twin and on mainnet", async () => {
    for (const id of [8453, 918453]) {
      const w = buildWorld(id);
      w.chain.set(ROUTER, "pendingWeightSetterRotation", [NEW_GOV, 4000n]);
      expect(failed(await verifyDeployment(w.opts))).toEqual(["router: no weight setter rotation pending"]);
    }
  });

  test("a completed rotation passes every label once the manifest names the new governance", async () => {
    for (const id of [8453, 918453]) {
      const w = buildWorld(id);
      rotate(w, { updateManifest: true });
      const r = await verifyDeployment(w.opts);
      expect(failed(r)).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  test("a completed rotation with a stale manifest fails on the governance holder label", async () => {
    const w = buildWorld();
    rotate(w, { updateManifest: false });
    expect(failed(await verifyDeployment(w.opts))).toContain("router: WEIGHT_SETTER_ROLE held by governance");
  });

  test("a second holder after a rotation fails the exactly-one label", async () => {
    const w = buildWorld();
    rotate(w, { updateManifest: true });
    w.chain.grant(ROUTER, WEIGHT_SETTER_ROLE, GOV);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["router: WEIGHT_SETTER_ROLE has exactly one holder"]);
  });
});
