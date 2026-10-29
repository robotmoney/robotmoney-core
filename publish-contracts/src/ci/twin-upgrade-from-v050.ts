#!/usr/bin/env bun
// Issue 1927: the Twin rehearsal of the v0.6.0 governed upgrade of the live v0.5.0 deployment (runbook docs/operations/contract-release-runbooks.md 4.15), from REAL v0.5.0 state.
// The job first publishes release/v0.5.0-rehearsal on the Twin fork with that tag's own publish-contracts CLI and its committed Twin sheet (the tag's twin-publish step script, rehearsal
// kind, upgradeable overlay): four vaults, rmAGENT router-eligible, the receipt in ic-policy.json, the v0.5.0 implementations and an applied receipt vector, as on Deploy 3. Then this
// driver runs the 4.15 commands, exactly as UPGRADE_FROM_V050_COMMANDS lists them, from the qa checkout (the CLI of this line):
//   --core-dir and --core-sha are the v0.5.0 checkout (the build that is live: its stage table, its manifest set, its deployed layout snapshots, its link offsets) and
//   --upgrade-build "$PWD" is the qa checkout (the new implementations and their snapshots).
// Every schedule and execute goes through the real Safe and timelock; the time warp inside govern is the only Twin-only step. It then reads the end state back from the chain and writes
// <V050_RUN_DIR>/upgrade-from-v050.json, which the workflow asserts with jq. Any failure exits non-zero. A record with no executed upgrade is never written.
// Environment in: RPC_URL, V050_RUN_DIR (the tag's twin-publish run directory: keys, passphrase, sheet.env, manifests, evidence, counts), V050_DIR (the clean v0.5.0 checkout the tag's
// publish ran in), GITHUB_WORKSPACE (the qa checkout, after forge build), GITHUB_ENV (optional). Never use this against Base mainnet.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../verify/codehash.ts";
import { rpcCallRevert } from "../evidence-check.ts";
import { parseSheetText } from "../sheet.ts";
import { loadStageTable } from "../stage-table.ts";
import { useStageTable } from "../stages.ts";
import { loadReceiptAddr } from "../govern.ts";

export { AGENT_POOL_FLOOR, RETIRE_WEIGHTS, UPGRADE_FROM_V050_COMMANDS, UPGRADE_FROM_V050_ENV, V050_SHA, V050_TAG } from "./upgrade-from-v050-commands.ts";
import { AGENT_POOL_FLOOR, UPGRADE_FROM_V050_COMMANDS, UPGRADE_FROM_V050_ENV, V050_SHA, V050_TAG } from "./upgrade-from-v050-commands.ts";

/** The record kind the workflow asserts. */
export const UPGRADE_FROM_V050_KIND = "twin-upgrade-from-v050";

/** One runbook line to argv: `$COMMON` becomes `common`, `"$PWD"` and every `$NAME` (or `$NAME/rest`) the value in `vars`. An unknown name throws. */
export function expandCommand(line: string, common: readonly string[], vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) {
    const tok = m[1] ?? m[2]!;
    if (m[2] === "$COMMON") { out.push(...common); continue; }
    out.push(tok.replace(/\$\{?([A-Z_0-9]+)\}?/g, (_x, n: string) => {
      const v = vars[n];
      if (v === undefined) throw new Error(`the command ${line} names $${n}, which has no value`);
      return v;
    }));
  }
  return out;
}

