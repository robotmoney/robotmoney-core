import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { PROOF_TX_NONCES } from "../../src/counts.ts";
import { getStageTable } from "../../src/stages.ts";
import { RPC_REFUSED_DETAIL, UNWIND_GUARD_LABEL, verifyDeployment } from "../../src/verify/index.ts";
import { keccak256, toHex } from "viem";
import { padTopic } from "../../src/verify/logs.ts";
import { ADMIN_ROLE, EMERGENCY_ROLE, SAFE_GUARD_SLOT, WEIGHT_SETTER_ROLE, stageManifestFile, SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP } from "../../src/verify/constants.ts";
import { USDC_ADDRESS, USDC_PROXY_CODE_HASH } from "../../src/usdc.ts";
import { LABELS_TXT, rewriteLabelsTxt, verifySection } from "./labels-file.ts";
import { CLAIM_LABEL } from "../../src/verify/upgradeability.ts";
import { adoptTimelock, buildWorld, deployedWorld, failed, WORLD_CREATE2_FACTORY, IMPLS, addr, DEPLOYER, SAFE, SEED_SHARES, VAULTS, REGISTRY, TIMELOCK, GATEWAY, OWNERS, ROUTER, GOV, REC, UNWIND_MAX_LOSS_BPS, UNWIND_MIN_USDC_OUT, type World } from "./world.ts";

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
    for (const l of labels) { expect(l).not.toMatch(/0x[0-9a-f]{4}/i); expect(l.replace(/GS\d+/g, "")).not.toMatch(/\d{3,}/); }
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

describe("a receipt the Safe applied through the timelock (issue 1696, issue 1698)", () => {
  const LABEL = "receipt: applied receipt is released and its weights are on the router";
  const RID = `0x${"ab".repeat(32)}` as `0x${string}`;
  const vaults = () => Object.values(VAULTS).map((v) => v.address);
  const BPS = [4000, 3000, 2000, 1000];
  /** applyReceipt released the receipt and set the router's ACTIVE vector; the default vector is still the sheet's. */
  const applied = (over: { released?: boolean; routerBps?: number[] } = {}) => {
    const w = buildWorld();
    w.opts.appliedReceipt = { receiptId: RID, vaults: vaults(), bps: BPS };
    w.chain.set(REC, "isReleased", () => over.released ?? true);
    w.chain.set(ROUTER, "votedWeightsActive", true);
    w.chain.set(ROUTER, "getWeights", [vaults(), (over.routerBps ?? BPS).map((x) => BigInt(x))]);
    w.chain.set(ROUTER, "getEffectiveWeights", [vaults(), (over.routerBps ?? BPS).map((x) => BigInt(x))]);
    return w;
  };
  test("no application: the label is present and passes, and the sheet vector is still required", async () => {
    const ok = await verifyDeployment(buildWorld().opts);
    expect(ok.checks.find((c) => c.label === LABEL)).toMatchObject({ ok: true });
    const w = buildWorld();
    w.chain.set(ROUTER, "getDefaultWeights", [vaults(), BPS.map((x) => BigInt(x))]);
    w.chain.set(ROUTER, "getEffectiveWeights", [vaults(), BPS.map((x) => BigInt(x))]);
    expect(failed(await verifyDeployment(w.opts)).sort()).toEqual(["router: default weights equal sheet", "router: effective weights equal the sheet's launch vector"].sort());
  });
  test("applied, released and active on the router: every check passes, the default vector staying the sheet's", async () => {
    const r = await verifyDeployment(applied().opts);
    expect(failed(r)).toEqual([]);
    expect(r.checks.find((c) => c.label === LABEL)).toMatchObject({ ok: true });
    expect(r.checks.find((c) => c.label === LABEL)!.detail).toContain(RID);
  });
  test("applied but the receipt reads not released fails the label", async () => {
    expect(failed(await verifyDeployment(applied({ released: false }).opts))).toEqual([LABEL]);
  });
  test("applied but the router holds another vector fails the label and the effective weights label", async () => {
    expect(failed(await verifyDeployment(applied({ routerBps: [5000, 3000, 2000, 0] }).opts)).sort()).toEqual([LABEL, "router: effective weights equal the sheet's launch vector"].sort());
  });
  test("applied but the active vector is not in effect fails the active label", async () => {
    const w = applied();
    w.chain.set(ROUTER, "votedWeightsActive", false);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["router: votedWeightsActive is true only after an applied receipt"]);
  });
});

