// Shared by the govern tests: the manifest fixtures and the in-memory fake of the Safe tool's entry points (a timelock that checks order and delay).
// The real Safe, the real signers and the real delay are exercised on the Twin chain run and on 8453 (runbook Q2), never here.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { publishLogger } from "../src/log.ts";
import type { RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { getStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { stageManifestName } from "../src/verify/constants.ts";
import { SAFE_141, type Signer } from "../src/safe/index.ts";
import { RECEIPT_ABI, SAFE_ADMIN_ABI, VAULT_ABI, type GovernApi } from "../src/govern.ts";
import { GOVERNANCE_APPLY_ABI } from "../src/apply-receipt.ts";
import { GOVERNANCE_CLEAR_ABI } from "../src/clear-voted-weights.ts";
import { GATEWAY_REGISTER_ABI } from "../src/committee-register.ts";
import { REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI } from "../src/redeploy-vault.ts";
import { GOVERNED_PROXY_ABI } from "../src/upgrade-rows.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../src/verify/codehash.ts";
import { SHA, sheetText, tmp } from "./fixtures.ts";

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const A = { icPolicy: addr(0x1007), timelock: addr(0x2001), safe: addr(0x2002), router: addr(0x1003), registry: addr(0x1002), gateway: addr(0x1004), governance: addr(0x1005), receipt: addr(0x1006), vaults: { USDC: addr(0x3001), PROTO: addr(0x3002), AGENT: addr(0x3003), RWA: addr(0x3004) } };

/** Writes the manifests govern reads (timelock, safe, router, registry, gateway, governance, ic-policy's receipt, one per vault) into `dir`. */
export function writeGovernManifests(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const w = (f: string, o: object) => writeFileSync(join(dir, `${f}.json`), JSON.stringify(o));
  const t = getStageTable();
  const n = (stage: string) => stageManifestName(t, stage);
  w(n("timelock"), { timelock: A.timelock }); w("safe", { safe: A.safe }); w(n("router"), { router: A.router }); w(n("registry"), { registry: A.registry });
  w(n("recorder"), { recorder: "0x00000000000000000000000000000000000c0c0c" });
  w(n("gateway"), { gateway: A.gateway }); w(n("governance"), { governance: A.governance }); w(n("ic-policy"), { consensus_receipt: A.receipt, policy: A.icPolicy });
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
    /** The scheduled calls per row, with the timelock predecessor each operation carries (undefined: none). */
    scheduled: new Map<string, { form: string; calls: { target: string; data: string }[]; predecessor?: string }>(),
    /** The timelock operation id of each scheduled row. */
    ids: new Map<string, Hex>(),
    /** Every transaction hash the fake Safe sent, per timelock operation id: a Safe transaction shared by two operations would show here. */
    safeTxs: new Map<string, string[]>(),
    /** Overrides for a read: `functionName` to the value the chain returns. */
    reads: {} as Record<string, unknown>,
    /** Receipt ids recordReceipt has anchored (the test seeds it) and releaseReceipt has released (an executed timelock call adds to it). */
    recorded: new Set<string>(), released: new Set<string>(),
    /** The vaults that read depositsPaused true. All four vaults deploy paused (issue 1710); an executed unpauseDeposits opens a vault, a test pauses one by adding it. */
    paused: new Set<string>([A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA]),
    /** Registry order, the vaults that are NOT router-eligible, the digest each recorded receipt stored, and the router's default weights (an executed setDefaultWeights sets them). */
    listed: [A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA] as Address[], ineligible: new Set<string>(),
    digests: new Map<string, Hex>(),
    /** Issue 1831: a receipt's recordedAt (default: its 1-based position in `recorded`, so receipts seeded in order are recorded in order), RouterGovernance's
     *  lastAppliedRecordedAt (an executed applyReceipt raises it and refuses a receipt not newer), and whether RouterGovernance holds the receipt ADMIN_ROLE. */
    recordedAt: new Map<string, bigint>(), lastAppliedRecordedAt: 0n, governanceIsReceiptAdmin: true,
    vaultCaps: new Map<string, bigint>(),
    weights: { vaults: [] as Address[], bps: [] as bigint[] },
    /** Issue 1743: the ACTIVE ("voted") vector on the router. An executed applyReceipt sets it (issue 1698). While set, votedWeightsActive reads true and getEffectiveWeights reads it
     *  instead of the default; an executed clearVotedWeights removes it. */
    voted: undefined as { vaults: Address[]; bps: bigint[] } | undefined,
    /** The chain clock at each Safe transaction hash: getTransactionReceipt answers with it as the block number, getBlock({blockNumber}) as the timestamp. */
    txClock: new Map<string, bigint>(),
    /** Issue 1727: the gateway's agents (AGENT_ROLE), the IC policy's committee agents (label) and the owner each agent has. An executed authorizeAgent / committeeRegister fills them. */
    /** Issue 1750: what the --submitter is on chain. A canonical 2-of-3 Safe by default; null is a key (no code); a function decides per address. */
    submitterKind: undefined as undefined | null | ((a: Address) => unknown),
    /** Issue 1796: the registry status of a vault (0 Active, 1 DepositsPaused, 2 Retired), the vaults whose retire() flag is set, the registry's router, and whether the timelock holds ADMIN_ROLE on the registry. */
    statuses: new Map<string, number>(), retiredFlag: new Set<string>(), registryRouter: A.router as Address, timelockIsRegistryAdmin: true,
    /** The vaults a redeploy left linked to the registry (registry() reads A.registry) and the vaults the timelock governs. */
    linked: new Set<string>(), governed: new Set<string>(),
    /** Issue 1796: a call of a timelock batch that reverts. The fake timelock is ATOMIC like the contract: a throwing call leaves the batch's earlier effects undone. */
    failOn: undefined as undefined | ((c: { target: string; data: Hex }) => boolean),
    agentRole: new Set<string>(), committee: new Map<string, string>(), agentOwner: new Map<string, string>(), gatewayAdmins: new Set<string>(),
    /** The Safe's owner list and threshold on chain (Safe self-administration rows change them), and the timelock roles as `role:account`. */
    owners: [...sheet.safeOwners] as string[], threshold: BigInt(sheet.safeThreshold), roles: new Set<string>(),
    /** Issue 1842: the GovernedUUPS proxies (lower-case address to its implementation and freeze flag), the code at an address (else a default), and every call the timelock
     *  scheduled (the CallScheduled logs the freeze row scans). An executed upgradeToAndCall moves the implementation, an executed freezeUpgrades sets the flag, as the library does. */
    proxies: new Map<string, { impl: Address; frozen: boolean }>(), codes: new Map<string, Hex>(), scheduledCalls: [] as { id: Hex; target: Address; data: Hex }[],
  };
  const recordedAtOf = (rid: string): bigint => s.recordedAt.get(rid.toLowerCase()) ?? BigInt([...s.recorded].map((x) => x.toLowerCase()).indexOf(rid.toLowerCase()) + 1);
  const rowOf = (d?: string) => (d ?? "").split(/[ :]/)[0]!;
  const idOf = (p: { calls: { target: string; data: string }[]; salt: string; form?: string; predecessor?: string }): Hex => keccak256(toBytes(JSON.stringify([p.calls.map((c) => [c.target, c.data]), p.salt, p.form ?? "batch", p.predecessor ?? null])));
  const handle: any = {
    address: A.safe, owners: sheet.safeOwners, threshold: sheet.safeThreshold, chain: { rpcUrl: "x", chainId: 918453 },
    client: {
      getCode: async ({ address }: { address?: string } = {}) => s.codes.get(String(address).toLowerCase()) ?? "0x6001600155",
      getStorageAt: async ({ address, slot }: { address: string; slot: string }) => {
        const p = s.proxies.get(address.toLowerCase());
        return slot.toLowerCase() === ERC1967_IMPLEMENTATION_SLOT && p ? (`0x${"0".repeat(24)}${p.impl.slice(2).toLowerCase()}` as Hex) : (`0x${"0".repeat(64)}` as Hex);
      },
      getBlockNumber: async () => s.clock,
      getBlock: async (a?: { blockNumber?: bigint }) => ({ timestamp: a?.blockNumber ?? s.clock }),
      getTransactionReceipt: async ({ hash }: { hash: string }) => ({ blockNumber: s.txClock.get(hash) ?? s.clock, status: "success" }),
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
          case "depositsPaused": return s.paused.has(address);
          case "feeRecipient": return sheet.feeRecipient === "@safe" ? A.safe : sheet.feeRecipient;
          case "agents": return [true, 0n];
          case "hasRole": if (address === A.receipt && String(args?.[1]).toLowerCase() === A.governance.toLowerCase()) return s.governanceIsReceiptAdmin; if (address === A.registry) return s.timelockIsRegistryAdmin; if (s.governed.has(address)) return String(args?.[1]).toLowerCase() === A.timelock.toLowerCase(); if (address === A.timelock) return s.roles.has(`${String(args?.[0])}:${String(args?.[1]).toLowerCase()}`); return address === A.icPolicy ? s.committee.has(String(args?.[1]).toLowerCase()) : s.agentRole.has(String(args?.[1]).toLowerCase()) || s.gatewayAdmins.has(String(args?.[1]).toLowerCase());
          case "agentOwner": return s.agentOwner.get(String(args?.[0]).toLowerCase()) ?? addr(0);
          case "icPolicy": return A.icPolicy;
          case "agentId": return s.committee.get(String(args?.[0]).toLowerCase()) ?? "";
          case "isRecorded": return s.recorded.has(String(args?.[0]).toLowerCase());
          case "getOwners": return s.owners;
          case "getThreshold": return s.threshold;
          case "isReleased": return s.released.has(String(args?.[0]).toLowerCase());
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
    connectSafe: (async () => handle) as never,
    timelockMinDelay: (async () => s.minDelay) as never,
    operationId: (async (_h: unknown, p: never) => idOf(p)) as never,
    operationState: (async (_h: unknown, _t: unknown, id: string) => { const o = s.ops.get(id); return o ? { exists: true, pending: o.pending, done: o.done, ready: o.pending && s.clock >= o.readyAt, readyAt: o.readyAt } : { exists: false, pending: false, done: false, ready: false, readyAt: 0n }; }) as never,
    scheduleOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; predecessor?: string; calls: { target: string; data: string }[] }) => {
      const id = idOf(p as never); const k = p.form === "single" ? "schedule" : "scheduleBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`); s.scheduled.set(rowOf(p.description), { form: p.form ?? "batch", calls: p.calls, predecessor: p.predecessor });
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
    executeTx: (async (_h: unknown, b: any) => {
      if (b.signatures.length < handle.threshold) throw new Error("below threshold");
      const id: string = b.timelock_operation_id;
      if (String(b.action).startsWith("safe-")) {
        const d = decodeFunctionData({ abi: SAFE_ADMIN_ABI, data: b.data });
        const lc = (x: unknown) => String(x).toLowerCase();
        if (d.functionName === "addOwnerWithThreshold") { s.owners.push(String(d.args[0])); s.threshold = d.args[1]; }
        else if (d.functionName === "removeOwner") { s.owners = s.owners.filter((x) => lc(x) !== lc(d.args[1])); s.threshold = d.args[2]; }
        else if (d.functionName === "swapOwner") s.owners = s.owners.map((x) => (lc(x) === lc(d.args[1]) ? String(d.args[2]) : x));
        else if (d.functionName === "changeThreshold") s.threshold = d.args[0];
      }
      else if (b.action === "schedule") s.ops.set(id, { exists: true, pending: true, done: false, readyAt: s.clock + s.minDelay });
      else if (b.action === "cancel") s.ops.delete(id);
      else if (b.action === "execute") {
        const snap = { proxies: new Map([...s.proxies].map(([k, v]) => [k, { ...v }])), listed: [...s.listed], ineligible: new Set(s.ineligible), weights: { vaults: [...s.weights.vaults], bps: [...s.weights.bps] }, statuses: new Map(s.statuses), retiredFlag: new Set(s.retiredFlag), paused: new Set(s.paused), vaultCaps: new Map(s.vaultCaps), released: new Set(s.released), voted: s.voted, ops: new Map(s.ops), lastAppliedRecordedAt: s.lastAppliedRecordedAt };
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
            if (c.data === encodeFunctionData({ abi: GOVERNANCE_CLEAR_ABI, functionName: "clearVotedWeights" })) { s.voted = undefined; continue; }
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
            if (d.functionName === "setVaultCap") s.vaultCaps.set(String(d.args[0]), d.args[1]);
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
          if (c.target === A.gateway) {
            let d: ReturnType<typeof decodeFunctionData<typeof GATEWAY_REGISTER_ABI>>;
            try { d = decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.data }); } catch { continue; } // a generic test call with junk calldata changes nothing here
            const who = String(d.args[0]).toLowerCase();
            if (d.functionName === "authorizeAgent") { s.agentRole.add(who); s.agentOwner.set(who, A.timelock); }
            if (d.functionName === "committeeRegister") s.committee.set(who, String(d.args[1]));
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
          if (c.target !== A.receipt) {
            if ((Object.values(A.vaults).includes(c.target as Address) || s.paused.has(c.target)) && decodeFunctionData({ abi: VAULT_ABI, data: c.data }).functionName === "unpauseDeposits") s.paused.delete(c.target);
            continue;
          }
          const d = decodeFunctionData({ abi: RECEIPT_ABI, data: c.data });
          if (d.functionName === "releaseReceipt") s.released.add(String(d.args[0]).toLowerCase());
        }
        } catch (e) { Object.assign(s, snap); throw e; }
      }
      else if (b.action === "updateDelay.schedule") s.ops.set(id, { exists: true, pending: true, done: false, readyAt: s.clock + s.minDelay });
      else if (b.action === "updateDelay.execute") { s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n }); s.minDelay = b.newDelay; }
      s.nonce++;
      const hash = `0x${s.nonce.toString(16).padStart(64, "0")}`;
      s.txClock.set(hash, s.clock);
      s.safeTxs.set(id, [...(s.safeTxs.get(id) ?? []), hash]);
      return { txHash: `0x${s.nonce.toString(16).padStart(64, "0")}` as Hex, bundle: { ...b, executed: { tx_hash: `0x${s.nonce.toString(16).padStart(64, "0")}`, status: 1 } } };
    }) as never,
    proposeTx: (async (_h: unknown, o: { to: string; data: Hex; action?: string }) => { s.events.push(`propose:${o.action}`); return { ...bundle(o.action ?? "call", keccak256(o.data)), to: o.to, data: o.data }; }) as never,
    verifyTimelockEffect: (async () => ({ ok: true, detail: "", state: {} })) as never,
    scheduledCalls: (async () => [...s.scheduledCalls]) as never,
  };
  return { s, api, handle };
}
const ROLE_ABI_FAKE = parseAbi(["function grantRole(bytes32 role, address account)", "function revokeRole(bytes32 role, address account)"]);
export const decodeKey = (d: bigint) => encodeFunctionData({ abi: parseAbi(["function updateDelay(uint256 newDelay)"]), functionName: "updateDelay", args: [d] });

export const signers = (sheet: ReturnType<typeof parseSheet>, n = 3): Signer[] => sheet.safeOwners.slice(0, n).map((o) => ({ kind: "keystore", modes: ["raw"], address: async () => o }) as unknown as Signer);
export const sender = { kind: "keystore", modes: ["raw"], address: async () => addr(0xa001) } as unknown as Signer;

