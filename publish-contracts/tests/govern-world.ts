// Shared by the govern tests: the manifest fixtures and the in-memory fake of the Safe tool's entry points (a timelock that checks order and delay).
// The real Safe, the real signers and the real delay are exercised on the Twin chain run and on 8453 (runbook Q2), never here.
// The fake Safe keeps a LIVE roster (QA plan v1 B4): connectSafe returns the owners and threshold the Safe self-administration rows have changed, and executeTx
// enforces the Safe's own rules with the Safe's error codes (GS020 below threshold, GS201 threshold above owner count, GS203, GS204, GS205 wrong prevOwner)
// and the timelock's role gates (PROPOSER_ROLE on schedule, CANCELLER_ROLE on cancel), so a tool bug that proposes a doomed call fails here, not on the Twin.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { publishLogger } from "../src/log.ts";
import type { RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { getStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { AGENT_ROLE, stageManifestName } from "../src/verify/constants.ts";
import { SAFE_141, type Signer } from "../src/safe/index.ts";
import { RECEIPT_ABI, SAFE_ADMIN_ABI, SAFE_SENTINEL_OWNER, VAULT_ABI, type GovernApi } from "../src/govern.ts";
import { GOVERNANCE_APPLY_ABI } from "../src/apply-receipt.ts";
import { REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI } from "../src/redeploy-vault.ts";
import { VAULT_UNWIND_GUARD_ABI } from "../src/unwind-guard.ts";
import { GOVERNED_PROXY_ABI } from "../src/upgrade-rows.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../src/verify/codehash.ts";
import { SHA, sheetText, tmp } from "./fixtures.ts";

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const A = { timelock: addr(0x2001), safe: addr(0x2002), router: addr(0x1003), registry: addr(0x1002), gateway: addr(0x1004), governance: addr(0x1005), receipt: addr(0x1006), vaults: { USDC: addr(0x3001), PROTO: addr(0x3002), RWA: addr(0x3004) } };
/** The vault a retire-vault round retires (rmAGENT on the live v0.5.0 deployment): not in any manifest of a three-vault deployment, so it is an address the sheet and the manifests never name. */
export const RETIRED_VAULT = addr(0x3003);

/** Writes the manifests govern reads (timelock, safe, router, registry, gateway, governance, the receipt stage's receipt, one per vault) into `dir`. */
export function writeGovernManifests(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const w = (f: string, o: object) => writeFileSync(join(dir, `${f}.json`), JSON.stringify(o));
  const t = getStageTable();
  const n = (stage: string) => stageManifestName(t, stage);
  w(n("timelock"), { timelock: A.timelock }); w("safe", { safe: A.safe }); w(n("router"), { router: A.router }); w(n("registry"), { registry: A.registry });
  w(n("gateway"), { gateway: A.gateway }); w(n("governance"), { governance: A.governance }); w(n("receipt"), { consensus_receipt: A.receipt });
  for (const v of t.vaults) w(manifestBase(v.manifest), { vault: A.vaults[v.key] });
}

export function setup(sheetOver: Record<string, string | null> = {}, chainId = 918453) {
  const coreDir = tmp("pc-govern-");
  writeGovernManifests(join(coreDir, "deployments", String(chainId)));
  const sheet = parseSheet(sheetText(sheetOver));
  const lines: string[] = [];
  const ctx = { coreDir, chainId, sheet, coreSha: SHA, rpc: "http://x", evidenceDir: join(coreDir, "evidence"), log: publishLogger((l) => lines.push(l)) } as unknown as RunContext;
  return { ctx, sheet, lines };
}

export type Op = { exists: boolean; pending: boolean; done: boolean; readyAt: bigint };
export function fakeTimelock(sheet: ReturnType<typeof parseSheet>, startMinDelay = 60n) {
  const s = {
    clock: 1000n, minDelay: startMinDelay, ops: new Map<string, Op>(), log: [] as string[], signed: [] as string[], nonce: 0,
    /** `kind:row` per timelock bundle built, in order: the row is the first word of the description. */
    events: [] as string[],
    /** The scheduled calls per row, with the timelock predecessor each operation carries (undefined: none) and the description of the Safe transaction that scheduled it. */
    scheduled: new Map<string, { form: string; calls: { target: string; data: string }[]; predecessor?: string; description?: string; salt: Hex }>(),
    /** The timelock operation id of each scheduled row. */
    ids: new Map<string, Hex>(),
    /** Every transaction hash the fake Safe sent, per timelock operation id: a Safe transaction shared by two operations would show here. */
    safeTxs: new Map<string, string[]>(),
    /** Overrides for a read: `functionName` to the value the chain returns. */
    reads: {} as Record<string, unknown>,
    /** Receipt ids recordReceipt has anchored (the test seeds it) and releaseReceipt has released (an executed timelock call adds to it). */
    recorded: new Set<string>(), released: new Set<string>(),
    /** The vaults that read depositsPaused true. All three vaults deploy paused (issue 1710); an executed unpauseDeposits opens a vault, a test pauses one by adding it. */
    paused: new Set<string>([A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA]),
    /** Registry order, the vaults that are NOT router-eligible, the digest each recorded receipt stored, and the router's default weights (an executed setDefaultWeights sets them). */
    listed: [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA] as Address[], ineligible: new Set<string>(),
    digests: new Map<string, Hex>(),
    /** Issue 1831: a receipt's recordedAt (default: its 1-based position in `recorded`, so receipts seeded in order are recorded in order), RouterGovernance's
     *  lastAppliedRecordedAt (an executed applyReceipt raises it and refuses a receipt not newer), and whether RouterGovernance holds the receipt ADMIN_ROLE. */
    recordedAt: new Map<string, bigint>(), lastAppliedRecordedAt: 0n,
    /** Issue 1888: who holds what on the receipt. RouterGovernance holds RECEIPT_RELEASER_ROLE (not ADMIN_ROLE), the timelock holds ADMIN_ROLE, and the submitter Safes granted RECEIPT_SUBMITTER_ROLE (lowercase). */
    governanceIsReceiptReleaser: true, governanceIsReceiptAdmin: false, timelockIsReceiptAdmin: true, submitterRoles: new Set<string>(),
    vaultCaps: new Map<string, bigint>(),
    weights: { vaults: [] as Address[], bps: [] as bigint[] },
    /** Issue 1743: the ACTIVE ("voted") vector on the router. An executed applyReceipt sets it (issue 1698). While set, votedWeightsActive reads true and getEffectiveWeights reads it
     *  instead of the default. Nothing removes it (issue 1988): only a newer applyReceipt replaces it. */
    voted: undefined as { vaults: Address[]; bps: bigint[] } | undefined,
    /** The chain clock at each Safe transaction hash: getTransactionReceipt answers with it as the block number, getBlock({blockNumber}) as the timestamp. */
    txClock: new Map<string, bigint>(),
    /** QA plan v1 C2: what getTransactionReceipt adds for a deploy transaction (a redeploy's): its sender, the contract a CREATE made (null for a call) and its status. */
    txReceipts: new Map<string, { from?: string; contractAddress?: string | null; status?: "success" | "reverted" }>(),
    /** Issue 1727: the gateway's agents (AGENT_ROLE), the IC policy's committee agents (label) and the owner each agent has. An executed authorizeAgent / committeeRegister fills them. */
    /** Issue 1750: what the --submitter is on chain. A canonical 2-of-3 Safe by default; null is a key (no code); a function decides per address. */
    submitterKind: undefined as undefined | null | ((a: Address) => unknown),
    /** Issue 1796: the registry status of a vault (0 Active, 1 DepositsPaused, 2 Retired), the vaults whose retire() flag is set, the registry's router, and whether the timelock holds ADMIN_ROLE on the registry. */
    statuses: new Map<string, number>(), retiredFlag: new Set<string>(), registryRouter: A.router as Address, timelockIsRegistryAdmin: true,
    /** The vaults a redeploy left linked to the registry (registry() reads A.registry) and the vaults the timelock governs. */
    linked: new Set<string>(), governed: new Set<string>(),
    /** Whether the timelock holds the router's ADMIN_ROLE (DeployTimelock grants it at stage 11; the redeploy batch's setVaultCap needs it). */
    timelockIsRouterAdmin: true,
    /** Issue 1796: a call of a timelock batch that reverts. The fake timelock is ATOMIC like the contract: a throwing call leaves the batch's earlier effects undone. */
    failOn: undefined as undefined | ((c: { target: string; data: Hex }) => boolean),
    agentRole: new Set<string>(), committee: new Map<string, string>(), agentOwner: new Map<string, string>(), gatewayAdmins: new Set<string>(),
    /** QA plan v1 B6: the gateway's live commitments (by storage key, the commit "block" is the clock) and each agent's stored policy (agents(agent) reads it). */
    commitments: new Map<string, { committer: string; block: bigint }>(),
    policies: new Map<string, { maxPerPayment: bigint; maxPerWindow: bigint; shareReceiver: string; maxWithdrawPerPayment: bigint; maxWithdrawPerWindow: bigint }>(),
    /** QA plan v1 D7: each basket vault's asset rows (assets(i), in order) and the emergency unwind guard per `vault|token` (lowercase). An executed setEmergencyUnwindGuard writes it. */
    assetRows: new Map<string, { token: Address; active: boolean }[]>(),
    guards: new Map<string, readonly [bigint, boolean, bigint]>(),
    /**
     * The Safe's owner list and threshold on chain (Safe self-administration rows change them), and the timelock roles as `role:account`: after the timelock stage the
     * Safe is the one proposer and canceller (DeployTimelock), so the fake seeds both (QA plan v1 B4: schedule and cancel check them).
     */
    owners: [...sheet.safeOwners] as string[], threshold: BigInt(sheet.safeThreshold), roles: new Set<string>([`${PROPOSER_ROLE_ID}:${A.safe.toLowerCase()}`, `${CANCELLER_ROLE_ID}:${A.safe.toLowerCase()}`]),
    /** Issue 1842: the GovernedUUPS proxies (lower-case address to its implementation and freeze flag), the code at an address (else a default), and every call the timelock
     *  scheduled (the CallScheduled logs the freeze row scans). An executed upgradeToAndCall moves the implementation, an executed freezeUpgrades sets the flag, as the library does. */
    proxies: new Map<string, { impl: Address; frozen: boolean }>(), codes: new Map<string, Hex>(), scheduledCalls: [] as { id: Hex; target: Address; data: Hex }[],
    /** Issue 1859: the transaction of each timelock CallScheduled and CallExecuted log, keyed `event:operation id` (what operationTx finds). A test deletes one to model a log not found. */
    timelockLogs: new Map<string, Hex>(),
  };
  const recordedAtOf = (rid: string): bigint => s.recordedAt.get(rid.toLowerCase()) ?? BigInt([...s.recorded].map((x) => x.toLowerCase()).indexOf(rid.toLowerCase()) + 1);
  const receiptHasRole = (role: string, who: string): boolean => {
    const r = role.toLowerCase(), w = who.toLowerCase();
    if (r === ADMIN_ROLE_ID.toLowerCase()) return w === A.timelock.toLowerCase() ? s.timelockIsReceiptAdmin : w === A.governance.toLowerCase() ? s.governanceIsReceiptAdmin : false;
    if (r === RELEASER_ROLE_ID.toLowerCase()) return w === A.governance.toLowerCase() && s.governanceIsReceiptReleaser;
    if (r === SUBMITTER_ROLE_ID.toLowerCase()) return s.submitterRoles.has(w);
    return false;
  };
  const rowOf = (d?: string) => (d ?? "").split(/[ :]/)[0]!;
  const idOf = (p: { calls: { target: string; data: string }[]; salt: string; form?: string; predecessor?: string }): Hex => keccak256(toBytes(JSON.stringify([p.calls.map((c) => [c.target, c.data]), p.salt, p.form ?? "batch", p.predecessor ?? null])));
  const handle: any = {
    address: A.safe, chain: { rpcUrl: "x", chainId: 918453 },
    // The live roster (B4): what connectSafe reads from the chain. A Safe self-administration row changes it, so a second row in the same world signs against the
    // owners and threshold the chain holds now, not the sheet's. A test may still assign them (a Safe whose owners differ from the sheet).
    get owners(): string[] { return s.owners; }, set owners(v: string[]) { s.owners = [...v]; },
    get threshold(): number { return Number(s.threshold); }, set threshold(v: number) { s.threshold = BigInt(v); },
    client: {
      getCode: async ({ address }: { address?: string } = {}) => s.codes.get(String(address).toLowerCase()) ?? "0x6001600155",
      getStorageAt: async ({ address, slot }: { address: string; slot: string }) => {
        const p = s.proxies.get(address.toLowerCase());
        return slot.toLowerCase() === ERC1967_IMPLEMENTATION_SLOT && p ? (`0x${"0".repeat(24)}${p.impl.slice(2).toLowerCase()}` as Hex) : (`0x${"0".repeat(64)}` as Hex);
      },
      // the chain head: the fake's clock is also its block number (getTransactionReceipt answers the clock of a transaction as its block)
      getBlockNumber: async () => s.clock,
      getBlock: async (a?: { blockNumber?: bigint }) => ({ timestamp: a?.blockNumber ?? s.clock }),
      getTransactionReceipt: async ({ hash }: { hash: string }) => ({ blockNumber: s.txClock.get(hash) ?? s.clock, status: "success", ...s.txReceipts.get(hash.toLowerCase()) }),
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
        const key = Object.entries(A.vaults).find(([, v]) => v === address)?.[0] as "USDC" | undefined;
        if (functionName in s.reads) return s.reads[functionName];
        switch (functionName) {
          case "tvlCap": return sheet.vaults[key!].tvlCap;
          case "perDepositCap": return sheet.vaults[key!].perDepositCap;
          case "exitFeeBps": return sheet.vaults[key!].exitFeeBps;
          case "isRouterEligible": return !s.ineligible.has(String(args?.[0]));
          case "getVault": return [{ name: "Robot Money Protocol", asset: addr(0xc0de), registeredAt: 1n }, s.statuses.get(String(args?.[0])) ?? 0];
          case "routerEligibleCount": return BigInt(s.listed.filter((v) => !s.ineligible.has(v)).length);
          case "router": return s.registryRouter;
          case "retired": return s.retiredFlag.has(address);
          case "registry": return s.linked.has(address) ? A.registry : addr(0);
          case "listVaults": return s.listed;
          case "getReceiptById": return { payloadDigest: s.digests.get(String(args?.[0]).toLowerCase()), recordedAt: recordedAtOf(String(args?.[0])) };
          case "lastAppliedRecordedAt": return s.lastAppliedRecordedAt;
          case "vaultCap": return s.vaultCaps.get(String(args?.[0])) ?? 0n;
          case "getDefaultWeights": return [s.weights.vaults, s.weights.bps];
          case "getWeights": return s.voted ? [s.voted.vaults, s.voted.bps] : [[], []];
          case "getEffectiveWeights": return s.voted ? [s.voted.vaults, s.voted.bps] : [s.weights.vaults, s.weights.bps];
          case "votedWeightsActive": return s.voted !== undefined;
          // PortfolioRouter.previewDeposit: one leg per effective leg; a leg whose vault is not registry-Active, not eligible or retired is unavailable with amount 0 (issue 1988)
          case "previewDeposit": {
            const [vs, bps] = s.voted ? [s.voted.vaults, s.voted.bps] : [s.weights.vaults, s.weights.bps];
            const ok = vs.map((v) => (s.statuses.get(v) ?? 0) === 0 && !s.ineligible.has(v) && !s.retiredFlag.has(v));
            const live = bps.reduce((t, b, i) => (ok[i] ? t + b : t), 0n);
            const amount = BigInt(args?.[0] as bigint);
            return vs.map((v, i) => ({ vault: v, weightBps: bps[i]!, legAmount: ok[i] && live > 0n ? (amount * bps[i]!) / live : 0n, estShares: 0n, unavailable: !ok[i] }));
          }
          case "depositsPaused": return s.paused.has(address);
          case "feeRecipient": return sheet.feeRecipient === "@safe" ? A.safe : sheet.feeRecipient;
          // RobotMoneyGateway.agents(agent): the public getter's eight non-array fields (QA plan v1 B6 reads the policy shape)
          case "agents": { const p = s.policies.get(String(args?.[0]).toLowerCase()); return p ? [true, 0n, p.maxPerPayment, p.maxPerWindow, p.shareReceiver, addr(0), p.maxWithdrawPerPayment, p.maxWithdrawPerWindow] : [false, 0n, 0n, 0n, addr(0), addr(0), 0n, 0n]; }
          case "commitments": { const c = s.commitments.get(String(args?.[0]).toLowerCase()); return c ? [c.committer, c.block] : [addr(0), 0n]; }
          // the ProposerFloorTimelock counter the tool reads before a PROPOSER_ROLE revoke (B3)
          case "proposerCount": return BigInt([...s.roles].filter((k) => k.startsWith(`${PROPOSER_ROLE_ID}:`)).length);
          case "hasRole": if (address === A.receipt) return receiptHasRole(String(args?.[0]), String(args?.[1])); if (address === A.registry) return s.timelockIsRegistryAdmin; if (address === A.router) return String(args?.[1]).toLowerCase() === A.timelock.toLowerCase() && s.timelockIsRouterAdmin; if (s.governed.has(address)) return String(args?.[1]).toLowerCase() === A.timelock.toLowerCase(); if (address === A.timelock) return s.roles.has(`${String(args?.[0])}:${String(args?.[1]).toLowerCase()}`); if (address === A.gateway) return String(args?.[0]).toLowerCase() === AGENT_ROLE.toLowerCase() ? s.agentRole.has(String(args?.[1]).toLowerCase()) : s.gatewayAdmins.has(String(args?.[1]).toLowerCase()); return s.agentRole.has(String(args?.[1]).toLowerCase()) || s.gatewayAdmins.has(String(args?.[1]).toLowerCase());
          case "agentOwner": return s.agentOwner.get(String(args?.[0]).toLowerCase()) ?? addr(0);
          case "getRoleAdmin": return ADMIN_ROLE_ID;
          case "isRecorded": return s.recorded.has(String(args?.[0]).toLowerCase());
          case "getOwners": return s.owners;
          case "getThreshold": return s.threshold;
          case "isReleased": return s.released.has(String(args?.[0]).toLowerCase());
          // QA plan v1 D7: BasketVault.assets(i) (reverts past the end) and the public emergencyUnwindGuard(token) getter (zeros until a guard is set)
          case "assets": { const r = (s.assetRows.get(address) ?? [])[Number(args?.[0])]; if (!r) throw new Error("execution reverted"); return [r.token, addr(0xf00), 500, r.active, addr(0xad), 0]; }
          case "emergencyUnwindGuard": return s.guards.get(`${address.toLowerCase()}|${String(args?.[0]).toLowerCase()}`) ?? [0n, false, 0n];
          case "upgradesFrozen": { const p = s.proxies.get(address.toLowerCase()); if (!p) throw new Error(`fake: ${address} is not a proxy`); return p.frozen; }
        }
        throw new Error(`fake: ${functionName}`);
      },
    },
    nonce: async () => s.nonce,
  };
  const bundle = (action: string, id: Hex) => ({ safe_tx_hash: keccak256(toBytes(`${action}${id}${s.nonce}`)), nonce: s.nonce, action, signatures: [] as unknown[], timelock_operation_id: id });
  const api: GovernApi = {
    inspectSubmitter: (async (_h: unknown, who: Address) => {
      if (s.submitterKind === null) return null;
      if (typeof s.submitterKind === "function") return s.submitterKind(who);
      return { address: who, owners: sheet.safeOwners, threshold: 2, code_hash: SAFE_141.proxyCodehash };
    }) as never,
    // the governing Safe, or (QA plan v1 B6) the submitter Safe register-committee drives for its private self-authorization: a 2-of-3 of the sheet's owners
    connectSafe: (async (c: { safeAddress?: string }) => (c?.safeAddress === undefined || c.safeAddress.toLowerCase() === A.safe.toLowerCase()
      ? handle
      : { address: c.safeAddress, chain: handle.chain, owners: [...sheet.safeOwners], threshold: 2, client: handle.client, nonce: async () => s.nonce })) as never,
    timelockMinDelay: (async () => s.minDelay) as never,
    operationId: (async (_h: unknown, p: never) => idOf(p)) as never,
    operationState: (async (_h: unknown, _t: unknown, id: string) => { const o = s.ops.get(id); return o ? { exists: true, pending: o.pending, done: o.done, ready: o.pending && s.clock >= o.readyAt, readyAt: o.readyAt } : { exists: false, pending: false, done: false, ready: false, readyAt: 0n }; }) as never,
    scheduleOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; predecessor?: string; salt: Hex; calls: { target: string; data: string }[] }) => {
      const id = idOf(p as never); const k = p.form === "single" ? "schedule" : "scheduleBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`); s.scheduled.set(rowOf(p.description), { form: p.form ?? "batch", calls: p.calls, predecessor: p.predecessor, description: p.description, salt: p.salt });
      s.ids.set(rowOf(p.description), id);
      for (const c of p.calls) s.scheduledCalls.push({ id, target: c.target as Address, data: c.data as Hex });
      return { ...bundle("schedule", id), predecessor: p.predecessor };
    }) as never,
    executeOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; predecessor?: string; calls: { target: string; data: Hex }[] }) => {
      const k = p.form === "single" ? "execute" : "executeBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`);
      return { ...bundle("execute", idOf(p as never)), calls: p.calls, predecessor: p.predecessor };
    }) as never,
    cancelOnTimelock: (async (_h: unknown, p: { id: Hex; description?: string }) => { s.log.push("cancel"); s.events.push(`cancel:${rowOf(p.description)}`); return bundle("cancel", p.id); }) as never,
    updateTimelockDelay: (async (_h: unknown, p: { newDelay: bigint; phase: string; salt: Hex }) => {
      s.log.push(`updateDelay.${p.phase}`); s.events.push(`updateDelay.${p.phase}:update-delay`);
      const id = idOf({ calls: [{ target: A.timelock, data: decodeKey(p.newDelay) }], salt: p.salt, form: "single" });
      return { ...bundle(`updateDelay.${p.phase}`, id), newDelay: p.newDelay };
    }) as never,
    signTx: (async (_h: unknown, b: { signatures: unknown[] }, signer: Signer) => { s.signed.push(await signer.address()); return { ...b, signatures: [...b.signatures, await signer.address()] }; }) as never,
    executeTx: (async (_h: any, b: any) => {
      const threshold: number = _h?.threshold ?? handle.threshold;
      if (b.signatures.length < threshold) throw new Error(`GS020: below threshold (${b.signatures.length} of ${threshold})`);
      const id: string = b.timelock_operation_id;
      if (String(b.action).startsWith("safe-")) {
        // The Safe's own rules (OwnerManager, B4 / T5): the fake reverts what a real SafeL2 1.4.1 reverts, with the Safe's error codes.
        const d = decodeFunctionData({ abi: SAFE_ADMIN_ABI, data: b.data });
        const lc = (x: unknown) => String(x).toLowerCase();
        const has = (x: unknown) => s.owners.some((o) => lc(o) === lc(x));
        const invalid = (x: unknown) => lc(x) === lc(addr(0)) || lc(x) === lc(SAFE_SENTINEL_OWNER) || lc(x) === lc(A.safe);
        const prevOk = (prev: unknown, owner: unknown) => { const i = s.owners.findIndex((o) => lc(o) === lc(owner)); return i >= 0 && lc(i === 0 ? SAFE_SENTINEL_OWNER : s.owners[i - 1]) === lc(prev); };
        const setThreshold = (t: bigint) => { if (t > BigInt(s.owners.length)) throw new Error("GS201: Threshold cannot exceed owner count"); if (t < 1n) throw new Error("GS202: Threshold needs to be greater than 0"); s.threshold = t; };
        if (d.functionName === "addOwnerWithThreshold") {
          if (invalid(d.args[0])) throw new Error("GS203: Invalid owner address provided");
          if (has(d.args[0])) throw new Error("GS204: Address is already an owner");
          s.owners.push(String(d.args[0])); setThreshold(d.args[1]);
        } else if (d.functionName === "removeOwner") {
          if (BigInt(s.owners.length) - 1n < d.args[2]) throw new Error("GS201: Threshold cannot exceed owner count");
          if (invalid(d.args[1])) throw new Error("GS203: Invalid owner address provided");
          if (!prevOk(d.args[0], d.args[1])) throw new Error("GS205: Invalid prevOwner, owner pair provided");
          s.owners = s.owners.filter((x) => lc(x) !== lc(d.args[1])); setThreshold(d.args[2]);
        } else if (d.functionName === "swapOwner") {
          if (invalid(d.args[2])) throw new Error("GS203: Invalid owner address provided");
          if (has(d.args[2])) throw new Error("GS204: Address is already an owner");
          if (invalid(d.args[1])) throw new Error("GS203: Invalid owner address provided");
          if (!prevOk(d.args[0], d.args[1])) throw new Error("GS205: Invalid prevOwner, owner pair provided");
          s.owners = s.owners.map((x) => (lc(x) === lc(d.args[1]) ? String(d.args[2]) : x));
        } else if (d.functionName === "changeThreshold") setThreshold(d.args[0]);
      }
      // TimelockController's role gates on the Safe (B4 / T5): schedule needs PROPOSER_ROLE, cancel needs CANCELLER_ROLE, both held by the Safe after the timelock stage.
      else if (b.action === "schedule" || b.action === "updateDelay.schedule") {
        if (!s.roles.has(`${PROPOSER_ROLE_ID}:${A.safe.toLowerCase()}`)) throw new Error(`AccessControlUnauthorizedAccount(${A.safe}, PROPOSER_ROLE)`);
        s.ops.set(id, { exists: true, pending: true, done: false, readyAt: s.clock + s.minDelay });
      }
      else if (b.action === "cancel") {
        if (!s.roles.has(`${CANCELLER_ROLE_ID}:${A.safe.toLowerCase()}`)) throw new Error(`AccessControlUnauthorizedAccount(${A.safe}, CANCELLER_ROLE)`);
        s.ops.delete(id);
      }
      else if (b.action === "execute") {
        const snap = { proxies: new Map([...s.proxies].map(([k, v]) => [k, { ...v }])), listed: [...s.listed], ineligible: new Set(s.ineligible), weights: { vaults: [...s.weights.vaults], bps: [...s.weights.bps] }, statuses: new Map(s.statuses), retiredFlag: new Set(s.retiredFlag), paused: new Set(s.paused), vaultCaps: new Map(s.vaultCaps), released: new Set(s.released), voted: s.voted, ops: new Map(s.ops), lastAppliedRecordedAt: s.lastAppliedRecordedAt, guards: new Map(s.guards), policies: new Map(s.policies), agentOwner: new Map(s.agentOwner), agentRole: new Set(s.agentRole), committee: new Map(s.committee), roles: new Set(s.roles) };
        try {
        // a TimelockController refuses an operation whose predecessor is not done
        if (b.predecessor && !s.ops.get(b.predecessor)?.done) throw new Error("TimelockController: missing dependency");
        s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n });
        for (const c of (b.calls ?? []) as { target: string; data: Hex }[]) {
          if (s.failOn?.(c)) throw new Error("injected revert");
          const px = s.proxies.get(c.target.toLowerCase());
          if (px) {
            // GovernedUpgrade: timelock only (the fake timelock is the caller), never once frozen; a freeze is bound to the live implementation and its code hash
            const d = decodeFunctionData({ abi: GOVERNED_PROXY_ABI, data: c.data });
            if (px.frozen) throw new Error("UpgradesAreFrozen()");
            if (d.functionName === "upgradeToAndCall") px.impl = d.args[0] as Address;
            else if (d.functionName === "freezeUpgrades") {
              const code = s.codes.get(px.impl.toLowerCase()) ?? "0x6001600155";
              if (String(d.args[0]).toLowerCase() !== px.impl.toLowerCase() || String(d.args[1]).toLowerCase() !== keccak256(code as Hex).toLowerCase()) throw new Error("FreezeTargetMismatch");
              px.frozen = true;
            }
            continue;
          }
          if (c.target === A.governance) {
            // RouterGovernance.applyReceipt (issue 1698): the contract's own checks, then release and the active vector in one call
            const w = decodeFunctionData({ abi: GOVERNANCE_APPLY_ABI, data: c.data });
            const [rid, digest, vs, bps] = w.args as [Hex, Hex, Address[], bigint[]];
            if (!s.recorded.has(rid.toLowerCase()) && !s.recorded.has(rid)) throw new Error("ReceiptNotRecorded");
            if (s.released.has(rid.toLowerCase())) throw new Error("ReceiptAlreadyReleased");
            if ((s.digests.get(rid.toLowerCase()) ?? "").toLowerCase() !== digest.toLowerCase()) throw new Error("PayloadDigestMismatch");
            if (recordedAtOf(rid) <= s.lastAppliedRecordedAt) throw new Error("ReceiptNotNewerThanApplied");
            if (new Set(vs.map((x) => x.toLowerCase())).size !== vs.length) throw new Error("DuplicateVault");
            s.lastAppliedRecordedAt = recordedAtOf(rid);
            s.released.add(rid.toLowerCase());
            s.voted = { vaults: [...vs], bps: [...bps] };
            continue;
          }
          if (c.target === A.router) {
            const d = decodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, data: c.data });
            if (d.functionName === "setVaultCap") {
              // PortfolioRouter.setVaultCap is onlyRole(ADMIN_ROLE): the timelock after stage 11
              if (!s.timelockIsRouterAdmin) throw new Error(`AccessControlUnauthorizedAccount(${A.timelock})`);
              s.vaultCaps.set(String(d.args[0]), d.args[1]);
            }
            continue;
          }
          if (c.target === A.registry) {
            // the contract rules the batch must respect: a vault is made ineligible before it is retired, the default vector spans the eligible set and sums to 10000
            const d = decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: c.data });
            if (d.functionName === "registerVault") { if (s.listed.includes(d.args[0] as Address)) throw new Error("AlreadyRegistered"); s.listed.push(d.args[0] as Address); s.ineligible.add(d.args[0] as string); }
            else if (d.functionName === "migrateEligibility") {
              const [v, eligible, vs, bps] = d.args as [Address, boolean, Address[], bigint[]];
              if (!s.listed.includes(v)) throw new Error("NotRegistered");
              if (eligible) s.ineligible.delete(v); else s.ineligible.add(v);
              const count = s.listed.filter((x) => !s.ineligible.has(x)).length;
              if (vs.length !== count) throw new Error(`LengthMismatch ${vs.length} ${count}`);
              if (bps.reduce((t, x) => t + x, 0n) !== 10000n) throw new Error("InvalidWeightSum");
              for (const x of vs) if (s.ineligible.has(x) || (s.statuses.get(x) ?? 0) !== 0) throw new Error("VaultNotActive");
              s.weights = { vaults: [...vs], bps: [...bps] };
            } else if (d.functionName === "retire") {
              const v = d.args[0] as Address;
              if (!s.ineligible.has(v)) throw new Error("RetireWhileRouterEligible");
              s.statuses.set(v, 2); s.retiredFlag.add(v);
            }
            continue;
          }
          if (c.target === A.timelock) {
            try {
              const d = decodeFunctionData({ abi: ROLE_ABI_FAKE, data: c.data });
              const k = `${String(d.args[0])}:${String(d.args[1]).toLowerCase()}`;
              if (d.functionName === "grantRole") s.roles.add(k); else s.roles.delete(k);
            } catch { /* updateDelay and the other timelock self-calls change no role */ }
            continue;
          }
          if (c.data.startsWith(SET_GUARD_SELECTOR)) {
            // QA plan v1 D7: BasketVault.setEmergencyUnwindGuard as the contract runs it: onlyRole(ADMIN_ROLE) (the vaults the timelock governs), maxLossBps <= MAX_BPS, an active asset only
            const [token, min, allowed, loss] = decodeFunctionData({ abi: VAULT_UNWIND_GUARD_ABI, data: c.data }).args as [Address, bigint, boolean, bigint];
            if (!s.governed.has(c.target)) throw new Error("AccessControlUnauthorizedAccount");
            if (loss > 10_000n) throw new Error("InvalidParam");
            if (!(s.assetRows.get(c.target) ?? []).some((r) => r.active && r.token.toLowerCase() === token.toLowerCase())) throw new Error("AssetNotFound");
            s.guards.set(`${c.target.toLowerCase()}|${token.toLowerCase()}`, [min, allowed, loss]);
            continue;
          }
          if (c.target !== A.receipt) {
            if ((Object.values(A.vaults).includes(c.target as Address) || s.paused.has(c.target)) && decodeFunctionData({ abi: VAULT_ABI, data: c.data }).functionName === "unpauseDeposits") s.paused.delete(c.target);
            continue;
          }
          try {
            const g = decodeFunctionData({ abi: ROLE_ABI_FAKE, data: c.data });
            if (String(g.args[0]).toLowerCase() === SUBMITTER_ROLE_ID.toLowerCase()) {
              if (!s.timelockIsReceiptAdmin) throw new Error("AccessControlUnauthorizedAccount");
              if (g.functionName === "grantRole") s.submitterRoles.add(String(g.args[1]).toLowerCase()); else s.submitterRoles.delete(String(g.args[1]).toLowerCase());
            }
            continue;
          } catch (e) { if (String((e as Error).message).includes("AccessControl")) throw e; /* not a role call: the release below */ }
          const d = decodeFunctionData({ abi: RECEIPT_ABI, data: c.data });
          if (d.functionName === "releaseReceipt") s.released.add(String(d.args[0]).toLowerCase());
        }
        } catch (e) { Object.assign(s, snap); throw e; }
      }
      else if (b.action === "updateDelay.execute") { s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n }); s.minDelay = b.newDelay; }
      s.nonce++;
      const hash = `0x${s.nonce.toString(16).padStart(64, "0")}`;
      s.txClock.set(hash, s.clock);
      if (b.action === "schedule" || b.action === "execute") s.timelockLogs.set(`${b.action === "schedule" ? "CallScheduled" : "CallExecuted"}:${id}`, hash as Hex);
      s.safeTxs.set(id, [...(s.safeTxs.get(id) ?? []), hash]);
      return { txHash: `0x${s.nonce.toString(16).padStart(64, "0")}` as Hex, bundle: { ...b, executed: { tx_hash: `0x${s.nonce.toString(16).padStart(64, "0")}`, status: 1 } } };
    }) as never,
    proposeTx: (async (_h: unknown, o: { to: string; data: Hex; action?: string }) => { s.events.push(`propose:${o.action}`); return { ...bundle(o.action ?? "call", keccak256(o.data)), to: o.to, data: o.data }; }) as never,
    verifyTimelockEffect: (async () => ({ ok: true, detail: "", state: {} })) as never,
    scheduledCalls: (async () => [...s.scheduledCalls]) as never,
    operationTx: (async (_h: unknown, _t: unknown, id: Hex, event: string) => s.timelockLogs.get(`${event}:${id}`)) as never,
  };
  return { s, api, handle };
}
const ROLE_ABI_FAKE = parseAbi(["function grantRole(bytes32 role, address account)", "function revokeRole(bytes32 role, address account)"]);
const SET_GUARD_SELECTOR = encodeFunctionData({ abi: VAULT_UNWIND_GUARD_ABI, functionName: "setEmergencyUnwindGuard", args: [addr(1), 1n, true, 0n] }).slice(0, 10);
/** The timelock role ids the fake seeds for the Safe (keccak256 of the role name, as TimelockController declares them). */
export const ADMIN_ROLE_ID: Hex = keccak256(toBytes("ADMIN_ROLE"));
export const SUBMITTER_ROLE_ID: Hex = keccak256(toBytes("RECEIPT_SUBMITTER_ROLE"));
export const RELEASER_ROLE_ID: Hex = keccak256(toBytes("RECEIPT_RELEASER_ROLE"));
export const PROPOSER_ROLE_ID: Hex = keccak256(toBytes("PROPOSER_ROLE"));
export const CANCELLER_ROLE_ID: Hex = keccak256(toBytes("CANCELLER_ROLE"));
export const decodeKey = (d: bigint) => encodeFunctionData({ abi: parseAbi(["function updateDelay(uint256 newDelay)"]), functionName: "updateDelay", args: [d] });

/** A fake owner signer for `o`: what `--owner-signer` names for an owner a self-administration row added. */
export const signerFor = (o: string): Signer => ({ kind: "keystore", modes: ["raw"], address: async () => o }) as unknown as Signer;
export const signers = (sheet: ReturnType<typeof parseSheet>, n = 3): Signer[] => sheet.safeOwners.slice(0, n).map(signerFor);
export const sender = { kind: "keystore", modes: ["raw"], address: async () => addr(0xa001) } as unknown as Signer;