describe("no active vector may override the launch vector without an applied receipt (issue 1743)", () => {
  const ACTIVE = "router: votedWeightsActive is true only after an applied receipt";
  const EFFECTIVE = "router: effective weights equal the sheet's launch vector";
  const vaults = () => Object.values(VAULTS).map((v) => v.address);
  test("the healthy world passes both labels", async () => {
    const r = await verifyDeployment(buildWorld().opts);
    expect(r.checks.find((c) => c.label === ACTIVE)).toMatchObject({ ok: true });
    expect(r.checks.find((c) => c.label === EFFECTIVE)).toMatchObject({ ok: true });
  });
  test("the 8453 failure: a voted vector (100% rmUSDC) on top of the right default fails both labels and not the default label", async () => {
    const w = buildWorld(8453);
    w.chain.set(ROUTER, "votedWeightsActive", true);
    w.chain.set(ROUTER, "getEffectiveWeights", [[vaults()[0]], [10000n]]);
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([ACTIVE, EFFECTIVE].sort());
    expect(r.checks.find((c) => c.label === EFFECTIVE)!.detail).toContain("want");
  });
  test("an unreadable getEffectiveWeights fails the effective label", async () => {
    const w = buildWorld();
    w.chain.set(ROUTER, "getEffectiveWeights", () => { throw new Error("execution reverted"); });
    expect(failed(await verifyDeployment(w.opts))).toEqual([EFFECTIVE]);
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
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmRWA]: EMERGENCY_ROLE held by emergency key", "vault[rmRWA]: EMERGENCY_ROLE has exactly one holder"]);
  });

  test("basket asset config differs from the sheet", async () => {
    const w = buildWorld();
    w.sheet.vaults.rmRWA.assets[0].swapFee = 100;
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmRWA]: asset config equals sheet"]);
  });

  test("every basket's maxSlippageBps is read back on chain and equals the config: rmAGENT 500, any other value fails (core 1695, issue 1705 C4)", async () => {
    const ok = await verifyDeployment(buildWorld().opts);
    const labels = ["rmPROTO", "rmAGENT", "rmRWA"].map((k) => `vault[${k}]: maxSlippageBps equals config`);
    for (const L of labels) expect(ok.checks.find((c) => c.label === L)).toMatchObject({ ok: true });
    // rmUSDC holds no basket and is not asked for it
    expect(ok.checks.filter((c) => c.label.endsWith("maxSlippageBps equals config")).map((c) => c.label)).toEqual(labels);
    for (const bad of [499n, 501n, 291n, 0n]) {
      const w = buildWorld();
      w.chain.set(VAULTS.rmAGENT.address, "maxSlippageBps", bad);
      expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmAGENT]: maxSlippageBps equals config"]);
    }
    const p = buildWorld();
    p.chain.set(VAULTS.rmPROTO.address, "maxSlippageBps", 300n);
    expect(failed(await verifyDeployment(p.opts))).toEqual(["vault[rmPROTO]: maxSlippageBps equals config"]);
    const none = buildWorld();
    delete none.sheet.vaults.rmRWA.maxSlippageBps;
    expect(failed(await verifyDeployment(none.opts))).toEqual(["vault[rmRWA]: maxSlippageBps equals config"]);
  });

  describe("per-vault role holders and the rmUSDC adapter allowlist, from the logs (issue 1705 C4, C5)", () => {
    const KEEPER_ROLE = keccak256(toHex("KEEPER_ROLE"));
    test("a healthy world passes every new label on every vault", async () => {
      const r = await verifyDeployment(buildWorld().opts);
      const want = [...Object.keys(VAULTS).flatMap((k) => [`vault[${k}]: KEEPER_ROLE has no holder`, `vault[${k}]: EMERGENCY_ROLE has exactly one holder`]), "vault[rmUSDC]: adapter set, caps and code-hash allowlist equal the deploy script"];
      for (const l of want) expect([l, r.checks.find((c) => c.label === l)?.ok]).toEqual([l, true]);
    });
    test("the verifier fails when any vault's KEEPER_ROLE has a holder, even the Safe or the timelock", async () => {
      for (const [k, who] of [["rmUSDC", SAFE], ["rmUSDC", TIMELOCK], ["rmPROTO", addr(0xbeef)], ["rmAGENT", addr(0xbeef)], ["rmRWA", addr(0xbeef)]] as const) {
        const w = buildWorld();
        w.chain.grant(VAULTS[k]!.address, KEEPER_ROLE, who);
        w.chain.roleGrantedLog(VAULTS[k]!.address, KEEPER_ROLE, who, 3000n);
        expect(failed(await verifyDeployment(w.opts))).toContain(`vault[${k}]: KEEPER_ROLE has no holder`);
      }
    });
    test("a KEEPER_ROLE grant that was revoked again is not a holder", async () => {
      const w = buildWorld();
      w.chain.roleGrantedLog(VAULTS.rmUSDC.address, KEEPER_ROLE, addr(0xbeef), 3000n);
      expect(failed(await verifyDeployment(w.opts))).toEqual([]);
    });
    test("a second EMERGENCY_ROLE holder fails, the emergency key alone passes", async () => {
      const w = buildWorld();
      w.chain.grant(VAULTS.rmAGENT.address, EMERGENCY_ROLE, addr(0xbeef));
      w.chain.roleGrantedLog(VAULTS.rmAGENT.address, EMERGENCY_ROLE, addr(0xbeef), 3000n);
      expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmAGENT]: EMERGENCY_ROLE has exactly one holder", "roles: every holder of every role on every governed contract is an expected account (log scan)"]);
    });
    const ADAPTERS = "vault[rmUSDC]: adapter set, caps and code-hash allowlist equal the deploy script";
    test("rmUSDC adapters: a moved cap, a missing adapter, an extra allowed adapter or code hash each fail", async () => {
      const cap = buildWorld();
      const a = cap.sheet.vaults.rmUSDC.adapters!;
      cap.chain.set(VAULTS.rmUSDC.address, "adapters", (x: any[]) => { const e = a[Number(x[0])]; if (!e) throw new Error("execution reverted"); return [e.adapter, Number(x[0]) === 0 ? 5000 : e.capBps, true]; });
      expect(failed(await verifyDeployment(cap.opts))).toEqual([ADAPTERS]);
      const gone = buildWorld();
      const b = gone.sheet.vaults.rmUSDC.adapters!;
      gone.chain.set(VAULTS.rmUSDC.address, "adapters", (x: any[]) => { const e = b[Number(x[0])]; if (!e) throw new Error("execution reverted"); return [e.adapter, e.capBps, Number(x[0]) !== 2]; });
      expect(failed(await verifyDeployment(gone.opts))).toEqual([ADAPTERS]);
      const extra = buildWorld();
      extra.chain.set(VAULTS.rmUSDC.address, "adapterAllowed", () => true);
      extra.chain.logs.push({ address: VAULTS.rmUSDC.address, topics: [keccak256(toHex("AdapterAllowedSet(address,bool)")), padTopic(addr(0xbeef))], data: "0x", blockNumber: 3000n });
      expect(failed(await verifyDeployment(extra.opts))).toEqual([ADAPTERS]);
      const hash = buildWorld();
      const h = keccak256(toHex("some other adapter code"));
      hash.chain.set(VAULTS.rmUSDC.address, "adapterCodeHashAllowed", () => true);
      hash.chain.logs.push({ address: VAULTS.rmUSDC.address, topics: [keccak256(toHex("AdapterCodeHashAllowedSet(bytes32,bool)")), h], data: "0x", blockNumber: 3000n });
      expect(failed(await verifyDeployment(hash.opts))).toEqual([ADAPTERS]);
    });
    test("an unreadable block number fails every log-scan vault label (never a skip)", async () => {
      const w = buildWorld();
      w.chain.blockNumber = async () => { throw new Error("rpc down"); };
      const f = failed(await verifyDeployment(w.opts));
      for (const k of Object.keys(VAULTS)) expect(f).toContain(`vault[${k}]: KEEPER_ROLE has no holder`);
      expect(f).toContain(ADAPTERS);
    });
  });

  test("a missing sheet entry fails exactly the labels that vault kind owns (core 1695)", async () => {
    const common = ["tvlCap equals sheet", "perDepositCap equals sheet", "exitFeeBps equals sheet", "feeRecipient equals sheet", "feeRecipient is not deployer", "paused state equals sheet", "router eligibility equals sheet"];
    const basket = ["asset config equals sheet", "navDeviationGuardBps equals sheet", "navDeviationGuardBps above zero", "pool liquidity meets the sheet floor", UNWIND_GUARD_LABEL];
    const usdc = ["adapter set, caps and code-hash allowlist equal the deploy script", "seed present", "totalSupply above zero", "manifest deployer share balance after seed is zero", "seed share receiver is named and is not the deployer", "deployer holds no shares", "seed share receiver holds the seed shares"];
    const want: Record<string, string[]> = {
      rmUSDC: [...common, ...usdc],
      rmPROTO: [...common, ...basket, "maxSlippageBps equals config"],
      rmAGENT: [...common, ...basket, "maxSlippageBps equals config"],
      rmRWA: [...common, ...basket, "maxSlippageBps equals config"],
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
    // issue 1808: the code that runs is the implementation's; a changed byte there fails the code label and refuses the immutability claim (issue 1809)
    const key = IMPLS["vault[rmUSDC]"]!.toLowerCase();
    const code = w.chain.codes.get(key)!;
    w.chain.codes.set(key, (code.slice(0, -2) + "ff") as `0x${string}`);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["vault[rmUSDC]: runtime code equals build artifact (masked)", CLAIM_LABEL]);
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
    for (const [k, v] of [...w.chain.storage]) if (k.startsWith(`${g}|`)) w.chain.storage.set(`${n}|${k.slice(g.length + 1)}`, v);
    for (const [k, v] of [...w.chain.handlers]) if (k.startsWith(`${g}:`)) w.chain.handlers.set(`${n}:${k.slice(g.length + 1)}`, v);
    for (const r of [...w.chain.roles]) { const [at, role, who] = r.split("|"); if (at === g) w.chain.roles.add(`${n}|${role}|${who}`); }
    w.chain.revoke(ROUTER, WEIGHT_SETTER_ROLE, GOV);
    w.chain.grant(ROUTER, WEIGHT_SETTER_ROLE, NEW_GOV);
    w.chain.revoke(ROUTER, ADMIN_ROLE, GOV);
    w.chain.grant(ROUTER, ADMIN_ROLE, NEW_GOV);
    // issue 1698: the new weight setter releases receipts, so the timelock moves the receipt register's ADMIN_ROLE to it too
    w.chain.revoke(REC, ADMIN_ROLE, GOV);
    w.chain.grant(REC, ADMIN_ROLE, NEW_GOV);
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

  // QA plan v1 C3 (CS-6, ADR-0002): every weight change waits the timelock delay only while the weight setter is timelock-gated. A rotation installs whatever
  // contract the Safe chose, so the run records the current holder's gating (VerifyReport.weightSetter) and fails the gating label on any other gate.
  describe("the current holder's gating is recorded (QA plan v1 C3, CS-6)", () => {
    const GATING = "router: every WEIGHT_SETTER_ROLE holder is timelock-gated";
    const FORWARDER = addr(0xf0e3);
    const gatingOf = (r: Awaited<ReturnType<typeof verifyDeployment>>) => r.checks.find((c) => c.label === GATING)!;

    test("the healthy world records RouterGovernance gated by the timelock alone and the delay each weight change waits, on mainnet and on Twin", async () => {
      for (const [id, delay] of [[8453, 172800], [918453, 60]] as const) {
        const r = await verifyDeployment(buildWorld(id).opts);
        expect(r.weightSetter).toEqual({ gating: "timelock", holders: [{ address: GOV, routerGovernanceCode: true, admins: [TIMELOCK], setters: [TIMELOCK], timelockGated: true }], timelock: TIMELOCK, delaySeconds: delay });
        expect(gatingOf(r).ok).toBe(true);
        expect(gatingOf(r).detail).toContain(`every weight change waits the timelock delay of ${delay} s`);
      }
    });

    test("a completed rotation to a new RouterGovernance records the new holder, still gated by the timelock", async () => {
      const w = buildWorld();
      rotate(w, { updateManifest: true });
      const r = await verifyDeployment(w.opts);
      expect(failed(r)).toEqual([]);
      expect(r.weightSetter).toMatchObject({ gating: "timelock", holders: [{ address: NEW_GOV, routerGovernanceCode: true, admins: [TIMELOCK], setters: [TIMELOCK], timelockGated: true }] });
    });

    test("a rotation to a Safe forwarder records it as not timelock-gated and fails the gating label, with or without a manifest naming it", async () => {
      for (const updateManifest of [false, true]) {
        const w = buildWorld();
        w.chain.codes.set(FORWARDER.toLowerCase(), "0x6080604052348015600f57600080fd5b50");
        w.chain.revoke(ROUTER, WEIGHT_SETTER_ROLE, GOV);
        w.chain.grant(ROUTER, WEIGHT_SETTER_ROLE, FORWARDER);
        if (updateManifest) {
          const p = join(w.manifestDir, stageManifestFile(getStageTable(), "governance"));
          writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), governance: FORWARDER }));
        }
        const r = await verifyDeployment(w.opts);
        expect(r.weightSetter).toMatchObject({ gating: "not-timelock", holders: [{ address: FORWARDER, routerGovernanceCode: false, timelockGated: false }] });
        expect(failed(r)).toContain(GATING);
        expect(gatingOf(r).detail).toContain("skip the timelock delay of 172800 s");
      }
    });

    test("the Safe as a second ADMIN_ROLE member of the weight setter is not timelock-gated: it could move weights with no delay", async () => {
      const w = buildWorld();
      w.chain.grant(GOV, ADMIN_ROLE, SAFE);
      const r = await verifyDeployment(w.opts);
      expect(r.weightSetter).toMatchObject({ gating: "not-timelock", holders: [{ address: GOV, routerGovernanceCode: true, admins: [TIMELOCK, SAFE], timelockGated: false }] });
      expect(failed(r)).toContain(GATING);
      expect(failed(r)).toContain("governance: ADMIN_ROLE not held by safe");
    });

    test("the Safe as a second WEIGHT_SETTER_ROLE member of the weight setter is not timelock-gated: it could applyReceipt with no delay (issue 1698)", async () => {
      const w = buildWorld();
      w.chain.grant(GOV, WEIGHT_SETTER_ROLE, SAFE);
      const r = await verifyDeployment(w.opts);
      expect(r.weightSetter).toMatchObject({ gating: "not-timelock", holders: [{ address: GOV, routerGovernanceCode: true, setters: [TIMELOCK, SAFE], timelockGated: false }] });
      expect(failed(r)).toContain(GATING);
    });

    test("no holder records not-timelock: an empty role gates nothing the verifier can name", async () => {
      const w = buildWorld();
      w.chain.revoke(ROUTER, WEIGHT_SETTER_ROLE, GOV);
      const r = await verifyDeployment(w.opts);
      expect(r.weightSetter).toMatchObject({ gating: "not-timelock", holders: [] });
      expect(gatingOf(r)).toMatchObject({ ok: false, detail: "WEIGHT_SETTER_ROLE has no holder" });
    });

    test("an unreadable holder enumeration records unreadable and fails the gating label alone: it never reads as gated", async () => {
      const w = buildWorld();
      const read = w.chain.read.bind(w.chain);
      w.chain.read = async (a, sig, args) => (sig.includes("getRoleMember(") ? Promise.reject(new Error("rpc down")) : read(a, sig, args));
      const r = await verifyDeployment(w.opts);
      expect(r.weightSetter).toMatchObject({ gating: "unreadable", holders: [], delaySeconds: 172800 });
      expect(failed(r)).toEqual([GATING]);
    });
  });
});