async function main(): Promise<void> {
  const env = (k: string, d = ""): string => process.env[k] ?? d;
  const fail = (m: string): never => { console.error(`twin-upgrade-from-v050: ${m}`); process.exit(1); };
  const say = (event: string, fields: Record<string, unknown> = {}) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: `upgrade_from_v050.${event}`, ...fields }));
  const qa = env("GITHUB_WORKSPACE") || fail("GITHUB_WORKSPACE is not set (the qa checkout)");
  const v050 = env("V050_DIR") || fail("V050_DIR is not set (the v0.5.0 checkout)");
  const rh = env("V050_RUN_DIR") || fail("V050_RUN_DIR is not set: publish release/v0.5.0-rehearsal with its own twin-publish first");
  const rpc = env("RPC_URL") || fail("RPC_URL is not set");
  const bun = process.execPath;
  const git = (dir: string, args: string[]): string => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) fail(`git -C ${dir} ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().trim();
  };
  const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
  const lcEq = (x: unknown, y: unknown): boolean => String(x).toLowerCase() === String(y).toLowerCase();
  const isTx = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);

  // ---- the two checkouts (runbook 4.15 step 0): HEAD, a clean tree and the tag for the v0.5.0 one; HEAD and a clean tree for the qa one (a Twin run has no rc tag) ----
  if (git(v050, ["rev-parse", "HEAD"]) !== V050_SHA) fail(`the v0.5.0 checkout ${v050} is not at ${V050_SHA}`);
  if (git(v050, ["status", "--porcelain"]) !== "") fail(`the v0.5.0 checkout ${v050} is not clean`);
  if (git(v050, ["rev-parse", `${V050_TAG}^{commit}`]) !== V050_SHA) fail(`${V050_TAG} does not point at ${V050_SHA}`);
  const qaSha = git(qa, ["rev-parse", "HEAD"]);
  if (git(qa, ["status", "--porcelain"]) !== "") fail(`the qa checkout ${qa} is not clean`);

  // ---- the sheet the tag published with: rmAGENT's pool floor is the unlowered 1e15 ----
  const sheet = join(rh, "sheet.env");
  const floor = parseSheetText(readFileSync(sheet, "utf8")).VAULT_AGENT_MIN_POOL_LIQUIDITY;
  if (floor !== AGENT_POOL_FLOOR) fail(`the published sheet's VAULT_AGENT_MIN_POOL_LIQUIDITY is ${JSON.stringify(floor)}, want exactly ${AGENT_POOL_FLOOR}`);

  const manifests = join(rh, "manifests"), evidence = join(rh, "evidence"), pass = join(rh, "passphrase");
  const m = (file: string, field: string): Address => getAddress(String(json(join(manifests, `${file}.json`))[field])) as Address;
  const timelock = m("timelock", "timelock"), governance = m("governance", "governance"), registry = m("registry", "registry"), router = m("router", "router");
  const rmAgent = m("agent-token-vault", "vault");
  const receipt = m("ic-policy", "consensus_receipt");
  const deployed = json(join(manifests, "upgradeability.json"));
  if (deployed.mode !== "upgradeable") fail(`the v0.5.0 upgradeability.json says mode ${deployed.mode}: publish with the upgrade overlay`);
  const from = { gateway: String(deployed.proxies?.gateway?.implementation), receipt: String(deployed.proxies?.receipt?.implementation) };
  const client = createPublicClient({ transport: http(rpc) });
  const implOf = async (proxy: Address): Promise<Address> => getAddress(`0x${((await client.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT })) ?? "0x").replace(/^0x/, "").padStart(64, "0").slice(24)}`) as Address;
  const gateway = getAddress(String(deployed.proxies?.gateway?.proxy)) as Address;
  if (!lcEq(await implOf(gateway), from.gateway) || !lcEq(await implOf(receipt), from.receipt)) fail(`the live implementations are not the ones the v0.5.0 upgradeability.json records (${JSON.stringify(from)})`);
  say("v050_state", { gateway, receipt, from, rmAgent, layout_ids: { gateway: deployed.proxies.gateway.layout_id, receipt: deployed.proxies.receipt.layout_id } });

  // ---- the 4.15 commands, with the Twin's arguments ----
  const common = ["--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet, "--core-dir", v050, "--core-sha", V050_SHA, "--evidence", evidence, "--environment", "stage",
    "--signer", `keystore:${join(rh, "keys", "DEPLOYER")}:${pass}`, "--counts-dir", join(rh, "counts")];
  const vars: Record<string, string> = { PWD: qa, EVIDENCE: evidence, TIMELOCK: timelock, GOVERNANCE: governance, REGISTRY: registry, RMAGENT: rmAgent, BASE_RPC_URL: rpc };
  // the runbook's environment (UPGRADE_FROM_V050_ENV), with the Twin's values
  const envValues: Record<(typeof UPGRADE_FROM_V050_ENV)[number], string> = { PUBLISH_MANIFEST_DIR: manifests };
  const runEnv: Record<string, string> = Object.fromEntries(UPGRADE_FROM_V050_ENV.map((k) => [k, envValues[k]]));
  const ran: { line: string; exit: number; out: string }[] = [];
  const runLine = (i: number, extraVars: Record<string, string> = {}): string => {
    const argv = expandCommand(UPGRADE_FROM_V050_COMMANDS[i]!, common, { ...vars, ...extraVars });
    say("command", { step: i, line: UPGRADE_FROM_V050_COMMANDS[i] });
    const r = Bun.spawnSync([bun, ...argv.slice(1)], { cwd: qa, env: { ...process.env, ...runEnv, YES: "1" }, stdout: "pipe", stderr: "inherit" });
    const out = r.stdout.toString();
    process.stdout.write(out);
    writeFileSync(join(rh, `upgrade-from-v050-${i}.out`), out);
    ran.push({ line: UPGRADE_FROM_V050_COMMANDS[i]!, exit: r.exitCode ?? -1, out: `upgrade-from-v050-${i}.out` });
    if (r.exitCode !== 0) fail(`${UPGRADE_FROM_V050_COMMANDS[i]} exited ${r.exitCode}`);
    return out;
  };
  const deployedImpl = (out: string, proxy: string): Address => {
    const ev = JSON.parse(out.split("\n").find((l) => l.includes('"event":"deploy_implementation"')) ?? fail(`deploy-implementation --proxy ${proxy} printed no deploy_implementation line`));
    if (ev.reused !== false || !isTx(ev.deploy_tx) || ev.proxy !== proxy) fail(`deploy-implementation --proxy ${proxy} did not deploy: ${JSON.stringify(ev)}`);
    return getAddress(ev.implementation) as Address;
  };

  // steps 3 to 5: the gateway, then the receipt with its typed migration
  const gatewayImpl = deployedImpl(runLine(0), "gateway");
  runLine(1, { GATEWAY_IMPL: gatewayImpl });
  if (!lcEq(await implOf(gateway), gatewayImpl)) fail(`after its upgrade the gateway runs ${await implOf(gateway)}, not ${gatewayImpl}`);
  const receiptImpl = deployedImpl(runLine(2), "receipt");
  runLine(3, { RECEIPT_IMPL: receiptImpl });
  if (!lcEq(await implOf(receipt), receiptImpl)) fail(`after its upgrade the receipt runs ${await implOf(receipt)}, not ${receiptImpl}`);

  // step 6: the retire batch under the applied receipt vector the tag's rehearsal left, as on Deploy 3. Nothing clears it (issue 1988): the retire leaves it active and unchanged,
  // and the router skips its rmAGENT leg (the row reads that back from previewDeposit). The next receipt sets the three-vault vector.
  const ROUTER_ABI = parseAbi(["function votedWeightsActive() view returns (bool)", "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)", "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)", "function getWeights() view returns (address[] vaults, uint256[] bps)"]);
  const voted = async (): Promise<boolean> => (await client.readContract({ address: router, abi: ROUTER_ABI, functionName: "votedWeightsActive" })) as boolean;
  const appliedKey = async (): Promise<string> => { const [v, b] = (await client.readContract({ address: router, abi: ROUTER_ABI, functionName: "getWeights" })) as [Address[], bigint[]]; return v.map((x, i) => `${x.toLowerCase()}:${b[i]}`).join(","); };
  const votedBefore = await voted();
  if (!votedBefore) fail("no applied receipt vector is active before the retire (the tag's twin-publish applies one): the retire under an active vector (issue 1988) is not exercised");
  const appliedBefore = await appliedKey();
  runLine(4);
  const votedAfter = await voted();
  const appliedAfter = await appliedKey();
  if (!votedAfter || appliedAfter !== appliedBefore) fail(`the retire changed the applied receipt vector: active ${votedAfter}, before [${appliedBefore}], after [${appliedAfter}]`);
  // steps 8 and 9: verify, and both evidence checks against the chain
  runLine(5);
  // Issue 1933: the 8453 branch of verify (verify-stage.ts) reads the receipt address through the loaded stage table and backs every receipt_applications entry of the run manifest
  // with its timelock batch on chain. The v0.5.0 table has no receipt stage (the receipt sits in ic-policy), and the Twin chain id skips that branch, so this job runs both halves on
  // the Twin by the same functions: loadReceiptAddr (the lookup verify calls) over the v0.5.0 table, then the checker verify calls, checkReceiptApplications and its on-chain half,
  // through evidence-check --receipt-applications, which reads the chain over the Twin RPC. The tag's own publish applied the receipt (govern --row apply-receipt), so the entry is genuine.
  const applied = (loadJson(join(evidence, "publish-run.json")).receipt_applications ?? []) as unknown[];
  if (applied.length === 0) fail("the v0.5.0 run manifest holds no receipt_applications (the tag's twin-publish applies one): the verify path that broke on Deploy 3 is not exercised");
  useStageTable(loadStageTable(v050));
  const resolvedReceipt = loadReceiptAddr({ coreDir: v050, chainId: TWIN_CHAIN_ID, manifestOut: manifests });
  if (!lcEq(resolvedReceipt, receipt)) fail(`the receipt the v0.5.0 table resolves (${resolvedReceipt}) is not the live receipt ${receipt}`);
  const backing = Bun.spawnSync([bun, join(qa, "publish-contracts", "src", "evidence-check.ts"), "--receipt-applications", join(evidence, "publish-run.json"), "--deployment-kind", "rehearsal",
    "--consensus-receipt", resolvedReceipt, "--governance", governance, "--timelock", timelock, "--rpc", rpc], { cwd: qa, stdout: "pipe", stderr: "pipe" });
  process.stdout.write(backing.stdout.toString());
  if (backing.exitCode !== 0) fail(`evidence-check --receipt-applications exited ${backing.exitCode}: ${backing.stderr.toString().trim()}`);
  const governed = runLine(6);
  if (!/^evidence ok \(governed upgrades: 2 upgrade\(s\), 1 with a typed migration, chain read\)$/m.test(governed)) fail(`evidence-check --governed-upgrades did not read both upgrades and the migration from the chain: ${governed}`);
  const retired = runLine(7);
  if (!/^evidence ok \(vault retirements: 1 retirement\(s\), chain read\)$/m.test(retired)) fail(`evidence-check --vault-retirements did not read the retirement from the chain: ${retired}`);

  // ---- the end state, read from the chain ----
  const REGISTRY_ABI = parseAbi(["function routerEligibleCount() view returns (uint256)", "function isRouterEligible(address vault) view returns (bool)"]);
  const VAULT_ABI = parseAbi(["function retired() view returns (bool)"]);
  const RECEIPT_ABI = parseAbi(["function RECEIPT_RELEASER_ROLE() view returns (bytes32)", "function ADMIN_ROLE() view returns (bytes32)", "function getRoleMemberCount(bytes32 role) view returns (uint256)", "function getRoleMember(bytes32 role, uint256 index) view returns (address)"]);
  const rc = <T>(functionName: string, args: unknown[] = []): Promise<T> => client.readContract({ address: receipt, abi: RECEIPT_ABI, functionName, args } as any) as Promise<T>;
  const releaserRole = await rc<Hex>("RECEIPT_RELEASER_ROLE"), adminRole = await rc<Hex>("ADMIN_ROLE");
  const members = async (role: Hex): Promise<Address[]> => { const n = await rc<bigint>("getRoleMemberCount", [role]); const out: Address[] = []; for (let i = 0n; i < n; i++) out.push(await rc<Address>("getRoleMember", [role, i])); return out; };
  const MIGRATE = encodeFunctionData({ abi: parseAbi(["function migrateToSubmitterRoles(address releaser)"]), functionName: "migrateToSubmitterRoles", args: [governance] });
  const rerun = await rpcCallRevert(rpc)({ from: timelock, to: receipt, data: MIGRATE });
  const INVALID_INITIALIZATION: Hex = keccak256(toBytes("InvalidInitialization()")).slice(0, 10) as Hex;
  const [dv, db] = (await client.readContract({ address: router, abi: ROUTER_ABI, functionName: "getDefaultWeights" })) as [Address[], bigint[]];
  const run = loadJson(join(evidence, "publish-run.json"));
  const upgrades = ((run.proxy_upgrades ?? []) as any[]).filter((e) => e?.proxy_name === "gateway" || e?.proxy_name === "receipt");
  const retirements = ((run.vault_retirements ?? []) as any[]).filter((e) => lcEq(e?.vault, rmAgent));
  const record = {
    kind: UPGRADE_FROM_V050_KIND, chain_id: TWIN_CHAIN_ID, v050: { tag: V050_TAG, sha: V050_SHA, upgradeability: deployed, agent_min_pool_liquidity: AGENT_POOL_FLOOR }, qa_sha: qaSha,
    commands: ran, voted_weights_active_before: votedBefore, voted_weights_active_after: votedAfter, applied_vector_unchanged: appliedAfter === appliedBefore,
    proxy_upgrades: upgrades.map((e) => ({ proxy_name: e.proxy_name, proxy: e.proxy, from_implementation: e.from_implementation, to_implementation: e.to_implementation, build: e.build, migration: e.migration?.name ?? null, operation_id: e.operation_id, schedule_tx: e.schedule_tx, execute_tx: e.execute_tx ?? null })),
    vault_retirements: retirements.map((e) => ({ vault: e.vault, operation_id: e.operation_id, schedule_tx: e.schedule_tx, execute_tx: e.execute_tx ?? null })),
    chain: {
      router_eligible_count: Number((await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "routerEligibleCount" })) as bigint),
      rmagent_retired: (await client.readContract({ address: rmAgent, abi: VAULT_ABI, functionName: "retired" })) as boolean,
      rmagent_router_eligible: (await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "isRouterEligible", args: [rmAgent] })) as boolean,
      default_weights: dv.map((v, i) => `${v}:${db[i]}`),
      receipt_releaser_role_holders: await members(releaserRole), receipt_admin_role_holders: await members(adminRole), governance, timelock,
      second_migration_revert_selector: rerun === undefined ? null : rerun.slice(0, 10), invalid_initialization_selector: INVALID_INITIALIZATION,
      gateway_implementation: await implOf(gateway), receipt_implementation: await implOf(receipt),
    },
  };
  const out = join(rh, "upgrade-from-v050.json");
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  say("done", { record: out, upgrades: upgrades.length, retirements: retirements.length });
  const ghEnv = env("GITHUB_ENV");
  if (ghEnv) appendFileSync(ghEnv, `TWIN_UPGRADE_FROM_V050=${out}\n`);
}

const loadJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

if (import.meta.main) await main();
