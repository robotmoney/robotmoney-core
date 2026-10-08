// Negative fixture for EVERY verifier label (devops 57: "mutation tests ... each fail with the expected label").
// The committed label list (fixtures/expected-labels.json) is the contract. For each label this file plants the one fault that label
// exists to catch in a healthy world and asserts the verifier reports exactly that label as failed. A label with no planted fault
// is itself a test failure, so a new label cannot ship without a negative fixture.
// The world is an in-memory chain (FakeChain). It proves what the verifier reports for a chain state, not that a chain behaves so.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, pad, toHex } from "viem";
import { verifyDeployment } from "../../src/verify/index.ts";
import {
  ADMIN_ROLE, AGENT_ROLE, WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROTATOR_ROLE, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, EMERGENCY_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, SAFE_GUARD_SLOT, SAFE_FALLBACK_SLOT, SAFE_PROBE_ADDRESS,
  SAFE_PROBE_ADDRESS_2, SIG_AGENT_AUTHORIZED, Z32, ZERO,
} from "../../src/verify/constants.ts";
import { padTopic } from "../../src/verify/logs.ts";
import { USDC_ADDRESS } from "../../src/usdc.ts";
import { buildWorld, failed, addr, DEPLOYER, SAFE, VAULTS, REGISTRY, TIMELOCK, GATEWAY, ROUTER, GOV, ICP, REC, RECORDER, V4_ADAPTER, OWNERS, OWNER_KEYS, PROOF_TX, proofInput, EMERGENCY, PAUSER, SEED_SHARES, type World } from "./world.ts";

const LABELS = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "expected-labels.json"), "utf8")) as string[];
const CORE: Record<string, `0x${string}`> = { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOV, icpolicy: ICP, receipt: REC, timelock: TIMELOCK, recorder: RECORDER };
const LIB_TICK_MATH = addr(0x11b1);
const WHO: Record<string, `0x${string}`> = { deployer: DEPLOYER, pauser: PAUSER, emergency: EMERGENCY, safe: SAFE };
const OTHER = addr(0x0bad);

/** The address a label's subject names: a core contract, vault[KEY] or library[NAME]. */
function subject(name: string): `0x${string}` {
  const v = /^vault\[(\w+)\]$/.exec(name); if (v) return VAULTS[v[1]].address;
  if (/^library\[tick_math\]$/.test(name)) return LIB_TICK_MATH;
  if (name === "safe") return SAFE;
  if (name === "adapter[V4:rmAGENT]") return V4_ADAPTER;
  const c = CORE[name]; if (c) return c;
  throw new Error(`no subject for '${name}'`);
}
const editManifest = (w: World, file: string, fn: (o: any) => void) => {
  const p = join(w.manifestDir, file); const o = JSON.parse(readFileSync(p, "utf8")); fn(o); writeFileSync(p, JSON.stringify(o));
};
const timelockFile = () => "timelock.json";