// QA plan v1 D7 (review E5, issue 1705 Q2): before govern --row set-unwind-guard nothing set a basket's emergency unwind guard, so the oracle-free unwind and the override path
// could not run. The stage 12 label requires a non-zero minUsdcOut on every active asset of a basket the sheet expects OPEN; a paused basket (pre-govern) passes and records the values.
describe("the emergency unwind guard label (QA plan v1 D7)", () => {
  const BASKETS = ["rmPROTO", "rmAGENT", "rmRWA"] as const;
  const labelOf = (k: string) => `vault[${k}]: ${UNWIND_GUARD_LABEL}`;
  const check = (r: Awaited<ReturnType<typeof verifyDeployment>>, k: string) => r.checks.find((c) => c.label === labelOf(k))!;
  /** The post-govern state of one basket: the sheet expects it open and the chain reads it open. */
  const open = (w: World, k: string) => { w.sheet.vaults[k]!.expectPaused = false; w.chain.set(VAULTS[k]!.address, "depositsPaused", false); };
  const zeroGuards = (w: World, k: string) => w.chain.set(VAULTS[k]!.address, "emergencyUnwindGuard", () => [0n, false, 0n]);

  test("every basket carries the label and rmUSDC does not (it has no unwind guard)", async () => {
    const r = await verifyDeployment(buildWorld().opts);
    for (const k of BASKETS) expect(check(r, k)?.ok).toBe(true);
    expect(r.checks.some((c) => c.label === labelOf("rmUSDC"))).toBe(false);
  });
  test("pre-govern: a paused basket with no guard set passes and records the zero values", async () => {
    const w = buildWorld();
    for (const k of BASKETS) zeroGuards(w, k);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    expect(check(r, "rmPROTO").detail).toContain("deposits paused, no guard required until the vault opens");
    expect(check(r, "rmPROTO").detail).toContain("minUsdcOut 0");
  });
  test("post-govern: an open basket whose every active asset reads a non-zero minUsdcOut passes, and the detail records overrideAllowed and maxLossBps", async () => {
    const w = buildWorld();
    for (const k of BASKETS) open(w, k);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    expect(check(r, "rmPROTO").detail).toContain(`minUsdcOut ${UNWIND_MIN_USDC_OUT} overrideAllowed true maxLossBps ${UNWIND_MAX_LOSS_BPS}`);
  });
  test("post-govern: an open basket with one active asset at minUsdcOut zero fails exactly its label, names the token and the govern row", async () => {
    const w = buildWorld();
    for (const k of BASKETS) open(w, k);
    const token = w.sheet.vaults.rmPROTO!.assets[1]!.token;
    w.chain.set(VAULTS.rmPROTO!.address, "emergencyUnwindGuard", (a: any[]) => (String(a[0]).toLowerCase() === token.toLowerCase() ? [0n, true, 500n] : [UNWIND_MIN_USDC_OUT, true, UNWIND_MAX_LOSS_BPS]));
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([labelOf("rmPROTO")]);
    expect(check(r, "rmPROTO").detail).toContain(`minUsdcOut is zero for ${token}`);
    expect(check(r, "rmPROTO").detail).toContain("govern --row set-unwind-guard");
  });
  test("post-govern: a basket the govern stage opened with no guard at all fails (the state before this row existed)", async () => {
    const w = buildWorld();
    for (const k of BASKETS) { open(w, k); zeroGuards(w, k); }
    expect(failed(await verifyDeployment(w.opts))).toEqual(BASKETS.map(labelOf));
  });
  test("an inactive asset row is not required to carry a guard", async () => {
    const w = buildWorld();
    open(w, "rmRWA");
    const row = w.sheet.vaults.rmRWA!.assets[0]!;
    // a second, inactive row with no guard: the label reads only the active ones (asset config is checked by its own label)
    w.chain.set(VAULTS.rmRWA!.address, "assets", (a: any[]) => {
      const i = Number(a[0]);
      if (i === 0) return [row.token, row.pool, row.swapFee, true, row.adapter, row.venue ?? 0];
      if (i === 1) return [addr(0xdead), addr(0xf009), 500, false, row.adapter, 0];
      throw new Error("execution reverted");
    });
    const r = await verifyDeployment(w.opts);
    expect(check(r, "rmRWA").ok).toBe(true);
    expect(check(r, "rmRWA").detail).not.toContain(addr(0xdead));
  });
  test("an open basket whose asset list reads empty fails closed: nothing proves an unwind floor", async () => {
    const w = buildWorld();
    open(w, "rmRWA");
    w.chain.set(VAULTS.rmRWA!.address, "assets", () => { throw new Error("execution reverted"); });
    const r = await verifyDeployment(w.opts);
    expect(check(r, "rmRWA").ok).toBe(false);
    expect(check(r, "rmRWA").detail).toContain("lists no active asset");
  });
  test("an unreadable guard is a failed check, not a pass", async () => {
    const w = buildWorld();
    open(w, "rmAGENT");
    w.chain.handlers.delete(`${VAULTS.rmAGENT!.address.toLowerCase()}:emergencyUnwindGuard`);
    expect(check(await verifyDeployment(w.opts), "rmAGENT").ok).toBe(false);
  });
  test("the label set is the same before and after govern (the check is always present)", async () => {
    const before = (await verifyDeployment(buildWorld().opts)).checks.map((c) => c.label);
    const w = buildWorld();
    for (const k of BASKETS) open(w, k);
    expect((await verifyDeployment(w.opts)).checks.map((c) => c.label)).toEqual(before);
  });
});

// Issue 1833, 1851: every log scan starts at --from-block. Each scanned contract's creation block is read from the receipt of the run's deploy transaction that created it
// (eth_getTransactionReceipt, served by pruned nodes), never from historical state. A contract created before the scan start fails its scan labels instead of passing on a partial log.
describe("from-block against the deploy receipts (issue 1833, 1851)", () => {
  const scanLabels = (key: string) => [`vault[${key}]: KEEPER_ROLE has no holder`, `vault[${key}]: EMERGENCY_ROLE has exactly one holder`, ...(key === "rmUSDC" ? [`vault[${key}]: adapter set, caps and code-hash allowlist equal the deploy script`] : [])];
  const AGENT_SCANS = ["agents: no agent authorized at handover", "agents: no address holds AGENT_ROLE after handover"];
  const DEPLOYER_SCAN = "deployer: holds no role on any contract (log scan)";
  const HOLDERS_SCAN = "roles: every holder of every role on every governed contract is an expected account (log scan)";
  const TIMELOCK_SCAN = "timelock: only the safe holds PROPOSER, CANCELLER or EXECUTOR role (log scan)";
  const ALL_SCANS = [...["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"].flatMap(scanLabels), ...AGENT_SCANS, DEPLOYER_SCAN, HOLDERS_SCAN, TIMELOCK_SCAN];
  const deployed = deployedWorld;
  const okOf = (r: Awaited<ReturnType<typeof verifyDeployment>>, l: string) => [l, r.checks.find((c) => c.label === l)?.ok];
  const detailOf = (r: Awaited<ReturnType<typeof verifyDeployment>>, l: string) => r.checks.find((c) => c.label === l)?.detail ?? "";

  test("every receipt at or after from-block: every scan label passes, and no code is read at a historical block", async () => {
    const w = deployed();
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    for (const l of ALL_SCANS) expect(okOf(r, l)).toEqual([l, true]);
    expect(w.chain.codeCalls.filter((x) => x.blockNumber !== undefined)).toEqual([]);
    expect(w.chain.receiptCalls.length).toBe(w.opts.deployTxs!.length); // read once per run, not once per label
  });
  test("a vault whose deploy receipt is before from-block: its scan labels fail with 'after the vault's creation', the other vaults' still pass", async () => {
    const r = await verifyDeployment(deployed({ rmUSDC: 99n }).opts);
    expect(r.ok).toBe(false);
    for (const l of scanLabels("rmUSDC")) {
      expect(okOf(r, l)).toEqual([l, false]);
      expect(detailOf(r, l)).toContain("from-block 100 is after the vault's creation");
      expect(detailOf(r, l)).toContain("created in block 99");
    }
    for (const k of ["rmPROTO", "rmAGENT", "rmRWA"]) for (const l of scanLabels(k)) expect(okOf(r, l)).toEqual([l, true]);
  });
  test("historical state reads throw 'missing trie node' and the receipts read fine: every scan passes", async () => {
    const w = deployed();
    const getCode = w.chain.getCode.bind(w.chain);
    w.chain.getCode = async (a: `0x${string}`, ...rest: unknown[]) => { if (rest[0] !== undefined) throw new Error("missing trie node"); return getCode(a); };
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
  });
  test("a receipt read that throws: every scan label fails with an RPC_REFUSED detail, the other labels pass", async () => {
    const w = deployed();
    w.chain.receipts.set(w.opts.deployTxs![2]!.toLowerCase(), () => { throw new Error("missing trie node"); });
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...ALL_SCANS].sort());
    for (const l of ALL_SCANS) expect(detailOf(r, l).startsWith(`${RPC_REFUSED_DETAIL}: `)).toBe(true);
    expect(detailOf(r, DEPLOYER_SCAN)).toContain("missing trie node");
  });
  // Issue 1864: a null receipt is a pruned node only when the same RPC serves none of the run's receipts and does not know the transaction.
  test("a recorded deploy transaction with no receipt while the same RPC serves the run's other receipts: every scan label fails naming it, not classified RPC_REFUSED", async () => {
    const w = deployed();
    const gone = w.opts.deployTxs![0]!;
    w.chain.receipts.delete(gone.toLowerCase());
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...ALL_SCANS].sort());
    for (const l of ALL_SCANS) {
      expect(detailOf(r, l).startsWith(RPC_REFUSED_DETAIL)).toBe(false);
      expect(detailOf(r, l)).toContain(`the recorded deploy transaction(s) ${gone} of the run have no receipt`);
    }
  });
  test("an RPC that returns no receipt for any recorded deploy transaction and does not know them (a node that does not index old transactions): every scan label fails classified RPC_REFUSED", async () => {
    const w = deployed();
    w.chain.receipts.clear();
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...ALL_SCANS].sort());
    for (const l of ALL_SCANS) expect(detailOf(r, l).startsWith(`${RPC_REFUSED_DETAIL}: the RPC does not know the transaction`)).toBe(true);
  });
  test("no receipt for any recorded deploy transaction while eth_getTransactionByHash knows one: not mined, every scan label fails not classified RPC_REFUSED", async () => {
    const w = deployed();
    w.chain.receipts.clear();
    w.chain.txs.set(w.opts.deployTxs![3]!.toLowerCase(), { to: null, input: "0x", value: 0n, status: "success" });
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...ALL_SCANS].sort());
    for (const l of ALL_SCANS) expect(detailOf(r, l).startsWith(RPC_REFUSED_DETAIL)).toBe(false);
  });
  test("a contract no receipt of the run created and the run did not adopt: its scan labels fail, not classified RPC_REFUSED", async () => {
    const w2 = deployed();
    w2.opts.deployTxs = w2.opts.deployTxs!.slice(1); // the gateway's receipt is missing from the run manifest
    const r2 = await verifyDeployment(w2.opts);
    expect(failed(r2).sort()).toEqual([...AGENT_SCANS, DEPLOYER_SCAN, HOLDERS_SCAN].sort());
    expect(detailOf(r2, AGENT_SCANS[0]!)).toContain("no deploy transaction of the run created gateway");
    expect(detailOf(r2, AGENT_SCANS[0]!)).toContain("the run did not adopt it");
    expect(detailOf(r2, AGENT_SCANS[0]!).startsWith(RPC_REFUSED_DETAIL)).toBe(false);
  });
  test("no deploy transactions given with from-block above zero: every scan label fails; from-block zero needs none", async () => {
    const w = deployed();
    w.opts.deployTxs = undefined;
    expect(failed(await verifyDeployment(w.opts)).sort()).toEqual([...ALL_SCANS].sort());
    const w0 = buildWorld();
    expect(failed(await verifyDeployment(w0.opts))).toEqual([]);
    expect(w0.chain.receiptCalls).toEqual([]);
  });
  // Issue 1835: the timelock stage may ADOPT a timelock someone else created at the predicted CREATE2 address. The run sent no creation transaction for it.
  const adoptedTimelock = (block: bigint, receipt: (tx: `0x${string}`) => Record<string, unknown> | null) => adoptTimelock(deployedWorld(), block, receipt);
  const TL_LABELS = [TIMELOCK_SCAN, DEPLOYER_SCAN, HOLDERS_SCAN];
  test("an adopted timelock created by a CREATE2 factory call at or after from-block: the timelock-holder, deployer-role and role-holder labels pass", async () => {
    const w = adoptedTimelock(105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] }));
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    for (const l of TL_LABELS) expect(okOf(r, l)).toEqual([l, true]);
  });
  // Issue 1864: the proof is the constructor's own RoleGranted(DEFAULT_ADMIN_ROLE, timelock, sender = factory), however the factory was reached.
  test("an adopted timelock created through a wrapper (the creation transaction's to is a multicall, not the factory): the labels pass", async () => {
    const WRAPPER = addr(0xca11);
    const w = adoptedTimelock(105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WRAPPER, logs: [{ address: TIMELOCK }] }));
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    for (const l of TL_LABELS) expect(okOf(r, l)).toEqual([l, true]);
  });
  for (const [what, grant] of [
    ["another role", { role: ADMIN_ROLE }],
    ["another account", { account: SAFE }],
    ["another sender (a grantRole call, not the constructor)", { sender: addr(0xabc) }],
  ] as const) {
    test(`an adopted timelock whose earliest RoleGranted log is in a successful direct CREATE2 factory call but grants ${what}: those labels fail, not classified RPC_REFUSED`, async () => {
      const w = adoptTimelock(deployedWorld(), 105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] }), grant);
      const r = await verifyDeployment(w.opts);
      expect(failed(r).sort()).toEqual([...TL_LABELS].sort());
      for (const l of TL_LABELS) {
        expect(detailOf(r, l)).toContain("is not the constructor's RoleGranted(DEFAULT_ADMIN_ROLE");
        expect(detailOf(r, l).startsWith(RPC_REFUSED_DETAIL)).toBe(false);
      }
    });
  }
  test("an adopted timelock whose constructor grant sits in a reverted transaction: those labels fail", async () => {
    const w = adoptedTimelock(105n, () => ({ blockNumber: 105n, status: "reverted", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [] }));
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...TL_LABELS].sort());
    expect(detailOf(r, TIMELOCK_SCAN)).toContain("is not successful");
  });
  test("the same timelock missing from deployTxs and NOT adopted: those labels fail closed", async () => {
    const w = adoptedTimelock(105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] }));
    w.opts.adoptedContracts = [];
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...TL_LABELS].sort());
    expect(detailOf(r, TIMELOCK_SCAN)).toContain("no deploy transaction of the run created timelock");
  });
  test("an adopted timelock whose creation receipt the RPC refuses: those labels fail classified RPC_REFUSED", async () => {
    const w = adoptedTimelock(105n, () => null);
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual([...TL_LABELS].sort());
    for (const l of TL_LABELS) expect(detailOf(r, l).startsWith(RPC_REFUSED_DETAIL)).toBe(true);
  });
  // Each scan family fails when --from-block is after the deploy receipt block of the contract it scans.
  for (const [what, blocks, want] of [
    ["the gateway (agent scans, deployer-role and role-holder scans)", { gateway: 99n }, [...AGENT_SCANS, DEPLOYER_SCAN, HOLDERS_SCAN]],
    ["the router (deployer-role and role-holder scans)", { router: 99n }, [DEPLOYER_SCAN, HOLDERS_SCAN]],
    ["the timelock, created through the CREATE2 factory (timelock-holder, deployer-role and role-holder scans)", { timelock: 99n }, [TIMELOCK_SCAN, DEPLOYER_SCAN, HOLDERS_SCAN]],
    ["a vault (its own scans, deployer-role and role-holder scans)", { rmAGENT: 99n }, [...scanLabels("rmAGENT"), DEPLOYER_SCAN, HOLDERS_SCAN]],
  ] as const) {
    test(`from-block after the creation of ${what}: exactly those scan labels fail`, async () => {
      const r = await verifyDeployment(deployed(blocks as Record<string, bigint>).opts);
      expect(failed(r).sort()).toEqual([...want].sort());
      for (const l of want) expect(detailOf(r, l)).toContain("from-block 100 is after the");
    });
  }
});