type Rule = [RegExp, (w: World, m: RegExpExecArray) => void];
const RULES: Rule[] = [
  [/^chain: id equals sheet$/, (w) => { w.chain.chain = 1; }],
  [/^manifest: (.+)\.json present$/, (w, m) => rmSync(join(w.manifestDir, `${m[1]}.json`))],
  [/^manifest: (.+)\.json chain_id equals sheet$/, (w, m) => editManifest(w, `${m[1]}.json`, (o) => { o.chain_id = 1; })],
  [/^manifest: safe\.json has a valid safe address$/, (w) => editManifest(w, "safe.json", (o) => { o.safe = "not-an-address"; })],
  [/^manifest: timelock\.json safe equals safe\.json$/, (w) => editManifest(w, timelockFile(), (o) => { o.safe = OTHER; })],
  [/^manifest: timelock\.json emergency equals sheet$/, (w) => editManifest(w, timelockFile(), (o) => { o.emergency = OTHER; })],
  [/^vault set: registry\.listVaults readable$/, (w) => { w.chain.handlers.delete(`${REGISTRY.toLowerCase()}:listVaults`); }],
  [/^vault set: manifests equal registry\.listVaults$/, (w) => w.chain.set(REGISTRY, "listVaults", Object.values(VAULTS).slice(0, 3).map((v) => v.address))],
  [/^vault set: registry vaultCount equals listVaults length$/, (w) => w.chain.set(REGISTRY, "vaultCount", 5n)],
  [/^vault set: sheet and manifests name the same vaults$/, (w) => { delete w.sheet.vaults.rmPROTO; }],
  [/^usdc: code hash equals pinned FiatTokenProxy$/, (w) => { w.chain.codes.set(USDC_ADDRESS.toLowerCase(), "0x6000"); }],
  [/^libraries: recorded in libs\.json$/, (w) => editManifest(w, "libs.json", (o) => { delete o.tick_math; })],
  [/^deployer: nonce equals sum of frozen counts$/, (w) => { w.chain.noncesMap.set(DEPLOYER.toLowerCase(), 1); }],
  // code present and code equals the build
  [/^(.+): has code$/, (w, m) => { w.chain.codes.delete(subject(m[1]).toLowerCase()); }],
  [/^(.+): runtime code equals build artifact \(masked\)$/, (w, m) => { w.chain.codes.set(subject(m[1]).toLowerCase(), "0x6000"); }],
  // timelock (these come before the generic role rules: the subject is the timelock itself)
  [/^timelock: min delay at least chain floor$/, (w) => w.chain.set(TIMELOCK, "getMinDelay", 60n)],
  [/^timelock: min delay equals sheet$/, (w) => { w.sheet.timelockDelay = 999_999; }],
  [/^timelock: manifest executorPolicy is open$/, (w) => editManifest(w, timelockFile(), (o) => { o.executorPolicy = "safe"; })],
  [/^timelock: manifest cancellerPolicy is safe-only$/, (w) => editManifest(w, timelockFile(), (o) => { o.cancellerPolicy = "any-signer"; })],
  [/^timelock: EXECUTOR_ROLE open to address zero$/, (w) => w.chain.revoke(TIMELOCK, EXECUTOR_ROLE, ZERO)],
  [/^timelock: only the safe holds PROPOSER, CANCELLER or EXECUTOR role \(log scan\)$/, (w) => { w.chain.grant(TIMELOCK, PROPOSER_ROLE, OTHER); w.chain.roleGrantedLog(TIMELOCK, PROPOSER_ROLE, OTHER, 130n); }],
  [/^timelock: (PROPOSER|CANCELLER)_ROLE held by safe$/, (w, m) => w.chain.revoke(TIMELOCK, { PROPOSER: PROPOSER_ROLE, EXECUTOR: EXECUTOR_ROLE, CANCELLER: CANCELLER_ROLE }[m[1]]!, SAFE)],
  [/^timelock: (PROPOSER|EXECUTOR|CANCELLER)_ROLE not held by deployer$/, (w, m) => w.chain.grant(TIMELOCK, { PROPOSER: PROPOSER_ROLE, EXECUTOR: EXECUTOR_ROLE, CANCELLER: CANCELLER_ROLE }[m[1]]!, DEPLOYER)],
  [/^timelock: (PROPOSER|EXECUTOR|CANCELLER)_ROLE not open to address zero$/, (w, m) => w.chain.grant(TIMELOCK, { PROPOSER: PROPOSER_ROLE, EXECUTOR: EXECUTOR_ROLE, CANCELLER: CANCELLER_ROLE }[m[1]]!, ZERO)],
  [/^timelock: admin role held by timelock itself$/, (w) => w.chain.revoke(TIMELOCK, Z32, TIMELOCK)],
  [/^timelock: admin role not held by deployer$/, (w) => w.chain.grant(TIMELOCK, Z32, DEPLOYER)],
  [/^timelock: admin role not held by safe$/, (w) => w.chain.grant(TIMELOCK, Z32, SAFE)],
  // the role matrix
  [/^router: ADMIN_ROLE held by governance$/, (w) => w.chain.revoke(ROUTER, ADMIN_ROLE, GOV)],
  [/^router: WEIGHT_SETTER_ROLE held by governance$/, (w) => w.chain.revoke(ROUTER, WEIGHT_SETTER_ROLE, GOV)],
  [/^router: WEIGHT_SETTER_ROLE not held by (timelock|deployer|safe|pauser|emergency)$/, (w, m) => w.chain.grant(ROUTER, WEIGHT_SETTER_ROLE, { timelock: TIMELOCK, ...WHO }[m[1]]!)],
  [/^router: WEIGHT_SETTER_ROLE has exactly one holder$/, (w) => w.chain.grant(ROUTER, WEIGHT_SETTER_ROLE, OTHER)],
  [/^router: no weight setter rotation pending$/, (w) => w.chain.set(ROUTER, "pendingWeightSetterRotation", [OTHER, 4000n])],
  [/^router: (WEIGHT_SETTER_ROTATOR_ROLE|WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE) has exactly one holder$/, (w, m) => w.chain.grant(ROUTER, m[1] === "WEIGHT_SETTER_ROTATOR_ROLE" ? WEIGHT_SETTER_ROTATOR_ROLE : WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, OTHER)],
  [/^router: WEIGHT_SETTER_ROTATOR_ROLE held by safe$/, (w) => w.chain.revoke(ROUTER, WEIGHT_SETTER_ROTATOR_ROLE, SAFE)],
  [/^router: WEIGHT_SETTER_ROTATOR_ROLE not held by (timelock|deployer|governance|pauser|emergency)$/, (w, m) => w.chain.grant(ROUTER, WEIGHT_SETTER_ROTATOR_ROLE, { timelock: TIMELOCK, governance: GOV, ...WHO }[m[1]]!)],
  [/^router: WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE held by timelock$/, (w) => w.chain.revoke(ROUTER, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, TIMELOCK)],
  [/^router: WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE not held by (safe|deployer|governance|pauser|emergency)$/, (w, m) => w.chain.grant(ROUTER, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, { governance: GOV, ...WHO }[m[1]]!)],
  [/^gateway: DEPOSIT_PAUSER_ROLE held by pauser$/, (w) => w.chain.revoke(GATEWAY, DEPOSIT_PAUSER_ROLE, PAUSER)],
  [/^gateway: DEPOSIT_PAUSER_ROLE not held by deployer$/, (w) => w.chain.grant(GATEWAY, DEPOSIT_PAUSER_ROLE, DEPLOYER)],
  [/^gateway: not paused$/, (w) => w.chain.set(GATEWAY, "depositsPaused", true)],
  [/^gateway: router\(\) equals the deployed router$/, (w) => w.chain.set(GATEWAY, "router", OTHER)],
  [/^registry: router\(\) equals the deployed router$/, (w) => w.chain.set(REGISTRY, "router", OTHER)],
  [/^(.+): ADMIN_ROLE held by timelock$/, (w, m) => w.chain.revoke(subject(m[1]), ADMIN_ROLE, TIMELOCK)],
  [/^(.+): DEFAULT_ADMIN held by timelock$/, (w, m) => w.chain.revoke(subject(m[1]), Z32, TIMELOCK)],
  [/^(.+): DEFAULT_ADMIN not held by deployer$/, (w, m) => w.chain.grant(subject(m[1]), Z32, DEPLOYER)],
  [/^(.+): ADMIN_ROLE not held by (deployer|pauser|emergency|safe)$/, (w, m) => w.chain.grant(subject(m[1]), ADMIN_ROLE, WHO[m[2]])],
  [/^(.+): EMERGENCY_ROLE held by emergency key$/, (w, m) => w.chain.revoke(subject(m[1]), EMERGENCY_ROLE, EMERGENCY)],
  [/^(.+): EMERGENCY_ROLE not held by deployer$/, (w, m) => w.chain.grant(subject(m[1]), EMERGENCY_ROLE, DEPLOYER)],
  // deploy-time configuration (issue 1520)
  [/^governance: votingPower of every voter equals sheet$/, (w) => w.chain.set(GOV, "votingPower", 1n)],
  [/^governance: quorumThreshold equals sheet$/, (w) => w.chain.set(GOV, "quorumThreshold", 99n)],
  [/^governance: votingPeriod equals sheet$/, (w) => w.chain.set(GOV, "votingPeriod", 99_999n)],
  [/^governance: executionDelay equals sheet$/, (w) => w.chain.set(GOV, "executionDelay", 99_999n)],
  [/^router: default weights equal sheet$/, (w) => w.chain.set(ROUTER, "getDefaultWeights", [Object.values(VAULTS).map((v) => v.address), [5000n, 5000n, 0n, 0n]])],
  [/^(vault\[\w+\]): router eligibility equals sheet$/, (w, m) => { w.sheet.vaults[/\[(\w+)\]/.exec(m[1])![1]].routerEligible = false; }],
  // vault facts
  [/^(vault\[\w+\]): registry link$/, (w, m) => w.chain.set(subject(m[1]), "registry", OTHER)],
  [/^(vault\[\w+\]): a second setRegistry reverts$/, (w) => { w.chain.setRegistryOpen = true; }],
  // core 1676: the Uniswap V4 asset of rmAGENT. Each label has the one fault it exists to catch.
  [/^vault\[rmAGENT\]: asset row is venue V4 with the price recorder as its pool$/, (w) => {
    const rm = VAULTS.rmAGENT.address;
    w.chain.set(rm, "assets", (a: any[]) => { if (Number(a[0]) !== 0) throw new Error("execution reverted"); return [w.sheet.vaults.rmAGENT.assets[0]!.token, OTHER, 29100, true, V4_ADAPTER, 1]; });
  }],
  [/^vault\[rmAGENT\]: V4 adapter codehash is allowed$/, (w) => w.chain.set(VAULTS.rmAGENT.address, "adapterCodeHashAllowed", false)],
  [/^vault\[rmAGENT\]: V4 adapter is bound to the recorder, the PoolManager and the pool key$/, (w) => w.chain.set(V4_ADAPTER, "RECORDER", OTHER)],
  [/^recorder: PoolKey and PoolManager equal config$/, (w) => w.chain.set(RECORDER, "tickSpacing", 200)],
  [/^recorder: observation ring holds the full window floor$/, (w) => w.chain.set(RECORDER, "slot0", [1n << 96n, -403009, 3, 900])],
  [/^recorder: has no owner, role or setter$/, (w) => {
    // the recorder code gains the `owner()` selector 0x8da5cb5b, as a PUSH4 would carry it
    w.chain.codes.set(RECORDER.toLowerCase(), `${w.chain.codes.get(RECORDER.toLowerCase())!}638da5cb5b` as `0x${string}`);
  }],
  [/^vault\[rmAGENT\]: holds RM as its one asset$/, (w) => { w.sheet.vaults.rmAGENT.assets = [{ token: addr(0xe7), pool: addr(0xf001), swapFee: 500, adapter: addr(0xad01) }]; }],
  [/^(vault\[\w+\]): tvlCap equals sheet$/, (w, m) => w.chain.set(subject(m[1]), "tvlCap", 1n)],
  [/^(vault\[\w+\]): perDepositCap equals sheet$/, (w, m) => w.chain.set(subject(m[1]), "perDepositCap", 1n)],
  [/^(vault\[\w+\]): exitFeeBps equals sheet$/, (w, m) => w.chain.set(subject(m[1]), "exitFeeBps", 999n)],
  [/^(vault\[\w+\]): navDeviationGuardBps equals sheet$/, (w, m) => w.chain.set(subject(m[1]), "navDeviationGuardBps", 500n)],
  // the vault default: a basket the deploy never armed. Fails "above zero" and "equals sheet" together.
  [/^(vault\[\w+\]): navDeviationGuardBps above zero$/, (w, m) => w.chain.set(subject(m[1]), "navDeviationGuardBps", 0n)],
  // a thin pool: the first asset pool of the vault reports liquidity below the sheet floor
  [/^(vault\[\w+\]): pool liquidity meets the sheet floor$/, (w, m) => w.chain.set(w.sheet.vaults[/\[(\w+)\]/.exec(m[1])![1]].assets[0]!.pool, "liquidity", 1n)],
  [/^(vault\[\w+\]): feeRecipient equals sheet$/, (w, m) => w.chain.set(subject(m[1]), "feeRecipient", OTHER)],
  [/^(vault\[\w+\]): feeRecipient is not deployer$/, (w, m) => w.chain.set(subject(m[1]), "feeRecipient", DEPLOYER)],
  [/^(vault\[\w+\]): paused state equals sheet$/, (w, m) => { const a = subject(m[1]); const was = w.sheet.vaults[/\[(\w+)\]/.exec(m[1])![1]].expectPaused; w.chain.set(a, "depositsPaused", !was); }],
  [/^vault\[rmAGENT\]: asset config equals sheet$/, (w) => { w.sheet.vaults.rmAGENT.assets = [{ token: addr(0xe7), pool: addr(0xf001), swapFee: 500, adapter: addr(0xad01) }]; }],
  [/^(vault\[\w+\]): asset config equals sheet$/, (w, m) => { w.sheet.vaults[/\[(\w+)\]/.exec(m[1])![1]].assets = []; }],
  [/^vault\[rmUSDC\]: seed present$/, (w) => w.chain.set(VAULTS.rmUSDC.address, "totalAssets", 0n)],
  [/^vault\[rmUSDC\]: totalSupply above zero$/, (w) => w.chain.set(VAULTS.rmUSDC.address, "totalSupply", 0n)],
  [/^vault\[rmUSDC\]: manifest deployer share balance after seed is zero$/, (w) => editManifest(w, "vault.json", (o) => { o.deployer_share_balance_after = 5; })],
  [/^vault\[rmUSDC\]: seed share receiver is named and is not the deployer$/, (w) => editManifest(w, "vault.json", (o) => { o.seed_share_receiver = DEPLOYER; })],
  [/^vault\[rmUSDC\]: seed share receiver equals sheet$/, (w) => editManifest(w, "vault.json", (o) => { o.seed_share_receiver = OTHER; })],
  [/^vault\[rmUSDC\]: deployer holds no shares$/, (w) => w.chain.set(VAULTS.rmUSDC.address, "balanceOf", (a: any[]) => (String(a[0]).toLowerCase() === DEPLOYER.toLowerCase() ? 1n : SEED_SHARES))],
  [/^vault\[rmUSDC\]: seed share receiver holds the seed shares$/, (w) => w.chain.set(VAULTS.rmUSDC.address, "balanceOf", 0n)],
  // agents and the role scan
  [/^agents: no agent authorized at handover$/, (w) => w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(SIG_AGENT_AUTHORIZED)), padTopic(OTHER), padTopic(DEPLOYER)], data: "0x", blockNumber: 300n })],
  [/^agents: manifest lists zero agents$/, (w) => editManifest(w, timelockFile(), (o) => { o.roles.gateway_agents_listed_count = 1; })],
  [/^agents: no address holds AGENT_ROLE after handover$/, (w) => { w.chain.roleGrantedLog(GATEWAY, AGENT_ROLE, OTHER, 300n); w.chain.grant(GATEWAY, AGENT_ROLE, OTHER); }],
  [/^agents: manifest says deployer owns no listed agent$/, (w) => editManifest(w, timelockFile(), (o) => { o.roles.deployer_owns_a_listed_gateway_agent = true; })],
  [/^deployer: holds no role on any contract \(log scan\)$/, (w) => w.chain.grant(TIMELOCK, ADMIN_ROLE, DEPLOYER)],
  // the Safe
  [/^safe: singleton is SafeL2 1\.4\.1$/, (w) => { w.chain.storage.set(`${SAFE.toLowerCase()}|${Z32}`, pad(OTHER, { size: 32 })); }],
  [/^safe: version is 1\.4\.1$/, (w) => w.chain.set(SAFE, "VERSION", "1.3.0")],
  [/^safe: proxy code hash equals manifest$/, (w) => editManifest(w, timelockFile(), (o) => { o.code_hashes.safe = keccak256(toHex("other")); })],
  [/^safe: owners equal sheet$/, (w) => { w.chain.owners = [OWNERS[0], OWNERS[1], addr(0x0a9)]; }],
  [/^safe: threshold equals sheet$/, (w) => { w.chain.threshold = 3; }],
  [/^safe: threshold at least 2$/, (w) => { w.chain.threshold = 1; }],
  [/^safe: threshold below owner count$/, (w) => { w.chain.threshold = 3; }],
  [/^safe: owner count at least 3$/, (w) => { w.chain.owners = [OWNERS[0], OWNERS[1]]; }],
  [/^safe: (deployer|emergency|pauser) is not an owner$/, (w, m) => { w.chain.owners = [...OWNERS, WHO[m[1]]]; }],
  [/^safe: no module enabled$/, (w) => { w.chain.modules = [OTHER]; }],
  [/^safe: no guard set$/, (w) => { w.chain.storage.set(`${SAFE.toLowerCase()}|${SAFE_GUARD_SLOT}`, pad(OTHER, { size: 32 })); }],
  [/^safe: fallback handler is canonical$/, (w) => { w.chain.storage.set(`${SAFE.toLowerCase()}|${SAFE_FALLBACK_SLOT}`, pad(OTHER, { size: 32 })); }],
  [/^safe: control proof transaction recorded$/, (w) => { w.opts.controlProof = undefined; }],
  [/^safe: control proof transaction succeeded$/, (w) => { w.chain.txs.get(PROOF_TX.toLowerCase())!.status = "reverted"; }],
  [/^safe: control proof is a self-call signed by every owner$/, (w) => { w.chain.txs.get(PROOF_TX.toLowerCase())!.input = proofInput(8453, OWNER_KEYS.slice(0, 2)); }],
  [/^safe: nonce at least 1$/, (w) => w.chain.set(SAFE, "nonce", 0n)],
  [/^safe: control below-threshold signatures revert GS020$/, (w) => { w.chain.threshold = 1; }],
  [/^safe: control non-owner signature reverts GS026$/, (w) => { w.chain.owners = [...OWNERS, SAFE_PROBE_ADDRESS]; }],
  [/^safe: control non-owner pair reverts GS026$/, (w) => { w.chain.owners = [...OWNERS, SAFE_PROBE_ADDRESS_2]; }],
];

function plant(w: World, label: string): void {
  const rule = RULES.find(([re]) => re.test(label));
  if (!rule) throw new Error(`no negative fixture for verifier label '${label}': add a rule to RULES`);
  rule[1](w, rule[0].exec(label)!);
}

describe("negative fixture for every verifier label", () => {
  test("the committed label list is not empty and has no duplicates", () => {
    expect(LABELS.length).toBeGreaterThan(150);
    expect(new Set(LABELS).size).toBe(LABELS.length);
  });

  test("every label has a planted fault (no label ships without a negative fixture)", () => {
    const missing = LABELS.filter((l) => !RULES.some(([re]) => re.test(l)));
    expect(missing).toEqual([]);
  });

  test("the healthy world fails nothing, so every failure below is the planted fault", async () => {
    expect(failed(await verifyDeployment(buildWorld().opts))).toEqual([]);
  });

  test.each(LABELS)("%s fails when its fault is planted", async (label) => {
    const w = buildWorld(8453);
    plant(w, label);
    const r = await verifyDeployment(w.opts);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain(label);
  });
});
